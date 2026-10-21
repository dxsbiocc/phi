import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { beforeEach, afterEach } from 'node:test'

import {
  DEFAULT_FILE_OPEN_CONVERSATION_LAYOUT,
  DEFAULT_NEXT_ACTION_SUGGESTIONS_ENABLED,
  DEFAULT_PREVENT_SLEEP_DURING_RUNS
} from '../src/shared/appSettingsTypes'
import {
  getAppSettingsPath,
  configureSystemUiLanguage,
  readAppSettings,
  readLastSelectedModel,
  updateAppSettings,
  writeLastSelectedModel
} from '../src/main/agent/app-settings'

beforeEach(() => configureSystemUiLanguage([]))
afterEach(() => configureSystemUiLanguage([]))

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
      uiLanguage: 'en',
      noProjectTaskFolder: join(agentDir, 'workspace'),
      allowExternalFileRead: false,
      preventSleepDuringRuns: DEFAULT_PREVENT_SLEEP_DURING_RUNS,
      nextActionSuggestionsEnabled: DEFAULT_NEXT_ACTION_SUGGESTIONS_ENABLED,
      fileOpenConversationLayout: DEFAULT_FILE_OPEN_CONVERSATION_LAYOUT,
      modelAvailability: { disabledProviders: [], disabledModels: [] }
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
      uiLanguage: 'en',
      noProjectTaskFolder,
      allowExternalFileRead: true,
      preventSleepDuringRuns: true,
      nextActionSuggestionsEnabled: false,
      fileOpenConversationLayout: 'tab',
      modelAvailability: { disabledProviders: [], disabledModels: [] }
    })
    assert.deepEqual(raw.custom, { keep: true })
    assert.equal(raw.noProjectTaskFolder, noProjectTaskFolder)
    assert.equal(raw.allowExternalFileRead, true)
    assert.equal(existsSync(noProjectTaskFolder), true)
  })
})

test('interface language persists independently and invalid updates leave settings unchanged', () => {
  withTempAgentDir((agentDir) => {
    const path = getAppSettingsPath(agentDir)
    writeFileSync(path, JSON.stringify({ custom: 'keep', uiLanguage: 'unsupported' }))
    assert.equal(readAppSettings(agentDir).uiLanguage, 'en')
    assert.equal(updateAppSettings({ uiLanguage: 'zh-CN' }, agentDir).uiLanguage, 'zh-CN')
    assert.equal(readAppSettings(agentDir).uiLanguage, 'zh-CN')
    const before = readFileSync(path, 'utf8')
    for (const value of [null, 'zh', '', 'EN', 1, {}]) {
      assert.throws(
        () => updateAppSettings({ uiLanguage: value }, agentDir),
        /Unsupported interface language/
      )
      assert.equal(readFileSync(path, 'utf8'), before)
    }
    assert.equal(updateAppSettings({ uiLanguage: 'en' }, agentDir).uiLanguage, 'en')
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).custom, 'keep')
  })
})

test('missing language follows the system without making unrelated saves a manual language choice', () => {
  withTempAgentDir((agentDir) => {
    const path = getAppSettingsPath(agentDir)
    configureSystemUiLanguage(['zh-Hans-CN', 'en-US'])
    assert.equal(readAppSettings(agentDir).uiLanguage, 'zh-CN')
    assert.equal(existsSync(path), false, 'detecting a default does not create settings')
    assert.equal(updateAppSettings({ preventSleepDuringRuns: true }, agentDir).uiLanguage, 'zh-CN')
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(path, 'utf8')), 'uiLanguage'), false)
    configureSystemUiLanguage(['en-US', 'zh-Hans-CN'])
    assert.equal(readAppSettings(agentDir).uiLanguage, 'en')
  })
})

test('a manual language choice survives system language changes and unrelated settings saves', () => {
  withTempAgentDir((agentDir) => {
    configureSystemUiLanguage(['zh-CN'])
    assert.equal(updateAppSettings({ uiLanguage: 'en' }, agentDir).uiLanguage, 'en')
    assert.equal(readAppSettings(agentDir).uiLanguage, 'en')
    assert.equal(updateAppSettings({ preventSleepDuringRuns: true }, agentDir).uiLanguage, 'en')
    configureSystemUiLanguage(['en-US'])
    assert.equal(updateAppSettings({ uiLanguage: 'zh-CN' }, agentDir).uiLanguage, 'zh-CN')
    assert.equal(readAppSettings(agentDir).uiLanguage, 'zh-CN')
    assert.equal(updateAppSettings({ preventSleepDuringRuns: false }, agentDir).uiLanguage, 'zh-CN')
  })
})

test('invalid or unreadable saved languages use the system default', () => {
  withTempAgentDir((agentDir) => {
    configureSystemUiLanguage(['zh-TW'])
    const path = getAppSettingsPath(agentDir)
    for (const value of ['unsupported', null, 1]) {
      writeFileSync(path, JSON.stringify({ uiLanguage: value }))
      assert.equal(readAppSettings(agentDir).uiLanguage, 'zh-CN')
    }
    writeFileSync(path, '{invalid')
    assert.equal(readAppSettings(agentDir).uiLanguage, 'zh-CN')
    configureSystemUiLanguage([])
    assert.equal(readAppSettings(agentDir).uiLanguage, 'en')
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

test('legacy manual decision settings are inert and remain untouched when saving general preferences', () => {
  withTempAgentDir((agentDir) => {
    const path = getAppSettingsPath(agentDir)
    const original = {
      custom: { keep: true },
      decisionModel: { providerId: 'typesafe', modelId: 'old-jev' }
    }
    writeFileSync(path, JSON.stringify(original))
    assert.equal('decisionModel' in readAppSettings(agentDir), false)
    assert.deepEqual(readAppSettings(agentDir).modelAvailability, {
      disabledProviders: [],
      disabledModels: []
    })
    updateAppSettings(
      { decisionModel: { providerId: 'forged', modelId: 'ignored' }, preventSleepDuringRuns: true },
      agentDir
    )
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
      ...original,
      preventSleepDuringRuns: true
    })
  })
})
