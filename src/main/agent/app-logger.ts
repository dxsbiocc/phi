import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPhiAgentDir } from './runtime-paths'
import { isSecretMetadataKey, redactSensitiveText } from './redaction'

const LOG_DIR_NAME = 'logs'
export const LOG_RETENTION_DAYS = 14
const MAX_METADATA_STRING_LENGTH = 500
const TOOL_OUTPUT_METADATA_KEY = /^(output|stdout|stderr|result)$/i

export interface AppLogEntry {
  timestamp?: string
  level?: 'info' | 'warn' | 'error'
  event: string
  sessionId?: string
  runId?: string
  metadata?: Record<string, unknown>
}

export function getPhiLogDir(): string {
  return join(getPhiAgentDir(), LOG_DIR_NAME)
}

function getLogPath(now = new Date()): string {
  return join(getPhiLogDir(), `${now.toISOString().slice(0, 10)}.jsonl`)
}

function ensureLogDir(): void {
  const logDir = getPhiLogDir()
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true })
  }
}

function omittedValue(value: unknown): string {
  if (typeof value === 'string') {
    return `[omitted ${value.length} chars]`
  }
  return '[omitted]'
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const redacted = redactSensitiveText(value)
    return redacted.length > MAX_METADATA_STRING_LENGTH
      ? `${redacted.slice(0, MAX_METADATA_STRING_LENGTH)}...`
      : redacted
  }
  if (Array.isArray(value)) return value.slice(0, 20).map(sanitizeValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !isSecretMetadataKey(key))
        .map(([key, innerValue]) => [
          key,
          TOOL_OUTPUT_METADATA_KEY.test(key) ? omittedValue(innerValue) : sanitizeValue(innerValue)
        ])
    )
  }
  return value
}

export function writeAppLog(entry: AppLogEntry, now = new Date()): void {
  try {
    ensureLogDir()
    appendFileSync(
      getLogPath(now),
      `${JSON.stringify({
        timestamp: entry.timestamp ?? now.toISOString(),
        level: entry.level ?? 'info',
        event: entry.event,
        ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
        ...(entry.runId ? { runId: entry.runId } : {}),
        ...(entry.metadata ? { metadata: sanitizeValue(entry.metadata) } : {})
      })}\n`,
      'utf-8'
    )
  } catch {
    // Logging must never break the agent runtime.
  }
}

export function cleanupOldLogs(now = new Date()): number {
  const logDir = getPhiLogDir()
  if (!existsSync(logDir)) return 0

  const cutoffMs = now.getTime() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000
  let removed = 0
  for (const fileName of readdirSync(logDir)) {
    if (!fileName.endsWith('.jsonl')) continue
    const filePath = join(logDir, fileName)
    try {
      const stat = statSync(filePath)
      if (stat.mtime.getTime() >= cutoffMs) continue
      unlinkSync(filePath)
      removed += 1
    } catch {
      // Ignore individual cleanup failures; the next startup can retry.
    }
  }
  return removed
}
