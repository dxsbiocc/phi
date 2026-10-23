import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createPromptRunStop,
  type PromptRunStopDeps,
  type StoppablePromptRun
} from '../src/main/session-runtime/prompt-run-stop'

type TestSession = { abort(options?: { preserveApprovals?: boolean }): Promise<void> }
type TestRun = StoppablePromptRun<TestSession>

function createDeps(calls: string[]): {
  deps: PromptRunStopDeps<TestRun, TestSession>
  runs: TestRun[]
  entries: Array<[string, TestRun]>
  recovery: { controller: AbortController; done: Promise<void> }
  resolveRecovery: () => void
} {
  const runs: TestRun[] = []
  const entries: Array<[string, TestRun]> = []
  let recoveryResolve: () => void = () => undefined
  const recoveryDone = new Promise<void>((resolve) => {
    recoveryResolve = resolve
  })
  const recovery = { controller: new AbortController(), done: recoveryDone }
  const deps: PromptRunStopDeps<TestRun, TestSession> = {
    runs: {
      advanceGeneration: (key) => {
        calls.push(`advance:${key}`)
        return 1
      },
      activeRuns: () => runs,
      activeEntries: () => entries,
      runtimeRecoveryOperations: {
        values: () => [recovery].values()
      }
    },
    browser: {
      cancel: (run) => calls.push(`browser-cancel:${run.runId}`),
      cleanup: async (run) => {
        calls.push(`browser-cleanup:${run.runId}`)
      }
    },
    agents: {
      stop: (id) => calls.push(`agent-stop:${id}`),
      stopAll: () => calls.push('agent-stop-all')
    },
    waits: {
      cancel: (scope) => calls.push(scope ? `wait-cancel:${scope.runId}` : 'wait-cancel-all')
    },
    sessions: {
      abort: async (session) => {
        calls.push('session-abort')
        await session.abort({ preserveApprovals: true })
      }
    }
  }
  return { deps, runs, entries, recovery, resolveRecovery: recoveryResolve }
}

test('stopPromptRun invalidates, cancels every owner, and waits for cleanup and abort', async () => {
  const calls: string[] = []
  const { deps } = createDeps(calls)
  const run: TestRun = {
    sessionKey: 'session-key',
    phiSessionId: 'phi-session',
    runId: 'run-1',
    cancelled: false,
    session: {
      abort: async () => {
        calls.push('abort')
      }
    }
  }

  await createPromptRunStop(deps).stopPromptRun('session-key', run)

  assert.equal(run.cancelled, true)
  assert.deepEqual(calls, [
    'advance:session-key',
    'browser-cancel:run-1',
    'browser-cleanup:run-1',
    'agent-stop:phi-session',
    'wait-cancel:run-1',
    'session-abort',
    'abort'
  ])
})

test('stopPromptRun can preserve the generation and skips abort without a session', async () => {
  const calls: string[] = []
  const { deps } = createDeps(calls)
  const run: TestRun = {
    sessionKey: 'session-key',
    phiSessionId: 'phi-session',
    runId: 'run-2',
    cancelled: false
  }

  await createPromptRunStop(deps).stopPromptRun('session-key', run, false)

  assert.equal(run.cancelled, true)
  assert.deepEqual(calls, [
    'browser-cancel:run-2',
    'browser-cleanup:run-2',
    'agent-stop:phi-session',
    'wait-cancel:run-2'
  ])
})

test('stopAllPromptRuns aborts recoveries, every run, and returns both cleanup barriers', async () => {
  const calls: string[] = []
  const { deps, runs, entries, recovery, resolveRecovery } = createDeps(calls)
  const first: TestRun = {
    sessionKey: 'first-key',
    phiSessionId: 'first-phi',
    runId: 'first-run',
    cancelled: false,
    session: {
      abort: async () => {
        calls.push('abort:first')
      }
    }
  }
  const second: TestRun = {
    sessionKey: 'second-key',
    phiSessionId: 'second-phi',
    runId: 'second-run',
    cancelled: false
  }
  runs.push(first, second)
  entries.push(['first-key', first], ['second-key', second])

  const shutdown = createPromptRunStop(deps).stopAllPromptRuns()
  await shutdown.browserCleanup
  assert.equal(recovery.controller.signal.aborted, true)
  assert.equal(first.cancelled, true)
  assert.equal(second.cancelled, true)
  assert.deepEqual(calls, [
    'advance:first-key',
    'browser-cancel:first-run',
    'advance:second-key',
    'browser-cancel:second-run',
    'browser-cleanup:first-run',
    'browser-cleanup:second-run',
    'agent-stop-all',
    'wait-cancel-all',
    'session-abort',
    'abort:first'
  ])
  assert.ok(!calls.includes('abort:second'))

  let runtimeSettled = false
  void shutdown.runtimeAbort.then(() => {
    runtimeSettled = true
  })
  await Promise.resolve()
  assert.equal(runtimeSettled, false)
  resolveRecovery()
  await shutdown.runtimeAbort
  assert.equal(runtimeSettled, true)
})
