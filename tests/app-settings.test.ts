import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_FILE_OPEN_CONVERSATION_LAYOUT,
  DEFAULT_NEXT_ACTION_SUGGESTIONS_ENABLED,
  DEFAULT_PREVENT_SLEEP_DURING_RUNS
} from '../src/shared/appSettingsTypes'
import {
  getAppSettingsPath,
  readAppSettings,
  readLastSelectedModel,
  updateAppSettings,
  writeLastSelectedModel
} from '../src/main/agent/app-settings'

function withTempAgentDir(run: (agentDir: string) => void): void {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-app-settings-'))
  try {
    run(agentDir)
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
}

test('app settings provide general preference defaults', () => {
  withTempAgentDir((agentDir) => {
    assert.deepEqual(readAppSettings(agentDir), {
      noProjectTaskFolder: join(agentDir, 'workspace'),
      allowExternalFileRead: false,
      preventSleepDuringRuns: DEFAULT_PREVENT_SLEEP_DURING_RUNS,
      nextActionSuggestionsEnabled: DEFAULT_NEXT_ACTION_SUGGESTIONS_ENABLED,
      fileOpenConversationLayout: DEFAULT_FILE_OPEN_CONVERSATION_LAYOUT
    })
  })
})

test('app settings update general preferences while preserving unknown fields', () => {
  withTempAgentDir((agentDir) => {
    const settingsPath = getAppSettingsPath(agentDir)
    const noProjectTaskFolder = join(agentDir, 'custom-workspace')
    writeFileSync(settingsPath, JSON.stringify({ custom: { keep: true } }), 'utf-8')

    const settings = updateAppSettings(
      {
        noProjectTaskFolder,
        allowExternalFileRead: true,
        preventSleepDuringRuns: true,
        nextActionSuggestionsEnabled: false,
        fileOpenConversationLayout: 'tab'
      },
      agentDir
    )
    const raw = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>

    assert.deepEqual(settings, {
      noProjectTaskFolder,
      allowExternalFileRead: true,
      preventSleepDuringRuns: true,
      nextActionSuggestionsEnabled: false,
      fileOpenConversationLayout: 'tab'
    })
    assert.deepEqual(raw.custom, { keep: true })
    assert.equal(raw.noProjectTaskFolder, noProjectTaskFolder)
    assert.equal(raw.allowExternalFileRead, true)
    assert.equal(existsSync(noProjectTaskFolder), true)
  })
})

test('app settings rejects invalid no-project task folders', () => {
  withTempAgentDir((agentDir) => {
    assert.throws(
      () => updateAppSettings({ noProjectTaskFolder: 'relative/path' }, agentDir),
      /无项目任务文件夹必须是绝对路径/
    )
  })
})

test('app settings rejects invalid file-open conversation layouts', () => {
  withTempAgentDir((agentDir) => {
    assert.throws(
      () => updateAppSettings({ fileOpenConversationLayout: 'floating' }, agentDir),
      /打开文件时的对话布局设置无效/
    )
  })
})

test('last model preference distinguishes no choice from persisted automatic selection', () => {
  withTempAgentDir((agentDir) => {
    assert.equal(readLastSelectedModel(agentDir), undefined)
    const model = { providerId: 'openai', modelId: 'gpt-test' }
    writeLastSelectedModel(model, agentDir)
    assert.deepEqual(readLastSelectedModel(agentDir), model)
    writeLastSelectedModel(null, agentDir)
    assert.equal(readLastSelectedModel(agentDir), null)
  })
})

test('last model preference preserves general settings and ignores malformed preferences', () => {
  withTempAgentDir((agentDir) => {
    const path = getAppSettingsPath(agentDir)
    writeFileSync(path, JSON.stringify({ custom: 'keep', lastSelectedModel: { modelId: 'bad' } }))
    assert.equal(readLastSelectedModel(agentDir), undefined)
    writeLastSelectedModel({ providerId: 'fixture', modelId: 'valid' }, agentDir)
    updateAppSettings({ allowExternalFileRead: true }, agentDir)
    assert.deepEqual(readLastSelectedModel(agentDir), { providerId: 'fixture', modelId: 'valid' })
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(raw.custom, 'keep')
    assert.equal(raw.allowExternalFileRead, true)
    writeFileSync(path, '{invalid')
    assert.equal(readLastSelectedModel(agentDir), undefined)
    assert.throws(() => writeLastSelectedModel(null, agentDir), /不是合法 JSON/)
    assert.equal(readFileSync(path, 'utf8'), '{invalid')
  })
})
