import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_DB_CONNECTOR_TOOLS_ENABLED,
  DEFAULT_NEXT_ACTION_SUGGESTIONS_ENABLED,
  DEFAULT_PREVENT_SLEEP_DURING_RUNS,
  DEFAULT_PROXY_TRANSPORT_STATUS
} from '../src/shared/appSettingsTypes'
import {
  getAppSettingsPath,
  normalizeDefaultProxyMode,
  readAppSettings,
  updateAppSettings,
  updateDefaultProxyMode
} from '../src/main/agent/app-settings'

function withTempAgentDir(run: (agentDir: string) => void): void {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-app-settings-'))
  try {
    run(agentDir)
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
}

test('app settings default proxy mode falls back to auto', () => {
  withTempAgentDir((agentDir) => {
    assert.deepEqual(readAppSettings(agentDir), {
      defaultProxyMode: 'auto',
      enableDbConnectorTools: DEFAULT_DB_CONNECTOR_TOOLS_ENABLED,
      noProjectTaskFolder: join(agentDir, 'workspace'),
      preventSleepDuringRuns: DEFAULT_PREVENT_SLEEP_DURING_RUNS,
      nextActionSuggestionsEnabled: DEFAULT_NEXT_ACTION_SUGGESTIONS_ENABLED,
      proxyTransportStatus: DEFAULT_PROXY_TRANSPORT_STATUS
    })
    assert.equal(normalizeDefaultProxyMode('enabled'), 'enabled')
    assert.equal(normalizeDefaultProxyMode('disabled'), 'disabled')
    assert.equal(normalizeDefaultProxyMode('unknown'), 'auto')
  })
})

test('app settings update default proxy mode while preserving unknown fields', () => {
  withTempAgentDir((agentDir) => {
    const settingsPath = getAppSettingsPath(agentDir)
    writeFileSync(
      settingsPath,
      JSON.stringify({
        mcpServers: { local: { command: 'phi' } },
        defaultProxyMode: 'disabled',
        enableDbConnectorTools: true
      }),
      'utf-8'
    )

    const settings = updateDefaultProxyMode('enabled', agentDir)
    const raw = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      defaultProxyMode: string
      mcpServers: Record<string, unknown>
    }

    assert.deepEqual(settings, {
      defaultProxyMode: 'enabled',
      enableDbConnectorTools: true,
      noProjectTaskFolder: join(agentDir, 'workspace'),
      preventSleepDuringRuns: DEFAULT_PREVENT_SLEEP_DURING_RUNS,
      nextActionSuggestionsEnabled: DEFAULT_NEXT_ACTION_SUGGESTIONS_ENABLED,
      proxyTransportStatus: DEFAULT_PROXY_TRANSPORT_STATUS
    })
    assert.equal(raw.defaultProxyMode, 'enabled')
    assert.deepEqual(raw.mcpServers, { local: { command: 'phi' } })
  })
})

test('app settings rejects invalid default proxy mode updates', () => {
  withTempAgentDir((agentDir) => {
    assert.throws(() => updateDefaultProxyMode('sometimes', agentDir), /未知默认代理模式/)
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
        nextActionSuggestionsEnabled: false
      },
      agentDir
    )
    const raw = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>

    assert.deepEqual(settings, {
      defaultProxyMode: 'auto',
      enableDbConnectorTools: DEFAULT_DB_CONNECTOR_TOOLS_ENABLED,
      noProjectTaskFolder,
      preventSleepDuringRuns: true,
      nextActionSuggestionsEnabled: false,
      proxyTransportStatus: DEFAULT_PROXY_TRANSPORT_STATUS
    })
    assert.deepEqual(raw.custom, { keep: true })
    assert.equal(raw.noProjectTaskFolder, noProjectTaskFolder)
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
