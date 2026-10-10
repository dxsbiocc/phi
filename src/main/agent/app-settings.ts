import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import type { PhiAppSettings, PhiAppSettingsPatch } from '../../shared/appSettingsTypes'
import {
  DEFAULT_ALLOW_EXTERNAL_FILE_READ,
  DEFAULT_FILE_OPEN_CONVERSATION_LAYOUT,
  DEFAULT_NEXT_ACTION_SUGGESTIONS_ENABLED,
  DEFAULT_PREVENT_SLEEP_DURING_RUNS
} from '../../shared/appSettingsTypes'
import { getPhiAgentDir } from './runtime-paths'

const SETTINGS_FILE = 'settings.json'
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

function fileOpenConversationLayout(value: unknown): PhiAppSettings['fileOpenConversationLayout'] {
  return value === 'sidebar' || value === 'tab' ? value : DEFAULT_FILE_OPEN_CONVERSATION_LAYOUT
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
    noProjectTaskFolder: normalizeNoProjectTaskFolder(raw.noProjectTaskFolder, agentDir),
    allowExternalFileRead: booleanSetting(
      raw.allowExternalFileRead,
      DEFAULT_ALLOW_EXTERNAL_FILE_READ
    ),
    preventSleepDuringRuns: booleanSetting(
      raw.preventSleepDuringRuns,
      DEFAULT_PREVENT_SLEEP_DURING_RUNS
    ),
    nextActionSuggestionsEnabled: booleanSetting(
      raw.nextActionSuggestionsEnabled,
      DEFAULT_NEXT_ACTION_SUGGESTIONS_ENABLED
    ),
    fileOpenConversationLayout: fileOpenConversationLayout(raw.fileOpenConversationLayout)
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

  if (hasOwnSetting(patch, 'allowExternalFileRead')) {
    if (typeof patch.allowExternalFileRead !== 'boolean') {
      throw new Error('项目外文件读取设置必须是布尔值')
    }
    nextRaw.allowExternalFileRead = patch.allowExternalFileRead
  }

  if (hasOwnSetting(patch, 'nextActionSuggestionsEnabled')) {
    if (typeof patch.nextActionSuggestionsEnabled !== 'boolean') {
      throw new Error('提示词建议设置必须是布尔值')
    }
    nextRaw.nextActionSuggestionsEnabled = patch.nextActionSuggestionsEnabled
  }

  if (hasOwnSetting(patch, 'fileOpenConversationLayout')) {
    if (
      patch.fileOpenConversationLayout !== 'sidebar' &&
      patch.fileOpenConversationLayout !== 'tab'
    ) {
      throw new Error('打开文件时的对话布局设置无效')
    }
    nextRaw.fileOpenConversationLayout = patch.fileOpenConversationLayout
  }

  const path = getAppSettingsPath(agentDir)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(nextRaw, null, 2)}\n`, 'utf-8')

  return appSettingsFromRaw(nextRaw, agentDir)
}
