import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { writeAppLog } from '../app-logger'
import { getPhiAgentDir } from '../runtime-paths'
import {
  emptyEnablementState,
  getEnablementPath,
  type EnablementLogger,
  writeEnablementState
} from './state'

export const DEFAULT_ENABLEMENT_MIGRATION_LIMITS = {
  maxSessions: 50,
  maxBytes: 5 * 1024 * 1024
} as const

export interface EnablementMigrationLimits {
  maxSessions?: number
  maxBytes?: number
}

export interface EnablementMigrationOptions {
  agentDir?: string
  logger?: EnablementLogger
  limits?: EnablementMigrationLimits
}

export interface EnablementMigrationResult {
  migrated: boolean
  enabledSkills: string[]
  sessionsScanned: number
  bytesScanned: number
}

interface SessionHistoryFile {
  path: string
  modifiedAt: number
}

const SINGLE_SKILL_KEYS = ['loadedSkill', 'loaded_skill', 'invokedSkill', 'invoked_skill'] as const
const MULTIPLE_SKILL_KEYS = [
  'loadedSkills',
  'loaded_skills',
  'invokedSkills',
  'invoked_skills'
] as const
const SKILL_EVENT_TYPES = new Set(['skill_loaded', 'skill_invoked', 'skill_load', 'skill_invoke'])

const defaultLogger: EnablementLogger = {
  info(message, metadata) {
    writeAppLog({ event: 'enablement_migration', metadata: { message, ...metadata } })
  },
  warn(message, metadata) {
    writeAppLog({
      event: 'enablement_migration_warning',
      level: 'warn',
      metadata: { message, ...metadata }
    })
  }
}

function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('Migration limits must be non-negative integers')
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function collectString(value: unknown, used: Set<string>): void {
  if (typeof value === 'string' && value.length > 0) used.add(value)
}

function collectStringList(value: unknown, used: Set<string>): void {
  if (!Array.isArray(value)) return
  for (const entry of value) collectString(entry, used)
}

function collectUsedSkills(event: unknown, used: Set<string>): void {
  if (!isRecord(event)) return

  for (const key of SINGLE_SKILL_KEYS) collectString(event[key], used)
  for (const key of MULTIPLE_SKILL_KEYS) collectStringList(event[key], used)

  if (typeof event.type === 'string' && SKILL_EVENT_TYPES.has(event.type)) {
    collectString(event.skill, used)
    collectString(event.skillName, used)
    collectString(event.name, used)
  }

  if (event.type !== 'tool_call_started' || event.toolName !== 'skill_run') return
  if (isRecord(event.args)) collectString(event.args.skill, used)
}

function sessionHistoryFiles(agentDir: string): SessionHistoryFile[] {
  const sessionsDir = join(agentDir, 'sessions')
  let entries
  try {
    entries = readdirSync(sessionsDir, { withFileTypes: true })
  } catch {
    return []
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry): SessionHistoryFile[] => {
      const path = join(sessionsDir, entry.name, 'messages.jsonl')
      try {
        return [{ path, modifiedAt: statSync(path).mtimeMs }]
      } catch {
        return []
      }
    })
    .sort(
      (left, right) => right.modifiedAt - left.modifiedAt || left.path.localeCompare(right.path)
    )
}

function readBounded(path: string, maxBytes: number): { text: string; bytes: number } {
  if (maxBytes === 0) return { text: '', bytes: 0 }
  const size = statSync(path).size
  const requested = Math.min(size, maxBytes)
  const buffer = Buffer.alloc(requested)
  const descriptor = openSync(path, 'r')
  try {
    const bytes = readSync(descriptor, buffer, 0, requested, 0)
    return { text: buffer.subarray(0, bytes).toString('utf8'), bytes }
  } finally {
    closeSync(descriptor)
  }
}

function scanHistory(
  agentDir: string,
  logger: EnablementLogger,
  limits: Required<EnablementMigrationLimits>
): Omit<EnablementMigrationResult, 'migrated' | 'enabledSkills'> & { used: Set<string> } {
  const used = new Set<string>()
  let sessionsScanned = 0
  let bytesScanned = 0
  const histories = sessionHistoryFiles(agentDir).slice(0, limits.maxSessions)

  for (const history of histories) {
    if (bytesScanned >= limits.maxBytes) break
    sessionsScanned += 1
    let malformedLines = 0
    try {
      const remaining = limits.maxBytes - bytesScanned
      const read = readBounded(history.path, remaining)
      bytesScanned += read.bytes
      for (const line of read.text.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          collectUsedSkills(JSON.parse(line) as unknown, used)
        } catch {
          malformedLines += 1
        }
      }
    } catch (error) {
      logger.warn('Could not scan session history during enablement migration', {
        path: history.path,
        error: error instanceof Error ? error.message : String(error)
      })
      continue
    }
    if (malformedLines > 0) {
      logger.warn('Ignored malformed session history lines during enablement migration', {
        path: history.path,
        count: malformedLines
      })
    }
  }

  return { used, sessionsScanned, bytesScanned }
}

export function migrateEnablementFromHistory(
  bundledSkillNames: Iterable<string>,
  options?: EnablementMigrationOptions
): EnablementMigrationResult {
  const agentDir = options?.agentDir ?? getPhiAgentDir()
  if (existsSync(getEnablementPath(agentDir))) {
    return { migrated: false, enabledSkills: [], sessionsScanned: 0, bytesScanned: 0 }
  }

  const limits = {
    maxSessions: positiveLimit(
      options?.limits?.maxSessions,
      DEFAULT_ENABLEMENT_MIGRATION_LIMITS.maxSessions
    ),
    maxBytes: positiveLimit(options?.limits?.maxBytes, DEFAULT_ENABLEMENT_MIGRATION_LIMITS.maxBytes)
  }
  const logger = options?.logger ?? defaultLogger
  const scan = scanHistory(agentDir, logger, limits)
  const bundled = new Set(bundledSkillNames)
  const enabledSkills = [...scan.used].filter((name) => bundled.has(name)).sort()
  const state = emptyEnablementState()
  for (const name of enabledSkills) state.global[`skill:${name}`] = true
  writeEnablementState(state, options)
  logger.info('Migrated bundled skill enablement from session history', {
    enabledSkills,
    sessionsScanned: scan.sessionsScanned,
    bytesScanned: scan.bytesScanned
  })

  return {
    migrated: true,
    enabledSkills,
    sessionsScanned: scan.sessionsScanned,
    bytesScanned: scan.bytesScanned
  }
}
