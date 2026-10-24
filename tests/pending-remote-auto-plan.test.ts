import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  clearPendingRemoteAutoPlanAfterTurn,
  effectiveRecoveredRemoteAutoMode,
  readPendingRemoteAutoPlan,
  writePendingRemoteAutoPlan,
  type PendingRemoteAutoPlan
} from '../src/main/agent/session/pending-remote-auto-plan'

const marker: PendingRemoteAutoPlan = {
  version: 1,
  phiSessionId: 'phi-1',
  runId: 'run-1',
  sessionGeneration: 3,
  mode: 'plan_execute'
}

function withDirectory(callback: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'phi-pending-plan-'))
  try {
    writeFileSync(join(directory, 'messages.jsonl'), '')
    writeFileSync(join(directory, 'manifest.json'), '{}')
    callback(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('pending remote auto plan survives review return and recovers as read-only', () => {
  withDirectory((directory) => {
    writePendingRemoteAutoPlan(directory, marker)
    assert.deepEqual(readPendingRemoteAutoPlan(directory), { state: 'pending', marker })
    // Review approval/cancellation is not terminal: the signed result has not yet completed the turn.
    assert.deepEqual(
      effectiveRecoveredRemoteAutoMode({
        directory,
        phiSessionId: 'phi-1',
        runId: 'run-1',
        sessionGeneration: 3,
        savedMode: 'auto'
      }),
      { mode: 'plan_execute', tainted: true }
    )
    assert.equal(
      clearPendingRemoteAutoPlanAfterTurn({
        directory,
        phiSessionId: 'phi-1',
        runId: 'run-1',
        settledRunId: 'run-1',
        terminalEventRunId: 'run-1'
      }),
      false
    )
    assert.equal(readPendingRemoteAutoPlan(directory).state, 'pending')
  })
})

test('mismatched or corrupt pending evidence fails closed on recovery', () => {
  withDirectory((directory) => {
    writePendingRemoteAutoPlan(directory, marker)
    for (const changed of [
      { runId: 'run-2' },
      { sessionGeneration: 4 },
      { phiSessionId: 'phi-2' },
      { savedMode: 'direct' as const }
    ]) {
      assert.deepEqual(
        effectiveRecoveredRemoteAutoMode({
          directory,
          phiSessionId: 'phi-1',
          runId: 'run-1',
          sessionGeneration: 3,
          savedMode: 'auto',
          ...changed
        }),
        { mode: 'plan', tainted: true }
      )
    }
    writeFileSync(join(directory, 'pending-remote-auto-plan.json'), '{bad')
    assert.deepEqual(
      effectiveRecoveredRemoteAutoMode({
        directory,
        phiSessionId: 'phi-1',
        runId: 'run-1',
        sessionGeneration: 3,
        savedMode: 'auto'
      }),
      { mode: 'plan', tainted: true }
    )
    assert.throws(() => writePendingRemoteAutoPlan(directory, marker), /unresolved/)
  })
})

test('symlink and oversized markers fail closed without reading their target', () => {
  withDirectory((directory) => {
    const target = join(directory, 'target.json')
    writeFileSync(target, JSON.stringify(marker))
    symlinkSync(target, join(directory, 'pending-remote-auto-plan.json'))
    assert.deepEqual(readPendingRemoteAutoPlan(directory), { state: 'invalid' })
    assert.deepEqual(
      effectiveRecoveredRemoteAutoMode({
        directory,
        phiSessionId: 'phi-1',
        runId: 'run-1',
        sessionGeneration: 3,
        savedMode: 'auto'
      }),
      { mode: 'plan', tainted: true }
    )
    rmSync(join(directory, 'pending-remote-auto-plan.json'))
    writeFileSync(join(directory, 'pending-remote-auto-plan.json'), 'x'.repeat(1024 * 1024))
    assert.deepEqual(readPendingRemoteAutoPlan(directory), { state: 'invalid' })
  })
})

test('marker clears only after this run has a terminal event and settled state', () => {
  withDirectory((directory) => {
    writePendingRemoteAutoPlan(directory, marker)
    const clear = (
      overrides: Partial<Parameters<typeof clearPendingRemoteAutoPlanAfterTurn>[0]> = {}
    ): boolean =>
      clearPendingRemoteAutoPlanAfterTurn({
        directory,
        phiSessionId: 'phi-1',
        runId: 'run-1',
        settledRunId: undefined,
        terminalEventRunId: 'run-1',
        ...overrides
      })
    assert.equal(clear({ terminalEventRunId: 'run-2' }), false)
    assert.equal(clear({ runId: 'run-2' }), false)
    assert.equal(readPendingRemoteAutoPlan(directory).state, 'pending')
    assert.equal(clear(), true)
    assert.deepEqual(
      effectiveRecoveredRemoteAutoMode({
        directory,
        phiSessionId: 'phi-1',
        runId: 'run-2',
        sessionGeneration: 4,
        savedMode: 'auto'
      }),
      { mode: 'auto', tainted: false }
    )
  })
})

test('a second writer cannot replace a marker between identity check and unlink', () => {
  withDirectory((directory) => {
    writePendingRemoteAutoPlan(directory, marker)
    const next = { ...marker, runId: 'run-2' }
    assert.equal(
      clearPendingRemoteAutoPlanAfterTurn({
        directory,
        phiSessionId: 'phi-1',
        runId: 'run-1',
        settledRunId: undefined,
        terminalEventRunId: 'run-1',
        beforeUnlink: () => {
          assert.throws(() => writePendingRemoteAutoPlan(directory, next), /EEXIST/)
          assert.deepEqual(readPendingRemoteAutoPlan(directory), { state: 'pending', marker })
        }
      }),
      true
    )
    writePendingRemoteAutoPlan(directory, next)
    assert.deepEqual(readPendingRemoteAutoPlan(directory), { state: 'pending', marker: next })
  })
})

test('failed settlement sync retains the read-only marker', () => {
  withDirectory((directory) => {
    writePendingRemoteAutoPlan(directory, marker)
    rmSync(join(directory, 'messages.jsonl'))
    assert.equal(
      clearPendingRemoteAutoPlanAfterTurn({
        directory,
        phiSessionId: 'phi-1',
        runId: 'run-1',
        settledRunId: undefined,
        terminalEventRunId: 'run-1'
      }),
      false
    )
    assert.deepEqual(readPendingRemoteAutoPlan(directory), { state: 'pending', marker })
  })
})

test('stale settlement lock without marker recovers read-only', () => {
  withDirectory((directory) => {
    mkdirSync(join(directory, '.pending-remote-auto-plan.lock'))
    assert.deepEqual(
      effectiveRecoveredRemoteAutoMode({
        directory,
        phiSessionId: 'phi-1',
        runId: 'run-1',
        sessionGeneration: 3,
        savedMode: 'auto'
      }),
      { mode: 'plan', tainted: true }
    )
  })
})

test('a failed timeline append leaves the already persisted marker intact', () => {
  withDirectory((directory) => {
    writePendingRemoteAutoPlan(directory, marker)
    assert.match(
      readFileSync(join(directory, 'pending-remote-auto-plan.json'), 'utf8'),
      /plan_execute/
    )
    assert.throws(
      () => writePendingRemoteAutoPlan(directory, { ...marker, runId: 'run-2' }),
      /unresolved/
    )
    assert.equal(readPendingRemoteAutoPlan(directory).state, 'pending')
  })
})
