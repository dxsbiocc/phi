import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentRunRegistry } from '../src/main/agent/agents/registry'
import { buildAgentRunTools } from '../src/main/agent/agents/run-tools'
import { AGENT_RUN_HOST_METHODS } from '../src/main/agent/agents/run-host'
import { HostServiceRegistry } from '../src/main/agent/engine/host-service-registry'
import { createFacadeAgentRunTools } from '../src/main/agent/engine/rpc/facade-agent-run-tools'
import type { RpcChildRunSnapshot } from '../src/main/agent/engine/rpc/subagents/types'
import type { PhiTool } from '../src/main/agent/engine/types'

function gate(): { promise: Promise<void>; release(): void } {
  let release!: () => void
  return {
    promise: new Promise((resolve) => {
      release = resolve
    }),
    release: () => release()
  }
}
function child(id: string, status: RpcChildRunSnapshot['status'] = 'running'): RpcChildRunSnapshot {
  return {
    id,
    phiSessionId: 'phi',
    projectId: 'project',
    generation: 1,
    parentRunId: 'parent',
    parentToolCallId: 'call',
    nativeId: 'native-' + id,
    childSessionFile: '/server/root/' + id + '.jsonl',
    agent: 'Checker',
    background: true,
    status,
    verified: true,
    startedAt: 100,
    ...(status === 'running' ? {} : { completedAt: 200 })
  }
}
function fixture(): {
  tools: PhiTool[]
  calls: Array<{ operation: string; id: string; signal?: AbortSignal }>
  records: Map<string, RpcChildRunSnapshot>
  invoke(
    name: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): ReturnType<PhiTool['execute']>
  finished: ReturnType<typeof gate>
  entered: ReturnType<typeof gate>
  reports(): number
  retire(): void
  failDelivery(id: string): void
} {
  const records = new Map([
    ['live', child('live')],
    ['done', child('done', 'completed')]
  ])
  const host = new HostServiceRegistry(),
    finished = gate(),
    entered = gate()
  const calls: Array<{ operation: string; id: string; signal?: AbortSignal }> = []
  let active = true,
    reports = 0
  const failedDeliveries = new Set<string>()
  host.register(AGENT_RUN_HOST_METHODS.reported, (params, context) => {
    const value = params as { originSessionId: string; runId: string }
    assert.equal(value.originSessionId, 'runtime')
    assert.ok(records.has(value.runId))
    assert.equal(context.originSessionId, 'runtime')
    assert.equal(context.agentRunId, value.runId)
    reports++
    return { ok: true }
  })
  const tools = createFacadeAgentRunTools({
    runtimeSessionId: 'runtime',
    phiSessionId: 'phi',
    projectId: 'project',
    host,
    assertCurrent: () => {
      if (!active) throw new Error('private-generation-error')
    },
    list: () => [...records.values()],
    wait: async (options) => {
      calls.push({ operation: 'wait', id: options.ids?.join(',') ?? '', signal: options.signal })
      return { runs: (options.ids ?? ['live']).map((id) => records.get(id)!), timedOut: true }
    },
    steer: async (id, _message, signal) => {
      calls.push({ operation: 'steer', id, signal })
    },
    stop: async (id, signal) => {
      calls.push({ operation: 'stop', id, signal })
      const next = { ...records.get(id)!, status: 'aborted' as const, completedAt: 201 }
      records.set(id, next)
      return next
    },
    readChildReport: async () =>
      '<phi_agent_result>{"status":"partial","missingInputs":["dataset"],"nextAgent":"Checker"}</phi_agent_result>Verified report',
    waitCompletionDelivery: async (id) => {
      if (failedDeliveries.has(id)) throw new Error('private-finished-delivery-secret')
      if (id === 'done') {
        entered.release()
        await finished.promise
      }
    }
  })
  const invoke = (
    name: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): ReturnType<PhiTool['execute']> => {
    const tool = tools.find((entry) => entry.name === name)!
    return tool.execute(
      'control-call',
      params,
      undefined,
      { cwd: '/server', recentUserImages: () => [] },
      signal
    )
  }
  return {
    tools,
    calls,
    records,
    invoke,
    finished,
    entered,
    reports: () => reports,
    retire: () => {
      active = false
    },
    failDelivery: (id) => {
      failedDeliveries.add(id)
    }
  }
}

test('remote run tools retain the original schemas/descriptions and become host-only tools', () => {
  const local = buildAgentRunTools(new AgentRunRegistry()),
    remote = fixture().tools
  const metadata = (tool: PhiTool): Omit<PhiTool, 'execute'> => ({
    name: tool.name,
    label: tool.label,
    site: tool.site,
    description: tool.description,
    parameters: tool.parameters,
    loadMode: tool.loadMode,
    approval: tool.approval
  })
  assert.deepEqual(
    remote.map(metadata),
    local.map((tool) => metadata({ ...tool, site: 'host' }))
  )
})

test('one failed completion delivery neither marks that outcome nor blocks a different child report', async () => {
  const f = fixture()
  f.records.set('other-done', child('other-done', 'completed'))
  f.failDelivery('done')
  await assert.rejects(
    f.invoke('agent_status', { id: 'done' }),
    (error: unknown) =>
      error instanceof Error && /专家/.test(error.message) && !error.message.includes('private-')
  )
  assert.equal(f.reports(), 0)
  const peer = await f.invoke('agent_status', { id: 'other-done' })
  assert.equal(peer.isError, undefined)
  assert.equal(f.reports(), 1)
})

test('terminal status waits for finished delivery before exactly-once reported acknowledgement', async () => {
  const f = fixture()
  const first = f.invoke('agent_status', { id: 'done' })
  const second = f.invoke('agent_status', { id: 'done' })
  await f.entered.promise
  assert.equal(f.reports(), 0)
  f.finished.release()
  const results = await Promise.all([first, second])
  assert.equal(f.reports(), 1)
  for (const result of results) {
    assert.match(JSON.stringify(result.content), /Verified report/)
    assert.match(JSON.stringify(result.content), /outcome: partial/)
    assert.match(JSON.stringify(result.content), /missing: dataset/)
  }
  await f.invoke('agent_status', { id: 'done' })
  assert.equal(f.reports(), 1)
})

test('peer ids are rejected before wait/steer/stop and cancelled completion cannot mark reported', async () => {
  const f = fixture()
  for (const [name, params] of [
    ['agent_stop', { id: 'peer' }],
    ['agent_steer', { id: 'peer', message: 'x' }],
    ['agent_wait', { ids: ['peer'] }]
  ] as const) {
    const result = await f.invoke(name, params)
    assert.equal(result.isError, true)
  }
  assert.deepEqual(f.calls, [])
  const controller = new AbortController()
  const pending = f.invoke('agent_status', { id: 'done' }, controller.signal)
  await f.entered.promise
  controller.abort(new Error('private-cancel-secret'))
  await assert.rejects(pending, /专家/)
  f.finished.release()
  assert.equal(f.reports(), 0)
})

test('wait/steer/stop carry the exact host-call signal and do not affect another child', async () => {
  const f = fixture(),
    controller = new AbortController()
  const untouched = f.records.get('done')
  await f.invoke('agent_steer', { id: 'live', message: 'refine the check' }, controller.signal)
  await f.invoke('agent_wait', { ids: ['live'], timeout_seconds: 1 }, controller.signal)
  await f.invoke('agent_stop', { id: 'live' }, controller.signal)
  assert.deepEqual(
    f.calls.map(({ operation, id, signal }) => ({
      operation,
      id,
      sameSignal: signal === controller.signal
    })),
    [
      { operation: 'steer', id: 'live', sameSignal: true },
      { operation: 'wait', id: 'live', sameSignal: true },
      { operation: 'stop', id: 'live', sameSignal: true }
    ]
  )
  assert.deepEqual(f.records.get('done'), untouched)
  assert.equal(f.reports(), 0)
  f.retire()
  await assert.rejects(f.invoke('agent_status', {}), /专家/)
})

test('native task ids resolve only within the live list and normalize reporting to the private run id', async () => {
  const f = fixture()
  const status = f.invoke('agent_status', { id: 'native-done' })
  const same = f.invoke('agent_status', { id: 'done' })
  await f.entered.promise
  f.finished.release()
  await Promise.all([status, same])
  assert.equal(f.reports(), 1)
  await f.invoke('agent_steer', { id: 'native-live', message: 'continue precisely' })
  await f.invoke('agent_wait', { ids: ['native-live', 'live'], timeout_seconds: 1 })
  await f.invoke('agent_stop', { id: 'native-live' })
  assert.deepEqual(
    f.calls.map(({ operation, id }) => ({ operation, id })),
    [
      { operation: 'steer', id: 'live' },
      { operation: 'wait', id: 'live' },
      { operation: 'stop', id: 'live' }
    ]
  )
  const peer = await f.invoke('agent_steer', { id: 'native-peer', message: 'blocked' })
  assert.equal(peer.isError, true)
  assert.equal(f.calls.length, 3)
})
