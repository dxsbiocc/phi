import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import type { PhiAppSettings, PhiAppSettingsPatch } from '../../shared/appSettingsTypes'
import {
  DEFAULT_NEXT_ACTION_SUGGESTIONS_ENABLED,
  DEFAULT_OFFICE_ENABLED,
  DEFAULT_PREVENT_SLEEP_DURING_RUNS
} from '../../shared/appSettingsTypes'
import { getPhiAgentDir } from './runtime-paths'

const SETTINGS_FILE = 'settings.json'
const SETTINGS_KEYS = new Set<keyof PhiAppSettingsPatch>([
  'noProjectTaskFolder',
  'preventSleepDuringRuns',
  'nextActionSuggestionsEnabled',
  'officeEnabled'
])
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function getAppSettingsPath(agentDir = getPhiAgentDir()): string {
  return join(agentDir, SETTINGS_FILE)
}

function defaultNoProjectTaskFolder(agentDir: string): string {
  return join(agentDir, 'workspace')
}

function normalizeNoProjectTaskFolder(value: unknown, agentDir: string): string {
  if (typeof value !== 'string') return defaultNoProjectTaskFolder(agentDir)
  const trimmed = value.trim()
  if (!trimmed || !isAbsolute(trimmed)) return defaultNoProjectTaskFolder(agentDir)
  return resolve(trimmed)
}

function booleanSetting(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function hasOwnSetting(raw: Record<string, unknown>, key: keyof PhiAppSettingsPatch): boolean {
  return Object.prototype.hasOwnProperty.call(raw, key)
}

function readRawSettings(agentDir: string): Record<string, unknown> {
  const path = getAppSettingsPath(agentDir)
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function appSettingsFromRaw(raw: Record<string, unknown>, agentDir: string): PhiAppSettings {
  return {
    noProjectTaskFolder: normalizeNoProjectTaskFolder(raw.noProjectTaskFolder, agentDir),
    preventSleepDuringRuns: booleanSetting(
      raw.preventSleepDuringRuns,
      DEFAULT_PREVENT_SLEEP_DURING_RUNS
    ),
    nextActionSuggestionsEnabled: booleanSetting(
      raw.nextActionSuggestionsEnabled,
      DEFAULT_NEXT_ACTION_SUGGESTIONS_ENABLED
    ),
    officeEnabled: booleanSetting(raw.officeEnabled, DEFAULT_OFFICE_ENABLED)
  }
}

export function readAppSettings(agentDir = getPhiAgentDir()): PhiAppSettings {
  return appSettingsFromRaw(readRawSettings(agentDir), agentDir)
}

function assertSettingsPatch(patch: unknown): asserts patch is Record<string, unknown> {
  if (!isRecord(patch)) throw new Error('设置更新内容无效')
  const unsupported = Object.keys(patch).find(
    (key) => !SETTINGS_KEYS.has(key as keyof PhiAppSettingsPatch)
  )
  if (unsupported) throw new Error(`不支持的设置项: ${unsupported}`)
}

function applySettingsPatch(
  raw: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  let nextRaw = { ...raw }
  if (hasOwnSetting(patch, 'noProjectTaskFolder')) {
    if (typeof patch.noProjectTaskFolder !== 'string') {
      throw new Error('无项目任务文件夹必须是路径字符串')
    }
    const trimmed = patch.noProjectTaskFolder.trim()
    if (!trimmed || !isAbsolute(trimmed)) throw new Error('无项目任务文件夹必须是绝对路径')
    const normalized = resolve(trimmed)
    mkdirSync(normalized, { recursive: true })
    nextRaw = { ...nextRaw, noProjectTaskFolder: normalized }
  }
  if (hasOwnSetting(patch, 'preventSleepDuringRuns')) {
    if (typeof patch.preventSleepDuringRuns !== 'boolean') {
      throw new Error('运行时防休眠设置必须是布尔值')
    }
    nextRaw = { ...nextRaw, preventSleepDuringRuns: patch.preventSleepDuringRuns }
  }
  if (hasOwnSetting(patch, 'nextActionSuggestionsEnabled')) {
    if (typeof patch.nextActionSuggestionsEnabled !== 'boolean') {
      throw new Error('提示词建议设置必须是布尔值')
    }
    nextRaw = { ...nextRaw, nextActionSuggestionsEnabled: patch.nextActionSuggestionsEnabled }
  }
  if (hasOwnSetting(patch, 'officeEnabled')) {
    if (typeof patch.officeEnabled !== 'boolean') throw new Error('Office 设置必须是布尔值')
    nextRaw = { ...nextRaw, officeEnabled: patch.officeEnabled }
  }
  return nextRaw
}

function writeRawSettings(raw: Record<string, unknown>, agentDir: string): void {
  const path = getAppSettingsPath(agentDir)
  const parent = dirname(path)
  mkdirSync(parent, { recursive: true })
  const temporary = join(parent, `.settings.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8')
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temporary file may not exist if the initial write failed.
    }
    throw error
  }
}

export function updateAppSettings(patch: unknown, agentDir = getPhiAgentDir()): PhiAppSettings {
  assertSettingsPatch(patch)
  const nextRaw = applySettingsPatch(readRawSettings(agentDir), patch)
  writeRawSettings(nextRaw, agentDir)
  return appSettingsFromRaw(nextRaw, agentDir)
}
