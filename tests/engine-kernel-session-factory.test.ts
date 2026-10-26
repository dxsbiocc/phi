import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  KernelSessionFactory,
  jsonSafeResourceSnapshot,
  parseKernelEngineSwitch,
  type KernelSessionConnection
} from '../src/main/agent/engine/kernel-session-factory'
import { SessionRoutingEngine } from '../src/main/agent/engine/session-routing-engine'
import { sessionCreateParamsSchema } from '../src/shared/kernel-protocol'
import { discoverPhiAgents } from '../src/main/agent/agents/discovery'

import { FakeKernelClient, legacyEngine, params } from './helpers/kernelSessionFactoryFake'

test('kernel engine switch is captured from only the trusted documented values', () => {
  assert.equal(parseKernelEngineSwitch(undefined), 'off')
  assert.equal(parseKernelEngineSwitch('0'), 'off')
  assert.equal(parseKernelEngineSwitch('1'), 'both')
  assert.equal(parseKernelEngineSwitch('local'), 'local')
  assert.equal(parseKernelEngineSwitch('remote'), 'remote')
  assert.equal(parseKernelEngineSwitch('both'), 'both')
  assert.equal(parseKernelEngineSwitch('unexpected'), 'off')
})

test('trusted resource snapshots drop undefined recursively without changing the source', () => {
  const source = params('json-safe').phiAgents!
  const normalized = jsonSafeResourceSnapshot(source)
  assert.equal(JSON.stringify(normalized).includes('undefined'), false)
  assert.equal(
    Object.hasOwn((normalized as unknown as Array<Record<string, unknown>>)[0], 'environment'),
    false
  )
  assert.equal(Object.hasOwn(source[0], 'environment'), true)
})

test('the real bundled agent snapshot is JSON-safe and round-trips through session.create', () => {
  const agents = discoverPhiAgents({
    cwd: process.cwd(),
    agentDir: process.env.PI_CODING_AGENT_DIR!,
    bundledDir: resolve('resources/agents'),
    pluginAgentDirs: []
  }).agents
  assert.ok(agents.length > 0)
  const phiAgents = jsonSafeResourceSnapshot(agents)
  assert.doesNotThrow(() => JSON.stringify(phiAgents))
  assert.equal(
    sessionCreateParamsSchema.safeParse({
      cwd: process.cwd(),
      model: { provider: 'test', id: 'model' },
      resourceVersion: 'a'.repeat(64),
      sessionManager: { kind: 'persistent' },
      phiAgents
    }).success,
    true
  )
})

test('SessionRoutingEngine sends local sessions to one shared kernel and never prompts on subscription changes', async () => {
  const client = new FakeKernelClient()
  let launches = 0
  const connection: KernelSessionConnection = {
    client,
    greeting: {
      protocol: { major: 1, minor: 0 },
      kernel: { version: 'test', ompVersion: 'test' },
      kernelInstanceId: 'kernel-instance',
      controllerGeneration: 1,
      capabilities: [],
      lastSeq: 0,
      runtime: { home: '/home/test', agentDir: '/agent' }
    },
    close: async () => undefined
  }
  const factory = new KernelSessionFactory({
    mode: 'local',
    launchLocal: async () => {
      launches += 1
      return connection
    }
  })
  const engine = new SessionRoutingEngine(legacyEngine(), () => factory)
  await engine.sessions.create(params('one'))
  await engine.sessions.create(params('two'))
  assert.equal(launches, 1)

  const before = client.requests.length
  const detachOne = engine.events.onSessionEvent('one', () => undefined)
  detachOne()
  const detachTwo = engine.events.onSessionEvent('two', () => undefined)
  detachTwo()
  assert.equal(client.requests.length, before)
  assert.equal(client.requests.filter((request) => request.method === 'session.prompt').length, 0)
})

test('SessionRoutingEngine closes every routed session before stopping its kernel host', async () => {
  const client = new FakeKernelClient()
  let hostClosed = false
  const factory = new KernelSessionFactory({
    mode: 'local',
    launchLocal: async () => ({
      client,
      greeting: {
        protocol: { major: 1, minor: 0 },
        kernel: { version: 'test', ompVersion: 'test' },
        kernelInstanceId: 'kernel-instance',
        controllerGeneration: 1,
        capabilities: [],
        lastSeq: 0,
        runtime: { home: '/home/test', agentDir: '/agent' }
      },
      close: async () => {
        assert.deepEqual(
          client.requests
            .filter((request) => request.method === 'session.close')
            .map((request) => request.context.sessionId),
          ['kernel-1', 'kernel-2']
        )
        hostClosed = true
      }
    })
  })
  const engine = new SessionRoutingEngine(legacyEngine(), () => factory)
  await engine.sessions.create(params('stop-order-one'))
  await engine.sessions.create(params('stop-order-two'))

  await assert.doesNotReject(engine.stop())
  assert.equal(hostClosed, true)
})

test('approval emitted immediately after create is delivered and uses trusted session identity', async () => {
  const client = new FakeKernelClient()
  const factory = new KernelSessionFactory({
    mode: 'local',
    launchLocal: async () => ({
      client,
      greeting: {
        protocol: { major: 1, minor: 0 },
        kernel: { version: 'test', ompVersion: 'test' },
        kernelInstanceId: 'kernel-instance',
        controllerGeneration: 1,
        capabilities: [],
        lastSeq: 0,
        runtime: { home: '/home/test', agentDir: '/agent' }
      },
      close: async () => undefined
    })
  })
  const engine = new SessionRoutingEngine(legacyEngine(), () => factory)
  const approvals: unknown[] = []
  engine.events.onToolApproval('early', (approval) => approvals.push(approval))
  client.onCreate = (sessionId) =>
    client.emit({
      kind: 'event',
      seq: 1,
      type: 'approval.requested',
      sessionId,
      runId: 'run-early',
      payload: {
        approvalId: 'approval-early',
        toolCallId: 'tool-early',
        toolName: 'write',
        input: { path: '/project/a.txt' }
      }
    })
  await engine.sessions.create(params('early'))
  assert.deepEqual(approvals, [
    {
      requestId: 'approval-early',
      toolCallId: 'tool-early',
      toolName: 'write',
      input: { path: '/project/a.txt' }
    }
  ])
})

test('kernel approval responses preserve denial reasons and ignore a late answer after cancellation', async () => {
  const client = new FakeKernelClient()
  const factory = new KernelSessionFactory({
    mode: 'local',
    launchLocal: async () => ({
      client,
      greeting: {
        protocol: { major: 1, minor: 0 },
        kernel: { version: 'test', ompVersion: 'test' },
        kernelInstanceId: 'kernel-instance',
        controllerGeneration: 1,
        capabilities: [],
        lastSeq: 0,
        runtime: { home: '/home/test', agentDir: '/agent' }
      },
      close: async () => undefined
    })
  })
  const engine = new SessionRoutingEngine(legacyEngine(), () => factory)
  await engine.sessions.create(params('approval-contract'))
  client.emit({
    kind: 'event',
    seq: 1,
    type: 'approval.requested',
    sessionId: 'kernel-1',
    runId: 'run-approval',
    payload: {
      approvalId: 'approval-denied',
      toolCallId: 'tool-denied',
      toolName: 'write',
      input: { path: '/project/a.txt' }
    }
  })
  await engine.events.respondToolApproval('approval-denied', {
    block: true,
    reason: 'Contract user denied'
  })
  assert.deepEqual(client.requests.at(-1), {
    method: 'approval.respond',
    params: {
      approvalId: 'approval-denied',
      decision: 'denied',
      reason: 'Contract user denied'
    },
    context: { sessionId: 'kernel-1' }
  })

  client.emit({
    kind: 'event',
    seq: 2,
    type: 'approval.requested',
    sessionId: 'kernel-1',
    runId: 'run-approval',
    payload: {
      approvalId: 'approval-cancelled',
      toolCallId: 'tool-cancelled',
      toolName: 'write',
      input: { path: '/project/b.txt' }
    }
  })
  client.approvalResponseError = {
    code: 'CANCELLED',
    message: 'The approval request was cancelled.'
  }
  await engine.events.respondToolApproval('approval-cancelled', null)
})

test('routed sessions advertise and invoke the engine decision evaluator', async () => {
  const client = new FakeKernelClient()
  const legacy = legacyEngine()
  let evaluated: unknown
  legacy.decisions.evaluate = async (input) => {
    evaluated = input
    return {
      choice: 'suitable',
      source: 'model',
      model: { providerId: 'test', modelId: 'model' }
    }
  }
  const factory = new KernelSessionFactory({
    mode: 'local',
    launchLocal: async () => ({
      client,
      greeting: {
        protocol: { major: 1, minor: 0 },
        kernel: { version: 'test', ompVersion: 'test' },
        kernelInstanceId: 'kernel-instance',
        controllerGeneration: 1,
        capabilities: [],
        lastSeq: 0,
        runtime: { home: '/home/test', agentDir: '/agent' }
      },
      close: async () => undefined
    })
  })
  const engine = new SessionRoutingEngine(legacy, () => factory)
  assert.ok(factory.hostCapabilityNames().includes('decisions.evaluate'))
  await engine.sessions.create(params('decision-contract'))
  const decide = client.host.get('decisions.evaluate')
  assert.ok(decide)
  const request = {
    purpose: 'task_routing' as const,
    context: 'Agent: TestAgent',
    question: 'Is this specialist suitable?',
    options: [
      { id: 'suitable', description: 'Suitable' },
      { id: 'uncertain', description: 'Uncertain' }
    ]
  }
  assert.equal(
    (
      (await decide(
        {
          runtimeSessionId: 'kernel-1',
          model: { providerId: 'test', modelId: 'model' },
          request
        },
        { sessionId: 'kernel-1', signal: new AbortController().signal }
      )) as { choice?: unknown }
    ).choice,
    'suitable'
  )
  assert.deepEqual(evaluated, {
    agentDir: '/agent',
    sessionId: 'decision-contract',
    model: { providerId: 'test', modelId: 'model' },
    request
  })
})

test('persistent kernel history returns its journal path and reopens without model fallback', async () => {
  const client = new FakeKernelClient()
  const factory = new KernelSessionFactory({
    mode: 'local',
    launchLocal: async () => ({
      client,
      greeting: {
        protocol: { major: 1, minor: 0 },
        kernel: { version: 'test', ompVersion: 'test' },
        kernelInstanceId: 'kernel-instance',
        controllerGeneration: 1,
        capabilities: [],
        lastSeq: 0,
        runtime: { home: '/home/test', agentDir: '/agent' }
      },
      close: async () => undefined
    })
  })
  const engine = new SessionRoutingEngine(legacyEngine(), () => factory)
  const created = await engine.sessions.create(params('history-before'))
  const path = created.state.sessionFile
  assert.equal(path, '/agent/phi-kernel/sessions/kernel-1/journal.jsonl')
  await engine.sessions.dispose({ sessionId: 'history-before' })
  client.snapshotModel = undefined
  const restoredParams = params('history-after')
  restoredParams.model = {
    provider: 'test',
    id: 'replacement',
    name: 'Replacement',
    reasoning: false
  }
  restoredParams.sessionManager = { kind: 'open', cwd: '/project', path }
  const restored = await engine.sessions.create(restoredParams)
  assert.equal(restored.state.sessionFile, path)
  assert.equal(restored.state.model, undefined)
  assert.equal(client.requests.filter((request) => request.method === 'session.create').length, 1)
  const opened = client.requests.findLast((request) => request.method === 'session.open')
  assert.equal((opened?.params as { sessionId?: unknown }).sessionId, 'kernel-1')
  assert.deepEqual(opened?.context, {})
})

test('factory stop rebinds host capabilities before same-client persistent reopen', async () => {
  const client = new FakeKernelClient()
  let launches = 0
  let configurations = 0
  const factory = new KernelSessionFactory({
    mode: 'local',
    hostCapabilities: ['modelAccess.credentials'],
    configureClient: (configured) => {
      configurations += 1
      return configured.registerHostHandler('modelAccess.credentials', () => ({ credentials: [] }))
    },
    launchLocal: async (_params, context) => {
      launches += 1
      assert.ok(context.hostCapabilities.includes('modelAccess.credentials'))
      context.configureClient(client)
      return {
        client,
        greeting: {
          protocol: { major: 1, minor: 0 },
          kernel: { version: 'test', ompVersion: 'test' },
          kernelInstanceId: 'same-kernel-instance',
          controllerGeneration: launches,
          capabilities: [],
          lastSeq: 0,
          runtime: { home: '/home/test', agentDir: '/agent' }
        },
        configuredBeforeHello: true,
        close: async () => undefined
      }
    }
  })
  const first = await factory.create(params('same-client-before'), new AbortController().signal, {
    event: () => undefined,
    state: () => undefined
  })
  const path = first.state().sessionFile
  assert.ok(path)
  await first.dispose()
  await factory.stop()

  client.snapshotModel = undefined
  client.onOpen = async () => {
    const credentials = client.host.get('modelAccess.credentials')
    assert.ok(credentials, 'credential capability must be rebound before session.open')
    assert.deepEqual(
      await credentials({}, { sessionId: 'kernel-1', signal: new AbortController().signal }),
      { credentials: [] }
    )
  }
  const reopened = params('same-client-after')
  reopened.sessionManager = { kind: 'open', cwd: '/project', path }
  const second = await factory.create(reopened, new AbortController().signal, {
    event: () => undefined,
    state: () => undefined
  })
  assert.equal(second.state().model, undefined)
  assert.equal(launches, 2)
  assert.equal(configurations, 2)
})

test('kernel host handlers receive session identity from the protocol context, not request params', async () => {
  const client = new FakeKernelClient()
  const factory = new KernelSessionFactory({
    mode: 'local',
    launchLocal: async () => ({
      client,
      greeting: {
        protocol: { major: 1, minor: 0 },
        kernel: { version: 'test', ompVersion: 'test' },
        kernelInstanceId: 'kernel-instance',
        controllerGeneration: 1,
        capabilities: [],
        lastSeq: 0,
        runtime: { home: '/home/test', agentDir: '/agent' }
      },
      close: async () => undefined
    })
  })
  let contextSessionId: string | undefined
  factory.registerHostHandler('notebookTool.execute', (_params, context) => {
    contextSessionId = context.originSessionId
    return { summary: 'ok', cells: [] }
  })
  await factory.create(params('host-context'), new AbortController().signal, {
    event: () => undefined,
    state: () => undefined,
    approval: () => undefined
  })
  const handler = client.host.get('notebookTool.execute')
  assert.ok(handler)
  await handler(
    { runtimeSessionId: 'forged', cwd: '/project', params: { path: 'demo.ipynb' } },
    { sessionId: 'kernel-1', signal: new AbortController().signal }
  )
  assert.equal(contextSessionId, 'host-context')
})

test('a host capability registered after launch binds now and is advertised on the next hello', async () => {
  const client = new FakeKernelClient()
  const factory = new KernelSessionFactory({
    mode: 'local',
    launchLocal: async () => ({
      client,
      greeting: {
        protocol: { major: 1, minor: 0 },
        kernel: { version: 'test', ompVersion: 'test' },
        kernelInstanceId: 'kernel-instance',
        controllerGeneration: 1,
        capabilities: [],
        lastSeq: 0,
        runtime: { home: '/home/test', agentDir: '/agent' }
      },
      close: async () => undefined
    })
  })
  await factory.create(params('late-host'), new AbortController().signal, {
    event: () => undefined,
    state: () => undefined
  })
  assert.equal(client.host.has('browser.cancel'), false)
  const remove = factory.registerHostHandler('browser.cancel', () => null)
  assert.equal(client.host.has('browser.cancel'), true)
  assert.ok(factory.hostCapabilityNames().includes('browser.cancel'))
  remove()
  assert.equal(client.host.has('browser.cancel'), false)
})

test('concurrent session.create calls cannot cross-wire trusted host identity', async () => {
  const client = new FakeKernelClient()
  client.asyncCreate = true
  const factory = new KernelSessionFactory({
    mode: 'local',
    launchLocal: async () => ({
      client,
      greeting: {
        protocol: { major: 1, minor: 0 },
        kernel: { version: 'test', ompVersion: 'test' },
        kernelInstanceId: 'kernel-instance',
        controllerGeneration: 1,
        capabilities: [],
        lastSeq: 0,
        runtime: { home: '/home/test', agentDir: '/agent' }
      },
      close: async () => undefined
    })
  })
  const identities: string[] = []
  factory.registerHostHandler('notebookTool.execute', (_params, context) => {
    identities.push(String(context.originSessionId))
    return { summary: 'ok', cells: [] }
  })
  client.onCreate = (kernelSessionId) => {
    void client.host.get('notebookTool.execute')?.(
      { runtimeSessionId: kernelSessionId, cwd: '/project', params: {} },
      { sessionId: kernelSessionId, signal: new AbortController().signal }
    )
  }
  const sink = { event: () => undefined, state: () => undefined }
  await Promise.all([
    factory.create(params('concurrent-a'), new AbortController().signal, sink),
    factory.create(params('concurrent-b'), new AbortController().signal, sink)
  ])
  assert.deepEqual(identities, ['concurrent-a', 'concurrent-b'])
})
