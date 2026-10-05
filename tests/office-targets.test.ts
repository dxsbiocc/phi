import assert from 'node:assert/strict'
import { test } from 'node:test'

import { OfficeTargetError, OfficeTargetRegistry } from '../src/main/agent/office/office-targets'

test('a run resolves the immutable Office target captured at bind time', () => {
  const targets = new OfficeTargetRegistry()
  const binding = {
    runId: 'run-1',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  }

  targets.bindRunTarget(binding)
  binding.artifactId = 'artifact-2'

  assert.deepEqual(targets.resolveRunTarget('run-1'), {
    runId: 'run-1',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })
})

test('a bound run deeply freezes its resolved selection snapshot', () => {
  const targets = new OfficeTargetRegistry()
  const paths = ['/Sheet1/A1', '/Sheet1/B1']
  targets.bindRunTarget({
    runId: 'run-selection',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: null,
    selection: {
      sheet: 'Sheet1',
      range: 'A1:B1',
      paths,
      resolvedAt: '2026-10-04T12:00:00.000Z'
    }
  })

  paths[0] = '/Sheet1/Z99'
  assert.deepEqual(targets.resolveRunTarget('run-selection').selection, {
    sheet: 'Sheet1',
    range: 'A1:B1',
    paths: ['/Sheet1/A1', '/Sheet1/B1'],
    resolvedAt: '2026-10-04T12:00:00.000Z'
  })
  assert.equal(Object.isFrozen(targets.resolveRunTarget('run-selection').selection?.paths), true)
})

test('an ordinary session keeps a host-injected null project identity', () => {
  const targets = new OfficeTargetRegistry()
  targets.bindRunTarget({
    runId: 'run-ordinary',
    artifactId: 'artifact-ordinary',
    sessionId: 'session-ordinary',
    projectId: null
  })

  assert.equal(targets.resolveRunTarget('run-ordinary').projectId, null)
})

test('resolving a run that was never bound fails with no_target', () => {
  const targets = new OfficeTargetRegistry()

  assert.throws(
    () => targets.resolveRunTarget('run-missing'),
    (error) => error instanceof OfficeTargetError && error.code === 'no_target'
  )
})

test('a run target cannot be resolved from a different session', () => {
  const targets = new OfficeTargetRegistry()
  targets.bindRunTarget({
    runId: 'run-1',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })

  assert.throws(
    () => targets.resolveRunTarget('run-1', 'session-2'),
    (error) => error instanceof OfficeTargetError && error.code === 'session_mismatch'
  )
  assert.equal(targets.resolveRunTarget('run-1', 'session-1').artifactId, 'artifact-1')
})

test('releasing an artifact makes its bound run fail with target_missing', () => {
  const targets = new OfficeTargetRegistry()
  targets.bindRunTarget({
    runId: 'run-1',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })

  assert.equal(targets.markArtifactReleased('artifact-1'), 1)
  assert.throws(
    () => targets.resolveRunTarget('run-1', 'session-1'),
    (error) => error instanceof OfficeTargetError && error.code === 'target_missing'
  )
})

test('binding the same run twice is rejected without replacing its target', () => {
  const targets = new OfficeTargetRegistry()
  targets.bindRunTarget({
    runId: 'run-1',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })

  assert.throws(
    () =>
      targets.bindRunTarget({
        runId: 'run-1',
        artifactId: 'artifact-2',
        sessionId: 'session-1',
        projectId: 'project-1'
      }),
    (error) => error instanceof OfficeTargetError && error.code === 'target_already_bound'
  )
  assert.equal(targets.resolveRunTarget('run-1').artifactId, 'artifact-1')
})

test('clearing a finished, cancelled, or failed run leaves a target_missing tombstone', () => {
  const targets = new OfficeTargetRegistry()
  targets.bindRunTarget({
    runId: 'run-1',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })

  assert.equal(targets.clearRunTarget('run-1'), true)
  assert.equal(targets.clearRunTarget('run-1'), false)
  assert.throws(
    () => targets.resolveRunTarget('run-1'),
    (error) => error instanceof OfficeTargetError && error.code === 'target_missing'
  )
})

test('run cleanup preserves the missing marker left by an artifact release', () => {
  const targets = new OfficeTargetRegistry()
  targets.bindRunTarget({
    runId: 'run-1',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })
  targets.markArtifactReleased('artifact-1')

  assert.equal(targets.clearRunTarget('run-1'), false)
  assert.throws(
    () => targets.resolveRunTarget('run-1'),
    (error) => error instanceof OfficeTargetError && error.code === 'target_missing'
  )
})

test('closing a session clears its live and released run targets only', () => {
  const targets = new OfficeTargetRegistry()
  targets.bindRunTarget({
    runId: 'run-live',
    artifactId: 'artifact-live',
    sessionId: 'session-1',
    projectId: 'project-1'
  })
  targets.bindRunTarget({
    runId: 'run-released',
    artifactId: 'artifact-released',
    sessionId: 'session-1',
    projectId: 'project-1'
  })
  targets.bindRunTarget({
    runId: 'run-other',
    artifactId: 'artifact-other',
    sessionId: 'session-2',
    projectId: 'project-2'
  })
  targets.markArtifactReleased('artifact-released')

  assert.equal(targets.clearSession('session-1'), 2)
  assert.throws(() => targets.resolveRunTarget('run-live'), { code: 'no_target' })
  assert.throws(() => targets.resolveRunTarget('run-released'), { code: 'no_target' })
  assert.equal(targets.resolveRunTarget('run-other').artifactId, 'artifact-other')
})

test('releasing one run artifact does not affect another run in the same session', () => {
  const targets = new OfficeTargetRegistry()
  targets.bindRunTarget({
    runId: 'run-1',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })
  targets.bindRunTarget({
    runId: 'run-2',
    artifactId: 'artifact-2',
    sessionId: 'session-1',
    projectId: 'project-1'
  })

  targets.markArtifactReleased('artifact-1')

  assert.throws(() => targets.resolveRunTarget('run-1'), { code: 'target_missing' })
  assert.equal(targets.resolveRunTarget('run-2').artifactId, 'artifact-2')
})

test('a bound run owns an abort signal that abortRun cancels idempotently', () => {
  const targets = new OfficeTargetRegistry()
  targets.bindRunTarget({
    runId: 'run-1',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })

  const signal = targets.signalForRun('run-1')
  assert.equal(signal?.aborted, false)
  assert.equal(targets.abortRun('run-1'), true)
  assert.equal(signal?.aborted, true)
  assert.equal(targets.abortRun('run-1'), false)
})

test('run cleanup aborts its controller and prevents the stopped id from being rebound', () => {
  const targets = new OfficeTargetRegistry()
  const target = {
    runId: 'run-1',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  }
  targets.bindRunTarget(target)
  const originalSignal = targets.signalForRun('run-1')

  assert.equal(targets.clearRunTarget('run-1'), true)
  assert.equal(originalSignal?.aborted, true)
  assert.equal(targets.signalForRun('run-1'), undefined)

  assert.throws(() => targets.bindRunTarget(target), { code: 'target_already_bound' })
})

test('artifact and session cleanup abort only their matching run controllers', () => {
  const targets = new OfficeTargetRegistry()
  targets.bindRunTarget({
    runId: 'run-artifact',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })
  targets.bindRunTarget({
    runId: 'run-session',
    artifactId: 'artifact-2',
    sessionId: 'session-1',
    projectId: 'project-1'
  })
  targets.bindRunTarget({
    runId: 'run-other',
    artifactId: 'artifact-3',
    sessionId: 'session-2',
    projectId: 'project-2'
  })
  const artifactSignal = targets.signalForRun('run-artifact')
  const sessionSignal = targets.signalForRun('run-session')
  const otherSignal = targets.signalForRun('run-other')

  targets.markArtifactReleased('artifact-1')
  assert.equal(artifactSignal?.aborted, true)
  assert.equal(targets.signalForRun('run-artifact'), undefined)
  assert.equal(sessionSignal?.aborted, false)

  targets.clearSession('session-1')
  assert.equal(sessionSignal?.aborted, true)
  assert.equal(targets.signalForRun('run-session'), undefined)
  assert.equal(otherSignal?.aborted, false)
})
