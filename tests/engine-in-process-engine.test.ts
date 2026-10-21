import assert from 'node:assert/strict'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { createInProcessEngine } from '../src/main/agent/engine/in-process-engine'
import { OmpBridge } from '../src/main/agent/engine/omp-bridge'
import type {
  PhiEngine,
  PhiSessionCreateParams,
  RuntimeModel
} from '../src/main/agent/engine/types'

type RecordedCall = {
  id: string
  method: string
  params: unknown
  result: unknown
}

type RecordedHostResponse = {
  type: 'hostResponse'
  id: string
  ok: boolean
  result?: unknown
  error?: string
}

function requestResult(method: string, params: unknown): unknown {
  if (method === 'decisions.evaluate')
    return {
      choice: 'inspect',
      source: 'model',
      model: { providerId: 'provider', modelId: 'model' },
      fallbackReason: 'not_configured'
    }
  if (method === 'session.create') {
    const sessionId = (params as { sessionId: string }).sessionId
    return { sessionId, state: { cwd: '/created' } }
  }
  return { method, passthrough: true }
}

function recordingBridge(): {
  bridge: OmpBridge
  calls: RecordedCall[]
  hostResponses: RecordedHostResponse[]
  emit(message: unknown): void
  child: ChildProcessWithoutNullStreams
} {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const emitter = new EventEmitter()
  const child = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    killed: false,
    kill(): boolean {
      this.killed = true
      queueMicrotask(() => this.emit('exit', 0, null))
      return true
    }
  }) as unknown as ChildProcessWithoutNullStreams
  const calls: RecordedCall[] = []
  const hostResponses: RecordedHostResponse[] = []
  let buffered = ''

  stdin.setEncoding('utf8')
  stdin.on('data', (chunk: string) => {
    buffered += chunk
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      if (!line) continue
      const message = JSON.parse(line) as Record<string, unknown>
      if (message.type === 'hostResponse') {
        hostResponses.push(message as RecordedHostResponse)
        continue
      }
      const id = String(message.id)
      const method = String(message.method)
      const params = message.params
      const result = requestResult(method, params)
      calls.push({ id, method, params, result })
      queueMicrotask(() => {
        stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`)
      })
    }
  })

  return {
    bridge: new OmpBridge(() => child),
    calls,
    hostResponses,
    emit: (message) => stdout.write(`${JSON.stringify(message)}\n`),
    child
  }
}

const model: RuntimeModel = {
  provider: 'provider',
  id: 'model',
  name: 'Model',
  reasoning: true
}

const createParams: PhiSessionCreateParams = {
  sessionId: 'created-session',
  cwd: '/workspace',
  agentDir: '/agent',
  sessionManager: { kind: 'persistent', cwd: '/workspace' },
  enableToolApproval: false
}

type RequestCase = {
  name: string
  method: string
  params: unknown
  resultIsPassedThrough?: boolean
  invoke(engine: PhiEngine): Promise<unknown>
}

const requestCases: RequestCase[] = [
  {
    name: 'decisions.models',
    method: 'decisions.models',
    params: { agentDir: '/agent' },
    invoke: (engine) => engine.decisions.models({ agentDir: '/agent' })
  },
  {
    name: 'sessions.create',
    method: 'session.create',
    params: createParams,
    invoke: (engine) => engine.sessions.create(createParams)
  },
  {
    name: 'sessions.prompt',
    method: 'session.prompt',
    params: { sessionId: 'session', text: 'hello', options: { synthetic: true } },
    invoke: (engine) =>
      engine.sessions.prompt({
        sessionId: 'session',
        text: 'hello',
        options: { synthetic: true }
      })
  },
  {
    name: 'sessions.contextUsage',
    method: 'session.contextUsage',
    params: { sessionId: 'session' },
    invoke: (engine) => engine.sessions.contextUsage({ sessionId: 'session' })
  },
  {
    name: 'sessions.setAutoCompactionSettings',
    method: 'session.setAutoCompactionSettings',
    params: { sessionId: 'session', overrides: { enabled: true } },
    invoke: (engine) =>
      engine.sessions.setAutoCompactionSettings({
        sessionId: 'session',
        overrides: { enabled: true }
      })
  },
  {
    name: 'sessions.compact',
    method: 'session.compact',
    params: { sessionId: 'session' },
    invoke: (engine) => engine.sessions.compact({ sessionId: 'session' })
  },
  {
    name: 'sessions.enterPlanMode',
    method: 'session.plan.enter',
    params: { sessionId: 'session' },
    invoke: (engine) => engine.sessions.enterPlanMode({ sessionId: 'session' })
  },
  {
    name: 'sessions.abort',
    method: 'session.abort',
    params: { sessionId: 'session' },
    invoke: (engine) => engine.sessions.abort({ sessionId: 'session' })
  },
  {
    name: 'sessions.dispose',
    method: 'session.dispose',
    params: { sessionId: 'session' },
    invoke: (engine) => engine.sessions.dispose({ sessionId: 'session' })
  },
  {
    name: 'sessions.setModel',
    method: 'session.setModel',
    params: { sessionId: 'session', agentDir: '/agent', model },
    invoke: (engine) =>
      engine.sessions.setModel({ sessionId: 'session', agentDir: '/agent', model })
  },
  {
    name: 'sessions.setThinkingLevel',
    method: 'session.setThinkingLevel',
    params: { sessionId: 'session', level: 'high' },
    invoke: (engine) => engine.sessions.setThinkingLevel({ sessionId: 'session', level: 'high' })
  },
  {
    name: 'sessions.rename',
    method: 'session.rename',
    params: { sessionId: 'session', name: 'Renamed' },
    invoke: (engine) => engine.sessions.rename({ sessionId: 'session', name: 'Renamed' })
  },
  {
    name: 'history.list',
    method: 'sessions.list',
    params: { agentDir: '/agent', cwd: '/workspace' },
    invoke: (engine) => engine.history.list({ agentDir: '/agent', cwd: '/workspace' })
  },
  {
    name: 'history.open',
    method: 'sessions.open',
    params: { agentDir: '/agent', path: '/session.jsonl', cwd: '/workspace' },
    invoke: (engine) =>
      engine.history.open({ agentDir: '/agent', path: '/session.jsonl', cwd: '/workspace' })
  },
  {
    name: 'history.fork',
    method: 'sessions.fork',
    params: {
      path: '/session.jsonl',
      cwd: '/workspace',
      userMessages: ['one', 'two'],
      selectedIndex: 1
    },
    invoke: (engine) =>
      engine.history.fork({
        path: '/session.jsonl',
        cwd: '/workspace',
        userMessages: ['one', 'two'],
        selectedIndex: 1
      })
  },
  {
    name: 'history.rename',
    method: 'sessions.rename',
    params: { agentDir: '/agent', path: '/session.jsonl', name: 'Stored name' },
    invoke: (engine) =>
      engine.history.rename({ agentDir: '/agent', path: '/session.jsonl', name: 'Stored name' })
  },
  {
    name: 'events.respondToolApproval',
    method: 'toolApproval.result',
    params: { requestId: 'approval', result: null },
    resultIsPassedThrough: false,
    invoke: (engine) => engine.events.respondToolApproval('approval', undefined)
  },
  {
    name: 'models.snapshot',
    method: 'modelRuntime.snapshot',
    params: { agentDir: '/agent' },
    invoke: (engine) => engine.models.snapshot({ agentDir: '/agent' })
  },
  {
    name: 'models.login',
    method: 'modelRuntime.login',
    params: {
      agentDir: '/agent',
      providerId: 'provider',
      type: 'api_key',
      key: 'secret'
    },
    invoke: (engine) =>
      engine.models.login({
        agentDir: '/agent',
        providerId: 'provider',
        type: 'api_key',
        key: 'secret'
      })
  },
  {
    name: 'models.logout',
    method: 'modelRuntime.logout',
    params: { agentDir: '/agent', providerId: 'provider' },
    invoke: (engine) => engine.models.logout({ agentDir: '/agent', providerId: 'provider' })
  },
  {
    name: 'models.respondAuthPrompt',
    method: 'auth.promptResult',
    params: { requestId: 'auth-ok', value: 'value' },
    resultIsPassedThrough: false,
    invoke: (engine) => engine.models.respondAuthPrompt('auth-ok', 'value')
  },
  {
    name: 'models.rejectAuthPrompt',
    method: 'auth.promptResult',
    params: { requestId: 'auth-error', error: 'denied' },
    resultIsPassedThrough: false,
    invoke: (engine) => engine.models.rejectAuthPrompt('auth-error', new Error('denied'))
  },
  {
    name: 'resources.reload',
    method: 'resources.reload',
    params: { cwd: '/workspace', noThemes: true },
    invoke: (engine) => engine.resources.reload({ cwd: '/workspace', noThemes: true })
  },
  {
    name: 'mcp.configuredStdioTools',
    method: 'mcp.configuredStdioTools',
    params: { name: 'local', entry: { command: 'server' } },
    invoke: (engine) =>
      engine.mcp.configuredStdioTools({ name: 'local', entry: { command: 'server' } })
  },
  {
    name: 'mcp.cancelConfiguredStdioTools',
    method: 'mcp.cancelConfiguredStdioTools',
    params: { requestKey: 'probe' },
    invoke: (engine) => engine.mcp.cancelConfiguredStdioTools({ requestKey: 'probe' })
  },
  {
    name: 'mcp.featuredTools',
    method: 'mcp.featuredTools',
    params: { id: 'featured', url: 'https://example.test/mcp', auth: 'oauth' },
    invoke: (engine) =>
      engine.mcp.featuredTools({
        id: 'featured',
        url: 'https://example.test/mcp',
        auth: 'oauth'
      })
  },
  {
    name: 'mcp.syncFeaturedApiKeys',
    method: 'mcp.syncFeaturedApiKeys',
    params: { id: 'featured' },
    invoke: (engine) => engine.mcp.syncFeaturedApiKeys({ id: 'featured' })
  },
  {
    name: 'mcp.applyConnectorEnabled',
    method: 'mcp.applyConnectorEnabled',
    params: { name: 'connector' },
    invoke: (engine) => engine.mcp.applyConnectorEnabled({ name: 'connector' })
  },
  {
    name: 'mcp.prepareRemoteAuth',
    method: 'mcp.prepareRemoteAuth',
    params: { name: 'remote', attemptId: 'attempt' },
    invoke: (engine) => engine.mcp.prepareRemoteAuth({ name: 'remote', attemptId: 'attempt' })
  },
  {
    name: 'mcp.cancelRemoteAuth',
    method: 'mcp.cancelRemoteAuth',
    params: { name: 'remote', attemptId: 'attempt' },
    invoke: (engine) => engine.mcp.cancelRemoteAuth({ name: 'remote', attemptId: 'attempt' })
  },
  {
    name: 'mcp.authorizeRemote',
    method: 'mcp.authorizeRemote',
    params: {
      name: 'remote',
      attemptId: 'attempt',
      serverUrl: 'https://example.test/mcp'
    },
    invoke: (engine) =>
      engine.mcp.authorizeRemote({
        name: 'remote',
        attemptId: 'attempt',
        serverUrl: 'https://example.test/mcp'
      })
  },
  {
    name: 'mcp.featuredAuthStatus',
    method: 'mcp.featuredAuthStatus',
    params: { id: 'featured', url: 'https://example.test/mcp' },
    invoke: (engine) =>
      engine.mcp.featuredAuthStatus({ id: 'featured', url: 'https://example.test/mcp' })
  },
  {
    name: 'mcp.cancelFeaturedAuth',
    method: 'mcp.cancelFeaturedAuth',
    params: { id: 'featured' },
    invoke: (engine) => engine.mcp.cancelFeaturedAuth({ id: 'featured' })
  },
  {
    name: 'mcp.authorizeFeatured',
    method: 'mcp.authorizeFeatured',
    params: { id: 'featured', url: 'https://example.test/mcp' },
    invoke: (engine) =>
      engine.mcp.authorizeFeatured({ id: 'featured', url: 'https://example.test/mcp' })
  },
  {
    name: 'memory.read',
    method: 'memory.read',
    params: { agentDir: '/agent', cwd: '/workspace' },
    invoke: (engine) => engine.memory.read({ agentDir: '/agent', cwd: '/workspace' })
  },
  {
    name: 'memory.deleteLesson',
    method: 'memory.deleteLesson',
    params: { agentDir: '/agent', cwd: '/workspace', index: 2, text: 'lesson' },
    invoke: (engine) =>
      engine.memory.deleteLesson({
        agentDir: '/agent',
        cwd: '/workspace',
        index: 2,
        text: 'lesson'
      })
  },
  {
    name: 'memory.clear',
    method: 'memory.clear',
    params: { agentDir: '/agent', cwd: '/workspace' },
    invoke: (engine) => engine.memory.clear({ agentDir: '/agent', cwd: '/workspace' })
  },
  {
    name: 'settings.autoCompactionDefaults',
    method: 'settings.autoCompactionDefaults',
    params: { cwd: '/workspace', agentDir: '/agent' },
    invoke: (engine) =>
      engine.settings.autoCompactionDefaults({ cwd: '/workspace', agentDir: '/agent' })
  },
  {
    name: 'settings.webSearch.get',
    method: 'settings.webSearch.get',
    params: { agentDir: '/agent' },
    invoke: (engine) => engine.settings.webSearch.get({ agentDir: '/agent' })
  },
  {
    name: 'settings.webSearch.update',
    method: 'settings.webSearch.update',
    params: { agentDir: '/agent', patch: { orderedEnabledIds: [] } },
    invoke: (engine) =>
      engine.settings.webSearch.update({
        agentDir: '/agent',
        patch: { orderedEnabledIds: [] }
      })
  },
  {
    name: 'settings.webSearch.searxngEngines',
    method: 'settings.webSearch.searxngEngines',
    params: { agentDir: '/agent' },
    invoke: (engine) => engine.settings.webSearch.searxngEngines({ agentDir: '/agent' })
  },
  {
    name: 'settings.webSearch.setApiKey',
    method: 'settings.webSearch.apiKey.set',
    params: { agentDir: '/agent', providerId: 'exa', key: 'secret' },
    invoke: (engine) =>
      engine.settings.webSearch.setApiKey({
        agentDir: '/agent',
        providerId: 'exa',
        key: 'secret'
      })
  },
  {
    name: 'settings.webSearch.clearApiKey',
    method: 'settings.webSearch.apiKey.clear',
    params: { agentDir: '/agent', providerId: 'exa' },
    invoke: (engine) =>
      engine.settings.webSearch.clearApiKey({ agentDir: '/agent', providerId: 'exa' })
  },
  {
    name: 'agentRuns.list',
    method: 'agentRuns.list',
    params: {},
    invoke: (engine) => engine.agentRuns.list({})
  },
  {
    name: 'agentRuns.steer',
    method: 'agentRun.steer',
    params: { sessionId: 'session', runId: 'run', message: 'adjust' },
    invoke: (engine) =>
      engine.agentRuns.steer({ sessionId: 'session', runId: 'run', message: 'adjust' })
  },
  {
    name: 'agentRuns.stop',
    method: 'agentRun.stop',
    params: { sessionId: 'session', runId: 'run' },
    invoke: (engine) => engine.agentRuns.stop({ sessionId: 'session', runId: 'run' })
  },
  {
    name: 'shellJobs.list',
    method: 'shellJobs.list',
    params: {},
    invoke: (engine) => engine.shellJobs.list({})
  },
  {
    name: 'shellJobs.cancel',
    method: 'shellJobs.cancel',
    params: { sessionId: 'session', jobId: 'job' },
    invoke: (engine) => engine.shellJobs.cancel({ sessionId: 'session', jobId: 'job' })
  }
]

test('every PhiEngine worker method forwards the exact method and params', async () => {
  const recording = recordingBridge()
  const engine = createInProcessEngine(recording.bridge)
  try {
    for (const entry of requestCases) {
      const callIndex = recording.calls.length
      const result = await entry.invoke(engine)
      const call = recording.calls[callIndex]
      assert.equal(call.method, entry.method, entry.name)
      assert.deepEqual(call.params, entry.params, entry.name)
      if (entry.resultIsPassedThrough === false) assert.equal(result, undefined, entry.name)
      else assert.deepEqual(result, call.result, entry.name)
    }
  } finally {
    await engine.stop()
  }
})

test('non-request PhiEngine methods forward subscriptions, host handlers, presence, and stop', async () => {
  const recording = recordingBridge()
  const engine = createInProcessEngine(recording.bridge)
  await engine.sessions.create(createParams)
  assert.equal(engine.sessions.has(createParams.sessionId), true)

  const received: unknown[] = []
  const cleanups = [
    engine.events.onSessionEvent('session', (value) => received.push(['event', value])),
    engine.events.onSessionState('session', (value) => received.push(['state', value])),
    engine.events.onToolApproval('session', (value) => received.push(['approval', value])),
    engine.models.onAuthPrompt((value) => received.push(['authPrompt', value])),
    engine.models.onAuthNotify((value) => received.push(['authNotify', value]))
  ]
  recording.emit({
    type: 'event',
    event: 'sessionEvent',
    sessionId: 'session',
    payload: { type: 'fixture_event', value: 'event' }
  })
  // Invalid envelopes cannot enter a typed event subscription.
  recording.emit({ type: 'event', event: 'sessionEvent', sessionId: 'session', payload: 'invalid' })
  recording.emit({ type: 'event', event: 'sessionState', sessionId: 'session', payload: 'state' })
  recording.emit({
    type: 'event',
    event: 'toolApproval',
    sessionId: 'session',
    payload: { requestId: 'approval' }
  })
  recording.emit({
    type: 'event',
    event: 'authPrompt',
    requestId: 'auth',
    payload: { providerId: 'provider', prompt: { type: 'text' } }
  })
  recording.emit({
    type: 'event',
    event: 'authNotify',
    payload: { providerId: 'provider', event: { type: 'progress' } }
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(received, [
    ['event', { type: 'fixture_event', value: 'event' }],
    ['state', 'state'],
    ['approval', { requestId: 'approval' }],
    ['authPrompt', { requestId: 'auth', providerId: 'provider', prompt: { type: 'text' } }],
    ['authNotify', { providerId: 'provider', event: { type: 'progress' } }]
  ])
  cleanups.forEach((cleanup) => cleanup())

  const unregister = engine.host.register('host.echo', (params, context) => ({ params, context }))
  recording.emit({
    type: 'hostRequest',
    id: 'host-request',
    method: 'host.echo',
    params: { value: 1 },
    context: { originSessionId: 'session', agentRunId: 'run', forged: 'ignored' }
  })
  const deadline = Date.now() + 1000
  while (recording.hostResponses.length === 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.deepEqual(recording.hostResponses[0], {
    type: 'hostResponse',
    id: 'host-request',
    ok: true,
    result: {
      params: { value: 1 },
      context: { originSessionId: 'session', agentRunId: 'run' }
    }
  })
  unregister()

  await engine.stop()
  assert.equal(recording.child.killed, true)
})

test('decision facade validates answers and cancels its private worker job without stopping the worker', async () => {
  const recording = recordingBridge()
  const engine = createInProcessEngine(recording.bridge)
  const params = {
    agentDir: '/agent',
    sessionId: 'session',
    model: { providerId: 'provider', modelId: 'model' },
    request: {
      purpose: 'recovery' as const,
      context: 'A read was interrupted.',
      question: 'What next?',
      options: [
        { id: 'inspect', description: 'Inspect before retry' },
        { id: 'retry', description: 'Retry a safe read' }
      ]
    }
  }
  try {
    assert.deepEqual(
      await engine.decisions.evaluate(params),
      requestResult('decisions.evaluate', {})
    )
    const firstJob = (recording.calls[0].params as { jobId: string }).jobId
    assert.match(firstJob, /^[a-f0-9-]{36}$/)
    const controller = new AbortController()
    const pending = engine.decisions.evaluate(params, controller.signal)
    const rejected = assert.rejects(pending)
    controller.abort(new Error('Stopped this decision'))
    await rejected
    const dispatch = recording.calls.findLast((call) => call.method === 'decisions.evaluate')!
    const cancelled = recording.calls.find((call) => call.method === 'decisions.cancel')!
    assert.deepEqual(cancelled.params, { jobId: (dispatch.params as { jobId: string }).jobId })
    assert.notEqual((dispatch.params as { jobId: string }).jobId, firstJob)
    assert.equal(recording.child.killed, false)
    // The already queued late worker reply cannot poison another decision.
    assert.deepEqual(
      await engine.decisions.evaluate(params),
      requestResult('decisions.evaluate', {})
    )
  } finally {
    await engine.stop()
  }
})

test('worker dispatch matches the PhiEngine facade and private runtime service commands', () => {
  const workerSource = readFileSync(
    join(process.cwd(), 'src/main/agent/engine/in-process/main.ts'),
    'utf8'
  )
  const workerMethods = [...workerSource.matchAll(/case '([^']+)'/g)].map((match) => match[1])
  // Gateway leases belong to the desktop bridge, rather than the public session facade.
  // Their real worker lifecycle is exercised by the gateway/lease contract suites.
  const engineMethods = [
    ...requestCases.map((entry) => entry.method),
    'decisions.evaluate',
    'decisions.cancel',
    'modelGateway.create',
    'modelGateway.revoke',
    'mcp.desktopCreate',
    'mcp.desktopCall',
    'mcp.desktopCancel',
    'mcp.desktopClose',
    'memory.desktopCreate',
    'memory.desktopIngest',
    'memory.desktopLearn',
    'memory.desktopCancel',
    'memory.desktopClose'
  ]
  assert.deepEqual([...new Set(engineMethods)].sort(), [...new Set(workerMethods)].sort())
})

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : []
  })
}

test('sources outside the engine do not import omp-bridge', () => {
  const sourceRoot = join(process.cwd(), 'src')
  const engineRoot = join(sourceRoot, 'main/agent/engine')
  const violations = sourceFiles(sourceRoot)
    .filter((path) => !path.startsWith(`${engineRoot}/`))
    .filter((path) =>
      /(?:from\s*|import\s*\()(['"])[^'"\n]*omp-bridge\1/.test(readFileSync(path, 'utf8'))
    )
    .map((path) => relative(process.cwd(), path))
  assert.deepEqual(violations, [])
})
