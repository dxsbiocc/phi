import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { readAppLogDirectory, readJsonlFile, type JsonlParseIssue } from './jsonl'

const ACTUAL_REQUEST_EVENT_TYPES = new Set([
  'assistant_thinking_completed',
  'assistant_message_finalized',
  'tool_call_started',
  'model_fallback',
  'automatic_title_request'
])

export interface RequestEventSnapshot {
  events: Record<string, unknown>[]
  issues: Array<JsonlParseIssue & { sessionId: string }>
}

export interface RequestBudgetSnapshot {
  maxRequests: number
  usedRequests: number
  remainingRequests: number
  atLimit: boolean
  overLimit: boolean
}

export class RequestBudgetExceededError extends Error {
  readonly snapshot: RequestBudgetSnapshot

  constructor(snapshot: RequestBudgetSnapshot) {
    super(
      snapshot.overLimit
        ? `Model request budget exceeded (${snapshot.usedRequests}/${snapshot.maxRequests})`
        : `Model request budget exhausted (${snapshot.usedRequests}/${snapshot.maxRequests})`
    )
    this.name = 'RequestBudgetExceededError'
    this.snapshot = snapshot
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/**
 * One provider response can persist thinking, text, and several tool calls. They all share the
 * response timestamp, so this tuple counts the response once while counting the next tool-loop
 * response separately.
 */
export function actualRequestKey(event: Record<string, unknown>): string | undefined {
  const type = String(event.type)
  if (!ACTUAL_REQUEST_EVENT_TYPES.has(type)) return undefined
  const sessionId = nonEmptyString(event.sessionId)
  const runId = nonEmptyString(event.runId)
  const createdAt = nonEmptyString(event.createdAt)
  if (!sessionId || !runId || !createdAt || !Number.isFinite(Date.parse(createdAt)))
    return undefined
  const response =
    type === 'model_fallback'
      ? `fallback:${createdAt}`
      : type === 'automatic_title_request'
        ? `title:${runId}:${createdAt}`
        : `assistant:${createdAt}`
  return `${sessionId}\u0000${runId}\u0000${response}`
}

export function actualRequestKeys(events: Iterable<Record<string, unknown>>): Set<string> {
  const keys = new Set<string>()
  const records = [...events]
  const approvalDeniedRuns = new Set(
    records.flatMap((event) =>
      event.type === 'approval_denied' &&
      nonEmptyString(event.sessionId) &&
      nonEmptyString(event.runId)
        ? [`${String(event.sessionId)}\u0000${String(event.runId)}`]
        : []
    )
  )
  for (const event of records) {
    const key = actualRequestKey(event)
    if (key) keys.add(key)
  }
  for (const event of records) {
    if (event.type !== 'run_failed') continue
    const sessionId = nonEmptyString(event.sessionId)
    const runId = nonEmptyString(event.runId)
    const createdAt = nonEmptyString(event.createdAt)
    if (!sessionId || !runId || !createdAt) continue
    if (!approvalDeniedRuns.has(`${sessionId}\u0000${runId}`)) {
      keys.add(`${sessionId}\u0000${runId}\u0000failed:${createdAt}`)
    }
  }
  return keys
}

export function countActualModelRequests(events: Iterable<Record<string, unknown>>): number {
  return actualRequestKeys(events).size
}

export function readPersistedRequestEvents(agentDir: string): RequestEventSnapshot {
  const sessionsDir = join(agentDir, 'sessions')
  if (!existsSync(sessionsDir)) return { events: [], issues: [] }
  const events: Record<string, unknown>[] = []
  const issues: Array<JsonlParseIssue & { sessionId: string }> = []
  const sessionDirs = readdirSync(sessionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
  for (const sessionDir of sessionDirs) {
    const parsed = readJsonlFile(join(sessionsDir, sessionDir.name, 'messages.jsonl'))
    events.push(
      ...parsed.records.map(({ value }) => ({
        ...value,
        sessionId: nonEmptyString(value.sessionId) ?? sessionDir.name
      }))
    )
    issues.push(...parsed.issues.map((issue) => ({ ...issue, sessionId: sessionDir.name })))
    const manifestPath = join(sessionsDir, sessionDir.name, 'manifest.json')
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
      if (manifest.titleSource === 'auto' && typeof manifest.createdAt === 'string') {
        events.push({
          type: 'automatic_title_request',
          sessionId: sessionDir.name,
          runId: 'automatic-title-success',
          createdAt: manifest.createdAt
        })
      }
    } catch {
      // An unreadable manifest is already surfaced by the app; request counting stays bounded.
    }
  }
  const appLogs = readAppLogDirectory(join(agentDir, 'logs')).entries
  const titleFailures = appLogs.filter(
    (entry) =>
      entry.event === 'session_auto_title_unavailable' && entry.sessionId && entry.timestamp
  )
  events.push(
    ...titleFailures.map((entry) => ({
      type: 'automatic_title_request',
      sessionId: entry.sessionId,
      runId: 'automatic-title-failure',
      createdAt: entry.timestamp
    }))
  )
  const persistedFailures = new Set(
    events.flatMap((event) =>
      event.type === 'run_failed' && nonEmptyString(event.sessionId) && nonEmptyString(event.runId)
        ? [`${String(event.sessionId)}\u0000${String(event.runId)}`]
        : []
    )
  )
  events.push(
    ...appLogs.flatMap((entry): Record<string, unknown>[] => {
      if (
        entry.event !== 'run_failed' ||
        !entry.sessionId ||
        !entry.runId ||
        !entry.timestamp ||
        persistedFailures.has(`${entry.sessionId}\u0000${entry.runId}`)
      ) {
        return []
      }
      return [
        {
          type: 'run_failed',
          sessionId: entry.sessionId,
          runId: entry.runId,
          createdAt: entry.timestamp
        }
      ]
    })
  )
  return { events, issues }
}

export class ActualRequestBudget {
  private readonly baseline: Set<string>
  private readonly observed = new Set<string>()

  constructor(
    readonly maxRequests: number,
    baselineEvents: Iterable<Record<string, unknown>> = []
  ) {
    if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) {
      throw new Error('maxRequests must be a positive integer')
    }
    this.baseline = actualRequestKeys(baselineEvents)
  }

  observe(events: Iterable<Record<string, unknown>>): RequestBudgetSnapshot {
    for (const key of actualRequestKeys(events)) {
      if (!this.baseline.has(key)) this.observed.add(key)
    }
    return this.snapshot()
  }

  snapshot(): RequestBudgetSnapshot {
    const usedRequests = this.observed.size
    return {
      maxRequests: this.maxRequests,
      usedRequests,
      remainingRequests: Math.max(0, this.maxRequests - usedRequests),
      atLimit: usedRequests >= this.maxRequests,
      overLimit: usedRequests > this.maxRequests
    }
  }

  assertCanStartPrompt(maxExpectedRequests = 2): RequestBudgetSnapshot {
    if (!Number.isSafeInteger(maxExpectedRequests) || maxExpectedRequests < 1) {
      throw new Error('maxExpectedRequests must be a positive integer')
    }
    const snapshot = this.snapshot()
    if (snapshot.usedRequests + maxExpectedRequests > snapshot.maxRequests) {
      throw new RequestBudgetExceededError(snapshot)
    }
    return snapshot
  }

  assertWithinLimit(): RequestBudgetSnapshot {
    const snapshot = this.snapshot()
    if (snapshot.atLimit) throw new RequestBudgetExceededError(snapshot)
    return snapshot
  }
}
