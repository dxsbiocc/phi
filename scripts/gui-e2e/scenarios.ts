import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Locator } from 'playwright-core'

import { readPersistedRequestEvents } from './request-budget'
import {
  evaluateCompletedRuns,
  evaluateNotebookSwitch,
  evaluateOutsideReadApproval,
  evaluatePlanMode,
  evaluateRemoteFork,
  evaluateStableServerSwitching,
  type ScenarioEvaluation
} from './scenario-results'
import { logsSince, observeBudget, startObservedRun, waitForRunTerminal } from './run-observer'
import { ScenarioSkip, type HarnessContext, type RemoteProject, type ScenarioName } from './types'
import {
  approvePlanReview,
  clickApproval,
  denyPendingApproval,
  clickLastFork,
  connectionProgressVisible,
  listNotebooks,
  openNotebookFromFiles,
  openProjectHome,
  projectSessionRows,
  selectPlanMode,
  selectProjectSession,
  submitChatPrompt,
  submitHomePrompt
} from './ui'

export interface ScenarioOutcome {
  passed: boolean
  evidence: string[]
  reason?: string
}

const TOKENS = {
  switchA: 'PHI-OK-1',
  switchB: 'PHI-OK-2',
  reconnect1: 'PHI-OK-3',
  reconnect2: 'PHI-OK-4',
  reconnect3: 'PHI-OK-5',
  forkBase: 'PHI-OK-6',
  forkChild: 'PHI-OK-7'
} as const

function projectA(context: HarnessContext): RemoteProject {
  const project = context.projects[0]
  if (!project) throw new ScenarioSkip('server A project is missing')
  return project
}

function projectB(context: HarnessContext): RemoteProject {
  const first = projectA(context)
  const project = context.projects.find((candidate) => candidate.id !== first.id)
  if (!project) throw new ScenarioSkip('server B project is missing or matches server A')
  return project
}

function exactReply(token: string): string {
  return `Reply with exactly: ${token}`
}

async function createAndRun(
  context: HarnessContext,
  project: RemoteProject,
  prompt: string
): Promise<string> {
  await openProjectHome(context.page, project)
  const runId = await startObservedRun(
    context,
    () => submitHomePrompt(context.page, prompt, context.model),
    3
  )
  const terminal = await waitForRunTerminal(context, runId)
  if (terminal.sessionId) await waitForAutomaticTitle(context, terminal.sessionId)
  return runId
}

function automaticTitleSettled(context: HarnessContext, sessionId: string): boolean {
  const manifestPath = join(context.home, '.phi', 'sessions', sessionId, 'manifest.json')
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
      if (manifest.titleSource === 'auto') return true
    } catch {
      // Keep polling; the app may be atomically replacing the manifest.
    }
  }
  return logsSince(context.home, '1970-01-01T00:00:00.000Z').some(
    (entry) => entry.event === 'session_auto_title_unavailable' && entry.sessionId === sessionId
  )
}

async function waitForAutomaticTitle(context: HarnessContext, sessionId: string): Promise<void> {
  const deadline = Date.now() + 35_000
  while (Date.now() < deadline) {
    if (automaticTitleSettled(context, sessionId)) {
      observeBudget(context.home, context.budget)
      const snapshot = context.budget.snapshot()
      if (snapshot.overLimit) {
        throw new Error(
          `Model request ceiling exceeded (${snapshot.usedRequests}/${snapshot.maxRequests})`
        )
      }
      return
    }
    if (context.abortSignal.aborted) throw context.abortSignal.reason
    await context.page.waitForTimeout(100)
  }
  throw new Error(`Automatic title request did not settle for session ${sessionId}`)
}

function outcome(evaluation: ScenarioEvaluation): ScenarioOutcome {
  return {
    passed: evaluation.passed,
    evidence: evaluation.evidence,
    ...(evaluation.reason ? { reason: evaluation.reason } : {})
  }
}

async function tokenVisible(context: HarnessContext, token: string): Promise<boolean> {
  const text = context.page.getByText(token, { exact: true }).last()
  try {
    await text.waitFor({ state: 'visible', timeout: 1_500 })
    return !(await connectionProgressVisible(context.page))
  } catch {
    return false
  }
}

async function switchCycle(
  context: HarnessContext,
  first: RemoteProject,
  second: RemoteProject
): Promise<boolean> {
  let visible = true
  for (let cycle = 0; cycle < 3; cycle += 1) {
    for (const [project, token] of [
      [first, TOKENS.switchA],
      [second, TOKENS.switchB],
      [first, TOKENS.switchA],
      [second, TOKENS.switchB]
    ] as const) {
      await selectProjectSession(context.page, project, 0)
      visible = (await tokenVisible(context, token)) && visible
    }
  }
  return visible
}

async function switchServers(context: HarnessContext): Promise<ScenarioOutcome> {
  const startedAt = new Date().toISOString()
  const first = projectA(context)
  const second = projectB(context)
  const firstRun = await createAndRun(context, first, exactReply(TOKENS.switchA))
  const secondRun = await createAndRun(context, second, exactReply(TOKENS.switchB))
  const switchingStartedAt = new Date().toISOString()
  const previousMessagesVisible = await switchCycle(context, first, second)
  const entries = logsSince(context.home, startedAt)
  const targets = entries.flatMap((entry) => {
    const target = entry.metadata?.target
    return entry.event.startsWith('remote_connection_') && typeof target === 'string'
      ? [target]
      : []
  })
  const runs = evaluateCompletedRuns(entries, [firstRun, secondRun])
  const stable = evaluateStableServerSwitching(entries, {
    serverTargets: [...new Set(targets)],
    switchingStartedAt,
    previousMessagesVisible
  })
  return outcome({
    passed: runs.passed && stable.passed,
    reason: runs.reason ?? stable.reason,
    evidence: [...runs.evidence, ...stable.evidence]
  })
}

async function reconnectReturn(context: HarnessContext): Promise<ScenarioOutcome> {
  const startedAt = new Date().toISOString()
  const project = projectA(context)
  const firstRun = await createAndRun(context, project, exactReply(TOKENS.reconnect1))
  const secondRun = await createAndRun(context, project, exactReply(TOKENS.reconnect2))
  await selectProjectSession(context.page, project, 1)
  const thirdRun = await startObservedRun(context, () =>
    submitChatPrompt(context.page, exactReply(TOKENS.reconnect3))
  )
  await waitForRunTerminal(context, thirdRun)
  const uiText = await context.page.locator('body').innerText()
  return outcome(
    evaluateCompletedRuns(
      logsSince(context.home, startedAt),
      [firstRun, secondRun, thirdRun],
      uiText
    )
  )
}

async function remoteFork(context: HarnessContext): Promise<ScenarioOutcome> {
  const startedAt = new Date().toISOString()
  const project = projectA(context)
  await createAndRun(context, project, exactReply(TOKENS.forkBase))
  await clickLastFork(context.page)
  const expectedHistoryVisible = await tokenVisible(context, TOKENS.forkBase)
  const forkRunId = await startObservedRun(context, () =>
    submitChatPrompt(context.page, exactReply(TOKENS.forkChild))
  )
  await waitForRunTerminal(context, forkRunId)
  return outcome(
    evaluateRemoteFork({
      entries: logsSince(context.home, startedAt),
      forkRunId,
      expectedHistoryVisible
    })
  )
}

async function planMode(context: HarnessContext): Promise<ScenarioOutcome> {
  const startedAt = new Date().toISOString()
  await openProjectHome(context.page, projectA(context))
  const colors = await selectPlanMode(context.page)
  const prompt = 'Plan only: list two steps to print hello. Do not run anything.'
  const runId = await startObservedRun(
    context,
    () => submitHomePrompt(context.page, prompt, context.model),
    3
  )
  const review = await approvePlanReview(context.page)
  const terminal = await waitForRunTerminal(context, runId)
  if (terminal.sessionId) await waitForAutomaticTitle(context, terminal.sessionId)
  return outcome(
    evaluatePlanMode({
      entries: logsSince(context.home, startedAt),
      runId,
      reviewShown: review.reviewShown,
      planVisible: review.planVisible,
      buttonColor: colors.trigger,
      selectedOptionColor: colors.option
    })
  )
}

function sessionEvents(context: HarnessContext): Record<string, unknown>[] {
  return readPersistedRequestEvents(join(context.home, '.phi')).events
}

/** The read tool's result in the session journal; tool cards stay collapsed in the UI. */
function readToolStatus(context: HarnessContext, runId: string): string | null {
  const completed = sessionEvents(context)
    .filter(
      (event) =>
        event.runId === runId && event.type === 'tool_call_completed' && event.toolName === 'read'
    )
    .at(-1)
  if (!completed) return null
  return completed.isError === true ? 'error' : 'done'
}

function approvalRecorded(
  context: HarnessContext,
  runId: string,
  eventType: 'approval_requested' | 'approval_denied' | 'approval_approved'
): boolean {
  return sessionEvents(context).some((event) => event.runId === runId && event.type === eventType)
}

async function outsideReadApproval(context: HarnessContext): Promise<ScenarioOutcome> {
  const project = projectA(context)
  await openProjectHome(context.page, project)
  const prompt = 'Use the read tool once to read /etc/hostname. Do not do anything else.'
  const toolOutput = context.page.locator('[data-testid="gui-e2e-tool-output"]:visible')
  const deniedRun = await startObservedRun(context, () =>
    submitHomePrompt(context.page, prompt, context.model)
  )
  await clickApproval(context.page, false)
  // After a denial the model may ask again with another path in the same run; deny those too.
  await waitForRunTerminal(context, deniedRun, () => denyPendingApproval(context.page))
  const deniedContentVisible = (await toolOutput.count()) > 0
  const approvedRun = await startObservedRun(
    context,
    () => submitChatPrompt(context.page, prompt),
    3
  )
  await clickApproval(context.page, true)
  const approvedTerminal = await waitForRunTerminal(context, approvedRun)
  if (approvedTerminal.sessionId) {
    await waitForAutomaticTitle(context, approvedTerminal.sessionId)
  }
  const approvedToolStatus = readToolStatus(context, approvedRun)
  return outcome(
    evaluateOutsideReadApproval({
      denialRequested: approvalRecorded(context, deniedRun, 'approval_requested'),
      denialObserved: approvalRecorded(context, deniedRun, 'approval_denied'),
      deniedContentVisible,
      approvalRequested: approvalRecorded(context, approvedRun, 'approval_requested'),
      approvalObserved: approvalRecorded(context, approvedRun, 'approval_approved'),
      approvedToolStatus
    })
  )
}

async function existingSession(context: HarnessContext, project: RemoteProject): Promise<Locator> {
  const rows = await projectSessionRows(context.page, project)
  if ((await rows.count()) === 0) throw new ScenarioSkip(`${project.name} has no existing session`)
  return rows.first()
}

async function waitForNotebookReturn(
  context: HarnessContext,
  started: number
): Promise<{
  elapsed: number | null
  opening: boolean
}> {
  let opening = false
  while (Date.now() - started <= 1_000) {
    opening =
      opening ||
      (await context.page.locator('[data-testid="gui-e2e-notebook-opening"]:visible').count()) > 0
    if (
      (await context.page.locator('[data-phi-notebook-virtual-list="true"]:visible').count()) > 0
    ) {
      return { elapsed: Date.now() - started, opening }
    }
    await context.page.waitForTimeout(50)
  }
  return { elapsed: null, opening }
}

async function notebookSwitch(context: HarnessContext): Promise<ScenarioOutcome> {
  const first = projectA(context)
  const second = projectB(context)
  observeBudget(context.home, context.budget)
  const beforeRequests = context.budget.snapshot().usedRequests
  await (await existingSession(context, first)).click()
  const notebooks = await listNotebooks(context.page, first.workingDirectory)
  const notebook = notebooks.find((item) => item.name.endsWith('.ipynb'))
  if (!notebook) throw new ScenarioSkip(`${first.name} has no .ipynb notebook`)
  await openNotebookFromFiles(context.page, notebook.name)
  await (await existingSession(context, second)).click()
  const firstRows = await projectSessionRows(context.page, first)
  const target = firstRows.first()
  const returnProbe = waitForNotebookReturn(context, Date.now())
  await target.click()
  const returned = await returnProbe
  observeBudget(context.home, context.budget)
  const afterRequests = context.budget.snapshot().usedRequests
  const evaluated = evaluateNotebookSwitch({
    contentVisibleAfterMs: returned.elapsed,
    openingStateObserved: returned.opening
  })
  const noRequests = afterRequests === beforeRequests
  return outcome({
    passed: evaluated.passed && noRequests,
    reason: evaluated.reason ?? (noRequests ? undefined : 'notebook scenario made a model request'),
    evidence: [...evaluated.evidence, `model requests used: ${afterRequests - beforeRequests}`]
  })
}

const runners: Record<ScenarioName, (context: HarnessContext) => Promise<ScenarioOutcome>> = {
  'notebook-switch': notebookSwitch,
  'plan-mode': planMode,
  'switch-servers': switchServers,
  'remote-fork': remoteFork,
  'reconnect-return': reconnectReturn,
  'outside-read-approval': outsideReadApproval
}

export function runScenario(name: ScenarioName, context: HarnessContext): Promise<ScenarioOutcome> {
  return runners[name](context)
}
