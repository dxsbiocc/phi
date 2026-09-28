import { EventEmitter } from 'node:events'
import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

const electronMockUrl = 'phi-test:electron'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') {
      return { url: electronMockUrl, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url !== electronMockUrl) {
      return nextLoad(url, context)
    }

    return {
      format: 'module',
      shortCircuit: true,
      source: `
        const state = {
          focusedWindow: null,
          windows: [],
          openedUrls: []
        };

        export const BrowserWindow = {
          getFocusedWindow() {
            return state.focusedWindow;
          },
          getAllWindows() {
            return state.windows;
          }
        };

        export const shell = {
          openExternal(url) {
            state.openedUrls.push(url);
            return Promise.resolve();
          }
        };

        export const __electronMock = {
          state,
          reset() {
            state.focusedWindow = null;
            state.windows = [];
            state.openedUrls = [];
          },
          setFocusedWindow(window) {
            state.focusedWindow = window;
          },
          setWindows(windows) {
            state.windows = windows;
          }
        };
      `
    }
  }
})

type ElectronMock = {
  reset(): void
  setFocusedWindow(window: FakeWindow | null): void
  setWindows(windows: FakeWindow[]): void
}

type AuthPromptLike =
  | {
      type: 'text' | 'secret' | 'manual_code'
      message: string
      placeholder?: string
      signal?: AbortSignal
    }
  | {
      type: 'select'
      message: string
      options: ReadonlyArray<{ id: string; label: string; description?: string }>
      signal?: AbortSignal
    }

type AuthInteractionLike = {
  signal?: AbortSignal
  prompt(prompt: AuthPromptLike): Promise<string>
  notify(event: unknown): void
}

type ToolHandler = (
  event: {
    toolName: string
    input: Record<string, unknown>
    toolCallId?: string
    agentRunId?: string
  },
  ctx: { signal?: AbortSignal }
) => Promise<unknown>

class FakeWebContents extends EventEmitter {
  destroyed = false
  sendThrows = false
  readonly sent: Array<{ channel: string; payload: unknown }> = []

  isDestroyed(): boolean {
    return this.destroyed
  }

  send(channel: string, payload: unknown): void {
    if (this.sendThrows) {
      throw new Error('send failed')
    }
    this.sent.push({ channel, payload })
  }

  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }

  renderProcessGone(): void {
    this.emit('render-process-gone')
  }

  navigate(isInPlace = false, isMainFrame = true): void {
    this.emit('did-start-navigation', {}, 'app://renderer', isInPlace, isMainFrame)
  }
}

class FakeWindow extends EventEmitter {
  destroyed = false
  readonly webContents = new FakeWebContents()

  isDestroyed(): boolean {
    return this.destroyed
  }

  close(): void {
    this.destroyed = true
    this.emit('closed')
  }
}

const { __electronMock } = (await import('electron')) as unknown as {
  __electronMock: ElectronMock
}
const { AuthManager } = await import('../src/main/agent/auth-manager')
const {
  bashApprovalDigest,
  editApprovalDigest,
  writeApprovalDigest,
  cancelToolApprovals,
  createApprovalExtension,
  resolveToolApproval
} = await import('../src/main/agent/tool-approval')

async function registerApprovalHandler(signal?: AbortSignal): Promise<ToolHandler> {
  let handler: ToolHandler | undefined
  const extension = createApprovalExtension({ signal })

  if (typeof extension === 'function') {
    await extension({
      on(eventName: string, candidate: ToolHandler): void {
        if (eventName === 'tool_call') handler = candidate
      }
    } as never)
  } else {
    await extension.factory({
      on(eventName: string, candidate: ToolHandler): void {
        if (eventName === 'tool_call') handler = candidate
      }
    } as never)
  }

  assert.ok(handler)
  return handler
}

function createRuntime(login: (interaction: AuthInteractionLike) => Promise<unknown>): unknown {
  return {
    async login(
      _providerId: string,
      _type: string,
      interaction: AuthInteractionLike
    ): Promise<unknown> {
      return login(interaction)
    },
    getProviders(): unknown[] {
      return []
    },
    async listCredentials(): Promise<unknown[]> {
      return []
    }
  }
}

afterEach(() => {
  cancelToolApprovals()
  __electronMock.reset()
})

test('tool approval resolves and cleans up accepted requests', async () => {
  const window = new FakeWindow()
  __electronMock.setFocusedWindow(window)
  const handler = await registerApprovalHandler()

  const pending = handler({ toolName: 'bash', input: { command: 'npm test' } }, {})
  assert.equal(window.webContents.sent.length, 1)
  assert.equal(window.listenerCount('closed'), 1)

  const request = window.webContents.sent[0].payload as { requestId: string }
  resolveToolApproval(request.requestId, true)

  assert.equal(await pending, undefined)
  assert.equal(window.listenerCount('closed'), 0)
  assert.equal(window.webContents.listenerCount('did-start-navigation'), 0)
  resolveToolApproval(request.requestId, false)
})

test('plan drafts and proposal writes use the session sandbox without a second approval', async () => {
  const handler = await registerApprovalHandler()
  assert.equal(
    await handler(
      { toolName: 'write', input: { path: 'local://analysis-plan.md', content: '# Plan' } },
      {}
    ),
    undefined
  )
  assert.equal(
    await handler({ toolName: 'edit', input: { path: 'local://analysis-plan.md' } }, {}),
    undefined
  )
  assert.equal(
    await handler({ toolName: 'edit', input: { path: '[local://analysis-plan.md#ABCD]' } }, {}),
    undefined
  )
  assert.equal(
    await handler({ toolName: 'write', input: { path: 'xd://propose', content: 'analysis' } }, {}),
    undefined
  )
  assert.match(
    String(
      (await handler({ toolName: 'write', input: { path: '/project/result.txt' } }, {}))?.reason
    ),
    /没有可用窗口/
  )
})

test('remote Bash approval shows host, pinned cwd, scope warning and exact command', async () => {
  const window = new FakeWindow()
  __electronMock.setFocusedWindow(window)
  let handler: ToolHandler | undefined
  const extension = createApprovalExtension({
    getContext: () => ({
      sessionId: 'phi-remote',
      runId: 'run-1',
      cwd: 'ssh://cluster-a/data/project',
      projectName: 'Cluster project',
      scopeNote: 'SSH cluster-a · cwd /data/project；Shell 命令可访问项目目录之外。'
    })
  })
  if (typeof extension !== 'function') {
    await extension.factory({
      on(eventName: string, candidate: ToolHandler): void {
        if (eventName === 'tool_call') handler = candidate
      }
    } as never)
  }
  assert.ok(handler)
  const pending = handler(
    {
      toolName: 'bash',
      toolCallId: 'tool-1',
      input: { command: 'printf marker', env: { TOKEN: 'private-value' }, timeout: 30 }
    },
    {}
  )
  const request = window.webContents.sent[0].payload as {
    requestId: string
    toolCallId: string
    command: string
    approvalDigest: string
    cwd: string
    summary: string
  }
  assert.equal(request.toolCallId, 'tool-1')
  assert.equal(request.command, 'printf marker')
  assert.equal(
    request.approvalDigest,
    bashApprovalDigest({ command: 'printf marker', env: { TOKEN: 'private-value' }, timeout: 30 })
  )
  assert.equal(request.cwd, 'ssh://cluster-a/data/project')
  assert.match(request.summary, /Shell 命令可访问项目目录之外/)
  assert.match(request.summary, /printf marker/)
  assert.match(request.summary, /env keys: TOKEN/)
  assert.doesNotMatch(request.summary, /private-value/)
  resolveToolApproval(request.requestId, false)
  await pending
})

test('Bash approval digest binds environment and timeout independent of env key order', () => {
  const approved = bashApprovalDigest({ command: 'echo ok', env: { B: '2', A: '1' }, timeout: 30 })
  assert.equal(
    approved,
    bashApprovalDigest({ command: 'echo ok', env: { A: '1', B: '2' }, timeout: 30 })
  )
  assert.notEqual(
    approved,
    bashApprovalDigest({ command: 'echo ok', env: { A: 'changed', B: '2' }, timeout: 30 })
  )
  assert.notEqual(
    approved,
    bashApprovalDigest({ command: 'echo ok', env: { A: '1', B: '2' }, timeout: 60 })
  )
})

test('remote write approval shows host and path while binding exact content', async () => {
  const window = new FakeWindow()
  __electronMock.setFocusedWindow(window)
  let handler: ToolHandler | undefined
  const extension = createApprovalExtension({
    getContext: () => ({
      sessionId: 'phi-remote',
      runId: 'run-1',
      cwd: 'ssh://cluster-a/data/project',
      writeScopeNote: 'SSH cluster-a · 项目 /data/project；仅创建新文件，不覆盖已有目标。'
    })
  })
  if (typeof extension !== 'function') {
    await extension.factory({
      on(eventName: string, candidate: ToolHandler): void {
        if (eventName === 'tool_call') handler = candidate
      }
    } as never)
  }
  assert.ok(handler)
  const pending = handler(
    {
      toolName: 'write',
      toolCallId: 'tool-write',
      input: { path: 'new.txt', content: 'private file content' }
    },
    {}
  )
  const request = window.webContents.sent[0].payload as {
    requestId: string
    approvalDigest: string
    summary: string
    cwd: string
  }
  assert.equal(request.cwd, 'ssh://cluster-a/data/project')
  assert.match(request.summary, /cluster-a/)
  assert.match(request.summary, /new\.txt/)
  assert.doesNotMatch(request.summary, /private file content/)
  assert.equal(
    request.approvalDigest,
    writeApprovalDigest({ path: 'new.txt', content: 'private file content' })
  )
  assert.notEqual(
    request.approvalDigest,
    writeApprovalDigest({ path: 'new.txt', content: 'changed' })
  )
  resolveToolApproval(request.requestId, false)
  await pending
})

test('remote edit approval binds old/new text without showing file content', async () => {
  const window = new FakeWindow()
  __electronMock.setFocusedWindow(window)
  let handler: ToolHandler | undefined
  const extension = createApprovalExtension({
    getContext: () => ({
      sessionId: 'phi-remote',
      runId: 'run-1',
      cwd: 'ssh://cluster-a/data/project',
      writeScopeNote: 'SSH cluster-a · 项目 /data/project；修改已读取且未变化的文件。'
    })
  })
  if (typeof extension !== 'function') {
    await extension.factory({
      on(eventName: string, candidate: ToolHandler): void {
        if (eventName === 'tool_call') handler = candidate
      }
    } as never)
  }
  assert.ok(handler)
  const input = { path: 'existing.txt', old_string: 'private old', new_string: 'private new' }
  const pending = handler(
    { toolName: 'edit', toolCallId: 'tool-edit', agentRunId: 'wrapper-run-1', input },
    {}
  )
  const request = window.webContents.sent[0].payload as {
    requestId: string
    agentRunId?: string
    approvalDigest: string
    summary: string
    cwd: string
  }
  assert.match(request.summary, /cluster-a/)
  assert.equal(request.agentRunId, 'wrapper-run-1')
  assert.match(request.summary, /existing\.txt/)
  assert.doesNotMatch(request.summary, /private old|private new/)
  assert.equal(request.approvalDigest, editApprovalDigest(input))
  assert.notEqual(request.approvalDigest, editApprovalDigest({ ...input, new_string: 'changed' }))
  resolveToolApproval(request.requestId, false)
  await pending
})

test('a remote approval hook follows the current ask/auto/full policy without session recreation', async () => {
  const window = new FakeWindow()
  __electronMock.setFocusedWindow(window)
  let ask = false
  let handler: ToolHandler | undefined
  const extension = createApprovalExtension({ shouldGate: () => ask })
  if (typeof extension !== 'function') {
    await extension.factory({
      on(eventName: string, candidate: ToolHandler): void {
        if (eventName === 'tool_call') handler = candidate
      }
    } as never)
  }
  assert.ok(handler)
  assert.equal(
    await handler({ toolName: 'write', input: { path: 'note.txt', content: 'safe' } }, {}),
    undefined
  )
  assert.equal(window.webContents.sent.length, 0)
  ask = true
  const pending = handler({ toolName: 'write', input: { path: 'note.txt', content: 'safe' } }, {})
  assert.equal(window.webContents.sent.length, 1)
  const request = window.webContents.sent[0].payload as { requestId: string }
  resolveToolApproval(request.requestId, false)
  assert.deepEqual(await pending, { block: true, reason: '用户拒绝了该操作' })
})

test('tool approval cancellation denies pending requests and ignores late responses', async () => {
  const window = new FakeWindow()
  __electronMock.setFocusedWindow(window)
  const handler = await registerApprovalHandler()

  const pending = handler({ toolName: 'edit', input: { path: '/tmp/file' } }, {})
  const request = window.webContents.sent[0].payload as { requestId: string }

  cancelToolApprovals()
  assert.deepEqual(await pending, { block: true, reason: '用户拒绝了该操作' })
  assert.equal(window.listenerCount('closed'), 0)

  resolveToolApproval(request.requestId, true)
})

test('aborted tool approval scopes deny late tool calls without creating requests', async () => {
  const window = new FakeWindow()
  __electronMock.setFocusedWindow(window)
  const controller = new AbortController()
  controller.abort()
  const handler = await registerApprovalHandler(controller.signal)

  const result = await handler({ toolName: 'write', input: { path: '/tmp/file' } }, {})

  assert.deepEqual(result, { block: true, reason: '操作已取消' })
  assert.equal(window.webContents.sent.length, 0)
})

test('explicit null approval window getter denies without falling back', async () => {
  const fallbackWindow = new FakeWindow()
  __electronMock.setFocusedWindow(fallbackWindow)
  let handler: ToolHandler | undefined
  const extension = createApprovalExtension({ getWindow: () => null })

  if (typeof extension !== 'function') {
    await extension.factory({
      on(eventName: string, candidate: ToolHandler): void {
        if (eventName === 'tool_call') handler = candidate
      }
    } as never)
  }

  assert.ok(handler)
  const result = await handler({ toolName: 'bash', input: { command: 'date' } }, {})
  assert.deepEqual(result, { block: true, reason: '没有可用窗口来请求批准' })
  assert.equal(fallbackWindow.webContents.sent.length, 0)
})

test('tool approval denies safely when the renderer disappears or delivery fails', async () => {
  const window = new FakeWindow()
  __electronMock.setFocusedWindow(window)
  const handler = await registerApprovalHandler()

  const pending = handler({ toolName: 'bash', input: { command: 'date' } }, {})
  window.webContents.navigate(true, true)
  assert.equal(window.webContents.listenerCount('did-start-navigation'), 1)
  window.webContents.navigate(false, true)

  assert.deepEqual(await pending, { block: true, reason: '用户拒绝了该操作' })
  assert.equal(window.listenerCount('closed'), 0)
  assert.equal(window.webContents.listenerCount('did-start-navigation'), 0)

  const brokenWindow = new FakeWindow()
  brokenWindow.webContents.sendThrows = true
  __electronMock.setFocusedWindow(brokenWindow)

  const failedDelivery = await handler({ toolName: 'bash', input: { command: 'date' } }, {})
  assert.deepEqual(failedDelivery, { block: true, reason: '用户拒绝了该操作' })
  assert.equal(brokenWindow.listenerCount('closed'), 0)
})

test('auth prompt resolves normally through the renderer response', async () => {
  const window = new FakeWindow()
  const state: { manager?: InstanceType<typeof AuthManager> } = {}
  __electronMock.setFocusedWindow(window)
  const manager = new AuthManager(
    Promise.resolve(
      createRuntime(async (interaction) => {
        const prompt = interaction.prompt({ type: 'text', message: 'API key' })
        const event = window.webContents.sent[0].payload as {
          requestId: string
          prompt: { signal?: AbortSignal }
        }
        assert.equal('signal' in event.prompt, false)
        await state.manager?.resolveInteraction(event.requestId, 'secret')
        assert.equal(await prompt, 'secret')
        return { type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 60000 }
      })
    ) as ConstructorParameters<typeof AuthManager>[0]
  )
  state.manager = manager

  assert.deepEqual(await manager.loginOAuth('provider'), [])
  assert.equal(window.listenerCount('closed'), 0)
})

test('auth prompt abort rejects and cleans up stale renderer responses', async () => {
  const window = new FakeWindow()
  __electronMock.setFocusedWindow(window)
  const controller = new AbortController()
  let requestId = ''
  const manager = new AuthManager(
    Promise.resolve(
      createRuntime(async (interaction) => {
        const prompt = interaction.prompt({
          type: 'manual_code',
          message: 'Paste code',
          signal: controller.signal
        })
        requestId = (window.webContents.sent[0].payload as { requestId: string }).requestId
        controller.abort()
        await prompt
      })
    ) as ConstructorParameters<typeof AuthManager>[0]
  )

  await assert.rejects(() => manager.loginOAuth('provider'), /cancelled/)
  assert.equal(window.listenerCount('closed'), 0)
  await manager.resolveInteraction(requestId, 'late')
})

test('auth prompt renderer death rejects and aborts the login interaction signal', async () => {
  const window = new FakeWindow()
  __electronMock.setFocusedWindow(window)
  let requestId = ''
  let loginSignal: AbortSignal | undefined
  const manager = new AuthManager(
    Promise.resolve(
      createRuntime(async (interaction) => {
        loginSignal = interaction.signal
        const prompt = interaction.prompt({ type: 'text', message: 'Code' })
        requestId = (window.webContents.sent[0].payload as { requestId: string }).requestId
        window.webContents.renderProcessGone()
        await prompt
      })
    ) as ConstructorParameters<typeof AuthManager>[0]
  )

  await assert.rejects(() => manager.loginOAuth('provider'), /window was closed/)
  assert.equal(loginSignal?.aborted, true)
  assert.equal(window.listenerCount('closed'), 0)
  assert.equal(window.webContents.listenerCount('render-process-gone'), 0)
  await manager.resolveInteraction(requestId, 'late')
})
