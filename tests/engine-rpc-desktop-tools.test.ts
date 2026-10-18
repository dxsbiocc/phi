import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'
import { NotebookToolHostRouter } from '../src/main/agent/notebook/notebook-tool-host-router'
import type { NotebookToolRequest } from '../src/main/agent/notebook/notebook-tools'
import { desktopToolsFixture, PNG, browserOutcome } from './helpers/rpcDesktopToolsFixture'
import { registeredHostTools } from '../src/main/agent/engine/rpc/host-tool-validation'
import {
  createRpcDesktopToolScope,
  isRpcDesktopCoordinatedTool
} from '../src/main/agent/engine/rpc/desktop-tool-scope'

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((part) => part.text ?? '').join('\n')
}

test('empty trusted skill catalog registers the other real schemas without exposing skill_run', (t) => {
  const f = desktopToolsFixture()
  t.after(() => f.close())
  const scope = createRpcDesktopToolScope({
    identity: f.scope.identity,
    services: f.services,
    currentRun: () => undefined,
    recentUserImages: () => [],
    allowBrowserTypeText: () => false,
    browserTextVault: f.vault,
    agentDir: join(f.root, 'agent'),
    allowedSkills: [],
    scriptTools: [],
    remoteLibrary: true
  })
  t.after(() => scope.dispose())
  const roster = registeredHostTools(scope.tools)
  assert.equal(roster.has('skill_run'), false)
  assert.equal(roster.get('lib.save')?.validate({ title: 'Selected remote paper' }), true)
  assert.equal(roster.get('lib.save')?.validate({}), false)
})

test('a skill enabled from several sources appears once in the skill_run schema', (t) => {
  const f = desktopToolsFixture()
  t.after(() => f.close())
  const scope = createRpcDesktopToolScope({
    identity: f.scope.identity,
    services: f.services,
    currentRun: () => undefined,
    recentUserImages: () => [],
    allowBrowserTypeText: () => false,
    browserTextVault: f.vault,
    agentDir: join(f.root, 'agent'),
    allowedSkills: ['remote-demo', 'grill-me', 'remote-demo', 'grill-me'],
    scriptTools: []
  })
  t.after(() => scope.dispose())
  const skillRun = scope.tools.find((tool) => tool.name === 'skill_run')
  const skill = (skillRun?.parameters.properties as Record<string, { enum?: string[] }>).skill
  assert.deepEqual(skill.enum, ['remote-demo', 'grill-me'])
})

test('actual existing dotted notebook names register without widening name policy to controls or arbitrary methods', (t) => {
  const f = desktopToolsFixture()
  t.after(() => f.close())
  const roster = registeredHostTools(f.scope.tools)
  assert.equal(roster.get('notebook.list')?.definition.name, 'notebook.list')
  for (const name of [
    'notebook/list',
    'notebook list',
    'notebook\nlist',
    'notebook\0list',
    'x'.repeat(129)
  ]) {
    assert.throws(
      () => registeredHostTools([{ ...f.tool('notebook.list'), name }]),
      /Invalid or duplicate/
    )
  }
  assert.throws(
    () => registeredHostTools([f.tool('notebook.list'), f.tool('notebook.list')]),
    /Invalid or duplicate/
  )
})

test('curated desktop scope exposes real builders and explicitly reports missing remote adapters', async (t) => {
  const f = desktopToolsFixture()
  t.after(() => f.close())
  const names = f.scope.tools.map((tool) => tool.name)
  for (const name of [
    'browser',
    'ask_user_question',
    'render_blocks',
    'palette_suggest',
    'notebook.list',
    'present_files',
    'download_file',
    'skill_run',
    'env_request',
    'wrapper_run',
    'wrapper_status'
  ])
    assert.ok(names.includes(name), name)
  assert.equal(
    names.some((name) => name.startsWith('lib.') || name.startsWith('mcp__')),
    false
  )
  assert.deepEqual(
    f.scope.unavailable.map(({ capability }) => capability),
    ['library', 'websearch/MCP', 'agent delegation']
  )
  assert.equal(
    f.scope.tools.every((tool) => tool.site === 'host'),
    true
  )
  assert.equal(isRpcDesktopCoordinatedTool(f.tool('browser')), true)
  assert.equal(isRpcDesktopCoordinatedTool(f.tool('env_request')), true)
  assert.equal(isRpcDesktopCoordinatedTool({ ...f.tool('browser') }), false)
  assert.equal(isRpcDesktopCoordinatedTool(f.tool('skill_run')), false)
  assert.equal(Object.isFrozen(f.tool('browser')), true)
  assert.equal(f.scope.approvalFor('notebook.run_cell', {}), 'write')
  assert.equal(f.scope.approvalFor('skill_run', {}), 'exec')
  assert.equal(f.scope.approvalFor('not-registered', {}), undefined)
  const output = await f.call('render_blocks', {
    blocks: [{ type: 'metrics', items: [{ label: 'Count', value: 3 }] }]
  })
  assert.deepEqual(output.details, {
    kind: 'ui_blocks',
    blocks: [{ type: 'metrics', items: [{ label: 'Count', value: 3 }] }]
  })
  assert.equal((await f.call('palette_suggest', { use: 'heatmap', limit: 1 })).isError, undefined)
})

test('real browser builder and coordinator receive trusted runtime/call context and preserve image results', async (t) => {
  const f = desktopToolsFixture()
  t.after(() => f.close())
  const result = await f.call('browser', { action: 'snapshot', tabId: 'tab-1' }, 'actual-call')
  assert.deepEqual(f.observed[0].context, {
    originSessionId: 'runtime-session',
    toolCallId: 'actual-call'
  })
  assert.deepEqual(
    result.content.find((part) => part.type === 'image'),
    { type: 'image', data: PNG, mimeType: 'image/png' }
  )
  assert.equal(result.isError, undefined)
  assert.equal(
    JSON.stringify(f.scope.tools.map(({ name, parameters }) => ({ name, parameters }))).includes(
      'runtime-session'
    ),
    false
  )
})

test('browser text uses only one-time vault placeholders and live plan policy', async (t) => {
  let typed: unknown
  const f = desktopToolsFixture({
    executeBrowser: async (input) => {
      typed = input
      return browserOutcome()
    }
  })
  t.after(() => f.close())
  const raw = {
    action: 'typeText',
    tabId: 'tab-1',
    expectedDocumentRevision: 2,
    text: 'synthetic private text',
    consequence: 'write'
  }
  assert.equal((await f.call('browser', raw, 'raw')).isError, true)
  assert.equal(typed, undefined)
  const sanitized = f.vault.sanitize('sanitized', raw)
  assert.equal((await f.call('browser', sanitized, 'sanitized')).isError, undefined)
  assert.equal(JSON.stringify(typed).includes('synthetic private text'), true)
  assert.equal((await f.call('browser', sanitized, 'sanitized')).isError, true)
  const denied = f.vault.sanitize('denied', raw)
  f.setTypeAllowed(false)
  assert.equal((await f.call('browser', denied, 'denied')).isError, true)
})

test('notebook builder uses actual remote router with verified identity and no local fallback', async (t) => {
  const f = desktopToolsFixture()
  t.after(() => f.close())
  let observed: NotebookToolRequest | undefined
  let local = 0
  const router = new NotebookToolHostRouter({
    local: async () => {
      local++
      return {}
    },
    isRemoteCwd: () => true,
    resolveRemote: async (identity) => {
      assert.deepEqual(identity, {
        runtimeSessionId: 'runtime-session',
        sessionId: 'phi-session',
        projectId: 'project'
      })
      return {
        projectCwd: '/canonical/selected/server/project',
        execute: async (request) => {
          observed = request
          return { summary: 'selected remote notebooks', notebooks: ['remote.ipynb'] }
        }
      }
    }
  })
  f.services.register('notebookTool.execute', (params) =>
    router.execute(params as NotebookToolRequest)
  )
  const result = await f.call('notebook.list', { sessionId: 'forged', cwd: '/desktop/forged' })
  assert.equal(observed?.cwd, '/canonical/selected/server/project')
  assert.equal(text(result), 'selected remote notebooks')
  assert.deepEqual(result.details, {
    summary: 'selected remote notebooks',
    notebooks: ['remote.ipynb']
  })
  assert.equal(local, 0)
  const unavailable = new NotebookToolHostRouter({
    local: async () => {
      local++
      return {}
    },
    isRemoteCwd: () => true,
    resolveRemote: async () => null
  })
  f.services.register('notebookTool.execute', (params) =>
    unavailable.execute(params as NotebookToolRequest)
  )
  const failed = await f.call('notebook.list')
  assert.equal(failed.isError, true)
  assert.match(text(failed), /没有回退/)
  assert.equal(local, 0)
})

test('download cancellation reaches the original selected remote request and never returns late success', async (t) => {
  const f = desktopToolsFixture()
  t.after(() => f.close())
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let finish!: (value: unknown) => void
  const held = new Promise<unknown>((resolve) => {
    finish = resolve
  })
  const seen: Array<{ method: string; params: unknown; context: unknown }> = []
  f.services.register('remoteWorkspace.download', (params, context) => {
    seen.push({ method: 'run', params, context })
    entered()
    return held
  })
  f.services.register('remoteWorkspace.cancelDownload', (params, context) => {
    seen.push({ method: 'cancel', params, context })
  })
  const signal = new AbortController()
  const execution = f.call(
    'download_file',
    { url: 'https://fixture.test/data.txt', outputPath: 'data.txt', projectId: 'forged' },
    'download-call',
    signal.signal
  )
  const rejected = assert.rejects(execution, /abort fixture/)
  await started
  signal.abort(new Error('abort fixture'))
  await rejected
  finish({ path: '/server/project/data.txt', displayPath: 'data.txt', bytes: 4 })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(seen.length, 2)
  const run = seen[0].params as Record<string, unknown>
  assert.equal(run.sessionId, 'phi-session')
  assert.equal(run.projectId, 'project')
  assert.deepEqual(seen[1].params, {
    sessionId: 'phi-session',
    projectId: 'project',
    requestId: run.requestId
  })
  const { signal: downloadSignal, ...downloadContext } = seen[0]
    .context as import('../src/main/agent/engine/types').PhiHostRequestContext
  assert.ok(downloadSignal instanceof AbortSignal)
  assert.equal(downloadSignal.aborted, true)
  assert.deepEqual(downloadContext, {
    originSessionId: 'runtime-session',
    toolCallId: 'download-call'
  })
  assert.deepEqual(seen[1].context, seen[0].context)
})

test('browser abort cancels the actual coordinator request without another session effect', async (t) => {
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let remoteSignal: AbortSignal | undefined
  const f = desktopToolsFixture({
    executeBrowser: async (_input, signal) => {
      remoteSignal = signal
      entered()
      return new Promise((resolve) =>
        signal.addEventListener('abort', () => resolve(browserOutcome()), { once: true })
      )
    }
  })
  t.after(() => f.close())
  const abort = new AbortController()
  const call = f.call(
    'browser',
    { action: 'snapshot', tabId: 'tab-1' },
    'browser-cancel',
    abort.signal
  )
  const rejected = assert.rejects(call, /browser stopped/)
  await started
  abort.abort(new Error('browser stopped'))
  await rejected
  assert.equal(remoteSignal?.aborted, true)
  assert.equal(f.observed.length, 2)
})

test('retired run/disposed scope rejects pending and future services with no fallback', async (t) => {
  const f = desktopToolsFixture()
  t.after(() => f.close())
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let resolve!: (value: unknown) => void
  f.services.register('notebookTool.execute', () => {
    entered()
    return new Promise((done) => {
      resolve = done
    })
  })
  const operation = f.call('notebook.list')
  await started
  f.setRun({ id: 'replacement', signal: new AbortController().signal })
  resolve({ summary: 'late old result' })
  await assert.rejects(operation, /binding changed/)
  f.scope.dispose()
  await assert.rejects(f.call('render_blocks', {}), /disposed/)
  assert.deepEqual(f.scope.recentUserImages(), [])
})

test('scope refuses caller cwd substitution and missing run before any handler', async (t) => {
  const f = desktopToolsFixture()
  t.after(() => f.close())
  await assert.rejects(
    f.tool('browser').execute('call', { action: 'snapshot', tabId: 'tab-1' }, undefined, {
      cwd: '/desktop/forged',
      recentUserImages: () => []
    }),
    /trusted active remote run/
  )
  f.setRun(undefined)
  await assert.rejects(f.call('browser', {}), /trusted active remote run/)
  assert.equal(f.observed.length, 0)
})

test('ask_user uses the trusted session UI interface and unavailable UI is an explicit tool error', async (t) => {
  const f = desktopToolsFixture()
  t.after(() => f.close())
  const questions = [
    {
      question: 'Choose the fixture result',
      header: 'Choice',
      options: [
        { label: 'A', description: 'First' },
        { label: 'B', description: 'Second' }
      ]
    }
  ]
  f.services.register('agentInteraction.request', (params, context) => {
    assert.deepEqual(params, { runtimeSessionId: 'runtime-session', questions })
    const { signal, ...identity } = context
    assert.ok(signal instanceof AbortSignal)
    assert.equal(signal.aborted, false)
    assert.deepEqual(identity, { originSessionId: 'runtime-session', toolCallId: 'question-call' })
    return {
      answers: [{ questionIndex: 0, question: questions[0].question, kind: 'option', answer: 'A' }]
    }
  })
  const answer = await f.call(
    'ask_user_question',
    { questions, runtimeSessionId: 'forged' },
    'question-call'
  )
  assert.equal(answer.isError, undefined)
  assert.match(text(answer), /User has answered/)
  f.services.register('agentInteraction.request', () => {
    throw new Error('Window unavailable')
  })
  const missing = await f.call('ask_user_question', { questions })
  assert.equal(missing.isError, true)
  assert.match(text(missing), /Window unavailable/)
  assert.deepEqual(missing.details, { answers: [], cancelled: true, error: 'no_custom_ui' })
})

test(
  'external browser/download abort retains its bound service context under strict rejection handling',
  { timeout: 15000 },
  async () => {
    const child = spawn(
      process.execPath,
      [
        '--unhandled-rejections=strict',
        '--import',
        './scripts/test-loader.mjs',
        '--test',
        '--test-name-pattern=download cancellation|browser abort',
        'tests/engine-rpc-desktop-tools.test.ts'
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_TEST_CONTEXT: undefined } }
    )
    let output = ''
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-65536)
      })
    const timer = setTimeout(() => child.kill('SIGKILL'), 12000)
    const status = await new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code, signal) => resolve({ code, signal }))
      }
    ).finally(() => clearTimeout(timer))
    assert.equal(status.code, 0, output)
    assert.equal(status.signal, null, output)
    assert.match(output, /pass 2/)
    assert.doesNotMatch(output, /UnhandledPromiseRejection|unhandledRejection/)
  }
)
