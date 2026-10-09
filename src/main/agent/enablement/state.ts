import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import type { EnablementItemKey, EnablementSnapshot } from '../../../shared/enablementTypes'
import type { SkillSourceCategory } from '../../../shared/skillTypes'
import { writeAppLog } from '../app-logger'
import { getPhiAgentDir } from '../runtime-paths'

export const CORE_SKILL_NAMES = ['create-wrapper'] as const

export type EnablementSource = SkillSourceCategory

export interface EnablementItem {
  key: EnablementItemKey
  source: EnablementSource
}

export interface EnablementState {
  version: 1
  global: Record<string, boolean>
  projects: Record<string, Record<string, boolean>>
}

export interface EnablementLogger {
  info(message: string, metadata?: Record<string, unknown>): void
  warn(message: string, metadata?: Record<string, unknown>): void
}

export interface EnablementOptions {
  agentDir?: string
  logger?: EnablementLogger
}

export interface EnablementResolutionOptions extends EnablementOptions {
  projectDir?: string
}

const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const PACKAGE_ID = /^[a-z][a-z0-9-]{1,63}$/

const defaultLogger: EnablementLogger = {
  info(message, metadata) {
    writeAppLog({
      event: 'enablement_info',
      metadata: { message, ...metadata }
    })
  },
  warn(message, metadata) {
    writeAppLog({
      event: 'enablement_warning',
      level: 'warn',
      metadata: { message, ...metadata }
    })
  }
}

function emptyState(): EnablementState {
  return { version: 1, global: {}, projects: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'boolean')
}

function isEnablementState(value: unknown): value is EnablementState {
  if (!isRecord(value) || value.version !== 1 || !isBooleanRecord(value.global)) return false
  if (!isRecord(value.projects)) return false
  return Object.entries(value.projects).every(
    ([projectPath, overrides]) => isAbsolute(projectPath) && isBooleanRecord(overrides)
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function loggerFor(options?: EnablementOptions): EnablementLogger {
  return options?.logger ?? defaultLogger
}

function agentDirFor(options?: EnablementOptions): string {
  return options?.agentDir ?? getPhiAgentDir()
}

function resolveProjectPath(projectDir: string): string {
  return realpathSync(projectDir)
}

/**
 * Reading overrides for a project folder that no longer exists (deleted, or not
 * mounted) falls back to its resolved path, which no saved override matches, so
 * the defaults apply. Writes still require a real folder (resolveProjectPath).
 */
function resolveProjectPathForRead(projectDir: string): string {
  try {
    return realpathSync(projectDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolve(projectDir)
    throw error
  }
}

function assertEnablementKey(key: string): asserts key is EnablementItemKey {
  const separator = key.indexOf(':')
  const kind = key.slice(0, separator)
  const id = key.slice(separator + 1)
  const valid =
    separator > 0 &&
    ((kind === 'skill' && SKILL_ID.test(id)) ||
      (['plugin', 'wrapper', 'mcp'].includes(kind) && PACKAGE_ID.test(id)))
  if (!valid) throw new Error(`Invalid enablement item key: ${key}`)
}

function assertEnablementSource(source: string): asserts source is EnablementSource {
  if (!['bundled', 'installed-package', 'user', 'project', 'plugin'].includes(source)) {
    throw new Error(`Invalid enablement source: ${source}`)
  }
}

function configuredValue(overrides: Record<string, boolean>, key: string): boolean | undefined {
  return Object.hasOwn(overrides, key) ? overrides[key] : undefined
}

export function getEnablementPath(agentDir = getPhiAgentDir()): string {
  return join(agentDir, 'state', 'enabled.json')
}

export function readEnablementState(options?: EnablementOptions): EnablementState {
  const path = getEnablementPath(agentDirFor(options))
  const logger = loggerFor(options)
  if (!existsSync(path)) {
    logger.warn('Enablement state is missing; using defaults', { path })
    return emptyState()
  }

  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!isEnablementState(value)) throw new Error('state does not match version 1')
    return value
  } catch (error) {
    logger.warn('Enablement state is invalid; using defaults', {
      path,
      error: errorMessage(error)
    })
    return emptyState()
  }
}

export function writeEnablementState(state: EnablementState, options?: EnablementOptions): void {
  if (!isEnablementState(state)) throw new Error('Refusing to write invalid enablement state')
  const target = getEnablementPath(agentDirFor(options))
  const parent = dirname(target)
  mkdirSync(parent, { recursive: true })
  const temporary = join(parent, `.enabled.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    renameSync(temporary, target)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temporary file may not exist if the initial write failed.
    }
    throw error
  }
}

export function getEnablementSnapshot(options?: EnablementResolutionOptions): EnablementSnapshot {
  const state = readEnablementState(options)
  const projectPath = options?.projectDir
    ? resolveProjectPathForRead(options.projectDir)
    : undefined
  return {
    version: 1,
    global: { ...state.global },
    ...(projectPath ? { projectPath } : {}),
    project: projectPath ? { ...(state.projects[projectPath] ?? {}) } : {}
  }
}

export function isCoreSkill(name: string): boolean {
  return (CORE_SKILL_NAMES as readonly string[]).includes(name)
}

export function isEnabled(item: EnablementItem, options?: EnablementResolutionOptions): boolean {
  assertEnablementKey(item.key)
  assertEnablementSource(item.source)
  const [kind, id] = item.key.split(':', 2)
  if (kind === 'skill' && isCoreSkill(id)) return true

  const state = readEnablementState(options)
  if (options?.projectDir) {
    const projectPath = resolveProjectPathForRead(options.projectDir)
    const projectValue = configuredValue(state.projects[projectPath] ?? {}, item.key)
    if (projectValue !== undefined) return projectValue
  }

  const globalValue = configuredValue(state.global, item.key)
  if (globalValue !== undefined) return globalValue

  if (kind !== 'skill') return true
  return item.source !== 'bundled'
}

export function setEnabled(
  item: EnablementItemKey,
  value: boolean | null,
  options?: EnablementResolutionOptions
): EnablementState {
  assertEnablementKey(item)
  if (typeof value !== 'boolean' && value !== null) {
    throw new Error('Enablement value must be true, false, or null')
  }
  const [kind, id] = item.split(':', 2)
  if (kind === 'skill' && isCoreSkill(id) && value === false) {
    throw new Error(`Core skill ${id} cannot be disabled`)
  }

  const state = readEnablementState(options)
  if (options?.projectDir) {
    const projectPath = resolveProjectPath(options.projectDir)
    const overrides = { ...(state.projects[projectPath] ?? {}) }
    if (value === null) delete overrides[item]
    else overrides[item] = value

    if (Object.keys(overrides).length === 0) delete state.projects[projectPath]
    else state.projects[projectPath] = overrides
  } else if (value === null) {
    delete state.global[item]
  } else {
    state.global[item] = value
  }

  writeEnablementState(state, options)
  return state
}

export function emptyEnablementState(): EnablementState {
  return emptyState()
}
