import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  PLAN_RUN_MAX_BYTES,
  listUnfinishedPlanRuns,
  planRunPath,
  readPlanRun,
  writePlanRun
} from '../src/main/agent/plan/persistence/plan-run-store'
import type { PlanRunState, PlanRunStatus } from '../src/shared/planRunTypes'

const CREATED_AT = '2026-10-23T00:00:00.000Z'

function runState(
  id = 'run-1',
  sessionId = 'session-1',
  status: PlanRunStatus = 'running'
): PlanRunState {
  const finished = status === 'completed' || status === 'stopped'
  return {
    id,
    sessionId,
    spec: {
      version: 1,
      goal: 'Persist a plan run',
      steps: [
        {
          id: 'store',
          title: 'Store the run',
          instructions: 'Write the run to private storage.',
          acceptance: 'The state can be recovered.',
          dependsOn: [],
          access: 'write',
          writes: ['src/main/agent/plan']
        }
      ]
    },
    status,
    steps: {
      store: {
        status: status === 'completed' ? 'done' : status === 'stopped' ? 'cancelled' : 'pending',
        attempts: finished ? 1 : 0,
        ...(finished ? { finishedAt: CREATED_AT } : {})
      }
    },
    ...(status === 'paused' ? { pause: { reason: 'user' as const } } : {}),
    replans: 0,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT
  }
}

function fixture(t: test.TestContext): string {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-plan-run-store-'))
  t.after(() => rmSync(agentDir, { recursive: true, force: true }))
  return agentDir
}

test('planRunPath is side-effect free and rejects unsafe filename fragments', (t) => {
  const agentDir = fixture(t)
  const expected = join(agentDir, 'sessions', 'session-1', 'plan-runs', 'run-1.json')

  assert.equal(planRunPath('session-1', 'run-1', agentDir), expected)
  assert.equal(existsSync(join(agentDir, 'sessions')), false)

  for (const unsafe of ['', '.', '..', '../peer', 'peer/run', 'peer\\run', 'run.json', '中文']) {
    assert.throws(() => planRunPath(unsafe, 'run-1', agentDir), /Invalid session id/)
    assert.throws(() => planRunPath('session-1', unsafe, agentDir), /Invalid run id/)
  }
})

test('writePlanRun creates private storage and atomically replaces the document', (t) => {
  const agentDir = fixture(t)
  const first = runState()
  const path = planRunPath(first.sessionId, first.id, agentDir)

  writePlanRun(first, agentDir)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.deepEqual(readPlanRun(first.sessionId, first.id, agentDir), first)

  const second = { ...first, updatedAt: '2026-10-23T00:01:00.000Z' }
  chmodSync(path, 0o644)
  writePlanRun(second, agentDir)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.deepEqual(readPlanRun(first.sessionId, first.id, agentDir), second)
  assert.deepEqual(readdirSync(join(agentDir, 'sessions', first.sessionId, 'plan-runs')), [
    'run-1.json'
  ])
})

test('writePlanRun enforces the 256 KB serialized byte limit', (t) => {
  const agentDir = fixture(t)
  const base = runState()
  const oversized: PlanRunState = {
    ...base,
    steps: {
      store: { ...base.steps.store, error: 'x'.repeat(PLAN_RUN_MAX_BYTES) }
    }
  }

  assert.throws(() => writePlanRun(oversized, agentDir), /byte limit/)
  assert.equal(existsSync(planRunPath(base.sessionId, base.id, agentDir)), false)
})

test('readPlanRun returns null for absent, malformed, oversized, and invalid UTF-8 files', (t) => {
  const agentDir = fixture(t)
  const state = runState()
  const path = planRunPath(state.sessionId, state.id, agentDir)
  mkdirSync(join(agentDir, 'sessions', state.sessionId, 'plan-runs'), { recursive: true })

  assert.equal(readPlanRun(state.sessionId, 'absent', agentDir), null)
  for (const content of [
    Buffer.from('{bad json'),
    Buffer.from([0xff]),
    Buffer.alloc(PLAN_RUN_MAX_BYTES + 1)
  ]) {
    writeFileSync(path, content, { mode: 0o600 })
    assert.equal(readPlanRun(state.sessionId, state.id, agentDir), null)
  }
  writeFileSync(path, '{"id":"run-1"}', { mode: 0o600 })
  assert.equal(readPlanRun(state.sessionId, state.id, agentDir), null)
})

test('readPlanRun rejects symlinks while atomic write preserves the symlink victim', (t) => {
  const agentDir = fixture(t)
  const state = runState()
  const path = planRunPath(state.sessionId, state.id, agentDir)
  const directory = join(agentDir, 'sessions', state.sessionId, 'plan-runs')
  const victim = join(agentDir, 'victim.json')
  mkdirSync(directory, { recursive: true })
  writeFileSync(victim, 'private victim', { mode: 0o600 })
  symlinkSync(victim, path)

  assert.equal(readPlanRun(state.sessionId, state.id, agentDir), null)
  writePlanRun(state, agentDir)

  assert.equal(readFileSync(victim, 'utf8'), 'private victim')
  assert.equal(lstatSync(path).isSymbolicLink(), false)
  assert.deepEqual(readPlanRun(state.sessionId, state.id, agentDir), state)
})

test('storage rejects a symlinked intermediate directory', (t) => {
  const agentDir = fixture(t)
  const outside = mkdtempSync(join(tmpdir(), 'phi-plan-run-victim-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  symlinkSync(outside, join(agentDir, 'sessions'))
  const state = runState()

  assert.throws(() => writePlanRun(state, agentDir), /Invalid recovery store directory/)
  assert.equal(readPlanRun(state.sessionId, state.id, agentDir), null)
  assert.deepEqual(listUnfinishedPlanRuns(state.sessionId, agentDir), [])
  assert.deepEqual(readdirSync(outside), [])
})

test('readPlanRun rejects identity mismatches and unsafe lookup identifiers', (t) => {
  const agentDir = fixture(t)
  const state = runState()
  writePlanRun(state, agentDir)
  const serialized = readFileSync(planRunPath(state.sessionId, state.id, agentDir))
  const peerPath = planRunPath(state.sessionId, 'peer-run', agentDir)
  writeFileSync(peerPath, serialized, { mode: 0o600 })

  assert.equal(readPlanRun(state.sessionId, 'peer-run', agentDir), null)
  assert.throws(() => readPlanRun('../peer', state.id, agentDir), /Invalid session id/)
  assert.throws(() => readPlanRun(state.sessionId, '../peer', agentDir), /Invalid run id/)
  assert.throws(
    () => writePlanRun({ ...state, sessionId: '../peer' }, agentDir),
    /Invalid session id/
  )
})

test('listUnfinishedPlanRuns returns only valid running and paused runs in stable order', (t) => {
  const agentDir = fixture(t)
  const states = [
    runState('run-b', 'session-1', 'paused'),
    runState('run-a', 'session-1', 'running'),
    runState('run-c', 'session-1', 'completed'),
    runState('run-d', 'session-1', 'stopped')
  ]
  for (const state of states) writePlanRun(state, agentDir)

  assert.deepEqual(
    listUnfinishedPlanRuns('session-1', agentDir).map((state) => state.id),
    ['run-a', 'run-b']
  )
})

test('listUnfinishedPlanRuns ignores each bad entry without hiding valid runs', (t) => {
  const agentDir = fixture(t)
  const valid = runState('valid')
  writePlanRun(valid, agentDir)
  const directory = join(agentDir, 'sessions', valid.sessionId, 'plan-runs')
  writeFileSync(join(directory, 'broken.json'), '{bad', { mode: 0o600 })
  writeFileSync(join(directory, 'oversized.json'), Buffer.alloc(PLAN_RUN_MAX_BYTES + 1))
  writeFileSync(join(directory, 'wrong.json'), JSON.stringify(runState('other')))
  writeFileSync(join(directory, 'ignored.txt'), JSON.stringify(valid))
  mkdirSync(join(directory, 'directory.json'))
  symlinkSync(planRunPath(valid.sessionId, valid.id, agentDir), join(directory, 'linked.json'))

  assert.deepEqual(listUnfinishedPlanRuns(valid.sessionId, agentDir), [valid])
  assert.deepEqual(listUnfinishedPlanRuns('missing-session', agentDir), [])
  assert.throws(() => listUnfinishedPlanRuns('../peer', agentDir), /Invalid session id/)
})

test('readPlanRun rejects a FIFO without blocking', { skip: process.platform === 'win32' }, (t) => {
  const agentDir = fixture(t)
  const path = planRunPath('session-1', 'fifo-run', agentDir)
  mkdirSync(join(agentDir, 'sessions', 'session-1', 'plan-runs'), { recursive: true })
  execFileSync('mkfifo', [path])

  assert.equal(readPlanRun('session-1', 'fifo-run', agentDir), null)
})
