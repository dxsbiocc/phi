import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import type {
  DefaultProxyMode,
  PhiAppSettings,
  PhiAppSettingsPatch
} from '../../shared/appSettingsTypes'
import {
  DEFAULT_NEXT_ACTION_SUGGESTIONS_ENABLED,
  DEFAULT_PREVENT_SLEEP_DURING_RUNS,
  DEFAULT_PROXY_MODE,
  DEFAULT_PROXY_TRANSPORT_STATUS
} from '../../shared/appSettingsTypes'
import { getPhiAgentDir } from './runtime-paths'

const SETTINGS_FILE = 'settings.json'
const DEFAULT_PROXY_MODES: DefaultProxyMode[] = ['auto', 'enabled', 'disabled']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function getAppSettingsPath(agentDir = getPhiAgentDir()): string {
  return join(agentDir, SETTINGS_FILE)
}

export function normalizeDefaultProxyMode(value: unknown): DefaultProxyMode {
  return DEFAULT_PROXY_MODES.includes(value as DefaultProxyMode)
    ? (value as DefaultProxyMode)
    : DEFAULT_PROXY_MODE
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

function readRawSettings(agentDir: string, options: { strict: boolean }): Record<string, unknown> {
  const path = getAppSettingsPath(agentDir)
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    return isRecord(parsed) ? parsed : {}
  } catch (error) {
    if (options.strict) {
      throw new Error(
        `settings.json 不是合法 JSON，无法保存设置: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
    return {}
  }
}

function appSettingsFromRaw(raw: Record<string, unknown>, agentDir: string): PhiAppSettings {
  return {
    defaultProxyMode: normalizeDefaultProxyMode(raw.defaultProxyMode),
    noProjectTaskFolder: normalizeNoProjectTaskFolder(raw.noProjectTaskFolder, agentDir),
    preventSleepDuringRuns: booleanSetting(
      raw.preventSleepDuringRuns,
      DEFAULT_PREVENT_SLEEP_DURING_RUNS
    ),
    nextActionSuggestionsEnabled: booleanSetting(
      raw.nextActionSuggestionsEnabled,
      DEFAULT_NEXT_ACTION_SUGGESTIONS_ENABLED
    ),
    proxyTransportStatus: DEFAULT_PROXY_TRANSPORT_STATUS
  }
}

export function readAppSettings(agentDir = getPhiAgentDir()): PhiAppSettings {
  return appSettingsFromRaw(readRawSettings(agentDir, { strict: false }), agentDir)
}

export function updateAppSettings(patch: unknown, agentDir = getPhiAgentDir()): PhiAppSettings {
  if (!isRecord(patch)) {
    throw new Error('设置更新内容无效')
  }

  const raw = readRawSettings(agentDir, { strict: true })
  const nextRaw = { ...raw }

  if (hasOwnSetting(patch, 'defaultProxyMode')) {
    const normalized = normalizeDefaultProxyMode(patch.defaultProxyMode)
    if (normalized !== patch.defaultProxyMode) {
      throw new Error('未知默认代理模式')
    }
    nextRaw.defaultProxyMode = normalized
  }

  if (hasOwnSetting(patch, 'noProjectTaskFolder')) {
    if (typeof patch.noProjectTaskFolder !== 'string') {
      throw new Error('无项目任务文件夹必须是路径字符串')
    }
    const trimmed = patch.noProjectTaskFolder.trim()
    if (!trimmed || !isAbsolute(trimmed)) {
      throw new Error('无项目任务文件夹必须是绝对路径')
    }
    const normalized = resolve(trimmed)
    mkdirSync(normalized, { recursive: true })
    nextRaw.noProjectTaskFolder = normalized
  }

  if (hasOwnSetting(patch, 'preventSleepDuringRuns')) {
    if (typeof patch.preventSleepDuringRuns !== 'boolean') {
      throw new Error('运行时防休眠设置必须是布尔值')
    }
    nextRaw.preventSleepDuringRuns = patch.preventSleepDuringRuns
  }

  if (hasOwnSetting(patch, 'nextActionSuggestionsEnabled')) {
    if (typeof patch.nextActionSuggestionsEnabled !== 'boolean') {
      throw new Error('提示词建议设置必须是布尔值')
    }
    nextRaw.nextActionSuggestionsEnabled = patch.nextActionSuggestionsEnabled
  }

  const path = getAppSettingsPath(agentDir)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(nextRaw, null, 2)}\n`, 'utf-8')

  return appSettingsFromRaw(nextRaw, agentDir)
}

export function updateDefaultProxyMode(mode: unknown, agentDir = getPhiAgentDir()): PhiAppSettings {
  return updateAppSettings({ defaultProxyMode: mode }, agentDir)
}
