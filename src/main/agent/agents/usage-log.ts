import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync
} from 'node:fs'
import { join } from 'node:path'

import type { AgentRunUsageRecord } from './usage'

/**
 * Usage records live in `<agentDir>/telemetry/agent-usage-YYYY-MM-DD.jsonl`, one file a day,
 * so old days can be dropped by name. Kept apart from the app log: this is data to be read
 * back and compared, not events to be skimmed.
 */

const TELEMETRY_DIR_NAME = 'telemetry'
const FILE_PREFIX = 'agent-usage-'
const FILE_PATTERN = /^agent-usage-(\d{4}-\d{2}-\d{2})\.jsonl$/
export const AGENT_USAGE_RETENTION_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

export function getAgentUsageDir(agentDir: string): string {
  return join(agentDir, TELEMETRY_DIR_NAME)
}

function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Recording must never get in the way of the run it describes. */
export function appendAgentUsageRecord(
  agentDir: string,
  record: AgentRunUsageRecord,
  now: Date = new Date()
): void {
  try {
    const dir = getAgentUsageDir(agentDir)
    mkdirSync(dir, { recursive: true })
    appendFileSync(
      join(dir, `${FILE_PREFIX}${dayOf(now)}.jsonl`),
      `${JSON.stringify(record)}\n`,
      'utf-8'
    )
  } catch {
    // Telemetry is best effort.
  }
}

function isUsageRecord(value: unknown): value is AgentRunUsageRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { agent?: unknown }).agent === 'string' &&
    typeof (value as { usage?: unknown }).usage === 'object'
  )
}

/** Records in file order (oldest day first); unreadable files and corrupt lines are skipped. */
export function readAgentUsageRecords(
  agentDir: string,
  options: { since?: Date } = {}
): AgentRunUsageRecord[] {
  const dir = getAgentUsageDir(agentDir)
  if (!existsSync(dir)) return []
  const sinceDay = options.since ? dayOf(options.since) : undefined
  const records: AgentRunUsageRecord[] = []
  for (const fileName of readdirSync(dir).sort()) {
    const day = FILE_PATTERN.exec(fileName)?.[1]
    if (!day || (sinceDay && day < sinceDay)) continue
    let text: string
    try {
      text = readFileSync(join(dir, fileName), 'utf-8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (isUsageRecord(parsed)) records.push(parsed)
      } catch {
        // A half-written line from a crash; the rest of the file is still good.
      }
    }
  }
  return records
}

/** Deletes usage files older than the retention window, judged by the date in the name. */
export function pruneAgentUsageLogs(agentDir: string, now: Date = new Date()): number {
  const dir = getAgentUsageDir(agentDir)
  if (!existsSync(dir)) return 0
  const cutoff = dayOf(new Date(now.getTime() - AGENT_USAGE_RETENTION_DAYS * DAY_MS))
  let removed = 0
  for (const fileName of readdirSync(dir)) {
    const day = FILE_PATTERN.exec(fileName)?.[1]
    if (!day || day >= cutoff) continue
    try {
      unlinkSync(join(dir, fileName))
      removed += 1
    } catch {
      // The next start can retry.
    }
  }
  return removed
}
