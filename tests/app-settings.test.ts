import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_NEXT_ACTION_SUGGESTIONS_ENABLED,
  DEFAULT_OFFICE_ENABLED,
  DEFAULT_PREVENT_SLEEP_DURING_RUNS
} from '../src/shared/appSettingsTypes'
import {
  getAppSettingsPath,
  readAppSettings,
  updateAppSettings
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
      preventSleepDuringRuns: DEFAULT_PREVENT_SLEEP_DURING_RUNS,
      nextActionSuggestionsEnabled: DEFAULT_NEXT_ACTION_SUGGESTIONS_ENABLED,
      officeEnabled: DEFAULT_OFFICE_ENABLED
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
        preventSleepDuringRuns: true,
        nextActionSuggestionsEnabled: false,
        officeEnabled: false
      },
      agentDir
    )
    const raw = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>

    assert.deepEqual(settings, {
      noProjectTaskFolder,
      preventSleepDuringRuns: true,
      nextActionSuggestionsEnabled: false,
      officeEnabled: false
    })
    assert.deepEqual(raw.custom, { keep: true })
    assert.equal(raw.noProjectTaskFolder, noProjectTaskFolder)
    assert.equal(raw.officeEnabled, false)
    assert.equal(existsSync(noProjectTaskFolder), true)
    assert.deepEqual(readdirSync(agentDir).sort(), ['custom-workspace', 'settings.json'])
  })
})

test('app settings recover corrupt files with Office enabled by default', () => {
  withTempAgentDir((agentDir) => {
    const settingsPath = getAppSettingsPath(agentDir)
    writeFileSync(settingsPath, '{broken', 'utf-8')

    assert.equal(readAppSettings(agentDir).officeEnabled, true)
    assert.equal(updateAppSettings({ officeEnabled: false }, agentDir).officeEnabled, false)
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf-8')), { officeEnabled: false })
    assert.deepEqual(readdirSync(agentDir), ['settings.json'])
  })
})

test('app settings accept only whitelisted keys and boolean Office values', () => {
  withTempAgentDir((agentDir) => {
    assert.throws(() => updateAppSettings({ arbitrarySetting: true }, agentDir), /不支持的设置项/)
    assert.throws(() => updateAppSettings({ officeEnabled: 'yes' }, agentDir), /Office/)
    assert.equal(existsSync(getAppSettingsPath(agentDir)), false)
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
