import assert from 'node:assert/strict'
import test from 'node:test'

import { parseAgentReport, type AgentReport } from '../src/main/agent/agents/report'
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
