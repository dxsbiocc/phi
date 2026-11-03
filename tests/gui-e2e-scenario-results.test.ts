import assert from 'node:assert/strict'
import test from 'node:test'

import type { AppLogEntry } from '../scripts/gui-e2e/jsonl'
import { activeRunIds } from '../scripts/gui-e2e/run-observer'
import {
  evaluateCompletedRuns,
  evaluateDryRun,
  evaluateNotebookSwitch,
  evaluateOutsideReadApproval,
  evaluatePlanMode,
  evaluateRemoteFork,
  evaluateStableServerSwitching
} from '../scripts/gui-e2e/scenario-results'

function log(event: string, overrides: Partial<AppLogEntry> = {}): AppLogEntry {
  return { event, timestamp: '2026-11-02T01:00:00.000Z', ...overrides }
}

test('activeRunIds returns only started runs without a terminal event', () => {
  const entries = [
    log('run_started', { runId: 'finished' }),
    log('run_started', { runId: 'active' }),
    log('run_completed', { runId: 'finished' }),
    log('run_started', { runId: 'failed' }),
    log('run_failed', { runId: 'failed' })
  ]
  assert.deepEqual(activeRunIds(entries), ['active'])
})

test('evaluateCompletedRuns requires every terminal event and rejects ECONNREFUSED', () => {
  const passed = evaluateCompletedRuns(
    [log('run_completed', { runId: 'run-1' }), log('run_completed', { runId: 'run-2' })],
    ['run-1', 'run-2']
  )
  assert.equal(passed.passed, true)

  const refused = evaluateCompletedRuns(
    [log('run_failed', { runId: 'run-1', metadata: { error: 'connect ECONNREFUSED host' } })],
    ['run-1']
  )
  assert.equal(refused.passed, false)
  assert.equal(refused.reason, 'ECONNREFUSED observed')
})

test('evaluateStableServerSwitching rejects connection churn after switching begins', () => {
  const entries = [
    log('remote_connection_opened', {
      timestamp: '2026-11-02T00:59:59.000Z',
      metadata: { layer: 'ssh', target: 'gpu' }
    }),
    log('remote_connection_closed', {
      timestamp: '2026-11-02T01:00:01.000Z',
      metadata: { layer: 'ssh', target: 'gpu' }
    })
  ]
  const result = evaluateStableServerSwitching(entries, {
    serverTargets: ['gpu', 'node-2'],
    switchingStartedAt: '2026-11-02T01:00:00.000Z',
    previousMessagesVisible: true
  })
  assert.equal(result.passed, false)
  assert.equal(result.reason, 'remote connection churn occurred while switching')
})

test('remote fork and plan mode combine durable run outcomes with UI evidence', () => {
  const entries = [
    log('run_completed', { runId: 'fork-run' }),
    log('run_completed', { runId: 'plan-run' })
  ]
  assert.equal(
    evaluateRemoteFork({ entries, forkRunId: 'fork-run', expectedHistoryVisible: true }).passed,
    true
  )
  assert.equal(
    evaluatePlanMode({
      entries,
      runId: 'plan-run',
      reviewShown: true,
      planVisible: true,
      buttonColor: 'rgb( 10, 20, 30 )',
      selectedOptionColor: 'rgb(10,20,30)'
    }).passed,
    true
  )
})

test('plan mode rejects run failure but accepts another terminal event after review', () => {
  const interrupted = evaluatePlanMode({
    entries: [log('run_interrupted', { runId: 'plan-run' })],
    runId: 'plan-run',
    reviewShown: true,
    planVisible: true,
    buttonColor: 'rgb(10,20,30)',
    selectedOptionColor: 'rgb(10,20,30)'
  })
  assert.equal(interrupted.passed, true)

  const failed = evaluatePlanMode({
    entries: [log('run_failed', { runId: 'plan-run' })],
    runId: 'plan-run',
    reviewShown: true,
    planVisible: true,
    buttonColor: 'rgb(10,20,30)',
    selectedOptionColor: 'rgb(10,20,30)'
  })
  assert.equal(failed.passed, false)
  assert.equal(failed.reason, 'plan run failed')
})

test('outside-read approval requires durable decisions and a successful approved tool call', () => {
  const result = evaluateOutsideReadApproval({
    denialRequested: true,
    denialObserved: true,
    deniedContentVisible: false,
    approvalRequested: true,
    approvalObserved: true,
    approvedToolStatus: 'done'
  })
  assert.equal(result.passed, true)

  const leaked = evaluateOutsideReadApproval({
    denialRequested: true,
    denialObserved: true,
    deniedContentVisible: true,
    approvalRequested: true,
    approvalObserved: true,
    approvedToolStatus: 'done'
  })
  assert.equal(leaked.passed, false)
  assert.equal(leaked.reason, 'outside content appeared after denial')

  const failedTool = evaluateOutsideReadApproval({
    denialRequested: true,
    denialObserved: true,
    deniedContentVisible: false,
    approvalRequested: true,
    approvalObserved: true,
    approvedToolStatus: 'error'
  })
  assert.equal(failedTool.passed, false)
  assert.equal(failedTool.reason, 'approved read tool did not finish successfully')
})

test('notebook switching must restore content within one second without a loading state', () => {
  assert.equal(
    evaluateNotebookSwitch({ contentVisibleAfterMs: 999, openingStateObserved: false }).passed,
    true
  )
  assert.equal(
    evaluateNotebookSwitch({ contentVisibleAfterMs: 1_001, openingStateObserved: false }).passed,
    false
  )
  assert.equal(
    evaluateNotebookSwitch({ contentVisibleAfterMs: 50, openingStateObserved: true }).passed,
    false
  )
})

test('dry-run evaluation requires selectors, clean request budget, and no remote connection', () => {
  const probes = [
    { name: 'model', selector: '[data-model]', state: 'found' as const },
    { name: 'session', selector: '[data-session]', state: 'dynamic' as const }
  ]
  assert.equal(evaluateDryRun({ probes, modelRequests: 0, remoteConnections: 0 }).passed, true)
  assert.equal(
    evaluateDryRun({
      probes: [...probes, { name: 'cleanup', selector: '.MuiPopover-root', state: 'missing' }],
      modelRequests: 0,
      remoteConnections: 0
    }).reason,
    'one or more dry-run checks failed'
  )
  assert.equal(evaluateDryRun({ probes, modelRequests: 1, remoteConnections: 0 }).passed, false)
  assert.equal(evaluateDryRun({ probes, modelRequests: 0, remoteConnections: 1 }).passed, false)
})
