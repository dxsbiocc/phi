import assert from 'node:assert/strict'
import test from 'node:test'
import { AGENT_RUN_HOST_METHODS, agentRunHostHandlers } from '../src/main/agent/agents/run-host'
import type { OmpBridge } from '../src/main/agent/engine/omp-bridge'
import type { RemoteSessionRuntime } from '../src/main/agent/engine/rpc/remote-session-runtime'
import { deliverFacadeChildCompletion } from '../src/main/agent/engine/rpc/facade-child-completion'
import type { RpcChildRunSnapshot } from '../src/main/agent/engine/rpc/subagents/types'
import { createAgentRunCompletions } from '../src/main/agent/plan/execution/agent-run-completions'
import { createEngineStepRunner } from '../src/main/agent/plan/execution/engine-step-runner'
import { createPlanExecutor } from '../src/main/agent/plan/execution/plan-executor'

const DECLARED_REPORT =
  '<phi_agent_result>{"status":"completed","missingInputs":[]}</phi_agent_result>\nFinished plan step'

test('verified remote child completion reaches the originating plan run', async () => {
  const delivered: unknown[][] = []
  const snapshot = {
    id: 'child-run',
    agent: 'PlanStep',
    status: 'completed',
    parentToolCallId: 'persisted-request-id',
    startedAt: 10,
    completedAt: 20
  } as RpcChildRunSnapshot
  const runtime = {
    readChildReport: async () => DECLARED_REPORT
  } as unknown as RemoteSessionRuntime
  const hostServices = {
    invoke: async (...args: unknown[]) => {
      delivered.push(args)
    }
  } as unknown as OmpBridge['hostServices']
  await deliverFacadeChildCompletion({
    snapshot,
    runtime: () => runtime,
    unavailable: () => false,
    isCurrent: () => true,
    task: 'Complete plan step',
    originSessionId: 'runtime-session-a',
    hostServices
  })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0][0], AGENT_RUN_HOST_METHODS.finished)
  assert.deepEqual(delivered[0][1], {
    originSessionId: 'runtime-session-a',
    run: {
      id: 'child-run',
      agent: 'PlanStep',
      state: 'done',
      task: 'Complete plan step',
      origin: 'host',
      background: true,
      startedAt: 10,
      completedAt: 20,
      toolCallId: 'persisted-request-id',
      report: DECLARED_REPORT,
      reportStatus: 'completed',
      missingInputs: []
    }
  })
  assert.deepEqual(delivered[0][2], {
    originSessionId: 'runtime-session-a',
    agentRunId: 'child-run'
  })
})

test('a plan step report without result metadata is not delivered as completed', async () => {
  const delivered: Array<{ run: { reportStatus?: string; state: string } }> = []
  const runtime = {
    readChildReport: async () => 'The glob result does not meet the listing criterion.'
  } as unknown as RemoteSessionRuntime
  await deliverFacadeChildCompletion({
    snapshot: {
      id: 'prose-run',
      agent: 'PlanStep',
      status: 'completed',
      startedAt: 10,
      completedAt: 20
    } as RpcChildRunSnapshot,
    runtime: () => runtime,
    unavailable: () => false,
    isCurrent: () => true,
    task: 'List top-level entries',
    originSessionId: 'runtime-session-a',
    hostServices: {
      invoke: async (_method: unknown, params: (typeof delivered)[number]) => {
        delivered.push(params)
      }
    } as unknown as OmpBridge['hostServices']
  })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].run.state, 'done')
  assert.equal(delivered[0].run.reportStatus, 'partial')
})

test('a report read finishing after runtime rotation cannot deliver the old child', async () => {
  let finishRead!: (value: string) => void
  const read = new Promise<string>((resolve) => {
    finishRead = resolve
  })
  let current = true
  const delivered: unknown[] = []
  const runtime = { readChildReport: () => read } as unknown as RemoteSessionRuntime
  const hostServices = {
    invoke: async (value: unknown) => {
      delivered.push(value)
    }
  } as unknown as OmpBridge['hostServices']
  const pending = deliverFacadeChildCompletion({
    snapshot: {
      id: 'old-child',
      agent: 'PlanStep',
      status: 'completed',
      parentToolCallId: 'old-request',
      startedAt: 10,
      completedAt: 20
    } as RpcChildRunSnapshot,
    runtime: () => runtime,
    unavailable: () => false,
    isCurrent: () => current,
    task: 'Old plan step',
    originSessionId: 'runtime-session-a',
    hostServices
  })
  current = false
  finishRead('Stale report')
  await pending
  assert.deepEqual(delivered, [])
})

test('malformed structured report cannot become a successful host step', async () => {
  const delivered: unknown[][] = []
  const runtime = {
    readChildReport: async () => '<phi_agent_result>{broken}</phi_agent_result>'
  } as unknown as RemoteSessionRuntime
  await deliverFacadeChildCompletion({
    snapshot: {
      id: 'malformed-child',
      agent: 'PlanStep',
      status: 'completed',
      parentToolCallId: 'request-a',
      startedAt: 10,
      completedAt: 20
    } as RpcChildRunSnapshot,
    runtime: () => runtime,
    unavailable: () => false,
    isCurrent: () => true,
    task: 'Complete plan step',
    originSessionId: 'runtime-session-a',
    hostServices: {
      invoke: async (...args: unknown[]) => {
        delivered.push(args)
      }
    } as unknown as OmpBridge['hostServices']
  })
  assert.equal((delivered[0][1] as { run: { state: string } }).run.state, 'error')
})

test('missing report fails the host plan step and leaves its dependent unlaunched', async () => {
  const completions = createAgentRunCompletions()
  const handlers = agentRunHostHandlers({
    resolveSession: () => undefined,
    appendToSession: () => {
      throw new Error('Host plan completions must stay off chat timeline')
    },
    sendToWindow: () => undefined,
    isAppFocused: () => true,
    showOsNotification: () => undefined,
    redact: (value) => value,
    persistStepOutput: () => null,
    redactValue: (value) => value,
    markReported: () => undefined,
    clearReported: () => undefined,
    deliverHostRun: (sessionId, run) => completions.deliver(sessionId, run)
  })
  const hostServices = {
    invoke: async (method: string, params: unknown) => handlers[method]!(params)
  } as unknown as OmpBridge['hostServices']
  const starts: string[] = []
  const runner = createEngineStepRunner({
    engine: {
      agentRuns: {
        start: async ({ task }) => {
          starts.push(task)
          return { runId: `child-${starts.length}` }
        },
        stop: async () => undefined
      }
    },
    completions,
    resolveRuntimeSessionId: () => 'runtime-session-a'
  })
  const executor = createPlanExecutor({
    runner,
    store: { write: () => undefined },
    events: { emit: () => undefined },
    clock: () => new Date().toISOString(),
    ids: () => 'plan-a'
  })
  await executor.start(
    {
      version: 1,
      goal: 'Complete a dependent plan',
      steps: [
        {
          id: 'first',
          title: 'First',
          instructions: 'Do first',
          acceptance: 'Verify first',
          dependsOn: [],
          access: 'read'
        },
        {
          id: 'second',
          title: 'Second',
          instructions: 'Do second',
          acceptance: 'Verify second',
          dependsOn: ['first'],
          access: 'read'
        }
      ]
    },
    'phi-a'
  )
  assert.equal(starts.length, 1)
  const missingRuntime = {
    readChildReport: async () => ''
  } as unknown as RemoteSessionRuntime
  const deliverMissingReport = (id: string): Promise<void> =>
    deliverFacadeChildCompletion({
      snapshot: {
        id,
        agent: 'PlanStep',
        status: 'completed',
        parentToolCallId: 'persisted-request-id',
        startedAt: 10,
        completedAt: 20
      } as RpcChildRunSnapshot,
      runtime: () => missingRuntime,
      unavailable: () => false,
      isCurrent: () => true,
      task: 'Do first',
      originSessionId: 'runtime-session-a',
      hostServices
    })
  await deliverMissingReport('child-1')
  for (let attempt = 0; attempt < 20 && starts.length < 2; attempt++)
    await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(starts.length, 2, 'the failed step may retry once')
  await deliverMissingReport('child-2')
  for (
    let attempt = 0;
    attempt < 20 && executor.get('plan-a')?.steps.first.status !== 'failed';
    attempt++
  )
    await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(executor.get('plan-a')?.steps.first.status, 'failed')
  assert.equal(executor.get('plan-a')?.steps.second.status, 'pending')
  assert.equal(starts.length, 2, 'the dependent step must not launch')
})
