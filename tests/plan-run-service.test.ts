import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentRunCompletion } from '../src/main/agent/plan/execution/agent-run-completions'
import { createPlanRunState, reducePlanRun } from '../src/main/agent/plan/model/plan-run-state'
import { createPlanRunService } from '../src/main/agent/plan/plan-run-service'
import type {
  PlanRunFinishedEvent,
  PlanRunState,
  PlanRunTimelineSnapshot,
  PlanSpec
} from '../src/shared/planRunTypes'

const spec: PlanSpec = {
  version: 1,
  goal: 'Recover and control a plan',
  steps: [
    {
      id: 'step-a',
      title: 'Step A',
      instructions: 'Do A',
      acceptance: 'A is done',
      dependsOn: [],
      access: 'read'
    }
  ]
}

function runningState(): PlanRunState {
  return reducePlanRun(
    createPlanRunState({
      id: 'plan-recover',
      sessionId: 'phi-1',
      spec,
      now: '2026-10-23T00:00:00.000Z'
    }),
    {
      type: 'step_launched',
      stepId: 'step-a',
      agentRunId: 'agent-old',
      at: '2026-10-23T00:00:01.000Z'
    }
  )
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.fail('Timed out waiting for plan execution')
}

test('active-work query catches running plans and running steps in paused plans', () => {
  const running = runningState()
  const pausedWithRunningStep = reducePlanRun(running, {
    type: 'pause',
    at: '2026-10-23T00:00:02.000Z'
  })
  const states = [pausedWithRunningStep]
  const service = createPlanRunService({
    engine: {
      agentRuns: {
        start: async () => ({ runId: 'unused' }),
        stop: async () => undefined
      }
    },
    resolveRuntimeSessionId: () => null,
    store: {
      write: () => undefined,
      read: () => null,
      list: () => states,
      listUnfinished: () => states
    },
    timeline: { append: (_sessionId, event) => event, broadcast: () => undefined },
    continueConversation: () => undefined,
    logError: (error) => assert.fail(String(error))
  })

  assert.equal(service.hasActiveWork('phi-1'), true)
  states[0] = {
    ...pausedWithRunningStep,
    steps: { 'step-a': { status: 'interrupted', attempts: 1 } }
  }
  assert.equal(service.hasActiveWork('phi-1'), false)
})

test('list recovers unfinished runs once and persists interrupted state', async () => {
  const paused = reducePlanRun(
    createPlanRunState({
      id: 'plan-paused',
      sessionId: 'phi-1',
      spec,
      now: '2026-10-23T00:00:00.000Z'
    }),
    { type: 'pause', at: '2026-10-23T00:00:01.000Z' }
  )
  const states = new Map([
    ['plan-recover', runningState()],
    ['plan-paused', paused]
  ])
  const timeline: string[] = []
  let unfinishedReads = 0
  const service = createPlanRunService({
    engine: {
      agentRuns: {
        start: async () => ({ runId: 'unused' }),
        stop: async () => undefined
      }
    },
    resolveRuntimeSessionId: () => null,
    store: {
      write: (state) => {
        states.set(state.id, state)
      },
      read: (_sessionId, runId) => states.get(runId) ?? null,
      list: () => [...states.values()],
      listUnfinished: () => {
        unfinishedReads += 1
        return [...states.values()].filter(
          (state) => state.status === 'running' || state.status === 'paused'
        )
      }
    },
    timeline: {
      append: (_sessionId, event) => {
        timeline.push(event.type)
        return event
      },
      broadcast: () => undefined
    },
    continueConversation: () => assert.fail('recovery must not wake the conversation'),
    logError: (error) => assert.fail(String(error)),
    clock: () => '2026-10-23T00:00:02.000Z',
    ids: () => 'unused'
  })

  const [first, second] = await Promise.all([service.list('phi-1'), service.list('phi-1')])
  assert.equal(first[0]?.status, 'paused')
  assert.equal(first[0]?.steps['step-a']?.status, 'interrupted')
  assert.deepEqual(second, first)
  assert.equal(unfinishedReads, 1)
  assert.equal(first.find((state) => state.id === 'plan-paused')?.status, 'paused')
  assert.deepEqual(timeline, ['plan_run_updated'])
})

test('stopping a running plan never emits a finish wake-up', async () => {
  const states = new Map<string, PlanRunState>()
  const stopped: string[] = []
  let wakes = 0
  const service = createPlanRunService({
    engine: {
      agentRuns: {
        start: async () => ({ runId: 'agent-1' }),
        stop: async ({ runId }) => {
          stopped.push(runId)
        }
      }
    },
    completions: {
      expect: async () => new Promise(() => undefined),
      deliver: () => false,
      abandonSession: () => undefined
    },
    resolveRuntimeSessionId: () => 'runtime-1',
    store: {
      write: (state) => {
        states.set(state.id, state)
      },
      read: (_sessionId, runId) => states.get(runId) ?? null,
      list: () => [...states.values()],
      listUnfinished: () => []
    },
    timeline: { append: (_sessionId, event) => event, broadcast: () => undefined },
    continueConversation: () => {
      wakes += 1
    },
    logError: (error) => assert.fail(String(error)),
    clock: () => '2026-10-23T00:00:00.000Z',
    ids: () => 'plan-stop'
  })

  await service.startFromApprovedPlan('phi-1', spec)
  const stoppedState = await service.stop('phi-1', 'plan-stop')
  assert.equal(stoppedState.status, 'stopped')
  assert.deepEqual(stopped, ['agent-1', 'agent-1'])
  assert.equal(wakes, 0)
})

test('timeline events use bounded snapshots while continuation keeps the full state', async () => {
  const largeSpec: PlanSpec = {
    version: 1,
    goal: `Summarize ${'goal'.repeat(200)}`,
    steps: Array.from({ length: 20 }, (_, index) => ({
      id: `step-${index + 1}`,
      title: `Step ${index + 1}`,
      instructions: `Do not persist this instruction ${index + 1}`,
      acceptance: `Do not persist this acceptance ${index + 1}`,
      dependsOn: [],
      access: 'read' as const
    }))
  }
  const states = new Map<string, PlanRunState>()
  const timeline: Array<Record<string, unknown>> = []
  const waiters = new Map<string, (value: { id: string; state: 'done'; report: string }) => void>()
  const wakes: PlanRunFinishedEvent[] = []
  let runSequence = 0
  const service = createPlanRunService({
    engine: {
      agentRuns: {
        start: async () => ({ runId: `agent-${++runSequence}` }),
        stop: async () => undefined
      }
    },
    completions: {
      expect: (_runtimeSessionId, runId) =>
        new Promise((resolve) => {
          waiters.set(runId, resolve)
        }),
      deliver: () => false,
      abandonSession: () => undefined
    },
    resolveRuntimeSessionId: () => 'runtime-1',
    store: {
      write: (state) => {
        states.set(state.id, state)
      },
      read: (_sessionId, runId) => states.get(runId) ?? null,
      list: () => [...states.values()],
      listUnfinished: () => []
    },
    timeline: {
      append: (_sessionId, event) => {
        timeline.push(event)
        return event
      },
      broadcast: () => undefined
    },
    continueConversation: (_sessionId, event) => wakes.push(event),
    logError: (error) => assert.fail(String(error)),
    clock: () => '2026-10-23T00:00:00.000Z',
    ids: () => 'plan-large'
  })

  await service.startFromApprovedPlan('phi-1', largeSpec)
  while (runSequence < largeSpec.steps.length) {
    const next = [...waiters.entries()][0]
    assert.ok(next)
    waiters.delete(next[0])
    next[1]({ id: next[0], state: 'done', report: 'x'.repeat(8 * 1024) })
    await until(() => waiters.size > 0 || runSequence === largeSpec.steps.length)
  }
  for (const [runId, resolve] of [...waiters]) {
    waiters.delete(runId)
    resolve({ id: runId, state: 'done', report: 'x'.repeat(8 * 1024) })
  }
  await until(() => wakes.length === 1)

  const planEvents = timeline.filter(
    (event) => typeof event.type === 'string' && event.type.startsWith('plan_run_')
  )
  assert.ok(planEvents.length > 0)
  assert.ok(
    planEvents.every((event) => Buffer.byteLength(JSON.stringify(event), 'utf8') <= 16 * 1024)
  )
  const snapshot = planEvents.at(-1)?.state as PlanRunTimelineSnapshot
  assert.equal(snapshot.goal.length, 500)
  assert.equal(snapshot.steps.length, 20)
  assert.equal(snapshot.steps[0]?.reportStatus, 'completed')
  assert.deepEqual(snapshot.steps[0]?.missingInputs, [])
  assert.equal('spec' in snapshot, false)
  assert.equal('sessionId' in snapshot, false)
  assert.equal('report' in (snapshot.steps[0] ?? {}), false)
  assert.equal(JSON.stringify(snapshot).includes('Do not persist this instruction'), false)
  assert.equal(JSON.stringify(snapshot).includes('Do not persist this acceptance'), false)
  assert.equal(JSON.stringify(snapshot).includes('x'.repeat(8 * 1024)), false)
  assert.equal(wakes[0]?.state.steps['step-1']?.report?.text.length, 8 * 1024)
})

test('later steps never fall back to a disposed runtime session', async () => {
  const dependentSpec: PlanSpec = {
    version: 1,
    goal: 'Do two dependent steps',
    steps: [
      { ...spec.steps[0]!, dependsOn: [] },
      {
        id: 'step-b',
        title: 'Step B',
        instructions: 'Do B',
        acceptance: 'B is done',
        dependsOn: ['step-a'],
        access: 'read'
      }
    ]
  }
  const states = new Map<string, PlanRunState>()
  const startedIn: string[] = []
  let runtimeSessionId: string | null = 'runtime-1'
  let finishFirst: ((value: AgentRunCompletion) => void) | undefined
  const service = createPlanRunService({
    engine: {
      agentRuns: {
        start: async ({ sessionId }) => {
          startedIn.push(sessionId)
          return { runId: 'agent-1' }
        },
        stop: async () => undefined
      }
    },
    completions: {
      expect: () =>
        new Promise((resolve) => {
          finishFirst = resolve
        }),
      deliver: () => false,
      abandonSession: () => undefined
    },
    resolveRuntimeSessionId: () => runtimeSessionId,
    store: {
      write: (state) => {
        states.set(state.id, state)
      },
      read: (_sessionId, runId) => states.get(runId) ?? null,
      list: () => [...states.values()],
      listUnfinished: () => []
    },
    timeline: { append: (_sessionId, event) => event, broadcast: () => undefined },
    continueConversation: () => assert.fail('a failed step must not finish the plan'),
    logError: (error) => assert.fail(String(error)),
    clock: () => '2026-10-23T00:00:00.000Z',
    ids: () => 'plan-runtime'
  })

  await service.startFromApprovedPlan('phi-1', dependentSpec)
  runtimeSessionId = null
  assert.ok(finishFirst)
  finishFirst({ id: 'agent-1', state: 'done', origin: 'host', report: 'A done' })
  await until(() => states.get('plan-runtime')?.status === 'paused')

  const state = states.get('plan-runtime')
  assert.deepEqual(startedIn, ['runtime-1'])
  assert.equal(state?.steps['step-b']?.status, 'failed')
  assert.equal(
    state?.steps['step-b']?.error,
    'The conversation runtime is not running; open the conversation to continue the plan.'
  )
})

test('start fails clearly when the conversation runtime is not alive', async () => {
  let starts = 0
  const service = createPlanRunService({
    engine: {
      agentRuns: {
        start: async () => {
          starts += 1
          return { runId: 'unused' }
        },
        stop: async () => undefined
      }
    },
    resolveRuntimeSessionId: () => null,
    store: {
      write: () => undefined,
      read: () => null,
      list: () => [],
      listUnfinished: () => []
    },
    timeline: { append: (_sessionId, event) => event, broadcast: () => undefined },
    continueConversation: () => undefined,
    logError: (error) => assert.fail(String(error))
  })

  await assert.rejects(
    service.startFromApprovedPlan('phi-1', spec),
    /The conversation runtime is not running; open the conversation to continue the plan\./
  )
  assert.equal(starts, 0)
})

test('stop uses the runtime captured by the running step after disposal', async () => {
  const states = new Map<string, PlanRunState>()
  const stoppedIn: string[] = []
  const timelineTypes: string[] = []
  let runtimeSessionId: string | null = 'runtime-1'
  const service = createPlanRunService({
    engine: {
      agentRuns: {
        start: async () => ({ runId: 'agent-1' }),
        stop: async ({ sessionId }) => {
          stoppedIn.push(sessionId)
        }
      }
    },
    completions: {
      expect: async () => new Promise(() => undefined),
      deliver: () => false,
      abandonSession: () => undefined
    },
    resolveRuntimeSessionId: () => runtimeSessionId,
    store: {
      write: (state) => {
        states.set(state.id, state)
      },
      read: (_sessionId, runId) => states.get(runId) ?? null,
      list: () => [...states.values()],
      listUnfinished: () => []
    },
    timeline: {
      append: (_sessionId, event) => {
        timelineTypes.push(event.type)
        return event
      },
      broadcast: () => undefined
    },
    continueConversation: () => assert.fail('stopped plans must not wake the conversation'),
    logError: (error) => assert.fail(String(error)),
    clock: () => '2026-10-23T00:00:00.000Z',
    ids: () => 'plan-stop-disposed'
  })

  await service.startFromApprovedPlan('phi-1', spec)
  runtimeSessionId = null
  const state = await service.stop('phi-1', 'plan-stop-disposed')

  assert.equal(state.status, 'stopped')
  assert.deepEqual(stoppedIn, ['runtime-1'])
  assert.equal(timelineTypes.at(-1), 'plan_run_finished')
  assert.equal(timelineTypes.filter((type) => type === 'plan_run_finished').length, 1)
})
