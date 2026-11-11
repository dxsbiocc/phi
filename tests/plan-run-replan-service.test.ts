import assert from 'node:assert/strict'
import test from 'node:test'

import { createPlanRunState, reducePlanRun } from '../src/main/agent/plan/model/plan-run-state'
import { createPlanRunService, type PlanRunService } from '../src/main/agent/plan/plan-run-service'
import type { PlanRunState, PlanSpec } from '../src/shared/planRunTypes'

const spec: PlanSpec = {
  version: 1,
  goal: 'Finish the feature',
  steps: [
    {
      id: 'first',
      title: 'First',
      instructions: 'Do the first step',
      acceptance: 'First is done',
      dependsOn: [],
      access: 'read'
    },
    {
      id: 'second',
      title: 'Second',
      instructions: 'Do the second step',
      acceptance: 'Second is done',
      dependsOn: ['first'],
      access: 'write'
    }
  ]
}

function failedState(): PlanRunState {
  let state = createPlanRunState({
    id: 'plan-1',
    sessionId: 'phi-1',
    spec,
    now: '2026-10-23T00:00:00.000Z'
  })
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    state = reducePlanRun(state, {
      type: 'step_launched',
      stepId: 'first',
      agentRunId: `agent-${attempt}`,
      at: `2026-10-23T00:00:0${attempt}.000Z`
    })
    state = reducePlanRun(state, {
      type: 'step_failed',
      stepId: 'first',
      error: 'failed',
      at: `2026-10-23T00:00:0${attempt}.500Z`
    })
  }
  return state
}

function harness(
  enterMode?: (
    runtimeSessionId: string,
    requestId: string,
    setRuntime: (id: string | null) => void
  ) => Promise<unknown>,
  exitMode?: (runtimeSessionId: string, requestId: string) => Promise<boolean>
): {
  service: PlanRunService
  states: Map<string, PlanRunState>
  entered: Array<{ runtimeSessionId: string; requestId: string }>
  exited: Array<{ runtimeSessionId: string; requestId: string }>
  launched: string[]
  errors: unknown[]
  setRuntime(id: string | null): void
  failReplacementWrites(count: number): void
} {
  const states = new Map<string, PlanRunState>([['plan-1', failedState()]])
  const entered: Array<{ runtimeSessionId: string; requestId: string }> = []
  const exited: Array<{ runtimeSessionId: string; requestId: string }> = []
  const launched: string[] = []
  const errors: unknown[] = []
  let runtimeSessionId: string | null = 'runtime-1'
  let remainingReplacementWriteFailures = 0
  const service = createPlanRunService({
    engine: {
      agentRuns: {
        start: async ({ task }) => {
          launched.push(task)
          return { runId: 'next-agent' }
        },
        stop: async () => undefined
      }
    },
    completions: {
      expect: async () => new Promise(() => undefined),
      deliver: () => false,
      abandonSession: () => undefined
    },
    resolveRuntimeSessionId: () => runtimeSessionId,
    enterReplanMode: async (sessionId, requestId) => {
      if (enterMode) await enterMode(sessionId, requestId, (id) => (runtimeSessionId = id))
      entered.push({ runtimeSessionId: sessionId, requestId })
    },
    exitReplanMode: async (sessionId, requestId) => {
      exited.push({ runtimeSessionId: sessionId, requestId })
      return exitMode ? exitMode(sessionId, requestId) : true
    },
    store: {
      write: (state) => {
        if (
          remainingReplacementWriteFailures > 0 &&
          state.replans === 1 &&
          state.status === 'running'
        ) {
          remainingReplacementWriteFailures -= 1
          throw new Error('replacement persistence failed')
        }
        states.set(state.id, state)
      },
      read: (sessionId, runId) => (sessionId === 'phi-1' ? (states.get(runId) ?? null) : null),
      list: (sessionId) => (sessionId === 'phi-1' ? [...states.values()] : []),
      listUnfinished: (sessionId) =>
        sessionId === 'phi-1'
          ? [...states.values()].filter((state) => state.status !== 'completed')
          : []
    },
    timeline: { append: (_sessionId, event) => event, broadcast: () => undefined },
    continueConversation: () => undefined,
    logError: (error) => errors.push(error),
    clock: () => '2026-10-23T00:00:10.000Z'
  })
  return {
    service,
    states,
    entered,
    exited,
    launched,
    errors,
    setRuntime: (id: string | null) => (runtimeSessionId = id),
    failReplacementWrites: (count) => {
      remainingReplacementWriteFailures = count
    }
  }
}

test('replan requires the bound paused run and enters structured plan mode first', async () => {
  const { service, entered } = harness()
  await assert.rejects(service.requestReplan('another-session', 'plan-1'), /not found/u)
  const request = await service.requestReplan('phi-1', 'plan-1')
  assert.equal(request.runId, 'plan-1')
  assert.match(request.prompt, /propose_plan_steps/u)
  assert.match(request.prompt, /Do the first step/u)
  assert.match(request.prompt, /untrusted plan and agent-report data/u)
  assert.deepEqual(entered, [{ runtimeSessionId: 'runtime-1', requestId: request.requestId }])
  assert.deepEqual(service.pendingReplan('phi-1', 'runtime-1'), {
    requestId: request.requestId,
    runId: 'plan-1'
  })
  assert.equal(service.pendingReplan('phi-1', 'other-runtime'), null)
  assert.equal((await service.requestReplan('phi-1', 'plan-1')).requestId, request.requestId)
  assert.equal(entered.length, 1)
})

test('reviewed replan validates started steps and rejects wrong runtime before replacement', async () => {
  const { service, states, setRuntime, launched } = harness()
  const { requestId } = await service.requestReplan('phi-1', 'plan-1')
  const invalid: PlanSpec = {
    ...spec,
    steps: [{ ...spec.steps[0]!, title: 'Changed started step' }, spec.steps[1]!]
  }
  const result = await service.validateReplanProposal('phi-1', requestId, invalid)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.errors.join(' '), /cannot modify started step/u)
  const replacement: PlanSpec = {
    ...spec,
    steps: [spec.steps[0]!, { ...spec.steps[1]!, title: 'New second step' }]
  }
  assert.equal((await service.validateReplanProposal('phi-1', requestId, replacement)).ok, true)
  await assert.rejects(
    service.applyApprovedReplan('phi-1', 'wrong-runtime', requestId, replacement),
    /no longer active/u
  )
  setRuntime('other-runtime')
  await assert.rejects(
    service.applyApprovedReplan('phi-1', 'runtime-1', requestId, replacement),
    /runtime is not running/u
  )
  assert.equal(states.get('plan-1')?.replans, 0)
  setRuntime('runtime-1')
  const updated = await service.applyApprovedReplan('phi-1', 'runtime-1', requestId, replacement)
  assert.equal(updated.replans, 1)
  assert.equal(updated.spec.steps[1]?.title, 'New second step')
  assert.equal(updated.steps.first?.status, 'skipped')
  assert.equal(updated.status, 'running')
  assert.equal(updated.steps.second?.status, 'running')
  assert.equal(launched.length, 1)
  assert.match(launched[0]!, /New second step/u)
  assert.equal(service.pendingReplan('phi-1', 'runtime-1'), null)
})

test('cancelled replan cannot apply a reviewed replacement', async () => {
  const { service, states } = harness()
  const { requestId } = await service.requestReplan('phi-1', 'plan-1')
  service.cancelReplan('phi-1', requestId)
  await assert.rejects(
    service.applyApprovedReplan('phi-1', 'runtime-1', requestId, spec),
    /no longer active/u
  )
  assert.equal(states.get('plan-1')?.replans, 0)
})

test('active conversation or plan mode rejection leaves no pending replan', async () => {
  const { service, states, entered } = harness(async () => {
    throw new Error('Conversation is already active')
  })
  await assert.rejects(service.requestReplan('phi-1', 'plan-1'), /already active/u)
  assert.equal(service.pendingReplan('phi-1', 'runtime-1'), null)
  assert.equal(states.get('plan-1')?.replans, 0)
  assert.deepEqual(entered, [])
})

test('concurrent approval claims the request once and rejects replay', async () => {
  const { service, states } = harness()
  const { requestId } = await service.requestReplan('phi-1', 'plan-1')
  const replacement: PlanSpec = {
    ...spec,
    steps: [spec.steps[0]!, { ...spec.steps[1]!, title: 'New second step' }]
  }
  const [first, second] = await Promise.allSettled([
    service.applyApprovedReplan('phi-1', 'runtime-1', requestId, replacement),
    service.applyApprovedReplan('phi-1', 'runtime-1', requestId, replacement)
  ])
  assert.equal(first.status, 'fulfilled')
  assert.equal(second.status, 'rejected')
  assert.equal(states.get('plan-1')?.replans, 1)
  await assert.rejects(
    service.applyApprovedReplan('phi-1', 'runtime-1', requestId, replacement),
    /no longer active/u
  )
})

test('runtime swap during proposal validation cannot steal or apply a pending replan', async () => {
  const { service, states, launched, setRuntime } = harness()
  const { requestId } = await service.requestReplan('phi-1', 'plan-1')
  const replacement: PlanSpec = {
    ...spec,
    steps: [spec.steps[0]!, { ...spec.steps[1]!, title: 'New second step' }]
  }
  const validate = service.validateReplanProposal.bind(service)
  let release!: () => void
  let validationStarted!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    validationStarted = resolve
  })
  service.validateReplanProposal = async (...args) => {
    validationStarted()
    await gate
    return validate(...args)
  }
  const applying = service.applyApprovedReplan('phi-1', 'runtime-1', requestId, replacement)
  await started
  setRuntime('runtime-2')
  await assert.rejects(service.requestReplan('phi-1', 'plan-1'), /already in progress/u)
  release()
  await assert.rejects(applying, /no longer active/u)
  assert.equal(states.get('plan-1')?.replans, 0)
  assert.equal(launched.length, 0)
})

test('cancel rolls back only the exact pending request', async () => {
  const { service, exited } = harness()
  const first = await service.requestReplan('phi-1', 'plan-1')
  await service.cancelRequestedReplan('phi-1', 'wrong-run', first.requestId)
  await service.cancelRequestedReplan('phi-1', 'plan-1', 'wrong-request')
  assert.equal(exited.length, 0)
  assert.equal(service.pendingReplan('phi-1', 'runtime-1')?.requestId, first.requestId)
  await service.cancelRequestedReplan('phi-1', 'plan-1', first.requestId)
  assert.deepEqual(exited, [{ runtimeSessionId: 'runtime-1', requestId: first.requestId }])
  assert.equal(service.pendingReplan('phi-1', 'runtime-1'), null)

  const second = await service.requestReplan('phi-1', 'plan-1')
  await service.cancelRequestedReplan('phi-1', 'plan-1', first.requestId)
  assert.equal(exited.length, 1)
  assert.equal(service.pendingReplan('phi-1', 'runtime-1')?.requestId, second.requestId)
})

test('pending replan blocks old run mutations until exact cancellation completes', async () => {
  const { service, states, launched } = harness()
  const request = await service.requestReplan('phi-1', 'plan-1')
  assert.deepEqual(service.pendingReplanForRun('phi-1', 'plan-1'), {
    requestId: request.requestId,
    runId: 'plan-1'
  })
  assert.equal(service.pendingReplanForRun('phi-1', 'other-run'), null)
  const before = states.get('plan-1')
  for (const operation of [
    () => service.pause('phi-1', 'plan-1'),
    () => service.resume('phi-1', 'plan-1'),
    () => service.retryStep('phi-1', 'plan-1', 'first'),
    () => service.skipStep('phi-1', 'plan-1', 'first')
  ]) {
    await assert.rejects(operation(), /replan is in progress/u)
    assert.equal(states.get('plan-1'), before)
    assert.equal(launched.length, 0)
  }
  await service.cancelRequestedReplan('phi-1', 'plan-1', request.requestId)
  assert.equal(service.pendingReplanForRun('phi-1', 'plan-1'), null)
  const resumed = await service.retryStep('phi-1', 'plan-1', 'first')
  assert.equal(resumed.status, 'running')
  assert.equal(launched.length, 1)
})

test('a run mutation already in admission prevents a concurrent replan', async () => {
  const { service, launched } = harness()
  const recover = service.recoverSession.bind(service)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const admitted = new Promise<void>((resolve) => {
    entered = resolve
  })
  service.recoverSession = async (sessionId) => {
    entered()
    await gate
    return recover(sessionId)
  }
  const resuming = service.retryStep('phi-1', 'plan-1', 'first')
  await admitted
  await assert.rejects(
    service.requestReplan('phi-1', 'plan-1'),
    /operation is already in progress/u
  )
  assert.equal(service.pendingReplanForRun('phi-1', 'plan-1'), null)
  release()
  const resumed = await resuming
  assert.equal(resumed.status, 'running')
  assert.equal(launched.length, 1)
})

test('replan admission blocks an old-run mutation before the request is bound', async () => {
  const { service, launched } = harness()
  const recover = service.recoverSession.bind(service)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const admitted = new Promise<void>((resolve) => {
    entered = resolve
  })
  service.recoverSession = async (sessionId) => {
    entered()
    await gate
    return recover(sessionId)
  }
  const requesting = service.requestReplan('phi-1', 'plan-1')
  await admitted
  await assert.rejects(service.retryStep('phi-1', 'plan-1', 'first'), /replan is in progress/u)
  assert.equal(launched.length, 0)
  release()
  const request = await requesting
  assert.equal(service.pendingReplanForRun('phi-1', 'plan-1')?.requestId, request.requestId)
  assert.equal(launched.length, 0)
})

test('rollback keeps old-run mutations blocked until the exact exit completes', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { service, launched } = harness(undefined, async () => {
    await gate
    return true
  })
  const request = await service.requestReplan('phi-1', 'plan-1')
  const cancelling = service.cancelRequestedReplan('phi-1', 'plan-1', request.requestId)
  assert.equal(service.pendingReplanForRun('phi-1', 'plan-1')?.requestId, request.requestId)
  await assert.rejects(service.retryStep('phi-1', 'plan-1', 'first'), /replan is in progress/u)
  assert.equal(launched.length, 0)
  release()
  await cancelling
  assert.equal(service.pendingReplanForRun('phi-1', 'plan-1'), null)
  await service.retryStep('phi-1', 'plan-1', 'first')
  assert.equal(launched.length, 1)
})

test('failed mode rollback preserves the exact binding for a retry', async () => {
  let canExit = false
  const { service, exited } = harness(undefined, async () => canExit)
  const request = await service.requestReplan('phi-1', 'plan-1')
  await assert.rejects(
    service.cancelRequestedReplan('phi-1', 'plan-1', request.requestId),
    /already active/u
  )
  assert.equal(service.pendingReplan('phi-1', 'runtime-1')?.requestId, request.requestId)
  canExit = true
  await service.cancelRequestedReplan('phi-1', 'plan-1', request.requestId)
  assert.equal(service.pendingReplan('phi-1', 'runtime-1'), null)
  assert.equal(exited.length, 2)
})

test('cancel clears a stale binding when its runtime has been replaced', async () => {
  const { service, setRuntime, exited } = harness()
  const request = await service.requestReplan('phi-1', 'plan-1')
  setRuntime('runtime-2')
  await service.cancelRequestedReplan('phi-1', 'plan-1', request.requestId)
  assert.equal(service.pendingReplan('phi-1', 'runtime-1'), null)
  assert.deepEqual(exited, [])
})

test('post-entry runtime change rolls back exactly before clearing pending', async () => {
  const { service, exited } = harness(async (_session, _request, setRuntime) => {
    setRuntime('runtime-2')
  })
  await assert.rejects(service.requestReplan('phi-1', 'plan-1'), /runtime is not running/u)
  assert.equal(exited.length, 1)
  assert.equal(exited[0]?.runtimeSessionId, 'runtime-1')
  assert.equal(service.pendingReplan('phi-1', 'runtime-1'), null)
})

test('failed post-entry rollback retains binding and next request retries cleanup', async () => {
  let exits = 0
  const { service, exited } = harness(
    async (_session, _request, setRuntime) => {
      setRuntime('runtime-2')
    },
    async () => ++exits > 1
  )
  await assert.rejects(service.requestReplan('phi-1', 'plan-1'), /runtime is not running/u)
  const pending = service.pendingReplan('phi-1', 'runtime-1')
  assert.ok(pending)
  assert.equal(exited.length, 1)
  const next = await service.requestReplan('phi-1', 'plan-1')
  assert.notEqual(next.requestId, pending.requestId)
  assert.equal(exited.length, 1)
  assert.equal(service.pendingReplan('phi-1', 'runtime-1'), null)
  assert.equal(service.pendingReplan('phi-1', 'runtime-2')?.requestId, next.requestId)
})

test('repeated replacement write failures leave old plan intact and launch nothing', async () => {
  const { service, states, launched, failReplacementWrites } = harness()
  const { requestId } = await service.requestReplan('phi-1', 'plan-1')
  const replacement: PlanSpec = {
    ...spec,
    steps: [spec.steps[0]!, { ...spec.steps[1]!, title: 'Reviewed second step' }]
  }
  failReplacementWrites(2)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      service.applyApprovedReplan('phi-1', 'runtime-1', requestId, replacement),
      /replacement persistence failed/u
    )
    assert.equal(states.get('plan-1')?.replans, 0)
    assert.equal((await service.get('phi-1', 'plan-1'))?.replans, 0)
    assert.equal(states.get('plan-1')?.status, 'paused')
    assert.equal(launched.length, 0)
  }
})

test('stopping a plan drops its pending replan and exits replan mode', async () => {
  const { service, exited, launched } = harness()
  const request = await service.requestReplan('phi-1', 'plan-1')
  const stopped = await service.stop('phi-1', 'plan-1')
  assert.equal(stopped.status, 'stopped')
  assert.deepEqual(exited, [{ runtimeSessionId: 'runtime-1', requestId: request.requestId }])
  assert.equal(service.pendingReplanForRun('phi-1', 'plan-1'), null)
  const late = await service.validateReplanProposal('phi-1', request.requestId, spec)
  assert.equal(late.ok, false)
  assert.equal(launched.length, 0)
})

test('stopping a plan still drops the replan when replan mode cannot be exited', async () => {
  const { service } = harness(undefined, async () => false)
  await service.requestReplan('phi-1', 'plan-1')
  const stopped = await service.stop('phi-1', 'plan-1')
  assert.equal(stopped.status, 'stopped')
  assert.equal(service.pendingReplanForRun('phi-1', 'plan-1'), null)
})
