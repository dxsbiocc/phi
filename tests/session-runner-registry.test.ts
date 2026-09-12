import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SessionRunnerRegistry } from '../src/main/agent/session/session-runner-registry'
import {
  createPhiSession,
  createRunId,
  listPhiSessions,
  readSessionEvents
} from '../src/main/agent/session/session-store'

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

async function withPhiDir<T>(callback: () => Promise<T>): Promise<T> {
  const previous = process.env.PI_CODING_AGENT_DIR
  const phiDir = mkdtempSync(join(tmpdir(), 'phi-runner-registry-'))
  process.env.PI_CODING_AGENT_DIR = phiDir
  try {
    return await callback()
  } finally {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR
    } else {
      process.env.PI_CODING_AGENT_DIR = previous
    }
    rmSync(phiDir, { recursive: true, force: true })
  }
}

function createTestSession(): string {
  return createPhiSession({
    kind: 'ordinary',
    cwd: '/workspace',
    cwdRealPath: '/workspace',
    permissionMode: 'auto'
  }).sessionId
}

test('runner allows independent sessions and stopping one leaves the other running', async () => {
  await withPhiDir(async () => {
    const registry = new SessionRunnerRegistry()
    const firstSessionId = createTestSession()
    const secondSessionId = createTestSession()
    const firstGate = deferred()
    const secondGate = deferred()

    const first = registry.startRun({
      sessionId: firstSessionId,
      runId: createRunId(),
      execute: async ({ signal }) => {
        await firstGate.promise
        if (signal.aborted) throw signal.reason
      }
    })
    const second = registry.startRun({
      sessionId: secondSessionId,
      runId: createRunId(),
      execute: async ({ signal }) => {
        await secondGate.promise
        if (signal.aborted) throw signal.reason
      }
    })

    assert.equal(registry.activeCount, 2)
    registry.stopRun(firstSessionId)
    firstGate.resolve()
    await first.done

    assert.equal(first.outcome, 'stopped')
    assert.equal(registry.getActiveRun(firstSessionId), null)
    assert.equal(registry.getActiveRun(secondSessionId)?.runId, second.runId)
    assert.equal(registry.activeCount, 1)

    secondGate.resolve()
    await second.done
    assert.equal(second.outcome, 'completed')
    assert.equal(registry.activeCount, 0)
  })
})

test('runner rejects concurrent runs in the same session', async () => {
  await withPhiDir(async () => {
    const registry = new SessionRunnerRegistry()
    const sessionId = createTestSession()
    const gate = deferred()

    const run = registry.startRun({
      sessionId,
      runId: createRunId(),
      execute: async () => {
        await gate.promise
      }
    })

    assert.throws(
      () =>
        registry.startRun({
          sessionId,
          runId: createRunId(),
          execute: async () => undefined
        }),
      /会话正在运行/
    )

    gate.resolve()
    await run.done
  })
})

test('runner records and clears the current run start time', async () => {
  await withPhiDir(async () => {
    const registry = new SessionRunnerRegistry()
    const sessionId = createTestSession()
    const gate = deferred()

    const run = registry.startRun({
      sessionId,
      runId: createRunId(),
      execute: async () => {
        await gate.promise
      }
    })

    let [manifest] = listPhiSessions()
    assert.equal(manifest.status, 'running')
    assert.equal(typeof manifest.currentRunStartedAt, 'string')

    gate.resolve()
    await run.done

    ;[manifest] = listPhiSessions()
    assert.equal(manifest.status, 'completed_unread')
    assert.equal(manifest.currentRunStartedAt, undefined)
  })
})

test('runner enforces active run limit without queueing', async () => {
  await withPhiDir(async () => {
    const registry = new SessionRunnerRegistry({ maxActiveRuns: 2 })
    const gates = [deferred(), deferred()]
    for (const gate of gates) {
      registry.startRun({
        sessionId: createTestSession(),
        runId: createRunId(),
        execute: async () => {
          await gate.promise
        }
      })
    }

    assert.throws(
      () =>
        registry.startRun({
          sessionId: createTestSession(),
          runId: createRunId(),
          execute: async () => undefined
        }),
      /运行中的会话已达上限/
    )

    gates.forEach((gate) => gate.resolve())
    await Promise.all(registry.getActiveRuns().map((run) => run.done))
  })
})

test('runner records lifecycle events and failed outcome', async () => {
  await withPhiDir(async () => {
    const registry = new SessionRunnerRegistry()
    const sessionId = createTestSession()
    const runId = createRunId()
    const run = registry.startRun({
      sessionId,
      runId,
      execute: async () => {
        throw new Error('boom org-930ebedfe4d54cf998034940e3c937c1<ak-fch4ix7rq6wi11c3z111>')
      }
    })

    await run.done

    assert.equal(run.outcome, 'failed')
    const events = readSessionEvents(sessionId)
    assert.deepEqual(
      events.map((event) => event.type),
      ['run_started', 'run_failed']
    )
    assert.equal(events[0].runId, runId)
    assert.equal(events[0].createdAt, run.startedAt)
    assert.equal(typeof events[1].durationMs, 'number')
    assert.equal(events[1].errorMessage, 'boom [redacted]')
  })
})

test('runner emits persisted lifecycle events for live renderer updates', async () => {
  await withPhiDir(async () => {
    const emitted: Array<{ sessionId: string; type: string; errorMessage?: unknown }> = []
    const registry = new SessionRunnerRegistry({
      onSessionEvent: (sessionId, event) => {
        emitted.push({ sessionId, type: event.type, errorMessage: event.errorMessage })
      }
    })
    const sessionId = createTestSession()
    const run = registry.startRun({
      sessionId,
      runId: createRunId(),
      execute: async () => {
        throw new Error('404 Not found the model kimi-k2.5 or Permission denied')
      }
    })

    await run.done

    assert.deepEqual(
      emitted.map((event) => event.type),
      ['run_started', 'run_failed']
    )
    assert.equal(emitted[1].sessionId, sessionId)
    assert.equal(emitted[1].errorMessage, '404 Not found the model kimi-k2.5 or Permission denied')
  })
})

test('runner keeps an already recorded assistant failure from becoming completed', async () => {
  await withPhiDir(async () => {
    const registry = new SessionRunnerRegistry()
    const sessionId = createTestSession()
    const runId = createRunId()
    const run = registry.startRun({
      sessionId,
      runId,
      getRecordedFailure: () => '404 Not found the model kimi-k2.5 or Permission denied',
      execute: async () => undefined
    })

    await run.done

    assert.equal(run.outcome, 'failed')
    const events = readSessionEvents(sessionId)
    assert.deepEqual(
      events.map((event) => event.type),
      ['run_started', 'run_failed']
    )
    assert.equal(typeof events[1].durationMs, 'number')
    assert.equal(listPhiSessions()[0].status, 'failed')
    assert.equal(listPhiSessions()[0].unreadKind, 'failed')
  })
})

test('runner can mark a run as needing approval and then resume state', async () => {
  await withPhiDir(async () => {
    const registry = new SessionRunnerRegistry()
    const sessionId = createTestSession()
    const approvalGate = deferred()
    const run = registry.startRun({
      sessionId,
      runId: createRunId(),
      execute: async () => {
        registry.markNeedsApproval(sessionId, 'approval-1')
        await approvalGate.promise
        registry.markRunning(sessionId)
      }
    })

    await tick()
    assert.equal(registry.getActiveRun(sessionId)?.status, 'needs_approval')

    approvalGate.resolve()
    await run.done
    assert.equal(run.outcome, 'completed')
    assert.deepEqual(
      readSessionEvents(sessionId).map((event) => event.type),
      ['run_started', 'approval_requested', 'run_resumed', 'run_completed']
    )
    assert.equal(typeof readSessionEvents(sessionId).at(-1)?.durationMs, 'number')
  })
})

test('runner records approval approval and denial decisions', async () => {
  await withPhiDir(async () => {
    const registry = new SessionRunnerRegistry()
    const approvedSessionId = createTestSession()
    const deniedSessionId = createTestSession()
    const approvedGate = deferred()
    const deniedGate = deferred()

    const approved = registry.startRun({
      sessionId: approvedSessionId,
      runId: createRunId(),
      execute: async () => {
        registry.markNeedsApproval(approvedSessionId, 'approval-ok', {
          toolName: 'bash',
          summary: 'npm test'
        })
        registry.markApprovalApproved(approvedSessionId, 'approval-ok')
        await approvedGate.promise
      }
    })
    const denied = registry.startRun({
      sessionId: deniedSessionId,
      runId: createRunId(),
      execute: async () => {
        registry.markNeedsApproval(deniedSessionId, 'approval-no')
        registry.markApprovalDenied(deniedSessionId, 'approval-no')
        await deniedGate.promise
        throw new Error('用户拒绝了该操作')
      }
    })

    await tick()
    approvedGate.resolve()
    deniedGate.resolve()
    await Promise.all([approved.done, denied.done])

    const approvedEvents = readSessionEvents(approvedSessionId)
    assert.deepEqual(
      approvedEvents.map((event) => event.type),
      ['run_started', 'approval_requested', 'approval_approved', 'run_completed']
    )
    assert.equal(approvedEvents[1].toolName, 'bash')
    assert.equal(approvedEvents[1].summary, 'npm test')

    assert.deepEqual(
      readSessionEvents(deniedSessionId).map((event) => event.type),
      ['run_started', 'approval_requested', 'approval_denied', 'run_failed']
    )
  })
})
