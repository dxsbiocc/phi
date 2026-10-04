import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { createAgentSession } from '../src/main/agent/session/session-manager'
import type {
  CreateAgentSessionOptions,
  RuntimeAgentSession,
  RuntimeSessionManager
} from '../src/main/agent/runtime/runtime-adapter'
import {
  TerminalDraftService,
  type TerminalDraftGenerationResult,
  type TerminalDraftManagerFacade,
  type TerminalDraftSession,
  type TerminalDraftTargetSnapshot
} from '../src/main/terminal/terminal-command-draft'
import { buildTerminalDraftSessionFactory } from '../src/main/terminal/terminal-draft-session'
import { TerminalError } from '../src/main/terminal/terminal-error'

const VALID_RESPONSE = JSON.stringify({
  command: 'touch <marker>',
  explanation: 'Create a marker file.',
  requiredInputs: [{ name: 'marker', description: 'Marker path' }]
})

class Deferred<T> {
  readonly promise: Promise<T>
  resolve!: (value: T | PromiseLike<T>) => void

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve
    })
  }
}

class FakeSession implements TerminalDraftSession {
  readonly prompts: string[] = []
  abortCalls = 0
  disposeCalls = 0

  constructor(
    readonly response = VALID_RESPONSE,
    private readonly promptGate?: Promise<void>,
    private readonly onPrompt?: () => void,
    private readonly abortGate?: Promise<void>,
    private readonly disposeGate?: Promise<void>
  ) {}

  async prompt(text: string): Promise<void> {
    this.prompts.push(text)
    this.onPrompt?.()
    await this.promptGate
  }

  assistantText(): string {
    return this.response
  }

  async abort(): Promise<void> {
    this.abortCalls += 1
    await this.abortGate
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1
    await this.disposeGate
  }
}

class FakeManager implements TerminalDraftManagerFacade {
  readonly snapshots = new Map<string, TerminalDraftTargetSnapshot>()
  readonly inputCalls: Array<{ terminalId: string; data: string }> = []
  inputGate?: Promise<void>

  constructor() {
    this.snapshots.set('terminal-a', {
      terminalId: 'terminal-a',
      workspaceKey: 'project:alpha',
      workspaceLabel: 'Alpha',
      initialCwd: '/work/alpha',
      shell: '/bin/zsh',
      state: 'open'
    })
  }

  snapshot(terminalId: string): TerminalDraftTargetSnapshot | undefined {
    return this.snapshots.get(terminalId)
  }

  async input(terminalId: string, data: string): Promise<void> {
    this.inputCalls.push({ terminalId, data })
    await this.inputGate
  }
}

function sessionFactory(
  sessions: FakeSession[] | ((context: { terminalId: string }) => FakeSession)
): (context: { terminalId: string }) => Promise<FakeSession> {
  return async (context) => {
    if (typeof sessions === 'function') return sessions(context)
    const session = sessions.shift()
    assert.ok(session, 'expected another fake session')
    return session
  }
}

async function terminalError(
  action: () => unknown | Promise<unknown>,
  code: TerminalError['code'],
  message?: string
): Promise<TerminalError> {
  let caught: unknown
  try {
    await action()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof TerminalError)
  assert.equal(caught.code, code)
  if (message) assert.equal(caught.message, message)
  return caught
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

async function settlesWithin<T>(promise: Promise<T>, timeoutMs = 100): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const watchdog = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('operation did not settle promptly')), timeoutMs)
  })
  try {
    return await Promise.race([promise, watchdog])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

test('generation only creates an editable draft and submit performs one PTY write', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phi-terminal-draft-'))
  try {
    const marker = join(directory, 'marker')
    const manager = new FakeManager()
    const session = new FakeSession()
    const service = new TerminalDraftService({
      manager,
      createSession: sessionFactory([session]),
      randomDraftId: () => 'draft-1'
    })

    const draft = await service.generate({
      requestId: 'generate-1',
      terminalId: 'terminal-a',
      kind: 'command',
      request: 'Create a marker file'
    })

    assert.equal(draft.source, 'touch <marker>')
    assert.equal(manager.inputCalls.length, 0)
    assert.equal(existsSync(marker), false)
    assert.equal(session.disposeCalls, 1)

    await service.submit({
      requestId: 'submit-1',
      draftId: draft.draftId,
      source: `touch ${marker}`,
      bracketedPaste: false
    })
    assert.deepEqual(manager.inputCalls, [{ terminalId: 'terminal-a', data: `touch ${marker}\r` }])
    assert.equal(existsSync(marker), false)
    await service.dispose()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('prompt contains only bounded, explicitly allowed terminal context', async () => {
  const manager = new FakeManager()
  const target = manager.snapshots.get('terminal-a') as TerminalDraftTargetSnapshot & {
    buffer?: string
    env?: Record<string, string>
  }
  target.buffer = 'BUFFER_SECRET_MUST_NOT_LEAK'
  target.env = { TOKEN: 'ENV_SECRET_MUST_NOT_LEAK' }
  const selection = `${'s'.repeat(16 * 1024)}TRUNCATED_SELECTION_SECRET`
  const session = new FakeSession(
    JSON.stringify({ command: 'pwd', explanation: 'Print cwd.', requiredInputs: [] })
  )
  const service = new TerminalDraftService({
    manager,
    createSession: sessionFactory([session]),
    randomDraftId: () => 'draft-context'
  })

  const result = await service.generate({
    requestId: 'generate-context',
    terminalId: 'terminal-a',
    kind: 'explain',
    request: 'Explain this selection',
    selection
  })
  const prompt = session.prompts[0]
  assert.equal(result.selectionTruncated, true)
  assert.match(prompt, /Explain this selection/u)
  assert.match(prompt, /"selection":"ssss/u)
  assert.match(prompt, /truncated at 16 KiB/u)
  assert.match(prompt, /"shell":"zsh"/u)
  assert.match(prompt, /"project":"Alpha"/u)
  assert.match(prompt, /"initialDirectory":"\/work\/alpha"/u)
  assert.match(prompt, /"platform":"macOS"/u)
  assert.doesNotMatch(prompt, /TRUNCATED_SELECTION_SECRET/u)
  assert.doesNotMatch(prompt, /BUFFER_SECRET_MUST_NOT_LEAK/u)
  assert.doesNotMatch(prompt, /ENV_SECRET_MUST_NOT_LEAK/u)
  await service.dispose()
})

test('prompt omits terminal selection when the user did not attach one', async () => {
  const manager = new FakeManager()
  const session = new FakeSession(
    JSON.stringify({ command: 'pwd', explanation: 'Print cwd.', requiredInputs: [] })
  )
  const service = new TerminalDraftService({ manager, createSession: sessionFactory([session]) })

  await service.generate({
    requestId: 'generate-no-selection',
    terminalId: 'terminal-a',
    kind: 'command',
    request: 'Show the current directory'
  })
  const contextLine = session.prompts[0].split('\n').at(-1) ?? ''
  assert.equal(Object.hasOwn(JSON.parse(contextLine), 'selection'), false)
  await service.dispose()
})

test('tool-less session builder forces noTools all and an in-memory manager per cwd', async () => {
  let capturedOptions: CreateAgentSessionOptions | undefined
  const promptCalls: Array<{ text: string; options: unknown }> = []
  const runtimeSession = {
    messages: [] as unknown[],
    prompt: async (text: string, options: unknown) => {
      promptCalls.push({ text, options })
      runtimeSession.messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: VALID_RESPONSE }]
      })
    },
    abort: async () => undefined,
    dispose: async () => undefined
  } as unknown as RuntimeAgentSession
  const createSessionSpy = (async (
    options?: CreateAgentSessionOptions
  ): ReturnType<typeof createAgentSession> => {
    capturedOptions = options
    return { session: runtimeSession }
  }) as typeof createAgentSession
  const fakeManager = { kind: 'memory' } as unknown as RuntimeSessionManager
  const factory = buildTerminalDraftSessionFactory({
    createAgentSession: createSessionSpy,
    createSessionManager: (cwd) => {
      assert.equal(cwd, '/work/alpha')
      return fakeManager
    },
    resolveSession: () => ({
      modelRuntime: {} as never,
      model: { provider: 'test', id: 'draft', name: 'Draft', reasoning: false },
      thinkingLevel: 'low'
    })
  })

  const session = await factory({
    terminalId: 'terminal-a',
    workspaceKey: 'project:alpha',
    cwd: '/work/alpha'
  })
  await session.prompt('draft prompt')
  assert.equal(capturedOptions?.noTools, 'all')
  assert.equal(capturedOptions?.cwd, '/work/alpha')
  assert.equal(capturedOptions?.sessionManager, fakeManager)
  assert.equal(capturedOptions?.model?.id, 'draft')
  assert.equal(capturedOptions?.thinkingLevel, 'low')
  assert.equal(promptCalls.length, 1)
  assert.deepEqual(promptCalls[0].options, {
    expandPromptTemplates: false,
    userInitiated: true,
    skipCompactionCheck: true
  })
  assert.equal(session.assistantText(), VALID_RESPONSE)
})

test('tool-less session builder rejects missing model before creating a session', async () => {
  let createCalls = 0
  const factory = buildTerminalDraftSessionFactory({
    createAgentSession: (async () => {
      createCalls += 1
      throw new Error('must not run')
    }) as typeof createAgentSession,
    createSessionManager: () => ({}) as RuntimeSessionManager,
    resolveSession: () => ({ modelRuntime: {} as never })
  })

  await terminalError(
    () =>
      factory({
        terminalId: 'terminal-a',
        workspaceKey: 'project:alpha',
        cwd: '/work/alpha'
      }),
    'unavailable',
    '请先配置模型'
  )
  assert.equal(createCalls, 0)
})

test('busy, timeout, and cancel paths abort as needed and always dispose sessions', async () => {
  const manager = new FakeManager()
  const busyGate = new Deferred<void>()
  const busySession = new FakeSession(VALID_RESPONSE, busyGate.promise)
  const busyService = new TerminalDraftService({
    manager,
    createSession: sessionFactory([busySession])
  })
  const first = busyService.generate({
    requestId: 'generate-busy-1',
    terminalId: 'terminal-a',
    kind: 'command',
    request: 'First request'
  })
  await waitFor(() => busySession.prompts.length === 1)
  await terminalError(
    () =>
      busyService.generate({
        requestId: 'generate-busy-2',
        terminalId: 'terminal-a',
        kind: 'command',
        request: 'Second request'
      }),
    'busy'
  )
  await busyService.cancel('generate-busy-1')
  await terminalError(() => first, 'unavailable', '生成已取消')
  assert.equal(busySession.abortCalls, 1)
  assert.equal(busySession.disposeCalls, 1)

  const timeoutSession = new FakeSession(VALID_RESPONSE, new Deferred<void>().promise)
  const timeoutService = new TerminalDraftService({
    manager,
    createSession: sessionFactory([timeoutSession]),
    generationTimeoutMs: 5
  })
  await terminalError(
    () =>
      timeoutService.generate({
        requestId: 'generate-timeout',
        terminalId: 'terminal-a',
        kind: 'command',
        request: 'Timeout request'
      }),
    'unavailable',
    '生成超时'
  )
  assert.equal(timeoutSession.abortCalls, 1)
  assert.equal(timeoutSession.disposeCalls, 1)
  await Promise.all([busyService.dispose(), timeoutService.dispose()])
})

test('timeout and cancel return promptly and clear the active slot when teardown hangs', async () => {
  const manager = new FakeManager()
  const neverPrompt = new Deferred<void>()
  const neverAbort = new Deferred<void>()
  const neverDispose = new Deferred<void>()
  const timedOutSession = new FakeSession(
    VALID_RESPONSE,
    neverPrompt.promise,
    undefined,
    neverAbort.promise,
    neverDispose.promise
  )
  const cancelledSession = new FakeSession(
    VALID_RESPONSE,
    neverPrompt.promise,
    undefined,
    neverAbort.promise,
    neverDispose.promise
  )
  const replacementSession = new FakeSession(
    JSON.stringify({ command: 'pwd', explanation: 'Print cwd.', requiredInputs: [] })
  )
  const service = new TerminalDraftService({
    manager,
    createSession: sessionFactory([timedOutSession, cancelledSession, replacementSession]),
    generationTimeoutMs: 5
  })

  await terminalError(
    () =>
      settlesWithin(
        service.generate({
          requestId: 'generate-hanging-timeout',
          terminalId: 'terminal-a',
          kind: 'command',
          request: 'Timeout despite hanging teardown'
        })
      ),
    'unavailable',
    '生成超时'
  )
  assert.equal(timedOutSession.abortCalls, 1)
  assert.equal(timedOutSession.disposeCalls, 1)

  const cancelledGeneration = service.generate({
    requestId: 'generate-hanging-cancel',
    terminalId: 'terminal-a',
    kind: 'command',
    request: 'Cancel despite hanging teardown'
  })
  await waitFor(() => cancelledSession.prompts.length === 1)
  await settlesWithin(service.cancel('generate-hanging-cancel'))
  await terminalError(() => settlesWithin(cancelledGeneration), 'unavailable', '生成已取消')
  assert.equal(cancelledSession.abortCalls, 1)
  assert.equal(cancelledSession.disposeCalls, 1)

  const replacement = await service.generate({
    requestId: 'generate-after-hanging-teardown',
    terminalId: 'terminal-a',
    kind: 'command',
    request: 'Prove the active slot was cleared'
  })
  assert.equal(replacement.source, 'pwd')
  await settlesWithin(service.dispose())
})

test('service disposal does not wait for hanging abort or dispose', async () => {
  const manager = new FakeManager()
  const neverPrompt = new Deferred<void>()
  const neverAbort = new Deferred<void>()
  const neverDispose = new Deferred<void>()
  const session = new FakeSession(
    VALID_RESPONSE,
    neverPrompt.promise,
    undefined,
    neverAbort.promise,
    neverDispose.promise
  )
  const service = new TerminalDraftService({
    manager,
    createSession: sessionFactory([session]),
    generationTimeoutMs: 60_000
  })
  const generation = service.generate({
    requestId: 'generate-service-dispose',
    terminalId: 'terminal-a',
    kind: 'command',
    request: 'Dispose the service'
  })
  await waitFor(() => session.prompts.length === 1)

  await settlesWithin(service.dispose())
  await terminalError(() => settlesWithin(generation), 'unavailable', '生成已取消')
  assert.equal(session.abortCalls, 1)
  assert.equal(session.disposeCalls, 1)
})

test('generation timeout also covers session creation and disposes a late session', async () => {
  const manager = new FakeManager()
  const sessionGate = new Deferred<FakeSession>()
  const service = new TerminalDraftService({
    manager,
    createSession: async () => await sessionGate.promise,
    generationTimeoutMs: 5
  })

  await terminalError(
    () =>
      service.generate({
        requestId: 'generate-slow-session',
        terminalId: 'terminal-a',
        kind: 'command',
        request: 'Slow session request'
      }),
    'unavailable',
    '生成超时'
  )

  const lateSession = new FakeSession()
  sessionGate.resolve(lateSession)
  await waitFor(() => lateSession.disposeCalls === 1)
  assert.equal(lateSession.abortCalls, 1)
  assert.equal(lateSession.prompts.length, 0)
  await service.dispose()
})

test('invalid model JSON is private and the session is disposed', async () => {
  const manager = new FakeManager()
  const rawOutput = 'not-json WITH_PRIVATE_TERMINAL_TEXT'
  const session = new FakeSession(rawOutput)
  const service = new TerminalDraftService({ manager, createSession: sessionFactory([session]) })

  const error = await terminalError(
    () =>
      service.generate({
        requestId: 'generate-invalid',
        terminalId: 'terminal-a',
        kind: 'command',
        request: 'Generate something'
      }),
    'invalid'
  )
  assert.doesNotMatch(error.message, /WITH_PRIVATE_TERMINAL_TEXT/u)
  assert.equal(session.disposeCalls, 1)
  await service.dispose()
})

test('parser accepts a surrounding json fence and rejects mismatched placeholders', async () => {
  const manager = new FakeManager()
  const fenced = new FakeSession(`\`\`\`json\n${VALID_RESPONSE}\n\`\`\``)
  const mismatch = new FakeSession(
    JSON.stringify({
      command: 'touch <other>',
      explanation: 'Mismatch.',
      requiredInputs: [{ name: 'marker', description: 'Marker' }]
    })
  )
  const service = new TerminalDraftService({
    manager,
    createSession: sessionFactory([fenced, mismatch])
  })
  const draft = await service.generate({
    requestId: 'generate-fenced',
    terminalId: 'terminal-a',
    kind: 'command',
    request: 'Fenced response'
  })
  assert.equal(draft.source, 'touch <marker>')
  await terminalError(
    () =>
      service.generate({
        requestId: 'generate-mismatch',
        terminalId: 'terminal-a',
        kind: 'command',
        request: 'Mismatch response'
      }),
    'invalid'
  )
  assert.equal(fenced.disposeCalls, 1)
  assert.equal(mismatch.disposeCalls, 1)
  await service.dispose()
})

test('submit validates draft lifetime, terminal state, workspace, source, and placeholders', async () => {
  let now = 1_000
  let draftNumber = 0
  const manager = new FakeManager()
  const service = new TerminalDraftService({
    manager,
    now: () => now,
    createSession: sessionFactory(() => new FakeSession()),
    randomDraftId: () => `draft-${++draftNumber}`
  })

  await terminalError(
    () =>
      service.submit({
        requestId: 'unknown-draft',
        draftId: 'missing',
        source: 'pwd',
        bracketedPaste: false
      }),
    'invalid'
  )

  const unresolved = await service.generate({
    requestId: 'generate-unresolved',
    terminalId: 'terminal-a',
    kind: 'command',
    request: 'Create marker'
  })
  await terminalError(
    () =>
      service.submit({
        requestId: 'submit-unresolved',
        draftId: unresolved.draftId,
        source: unresolved.source,
        bracketedPaste: false
      }),
    'invalid',
    '请填写所有必填项'
  )
  await terminalError(
    () =>
      service.submit({
        requestId: 'submit-oversize',
        draftId: unresolved.draftId,
        source: 'x'.repeat(16 * 1024 + 1),
        bracketedPaste: false
      }),
    'invalid',
    '命令过长'
  )
  await terminalError(
    () =>
      service.submit({
        requestId: 'submit-nul',
        draftId: unresolved.draftId,
        source: 'touch ok\0',
        bracketedPaste: false
      }),
    'invalid',
    '命令包含无效字符'
  )

  manager.snapshots.get('terminal-a')!.state = 'exited'
  await terminalError(
    () =>
      service.submit({
        requestId: 'submit-closed',
        draftId: unresolved.draftId,
        source: 'touch marker',
        bracketedPaste: false
      }),
    'not_open'
  )
  manager.snapshots.get('terminal-a')!.state = 'open'
  manager.snapshots.get('terminal-a')!.workspaceKey = 'project:other'
  await terminalError(
    () =>
      service.submit({
        requestId: 'submit-workspace',
        draftId: unresolved.draftId,
        source: 'touch marker',
        bracketedPaste: false
      }),
    'invalid',
    '目标终端工作区已变化'
  )
  manager.snapshots.get('terminal-a')!.workspaceKey = 'project:alpha'

  const expiring = await service.generate({
    requestId: 'generate-expiring',
    terminalId: 'terminal-a',
    kind: 'command',
    request: 'Create another marker'
  })
  now += 30 * 60 * 1_000
  await terminalError(
    () =>
      service.submit({
        requestId: 'submit-expired',
        draftId: expiring.draftId,
        source: 'touch marker',
        bracketedPaste: false
      }),
    'invalid',
    '草稿不存在或已过期'
  )
  await service.dispose()
})

test('submit deduplicates requestId, rejects a new requestId, and wraps bracketed paste once', async () => {
  const manager = new FakeManager()
  let id = 0
  const service = new TerminalDraftService({
    manager,
    createSession: sessionFactory(() => new FakeSession()),
    randomDraftId: () => `draft-${++id}`
  })
  const draft = await service.generate({
    requestId: 'generate-dedupe',
    terminalId: 'terminal-a',
    kind: 'command',
    request: 'Create marker'
  })

  await service.submit({
    requestId: 'submit-dedupe',
    draftId: draft.draftId,
    source: 'touch first',
    bracketedPaste: false
  })
  await service.submit({
    requestId: 'submit-dedupe',
    draftId: draft.draftId,
    source: 'touch must-not-run',
    bracketedPaste: true
  })
  assert.deepEqual(manager.inputCalls, [{ terminalId: 'terminal-a', data: 'touch first\r' }])
  await terminalError(
    () =>
      service.submit({
        requestId: 'submit-new-id',
        draftId: draft.draftId,
        source: 'touch second',
        bracketedPaste: false
      }),
    'invalid',
    '该草稿已发送'
  )

  const bracketed = await service.generate({
    requestId: 'generate-bracketed',
    terminalId: 'terminal-a',
    kind: 'command',
    request: 'Create marker with bracketed paste'
  })
  await service.submit({
    requestId: 'submit-bracketed',
    draftId: bracketed.draftId,
    source: 'touch bracketed',
    bracketedPaste: true
  })
  assert.deepEqual(manager.inputCalls.at(-1), {
    terminalId: 'terminal-a',
    data: '\x1b[200~touch bracketed\x1b[201~\r'
  })
  await service.dispose()
})

test('submitted is claimed before awaiting input so concurrent submissions remain exactly once', async () => {
  const manager = new FakeManager()
  const gate = new Deferred<void>()
  manager.inputGate = gate.promise
  const service = new TerminalDraftService({
    manager,
    createSession: sessionFactory([new FakeSession()])
  })
  const draft = await service.generate({
    requestId: 'generate-concurrent',
    terminalId: 'terminal-a',
    kind: 'command',
    request: 'Create marker'
  })
  const first = service.submit({
    requestId: 'submit-concurrent-1',
    draftId: draft.draftId,
    source: 'touch once',
    bracketedPaste: false
  })
  await terminalError(
    () =>
      service.submit({
        requestId: 'submit-concurrent-2',
        draftId: draft.draftId,
        source: 'touch twice',
        bracketedPaste: false
      }),
    'invalid',
    '该草稿已发送'
  )
  assert.equal(manager.inputCalls.length, 1)
  gate.resolve()
  await first
  await service.dispose()
})

test('draft cap evicts the least recently used draft and terminal close removes bound drafts', async () => {
  const manager = new FakeManager()
  let id = 0
  const service = new TerminalDraftService({
    manager,
    createSession: sessionFactory(() => new FakeSession()),
    randomDraftId: () => `draft-${++id}`,
    now: () => 10_000
  })
  const drafts: TerminalDraftGenerationResult[] = []
  for (let index = 0; index < 33; index += 1) {
    drafts.push(
      await service.generate({
        requestId: `generate-cap-${index}`,
        terminalId: 'terminal-a',
        kind: 'command',
        request: `Create marker ${index}`
      })
    )
  }
  await terminalError(
    () =>
      service.submit({
        requestId: 'submit-evicted',
        draftId: drafts[0].draftId,
        source: 'touch old',
        bracketedPaste: false
      }),
    'invalid',
    '草稿不存在或已过期'
  )

  service.terminalClosed('terminal-a')
  await terminalError(
    () =>
      service.submit({
        requestId: 'submit-closed-cleanup',
        draftId: drafts.at(-1)!.draftId,
        source: 'touch recent',
        bracketedPaste: false
      }),
    'invalid',
    '草稿不存在或已过期'
  )
  await service.dispose()
})

test('submit request cache is capped, retains in-flight requests, and expires settled results', async () => {
  let now = 50_000
  const service = new TerminalDraftService({
    manager: new FakeManager(),
    createSession: sessionFactory([]),
    now: () => now
  })
  for (let index = 0; index < 1_024; index += 1) {
    await terminalError(
      () =>
        service.submit({
          requestId: `unknown-${index}`,
          draftId: 'missing',
          source: 'pwd',
          bracketedPaste: false
        }),
      'invalid'
    )
  }
  await terminalError(
    () =>
      service.submit({
        requestId: 'over-capacity',
        draftId: 'missing',
        source: 'pwd',
        bracketedPaste: false
      }),
    'busy'
  )

  now += 10 * 60 * 1_000
  await terminalError(
    () =>
      service.submit({
        requestId: 'after-expiry',
        draftId: 'missing',
        source: 'pwd',
        bracketedPaste: false
      }),
    'invalid'
  )
  await service.dispose()
})

test('late generation cannot create a draft after the terminal workspace changes', async () => {
  const manager = new FakeManager()
  const session = new FakeSession(VALID_RESPONSE, undefined, () => {
    manager.snapshots.get('terminal-a')!.workspaceKey = 'project:other'
  })
  const service = new TerminalDraftService({ manager, createSession: sessionFactory([session]) })
  await terminalError(
    () =>
      service.generate({
        requestId: 'generate-late',
        terminalId: 'terminal-a',
        kind: 'command',
        request: 'Late generation'
      }),
    'invalid',
    '目标终端工作区已变化'
  )
  assert.equal(manager.inputCalls.length, 0)
  assert.equal(session.disposeCalls, 1)
  await service.dispose()
})

test('submit rejects a literal bracketed-paste end marker and allows a resend after a pre-write rejection', async () => {
  const manager = new FakeManager()
  const service = new TerminalDraftService({
    manager,
    createSession: sessionFactory(() => new FakeSession()),
    randomDraftId: () => 'draft-review'
  })
  const draft = await service.generate({
    requestId: 'generate-review',
    terminalId: 'terminal-a',
    kind: 'command',
    request: 'Create marker'
  })
  const filled = draft.source.replace(/<[a-z][a-z0-9_]*>/gu, 'value')

  await terminalError(
    () =>
      service.submit({
        requestId: 'submit-escape',
        draftId: draft.draftId,
        source: `${filled}\x1b[201~rm -rf x`,
        bracketedPaste: true
      }),
    'invalid'
  )
  assert.equal(manager.inputCalls.length, 0)

  const original = manager.input.bind(manager)
  manager.input = async () => {
    throw new TerminalError('not_open', 'Terminal is not open')
  }
  await terminalError(
    () =>
      service.submit({
        requestId: 'submit-closed',
        draftId: draft.draftId,
        source: filled,
        bracketedPaste: false
      }),
    'not_open'
  )
  manager.input = original
  await service.submit({
    requestId: 'submit-retry',
    draftId: draft.draftId,
    source: filled,
    bracketedPaste: false
  })
  assert.deepEqual(manager.inputCalls, [{ terminalId: 'terminal-a', data: `${filled}\r` }])
  await service.dispose()
})
