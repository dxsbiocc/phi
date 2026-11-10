import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseAgentReport,
  requireDeclaredCompletion,
  type AgentReport
} from '../src/main/agent/agents/report'
import {
  createPlanExecutor,
  type PlanExecutor,
  type PlanExecutorEvent
} from '../src/main/agent/plan/execution/plan-executor'
import type {
  StepOutcome,
  StepRunner,
  StepRunnerStartInput
} from '../src/main/agent/plan/execution/step-runner'
import { createPlanRunState, reducePlanRun } from '../src/main/agent/plan/model/plan-run-state'
import type { PlanRunState, PlanSpec, PlanStep } from '../src/shared/planRunTypes'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

interface FakeRun {
  runId: string
  input: StepRunnerStartInput
  result: Deferred<StepOutcome>
}

class FakeRunner implements StepRunner {
  readonly runs: FakeRun[] = []
  readonly stopped: Array<{ sessionId: string; runId: string }> = []
  throwStarts = 0

  async start(input: StepRunnerStartInput): Promise<{ runId: string; done: Promise<StepOutcome> }> {
    if (this.throwStarts > 0) {
      this.throwStarts -= 1
      throw new Error('launch exploded')
    }
    const result = deferred<StepOutcome>()
    const run = { runId: `agent-${this.runs.length + 1}`, input, result }
    this.runs.push(run)
    return { runId: run.runId, done: result.promise }
  }

  stop(sessionId: string, runId: string): void {
    this.stopped.push({ sessionId, runId })
  }
}

function step(id: string, overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    title: `Step ${id}`,
    instructions: `Do ${id}`,
    acceptance: `Verify ${id}`,
    dependsOn: [],
    access: 'read',
    ...overrides
  }
}

function spec(steps: PlanStep[]): PlanSpec {
  return { version: 1, goal: 'Finish the plan', steps }
}

function completed(text = 'done'): AgentReport {
  return parseAgentReport(text)
}

interface Fixture {
  executor: PlanExecutor
  runner: FakeRunner
  writes: PlanRunState[]
  events: PlanExecutorEvent[]
  order: string[]
}

function fixture(runner = new FakeRunner()): Fixture {
  const writes: PlanRunState[] = []
  const events: PlanExecutorEvent[] = []
  const order: string[] = []
  let tick = 0
  const executor = createPlanExecutor({
    runner,
    store: {
      write(state) {
        writes.push(structuredClone(state))
        order.push(`write:${state.updatedAt}`)
      }
    },
    events: {
      emit(event) {
        events.push(structuredClone(event))
        order.push(
          event.type === 'executor_error'
            ? `emit:${event.type}:${event.runId}`
            : `emit:${event.type}:${event.state.updatedAt}`
        )
      }
    },
    clock: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
    ids: () => 'plan-1'
  })
  return { executor, runner, writes, events, order }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.fail('condition was not reached')
}

function succeed(run: FakeRun, text = 'done'): void {
  run.result.resolve({ ok: true, report: completed(text) })
}

function fail(run: FakeRun, error = 'failed'): void {
  run.result.resolve({ ok: false, error })
}

test('an omitted step agent launches the shared PlanStep default', async () => {
  const app = fixture()
  await app.executor.start(spec([step('a')]), 'session-1')
  assert.equal(app.runner.runs[0]?.input.agent, 'PlanStep')
  succeed(app.runner.runs[0]!)
  await waitFor(() => app.executor.get('plan-1')?.status === 'completed')
})

test('diamond dependencies run read branches in parallel and finish once', async () => {
  const app = fixture()
  const state = await app.executor.start(
    spec([
      step('a'),
      step('b', { dependsOn: ['a'] }),
      step('c', { dependsOn: ['a'] }),
      step('d', { dependsOn: ['b', 'c'] })
    ]),
    'session-1'
  )
  assert.equal(state.steps.a.status, 'running')
  assert.equal(app.runner.runs.length, 1)
  succeed(app.runner.runs[0]!)
  await waitFor(() => app.runner.runs.length === 3)
  assert.match(app.runner.runs[1]!.input.task, /Step b/)
  assert.match(app.runner.runs[2]!.input.task, /Step c/)
  succeed(app.runner.runs[1]!)
  succeed(app.runner.runs[2]!)
  await waitFor(() => app.runner.runs.length === 4)
  succeed(app.runner.runs[3]!)
  await waitFor(() => app.executor.get('plan-1')?.status === 'completed')
  assert.equal(app.events.filter((event) => event.type === 'run_finished').length, 1)
  for (const event of app.events) {
    if (event.type !== 'state_changed') continue
    const emitted = app.order.indexOf(`emit:state_changed:${event.state.updatedAt}`)
    assert.ok(app.order.lastIndexOf(`write:${event.state.updatedAt}`, emitted) < emitted)
  }
})

test('write steps serialize without ranges and parallelize with disjoint ranges', async () => {
  const serial = fixture()
  await serial.executor.start(
    spec([step('a', { access: 'write' }), step('b', { access: 'write' })]),
    'session-1'
  )
  assert.equal(serial.runner.runs.length, 1)
  succeed(serial.runner.runs[0]!)
  await waitFor(() => serial.runner.runs.length === 2)

  const parallel = fixture()
  await parallel.executor.start(
    spec([
      step('a', { access: 'write', writes: ['src/a'] }),
      step('b', { access: 'write', writes: ['src/b'] })
    ]),
    'session-1'
  )
  assert.equal(parallel.runner.runs.length, 2)
})

async function pauseAfterTwoFailures(app: Fixture): Promise<void> {
  await app.executor.start(spec([step('a')]), 'session-1')
  fail(app.runner.runs[0]!)
  await waitFor(() => app.runner.runs.length === 2)
  fail(app.runner.runs[1]!)
  await waitFor(() => app.executor.get('plan-1')?.status === 'paused')
}

test('failure retries once, then retry or skip continues the paused run', async () => {
  const retry = fixture()
  await pauseAfterTwoFailures(retry)
  assert.equal(retry.executor.get('plan-1')?.pause?.reason, 'step_failed')
  await retry.executor.retryStep('plan-1', 'a')
  assert.equal(retry.runner.runs.length, 3)
  succeed(retry.runner.runs[2]!)
  await waitFor(() => retry.executor.get('plan-1')?.status === 'completed')

  const skip = fixture()
  await pauseAfterTwoFailures(skip)
  const skipped = await skip.executor.skipStep('plan-1', 'a')
  assert.equal(skipped.status, 'completed')
  assert.equal(skipped.steps.a.status, 'skipped')
})

test('retrying one of multiple failures stays paused until every failure is resolved', async () => {
  const app = fixture()
  await app.executor.start(
    spec([step('a'), step('b'), step('c', { dependsOn: ['a', 'b'] })]),
    'session-1'
  )
  fail(app.runner.runs[0]!)
  fail(app.runner.runs[1]!)
  await waitFor(() => app.runner.runs.length === 4)
  fail(app.runner.runs[2]!)
  fail(app.runner.runs[3]!)
  await waitFor(() => app.executor.get('plan-1')?.steps.b.status === 'failed')
  assert.equal(app.executor.get('plan-1')?.pause?.stepId, 'a')

  const afterB = await app.executor.retryStep('plan-1', 'b')
  assert.equal(afterB.status, 'paused')
  assert.equal(afterB.pause?.stepId, 'a')
  assert.equal(afterB.steps.b.status, 'pending')
  assert.equal(app.runner.runs.length, 4)

  const afterA = await app.executor.retryStep('plan-1', 'a')
  assert.equal(afterA.status, 'running')
  assert.equal(app.runner.runs.length, 6)
  succeed(app.runner.runs[4]!)
  succeed(app.runner.runs[5]!)
  await waitFor(() => app.runner.runs.length === 7)
  succeed(app.runner.runs[6]!)
  await waitFor(() => app.executor.get('plan-1')?.status === 'completed')
})

test('missing inputs pause immediately without retrying', async () => {
  const app = fixture()
  await app.executor.start(spec([step('a')]), 'session-1')
  app.runner.runs[0]!.result.resolve({
    ok: true,
    report: {
      status: 'blocked',
      text: 'Need a token',
      missingInputs: ['API token'],
      structured: true
    }
  })
  await waitFor(() => app.executor.get('plan-1')?.status === 'paused')
  assert.equal(app.executor.get('plan-1')?.pause?.reason, 'needs_input')
  assert.equal(app.runner.runs.length, 1)
})

test('pause lets active work finish but gates dependents until resume', async () => {
  const app = fixture()
  await app.executor.start(spec([step('a'), step('b', { dependsOn: ['a'] })]), 'session-1')
  await app.executor.pause('plan-1')
  succeed(app.runner.runs[0]!)
  await waitFor(() => app.executor.get('plan-1')?.steps.a.status === 'done')
  assert.equal(app.runner.runs.length, 1)
  await app.executor.resume('plan-1')
  assert.equal(app.runner.runs.length, 2)
})

test('stop aborts and cancels every running step', async () => {
  const app = fixture()
  await app.executor.start(spec([step('a'), step('b')]), 'session-1')
  const stopped = await app.executor.stop('plan-1')
  assert.deepEqual(app.runner.stopped, [
    { sessionId: 'session-1', runId: 'agent-1' },
    { sessionId: 'session-1', runId: 'agent-2' }
  ])
  assert.equal(stopped.status, 'stopped')
  assert.equal(stopped.steps.a.status, 'cancelled')
  assert.equal(stopped.steps.b.status, 'cancelled')
  assert.ok(app.runner.runs.every((run) => run.input.signal.aborted))
})

test('runner start throws and done rejects are converted into step failures', async () => {
  const throwing = new FakeRunner()
  throwing.throwStarts = 4
  const startFailure = fixture(throwing)
  const paused = await startFailure.executor.start(
    spec([step('a'), step('b'), step('c')]),
    'session-1'
  )
  assert.equal(paused.status, 'paused')
  assert.match(paused.steps.a.error ?? '', /launch exploded/)
  assert.equal(paused.steps.a.attempts, 2)
  assert.equal(paused.steps.b.attempts, 1)
  assert.equal(paused.steps.c.attempts, 1)

  const rejection = fixture()
  await rejection.executor.start(spec([step('a')]), 'session-1')
  rejection.runner.runs[0]!.result.reject(new Error('done rejected'))
  await waitFor(() => rejection.runner.runs.length === 2)
  assert.equal(rejection.executor.get('plan-1')?.steps.a.attempts, 2)
})

test('concurrent done callbacks are serialized without losing either update', async () => {
  const app = fixture()
  await app.executor.start(spec([step('a'), step('b')]), 'session-1')
  succeed(app.runner.runs[0]!)
  succeed(app.runner.runs[1]!)
  await waitFor(() => app.executor.get('plan-1')?.status === 'completed')
  assert.equal(app.executor.get('plan-1')?.steps.a.status, 'done')
  assert.equal(app.executor.get('plan-1')?.steps.b.status, 'done')
})

test('a suspended session records a cancelled child as interrupted without retrying', async () => {
  const app = fixture()
  await app.executor.start(spec([step('a'), step('b', { dependsOn: ['a'] })]), 'session-1')
  await app.executor.suspendSession('session-1')
  fail(app.runner.runs[0]!, 'cancelled at quit')
  await waitFor(() => app.executor.get('plan-1')?.steps.a.status === 'interrupted')
  const state = app.executor.get('plan-1')!
  assert.equal(state.status, 'paused')
  assert.equal(state.steps.a.attempts, 1)
  assert.equal(state.steps.b.status, 'pending')
  assert.deepEqual(state.pause, { reason: 'interrupted', stepId: 'a' })
  assert.equal(app.runner.runs.length, 1)
})

test('interrupting a session ignores the cancelled child completion without retrying', async () => {
  const app = fixture()
  await app.executor.start(spec([step('a'), step('b', { dependsOn: ['a'] })]), 'session-1')
  await app.executor.interruptRunningSteps('session-1')
  const interrupted = app.executor.get('plan-1')!
  assert.equal(interrupted.status, 'paused')
  assert.equal(interrupted.steps.a.status, 'interrupted')
  assert.equal(interrupted.steps.a.attempts, 1)
  assert.equal(interrupted.steps.b.status, 'pending')
  assert.deepEqual(interrupted.pause, { reason: 'interrupted', stepId: 'a' })

  fail(app.runner.runs[0]!, 'cancelled at quit')
  await waitFor(() => app.executor.get('plan-1')?.status === 'paused')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(app.runner.runs.length, 1, 'a cancellation completion must not retry')
  assert.equal(app.executor.get('plan-1')?.steps.a.status, 'interrupted')
})

test('restart recovery interrupts running work and can retry it', async () => {
  const app = fixture()
  const initial = createPlanRunState({
    id: 'plan-1',
    sessionId: 'session-1',
    spec: spec([step('a')]),
    now: '2026-01-01T00:00:00.000Z'
  })
  const running = reducePlanRun(initial, {
    type: 'step_launched',
    stepId: 'a',
    agentRunId: 'lost-run',
    at: '2026-01-01T00:00:01.000Z'
  })
  const recovered = await app.executor.recover(running)
  assert.equal(recovered.status, 'paused')
  assert.equal(recovered.pause?.reason, 'interrupted')
  assert.equal(recovered.steps.a.status, 'interrupted')
  await app.executor.retryStep('plan-1', 'a')
  assert.equal(app.runner.runs.length, 1)
  succeed(app.runner.runs[0]!)
  await waitFor(() => app.executor.get('plan-1')?.status === 'completed')
})

test('restart recovery records the last persisted alive time for running work', async () => {
  const app = fixture()
  const initial = createPlanRunState({
    id: 'plan-1',
    sessionId: 'session-1',
    spec: spec([step('a')]),
    now: '2025-12-31T23:00:00.000Z'
  })
  const running = reducePlanRun(initial, {
    type: 'step_launched',
    stepId: 'a',
    agentRunId: 'lost-run',
    at: '2025-12-31T23:00:01.000Z'
  })
  const lastAlive = '2025-12-31T23:59:00.000Z'
  const recovered = await app.executor.recover({ ...running, updatedAt: lastAlive })
  assert.equal(recovered.steps.a.finishedAt, lastAlive)
  assert.equal(recovered.steps.a.lastSeenAt, lastAlive)
  assert.equal(recovered.updatedAt, '2026-01-01T00:00:00.000Z')
})

test('quiescent release uses the last alive time after restart, not the release time', async () => {
  let now = '2026-01-01T00:00:00.000Z'
  const runner = new FakeRunner()
  const writes: PlanRunState[] = []
  const executor = createPlanExecutor({
    runner,
    store: {
      write: (state) => {
        writes.push(structuredClone(state))
      }
    },
    events: { emit: () => undefined },
    clock: () => now,
    ids: () => 'plan-1',
    requiresDurableLaunch: () => true
  })
  await executor.start(spec([step('a')]), 'session-1')
  const requestId = runner.runs[0]?.input.requestId
  assert.ok(requestId)
  const launching = writes.find((state) => state.steps.a.status === 'launching')
  assert.ok(launching)

  now = '2026-01-02T00:00:00.000Z'
  const recoveredRunner = new FakeRunner()
  const recovered = createPlanExecutor({
    runner: recoveredRunner,
    store: { write: () => undefined },
    events: { emit: () => undefined },
    clock: () => now,
    ids: () => 'unused',
    requiresDurableLaunch: () => true
  })
  const state = await recovered.recover({ ...launching, updatedAt: '2026-01-01T00:05:00.000Z' })
  assert.equal(state.steps.a.status, 'unknown')
  assert.equal(state.steps.a.lastSeenAt, '2026-01-01T00:05:00.000Z')

  now = '2026-01-03T00:00:00.000Z'
  const released = await recovered.confirmLaunchQuiescent('plan-1', 'a', requestId)
  assert.equal(released.steps.a.status, 'interrupted')
  assert.equal(released.steps.a.finishedAt, '2026-01-01T00:05:00.000Z')
  assert.equal(released.updatedAt, '2026-01-03T00:00:00.000Z')
  assert.equal(recoveredRunner.runs.length, 0)
})

test('restart recovery schedules a running plan with no running steps', async () => {
  const app = fixture()
  const initial = createPlanRunState({
    id: 'plan-1',
    sessionId: 'session-1',
    spec: spec([step('a')]),
    now: '2026-01-01T00:00:00.000Z'
  })
  const recovered = await app.executor.recover(initial)
  assert.equal(recovered.status, 'running')
  assert.equal(recovered.steps.a.status, 'running')
  assert.equal(app.runner.runs.length, 1)
})

test('store write failures emit safely, keep watching done, and never reject unhandled', async () => {
  const runner = new FakeRunner()
  const unhandled: unknown[] = []
  const reported: PlanExecutorEvent[] = []
  let writes = 0
  const onUnhandled = (error: unknown): void => {
    unhandled.push(error)
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    const executor = createPlanExecutor({
      runner,
      store: {
        write() {
          writes += 1
          if (writes > 1) throw new Error('launch write failed')
        }
      },
      events: {
        emit(event) {
          if (event.type !== 'executor_error') return
          reported.push(event)
          throw new Error('error emit failed')
        }
      },
      clock: () => '2026-01-01T00:00:00.000Z',
      ids: () => 'plan-1'
    })
    const running = await executor.start(spec([step('a')]), 'session-1')
    assert.equal(running.steps.a.status, 'running')
    assert.deepEqual(reported[0], {
      type: 'executor_error',
      runId: 'plan-1',
      error: 'launch write failed'
    })
    runner.runs[0]!.result.reject(new Error('done rejected'))
    await waitFor(() => reported.length === 2)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('an initial persistence failure rolls back the in-memory run', async () => {
  const executor = createPlanExecutor({
    runner: new FakeRunner(),
    store: { write: () => Promise.reject(new Error('initial write failed')) },
    events: { emit: () => undefined },
    clock: () => '2026-01-01T00:00:00.000Z',
    ids: () => 'plan-rollback'
  })
  await assert.rejects(executor.start(spec([step('a')]), 'session-1'), /initial write failed/)
  assert.equal(executor.get('plan-rollback'), undefined)
})

test('approval commits on successful initial write even if prompt cancels during async storage', async () => {
  const runner = new FakeRunner()
  const writeStarted = deferred<void>()
  const releaseWrite = deferred<void>()
  const persisted: PlanRunState[] = []
  let current = true
  const executor = createPlanExecutor({
    runner,
    store: {
      async write(state) {
        if (state.status === 'running') {
          writeStarted.resolve()
          await releaseWrite.promise
        }
        persisted.push(structuredClone(state))
      }
    },
    events: { emit: () => undefined },
    clock: () => '2026-01-01T00:00:00.000Z',
    ids: () => 'late-plan'
  })
  const starting = executor.start(spec([step('a')]), 'session-1', () => {
    if (!current) throw new Error('review is stale')
  })
  await writeStarted.promise
  current = false
  releaseWrite.resolve()
  const started = await starting
  assert.equal(persisted[0]?.status, 'running')
  assert.equal(
    persisted.some((state) => state.status === 'stopped'),
    false
  )
  assert.equal(started.steps.a?.status, 'running')
  assert.equal(runner.runs.length, 1)
})

test('start rejects stale approval inside its queue before any durable write', async () => {
  let writes = 0
  let current = true
  const runner = new FakeRunner()
  const executor = createPlanExecutor({
    runner,
    store: {
      write() {
        writes += 1
      }
    },
    events: { emit: () => undefined },
    clock: () => '2026-01-01T00:00:00.000Z',
    ids: () => 'stale-plan'
  })
  const starting = executor.start(spec([step('a')]), 'session-1', () => {
    if (!current) throw new Error('review is stale')
  })
  current = false
  await assert.rejects(starting, /review is stale/u)
  assert.equal(writes, 0)
  assert.equal(runner.runs.length, 0)
  assert.equal(executor.get('stale-plan'), undefined)
})

test('failed in-flight initial write leaves no runnable plan after cancellation', async () => {
  const runner = new FakeRunner()
  const writeStarted = deferred<void>()
  const releaseWrite = deferred<void>()
  let current = true
  const executor = createPlanExecutor({
    runner,
    store: {
      async write() {
        writeStarted.resolve()
        await releaseWrite.promise
        throw new Error('initial write failed')
      }
    },
    events: { emit: () => undefined },
    clock: () => '2026-01-01T00:00:00.000Z',
    ids: () => 'failed-plan'
  })
  const starting = executor.start(spec([step('a')]), 'session-1', () => {
    if (!current) throw new Error('review is stale')
  })
  await writeStarted.promise
  current = false
  releaseWrite.resolve()
  await assert.rejects(starting, /initial write failed/u)
  assert.equal(executor.get('failed-plan'), undefined)
  assert.equal(runner.runs.length, 0)
})

test('replacement persistence failure keeps the old plan and launches no new step', async () => {
  const runner = new FakeRunner()
  const original = spec([step('first'), step('second', { dependsOn: ['first'] })])
  let paused = createPlanRunState({
    id: 'plan-1',
    sessionId: 'session-1',
    spec: original,
    now: '2026-01-01T00:00:00.000Z'
  })
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    paused = reducePlanRun(paused, {
      type: 'step_launched',
      stepId: 'first',
      agentRunId: `agent-${attempt}`,
      at: `2026-01-01T00:00:0${attempt}.000Z`
    })
    paused = reducePlanRun(paused, {
      type: 'step_failed',
      stepId: 'first',
      error: 'failed',
      at: `2026-01-01T00:00:0${attempt}.500Z`
    })
  }
  const writes: PlanRunState[] = []
  const events: PlanExecutorEvent[] = []
  const executor = createPlanExecutor({
    runner,
    store: {
      write(state) {
        if (state.replans > 0) throw new Error('replacement write failed')
        writes.push(structuredClone(state))
      }
    },
    events: {
      emit(event) {
        events.push(event)
      }
    },
    clock: () => '2026-01-01T00:00:10.000Z',
    ids: () => 'unused'
  })
  const before = await executor.recover(paused)
  const priorEvents = events.length
  const replacement = spec([
    original.steps[0]!,
    step('second', {
      title: 'Reviewed second step',
      dependsOn: ['first']
    })
  ])
  await assert.rejects(
    executor.replaceRemainingSteps('plan-1', replacement),
    /replacement write failed/u
  )
  assert.deepEqual(executor.get('plan-1'), before)
  assert.equal(writes.at(-1)?.replans, 0)
  assert.equal(events.length, priorEvents)
  assert.equal(runner.runs.length, 0)
})

test('remote launch persists its request ID before dispatch and recovery blocks replay', async () => {
  const runner = new FakeRunner()
  const writes: PlanRunState[] = []
  const executor = createPlanExecutor({
    runner,
    store: {
      write: (state) => {
        writes.push(structuredClone(state))
      }
    },
    events: { emit: () => undefined },
    clock: () => '2026-01-01T00:00:00.000Z',
    ids: () => 'plan-1',
    requiresDurableLaunch: () => true
  })
  const launched = await executor.start(spec([step('a')]), 'session-1')
  const requestId = runner.runs[0]?.input.requestId
  assert.ok(requestId)
  assert.equal(writes[1]?.steps.a.status, 'launching')
  assert.equal(writes[1]?.steps.a.requestId, requestId)
  assert.equal(launched.steps.a.requestId, requestId)
  const recoveredRunner = new FakeRunner()
  const recovered = createPlanExecutor({
    runner: recoveredRunner,
    store: { write: () => undefined },
    events: { emit: () => undefined },
    clock: () => '2026-01-01T00:00:01.000Z',
    ids: () => 'unused',
    requiresDurableLaunch: () => true
  })
  const state = await recovered.recover(writes[1]!)
  assert.equal(state.steps.a.status, 'unknown')
  assert.equal(state.pause?.reason, 'unknown')
  assert.equal(recoveredRunner.runs.length, 0)
  await assert.rejects(recovered.retryStep('plan-1', 'a'), /unknown remote launch/)
  await assert.rejects(recovered.skipStep('plan-1', 'a'), /unknown remote launch/)
  await assert.rejects(recovered.stop('plan-1'), /unresolved launch/)
  const acknowledged = createPlanExecutor({
    runner: recoveredRunner,
    store: { write: () => undefined },
    events: { emit: () => undefined },
    clock: () => '2026-01-01T00:00:02.000Z',
    ids: () => 'unused',
    requiresDurableLaunch: () => true
  })
  const acknowledgedRecovery = await acknowledged.recover(launched)
  assert.equal(acknowledgedRecovery.steps.a.status, 'unknown')
  assert.equal(acknowledgedRecovery.steps.a.agentRunId, launched.steps.a.agentRunId)
  assert.equal(recoveredRunner.runs.length, 0)
})

test('remote launch persistence failure prevents dispatch', async () => {
  const runner = new FakeRunner()
  let writes = 0
  const executor = createPlanExecutor({
    runner,
    store: {
      write: () => {
        if (++writes === 2) throw new Error('disk unavailable')
      }
    },
    events: { emit: () => undefined },
    clock: () => '2026-01-01T00:00:00.000Z',
    ids: () => 'plan-1',
    requiresDurableLaunch: () => true
  })
  const state = await executor.start(spec([step('a')]), 'session-1')
  assert.equal(state.steps.a.status, 'pending')
  assert.equal(runner.runs.length, 0)
})

test('missing session identity rejects plan creation before any dispatch', async () => {
  const runner = new FakeRunner()
  let writes = 0
  const executor = createPlanExecutor({
    runner,
    store: {
      write: () => {
        writes += 1
      }
    },
    events: { emit: () => undefined },
    clock: () => '2026-01-01T00:00:00.000Z',
    ids: () => 'plan-1',
    requiresDurableLaunch: () => {
      throw new Error('Session manifest unavailable')
    }
  })
  await assert.rejects(executor.start(spec([step('a')]), 'session-1'), /manifest unavailable/)
  assert.equal(writes, 0)
  assert.equal(runner.runs.length, 0)
})

test('ambiguous remote start is UNKNOWN instead of an automatic retry', async () => {
  const runner = new FakeRunner()
  runner.throwStarts = 1
  const executor = createPlanExecutor({
    runner,
    store: { write: () => undefined },
    events: { emit: () => undefined },
    clock: () => '2026-01-01T00:00:00.000Z',
    ids: () => 'plan-1',
    requiresDurableLaunch: () => true
  })
  const state = await executor.start(spec([step('a')]), 'session-1')
  assert.equal(state.steps.a.status, 'unknown')
  assert.equal(state.steps.a.attempts, 1)
  assert.equal(state.pause?.reason, 'unknown')
  assert.equal(runner.runs.length, 0)
})

test('an undeclared completion is retried with its previous report, not from scratch', async () => {
  const app = fixture()
  await app.executor.start(spec([step('a')]), 'session-1')
  assert.doesNotMatch(app.runner.runs[0]!.input.task, /## Previous attempt/)
  app.runner.runs[0]!.result.resolve({
    ok: true,
    report: requireDeclaredCompletion(parseAgentReport('Listed 4 entries in /data.'))
  })
  await waitFor(() => app.runner.runs.length === 2)
  const retryTask = app.runner.runs[1]!.input.task
  assert.match(retryTask, /## Previous attempt/)
  assert.match(retryTask, /Reported status: partial/)
  assert.match(retryTask, /Listed 4 entries in \/data\./)
  assert.match(retryTask, /Do not redo work that is already done/)
  assert.doesNotMatch(retryTask, /phi_agent_result>[^<]*Listed 4 entries/)
  succeed(
    app.runner.runs[1]!,
    '<phi_agent_result>{"status":"completed","missingInputs":[]}</phi_agent_result>\nVerified the 4 entries.'
  )
  await waitFor(() => app.executor.get('plan-1')?.status === 'completed')
})

test('a step that failed with an error is retried with that error', async () => {
  const app = fixture()
  await app.executor.start(spec([step('a')]), 'session-1')
  fail(app.runner.runs[0]!, 'read timed out')
  await waitFor(() => app.runner.runs.length === 2)
  assert.match(app.runner.runs[1]!.input.task, /## Previous attempt[\s\S]*Error: read timed out/)
})
