import { join } from 'node:path'

import type { Page } from 'playwright-core'

import { readAppLogDirectory, type AppLogEntry } from './jsonl'
import {
  readPersistedRequestEvents,
  RequestBudgetExceededError,
  type ActualRequestBudget
} from './request-budget'
import { BudgetSkip, type HarnessContext, type RunObservation } from './types'

const POLL_MS = 100
const RUN_START_TIMEOUT_MS = 30_000
const RUN_TERMINAL_EVENTS = new Set(['run_completed', 'run_failed', 'run_interrupted'])

function appLogs(home: string): AppLogEntry[] {
  return readAppLogDirectory(join(home, '.phi', 'logs')).entries
}

export function activeRunIds(entries: AppLogEntry[]): string[] {
  const active = new Set<string>()
  for (const entry of entries) {
    if (!entry.runId) continue
    if (entry.event === 'run_started') active.add(entry.runId)
    else if (RUN_TERMINAL_EVENTS.has(entry.event)) active.delete(entry.runId)
  }
  return [...active]
}

export function observeBudget(home: string, budget: ActualRequestBudget): number {
  const snapshot = readPersistedRequestEvents(join(home, '.phi'))
  return budget.observe(snapshot.events).usedRequests
}

function assertPromptBudget(context: HarnessContext, expectedRequests: number): void {
  observeBudget(context.home, context.budget)
  try {
    context.budget.assertCanStartPrompt(expectedRequests)
  } catch (error) {
    if (error instanceof RequestBudgetExceededError) throw new BudgetSkip()
    throw error
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('GUI acceptance aborted')
}

async function pollDelay(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortReason(signal)
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortReason(signal))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, POLL_MS)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function startObservedRun(
  context: HarnessContext,
  submit: () => Promise<void>,
  expectedRequests = 2
): Promise<string> {
  assertPromptBudget(context, expectedRequests)
  const existing = new Set(
    appLogs(context.home).flatMap((entry) => (entry.runId ? [entry.runId] : []))
  )
  await submit()
  const deadline = Date.now() + RUN_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    const started = appLogs(context.home).find(
      (entry) => entry.event === 'run_started' && entry.runId && !existing.has(entry.runId)
    )
    if (started?.runId) return started.runId
    await pollDelay(context.abortSignal)
  }
  throw new Error('No new run_started event appeared after prompt submission')
}

function terminalObservation(entries: AppLogEntry[], runId: string): RunObservation | undefined {
  const terminal = entries.findLast(
    (entry) => entry.runId === runId && RUN_TERMINAL_EVENTS.has(entry.event)
  )
  if (!terminal) return undefined
  const error = terminal.metadata?.error
  return {
    runId,
    sessionId: terminal.sessionId,
    terminalEvent: terminal.event as RunObservation['terminalEvent'],
    ...(typeof error === 'string' ? { error } : {})
  }
}

async function stopAtBudget(page: Page): Promise<void> {
  const stop = page.locator('[data-phi-composer-action="stop"]:visible').last()
  if ((await stop.count()) > 0) await stop.click().catch(() => undefined)
}

export async function waitForRunTerminal(
  context: HarnessContext,
  runId: string,
  /** Runs on every poll, e.g. to answer approvals the model asks for again in the same run. */
  onPoll?: () => Promise<void>
): Promise<RunObservation> {
  let stopRequested = false
  while (true) {
    const terminal = terminalObservation(appLogs(context.home), runId)
    const used = observeBudget(context.home, context.budget)
    const snapshot = context.budget.snapshot()
    if (snapshot.overLimit)
      throw new Error(`Model request ceiling exceeded (${used}/${snapshot.maxRequests})`)
    if (snapshot.atLimit && !stopRequested && !terminal) {
      stopRequested = true
      await stopAtBudget(context.page)
    }
    if (terminal) return terminal
    await onPoll?.()
    await pollDelay(context.abortSignal)
  }
}

export async function stopActiveRunBeforeScenario(
  context: HarnessContext
): Promise<RunObservation | undefined> {
  const runId = activeRunIds(appLogs(context.home)).at(-1)
  if (!runId) return undefined
  const stop = context.page.locator('[data-phi-composer-action="stop"]:visible').last()
  if ((await stop.count()) === 0) {
    throw new Error(`Active run ${runId} remained before scenario, but the stop button was absent`)
  }
  await stop.click()
  return waitForRunTerminal(context, runId)
}

export function logsSince(home: string, timestamp: string): AppLogEntry[] {
  const cutoff = Date.parse(timestamp)
  return appLogs(home).filter((entry) => {
    const time = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN
    return Number.isFinite(time) && time >= cutoff
  })
}

export function runCompleted(entries: AppLogEntry[], runId: string): boolean {
  return entries.some((entry) => entry.runId === runId && entry.event === 'run_completed')
}
