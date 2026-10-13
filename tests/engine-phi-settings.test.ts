import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const RESULT_MARKER = 'PHI_SETTINGS_RESULT='
const SETTINGS_MODULE_URL = pathToFileURL(
  join(process.cwd(), 'node_modules/@oh-my-pi/pi-coding-agent/src/config/settings.ts')
).href
const PHI_SETTINGS_MODULE_URL = pathToFileURL(
  join(process.cwd(), 'src/main/agent/engine/in-process/settings.ts')
).href
const DEFAULT_METHOD_ORDER = ['remote', 'snapcompact', 'handoff', 'shake', 'soft']

function temporarySettingsDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function writeConfig(agentDir: string, contents: string): void {
  writeFileSync(join(agentDir, 'config.yml'), contents)
}

async function runSettingsScenario<T>(body: string): Promise<T> {
  const source = `
import { Settings } from ${JSON.stringify(SETTINGS_MODULE_URL)}
import {
  applyAutoCompactionOverrides,
  createPhiSettings
} from ${JSON.stringify(PHI_SETTINGS_MODULE_URL)}

const result = await (async () => {
${body}
})()
console.log(${JSON.stringify(RESULT_MARKER)} + JSON.stringify(result))
`
  const { stdout } = await execFileAsync('bun', ['--eval', source], {
    cwd: process.cwd(),
    env: process.env,
    timeout: 30000,
    maxBuffer: 1024 * 1024
  })
  const line = stdout.split('\n').find((candidate) => candidate.startsWith(RESULT_MARKER))
  assert.ok(line, `Bun settings scenario did not return a result:\n${stdout}`)
  return JSON.parse(line.slice(RESULT_MARKER.length)) as T
}

test('PhiSettings reads stored OMP values and applies Phi defaults', async (t) => {
  const emptyAgentDir = temporarySettingsDirectory('phi-settings-defaults-')
  const configuredAgentDir = temporarySettingsDirectory('phi-settings-values-')
  t.after(() => {
    rmSync(emptyAgentDir, { recursive: true, force: true })
    rmSync(configuredAgentDir, { recursive: true, force: true })
  })

  const extensionPath = join(configuredAgentDir, 'example-extension')
  writeConfig(
    configuredAgentDir,
    `compaction:
  enabled: false
  thresholdPercent: 75
  thresholdTokens: 12345
  methodOrder:
    - shake
    - soft
mcp:
  enableProjectConfig: false
  notifications: true
extensions:
  - ${JSON.stringify(extensionPath)}
providers:
  webSearchOrder:
    - searxng
    - exa
  webSearchExclude:
    - google
searxng:
  endpoint: https://search.example.test
  token: secret-token
  basicUsername: search-user
  basicPassword: secret-password
  engines: general,science
`
  )

  const result = await runSettingsScenario<{
    defaults: { mcp: unknown; extensions: unknown }
    configured: {
      compaction: unknown
      webSearch: unknown
      credentials: unknown
      mcp: unknown
      extensions: unknown
    }
  }>(`
const emptyAgentDir = ${JSON.stringify(emptyAgentDir)}
const configuredAgentDir = ${JSON.stringify(configuredAgentDir)}
const empty = createPhiSettings(await Settings.loadIsolated({
  cwd: emptyAgentDir,
  agentDir: emptyAgentDir
}))
const configured = createPhiSettings(await Settings.loadIsolated({
  cwd: configuredAgentDir,
  agentDir: configuredAgentDir
}))
return {
  defaults: {
    mcp: empty.mcp.read(),
    extensions: empty.extensions.read()
  },
  configured: {
    compaction: configured.compaction.read(),
    webSearch: configured.webSearch.read(),
    credentials: configured.webSearch.readSearxngCredentials(),
    mcp: configured.mcp.read(),
    extensions: configured.extensions.read()
  }
}
`)

  assert.deepEqual(result.defaults.mcp, {
    enableProjectConfig: true,
    notifications: false
  })
  assert.deepEqual(result.defaults.extensions, {
    configured: [],
    sourceLevel: 'user'
  })
  assert.deepEqual(result.configured.compaction, {
    enabled: false,
    thresholdPercent: 75,
    thresholdTokens: 12345,
    methodOrder: ['shake', 'soft']
  })
  assert.deepEqual(result.configured.webSearch, {
    order: ['searxng', 'exa'],
    excluded: ['google'],
    endpoint: 'https://search.example.test',
    engines: 'general,science'
  })
  assert.deepEqual(result.configured.credentials, {
    endpoint: 'https://search.example.test',
    token: 'secret-token',
    basicUsername: 'search-user',
    basicPassword: 'secret-password'
  })
  assert.deepEqual(result.configured.mcp, {
    enableProjectConfig: false,
    notifications: true
  })
  assert.deepEqual(result.configured.extensions, {
    configured: [extensionPath],
    sourceLevel: 'user'
  })
})

test('PhiSettings compaction overrides all keys and restores the original baseline', async (t) => {
  const directAgentDir = temporarySettingsDirectory('phi-settings-compaction-direct-')
  const baselineAgentDir = temporarySettingsDirectory('phi-settings-compaction-baseline-')
  t.after(() => {
    rmSync(directAgentDir, { recursive: true, force: true })
    rmSync(baselineAgentDir, { recursive: true, force: true })
  })
  writeConfig(
    baselineAgentDir,
    `compaction:
  enabled: false
  thresholdPercent: 85
  thresholdTokens: 43210
  methodOrder: []
`
  )

  const result = await runSettingsScenario<{
    direct: unknown
    enabled: unknown
    restored: unknown
    thresholdOnly: unknown
  }>(`
const readRaw = (settings) => ({
  enabled: settings.get('compaction.enabled'),
  thresholdPercent: settings.get('compaction.thresholdPercent'),
  thresholdTokens: settings.get('compaction.thresholdTokens'),
  methodOrder: settings.get('compaction.methodOrder')
})
const directAgentDir = ${JSON.stringify(directAgentDir)}
const directSettings = await Settings.loadIsolated({
  cwd: directAgentDir,
  agentDir: directAgentDir
})
createPhiSettings(directSettings).compaction.override({
  enabled: false,
  thresholdPercent: 70,
  thresholdTokens: 50000,
  methodOrder: ['handoff', 'soft']
})
const direct = readRaw(directSettings)

const baselineAgentDir = ${JSON.stringify(baselineAgentDir)}
const baselineSettings = await Settings.loadIsolated({
  cwd: baselineAgentDir,
  agentDir: baselineAgentDir
})
applyAutoCompactionOverrides(baselineSettings, { enabled: true, thresholdPercent: 70 })
const enabled = readRaw(baselineSettings)
applyAutoCompactionOverrides(baselineSettings, {})
const restored = readRaw(baselineSettings)
applyAutoCompactionOverrides(baselineSettings, { thresholdPercent: 90 })
const thresholdOnly = readRaw(baselineSettings)
return { direct, enabled, restored, thresholdOnly }
`)

  assert.deepEqual(result.direct, {
    enabled: false,
    thresholdPercent: 70,
    thresholdTokens: 50000,
    methodOrder: ['handoff', 'soft']
  })
  assert.deepEqual(result.enabled, {
    enabled: true,
    thresholdPercent: 70,
    thresholdTokens: -1,
    methodOrder: DEFAULT_METHOD_ORDER
  })
  assert.deepEqual(result.restored, {
    enabled: false,
    thresholdPercent: 85,
    thresholdTokens: 43210,
    methodOrder: []
  })
  assert.deepEqual(result.thresholdOnly, {
    enabled: false,
    thresholdPercent: 90,
    thresholdTokens: -1,
    methodOrder: []
  })
})

test('PhiSettings web search writes persist after flush', async (t) => {
  const agentDir = temporarySettingsDirectory('phi-settings-web-search-')
  t.after(() => rmSync(agentDir, { recursive: true, force: true }))

  const result = await runSettingsScenario<unknown>(`
const agentDir = ${JSON.stringify(agentDir)}
const settings = await Settings.loadIsolated({ cwd: agentDir, agentDir })
const phiSettings = createPhiSettings(settings)
phiSettings.webSearch.write({
  order: ['searxng', 'exa'],
  excluded: ['google', 'brave'],
  endpoint: 'https://persisted.example.test',
  engines: 'general,science'
})
await phiSettings.flush()
const persisted = await Settings.loadReadOnly({ cwd: agentDir, agentDir })
return {
  order: persisted.get('providers.webSearchOrder'),
  excluded: persisted.get('providers.webSearchExclude'),
  endpoint: persisted.get('searxng.endpoint'),
  engines: persisted.get('searxng.engines')
}
`)

  assert.deepEqual(result, {
    order: ['searxng', 'exa'],
    excluded: ['google', 'brave'],
    endpoint: 'https://persisted.example.test',
    engines: 'general,science'
  })
})

test('PhiSettings selects the local OMP memory backend', async (t) => {
  const agentDir = temporarySettingsDirectory('phi-settings-memory-')
  const projectDir = join(agentDir, 'project')
  mkdirSync(projectDir)
  t.after(() => rmSync(agentDir, { recursive: true, force: true }))

  const result = await runSettingsScenario<unknown>(`
const agentDir = ${JSON.stringify(agentDir)}
const projectDir = ${JSON.stringify(projectDir)}
const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir })
createPhiSettings(settings).memory.useLocalBackend()
return settings.get('memory.backend')
`)

  assert.equal(result, 'local')
})
