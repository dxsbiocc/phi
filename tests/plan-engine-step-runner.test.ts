import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createAgentRunCompletions,
  type AgentRunCompletions
} from '../src/main/agent/plan/execution/agent-run-completions'
import { createEngineStepRunner } from '../src/main/agent/plan/execution/engine-step-runner'
import type { StepRunner } from '../src/main/agent/plan/execution/step-runner'

interface Calls {
  starts: Array<{ sessionId: string; agent?: string; task: string }>
  stops: Array<{ sessionId: string; runId: string }>
}

interface Fixture {
  calls: Calls
  completions: AgentRunCompletions
  runner: StepRunner
}

function fixture(options: { stopError?: Error } = {}): Fixture {
  const calls: Calls = { starts: [], stops: [] }
  const completions = createAgentRunCompletions()
  const runner = createEngineStepRunner({
    engine: {
      agentRuns: {
        async start(params) {
          calls.starts.push(params)
          return { runId: `run-${calls.starts.length}` }
        },
        async stop(params) {
          calls.stops.push(params)
          if (options.stopError) throw options.stopError
          return { ok: true }
        }
      }
    },
    completions,
    resolveRuntimeSessionId: (sessionId) => (sessionId === 'phi-1' ? 'runtime-1' : null)
  })
  return { calls, completions, runner }
}

test('start uses the runtime session and maps a completed structured report', async () => {
  const app = fixture()
  const controller = new AbortController()
  const handle = await app.runner.start({
    sessionId: 'phi-1',
    agent: 'Specialist',
    task: 'do the step',
    signal: controller.signal
  })
  assert.deepEqual(app.calls.starts, [
    { sessionId: 'runtime-1', agent: 'Specialist', task: 'do the step' }
  ])
  app.completions.deliver('runtime-1', {
    id: handle.runId,
    state: 'done',
    origin: 'host',
    report: 'human report',
    reportStatus: 'blocked',
    missingInputs: ['token']
  })
  assert.deepEqual(await handle.done, {
    ok: true,
    report: {
      status: 'blocked',
      text: 'human report',
      missingInputs: ['token'],
      structured: false
    }
  })
})

test('an early completion is observed and error states become failed outcomes', async () => {
  const completions = createAgentRunCompletions()
  const runner = createEngineStepRunner({
    engine: {
      agentRuns: {
        async start() {
          completions.deliver('runtime-1', {
            id: 'run-fast',
            state: 'error',
            origin: 'host',
            error: 'boom'
          })
          return { runId: 'run-fast' }
        },
        async stop() {
          return undefined
        }
      }
    },
    completions,
    resolveRuntimeSessionId: () => 'runtime-1'
  })
  const handle = await runner.start({
    sessionId: 'phi-1',
    task: 'fast',
    signal: new AbortController().signal
  })
  assert.deepEqual(await handle.done, { ok: false, error: 'boom' })
})

test('start rejects before engine launch when the runtime session is missing', async () => {
  const app = fixture()
  await assert.rejects(
    app.runner.start({
      sessionId: 'phi-missing',
      task: 'work',
      signal: new AbortController().signal
    }),
    /No runtime session/
  )
  assert.deepEqual(app.calls.starts, [])
})

test('abort stops the run and explicit stop ignores an already-finished error', async () => {
  const app = fixture({ stopError: new Error('Run run-1 has already finished.') })
  const controller = new AbortController()
  await app.runner.start({ sessionId: 'phi-1', task: 'work', signal: controller.signal })
  controller.abort()
  await new Promise<void>((resolve) => setImmediate(resolve))
  await app.runner.stop('phi-1', 'run-1')
  assert.deepEqual(app.calls.stops, [
    { sessionId: 'runtime-1', runId: 'run-1' },
    { sessionId: 'runtime-1', runId: 'run-1' }
  ])
})

test('explicit stop preserves unexpected engine failures', async () => {
  const app = fixture({ stopError: new Error('bridge disconnected') })
  await assert.rejects(async () => {
    await app.runner.stop('phi-1', 'run-9')
  }, /bridge disconnected/)
})
