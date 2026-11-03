import type { AppLogEntry } from './jsonl'
import type { DryRunProbe } from './types'

export interface ScenarioEvaluation {
  passed: boolean
  reason?: string
  evidence: string[]
}

function metadataString(entry: AppLogEntry, key: string): string | undefined {
  const value = entry.metadata?.[key]
  return typeof value === 'string' ? value : undefined
}

function timestampAtOrAfter(entry: AppLogEntry, boundary: string): boolean {
  const eventTime = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN
  const boundaryTime = Date.parse(boundary)
  return Number.isFinite(eventTime) && Number.isFinite(boundaryTime) && eventTime >= boundaryTime
}

function terminalRunEvent(entries: AppLogEntry[], runId: string): AppLogEntry | undefined {
  return entries.findLast(
    (entry) =>
      entry.runId === runId &&
      ['run_completed', 'run_failed', 'run_interrupted'].includes(entry.event)
  )
}

function failure(reason: string, evidence: string[]): ScenarioEvaluation {
  return { passed: false, reason, evidence }
}

export function evaluateCompletedRuns(
  entries: AppLogEntry[],
  expectedRunIds: string[],
  visibleUiText = ''
): ScenarioEvaluation {
  const completed: string[] = []
  const failed: string[] = []
  const missing: string[] = []
  for (const runId of expectedRunIds) {
    const terminal = terminalRunEvent(entries, runId)
    if (!terminal) missing.push(runId)
    else if (terminal.event === 'run_completed') completed.push(runId)
    else failed.push(runId)
  }
  const refused = entries.some(
    (entry) =>
      entry.event === 'run_failed' && /ECONNREFUSED/i.test(metadataString(entry, 'error') ?? '')
  )
  const uiRefused = /ECONNREFUSED/i.test(visibleUiText)
  const evidence = [
    `completed runs: ${completed.length}/${expectedRunIds.length}`,
    `failed runs: ${failed.length}`,
    `missing terminal events: ${missing.length}`,
    `ECONNREFUSED observed: ${refused || uiRefused ? 'yes' : 'no'}`
  ]
  if (refused || uiRefused) return failure('ECONNREFUSED observed', evidence)
  if (failed.length > 0) return failure('one or more runs failed', evidence)
  if (missing.length > 0) return failure('one or more runs did not finish', evidence)
  return { passed: true, evidence }
}

export function evaluateStableServerSwitching(
  entries: AppLogEntry[],
  input: { serverTargets: string[]; switchingStartedAt: string; previousMessagesVisible: boolean }
): ScenarioEvaluation {
  const targets = new Set(input.serverTargets)
  const churn = entries.filter(
    (entry) =>
      (entry.event === 'remote_connection_opened' || entry.event === 'remote_connection_closed') &&
      timestampAtOrAfter(entry, input.switchingStartedAt) &&
      targets.has(metadataString(entry, 'target') ?? '')
  )
  const evidence = [
    `connection events during switching: ${churn.length}`,
    `previous messages visible without reconnect state: ${input.previousMessagesVisible ? 'yes' : 'no'}`
  ]
  if (churn.length > 0) return failure('remote connection churn occurred while switching', evidence)
  if (!input.previousMessagesVisible)
    return failure('previous messages were not immediately visible', evidence)
  return { passed: true, evidence }
}

export function evaluateRemoteFork(input: {
  entries: AppLogEntry[]
  forkRunId: string
  expectedHistoryVisible: boolean
}): ScenarioEvaluation {
  const runs = evaluateCompletedRuns(input.entries, [input.forkRunId])
  const evidence = [
    ...runs.evidence,
    `fork history visible: ${input.expectedHistoryVisible ? 'yes' : 'no'}`
  ]
  if (!runs.passed) return failure(runs.reason ?? 'fork run failed', evidence)
  if (!input.expectedHistoryVisible) return failure('fork history is incomplete', evidence)
  return { passed: true, evidence }
}

function normalizedColor(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '')
}

export function evaluatePlanMode(input: {
  entries: AppLogEntry[]
  runId: string
  reviewShown: boolean
  planVisible: boolean
  buttonColor: string
  selectedOptionColor: string
}): ScenarioEvaluation {
  const terminal = terminalRunEvent(input.entries, input.runId)
  const colorsMatch =
    normalizedColor(input.buttonColor) === normalizedColor(input.selectedOptionColor)
  const evidence = [
    `plan review shown: ${input.reviewShown ? 'yes' : 'no'}`,
    `plan visible: ${input.planVisible ? 'yes' : 'no'}`,
    `terminal event: ${terminal?.event ?? 'missing'}`,
    `mode colors match: ${colorsMatch ? 'yes' : 'no'}`
  ]
  if (!input.reviewShown) return failure('plan review was not shown', evidence)
  if (!input.planVisible) return failure('plan output was not visible', evidence)
  if (!terminal) return failure('plan run did not finish', evidence)
  if (terminal.event === 'run_failed') return failure('plan run failed', evidence)
  if (!colorsMatch) return failure('mode button color does not match the selected option', evidence)
  return { passed: true, evidence }
}

export function evaluateOutsideReadApproval(input: {
  denialRequested: boolean
  denialObserved: boolean
  deniedContentVisible: boolean
  approvalRequested: boolean
  approvalObserved: boolean
  approvedToolStatus: string | null
}): ScenarioEvaluation {
  const evidence = [
    `denial approval requested: ${input.denialRequested ? 'yes' : 'no'}`,
    `denial recorded: ${input.denialObserved ? 'yes' : 'no'}`,
    `content hidden after denial: ${input.deniedContentVisible ? 'no' : 'yes'}`,
    `approve approval requested: ${input.approvalRequested ? 'yes' : 'no'}`,
    `approval recorded: ${input.approvalObserved ? 'yes' : 'no'}`,
    `approved read tool status: ${input.approvedToolStatus ?? 'missing'}`
  ]
  if (!input.denialRequested) return failure('denial approval was not requested', evidence)
  if (!input.denialObserved) return failure('denial was not recorded', evidence)
  if (input.deniedContentVisible) return failure('outside content appeared after denial', evidence)
  if (!input.approvalRequested) return failure('approve approval was not requested', evidence)
  if (!input.approvalObserved) return failure('approval was not recorded', evidence)
  if (input.approvedToolStatus !== 'done')
    return failure('approved read tool did not finish successfully', evidence)
  return { passed: true, evidence }
}

export function evaluateNotebookSwitch(input: {
  contentVisibleAfterMs: number | null
  openingStateObserved: boolean
}): ScenarioEvaluation {
  const fastEnough =
    input.contentVisibleAfterMs !== null &&
    Number.isFinite(input.contentVisibleAfterMs) &&
    input.contentVisibleAfterMs <= 1_000
  const evidence = [
    `content visible within 1s: ${fastEnough ? 'yes' : 'no'}`,
    `opening state observed: ${input.openingStateObserved ? 'yes' : 'no'}`
  ]
  if (!fastEnough) return failure('notebook content was not visible within one second', evidence)
  if (input.openingStateObserved)
    return failure('notebook opening state appeared on return', evidence)
  return { passed: true, evidence }
}

export function evaluateDryRun(input: {
  probes: DryRunProbe[]
  modelRequests: number
  remoteConnections: number
}): ScenarioEvaluation {
  const missing = input.probes.filter((probe) => probe.state === 'missing')
  const evidence = [
    `selectors found: ${input.probes.filter((probe) => probe.state === 'found').length}`,
    `dynamic selectors deferred: ${input.probes.filter((probe) => probe.state === 'dynamic').length}`,
    `missing selectors: ${missing.map((probe) => probe.name).join(', ') || 'none'}`,
    `model requests used: ${input.modelRequests}`,
    `remote connections opened: ${input.remoteConnections}`
  ]
  if (missing.length > 0) return failure('one or more dry-run checks failed', evidence)
  if (input.modelRequests > 0) return failure('dry-run made a model request', evidence)
  if (input.remoteConnections > 0) return failure('dry-run opened a remote connection', evidence)
  return { passed: true, evidence }
}
