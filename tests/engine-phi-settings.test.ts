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

async function runSettingsScenario<T>(
  body: string,
  environment: Record<string, string> = {}
): Promise<T> {
  const source = `
import { Settings } from ${JSON.stringify(SETTINGS_MODULE_URL)}
import {
  cfgCompactionEnabled, cfgCompactionThresholdPercent,
  cfgCompactionThresholdTokens, cfgCompactionMethodOrder
} from '@oh-my-pi/pi-coding-agent/session/context-settings'
import { cfgRetryFallbackChains } from '@oh-my-pi/pi-coding-agent/session/settings'
import { cfgMemoryBackend } from '@oh-my-pi/pi-coding-agent/memory-backend/settings'
import { cfgExtensions } from '@oh-my-pi/pi-coding-agent/extensibility/settings'
import { cfgSearxngToken, cfgSearxngBasicUsername, cfgSearxngBasicPassword } from '@oh-my-pi/pi-coding-agent/web/settings'
import { resolveRoleChain } from '@oh-my-pi/pi-coding-agent/config/model-resolver'
import { getBundledModels } from '@oh-my-pi/pi-catalog/models'
import {
  applyAutoCompactionOverrides,
  createPhiSettings
} from ${JSON.stringify(PHI_SETTINGS_MODULE_URL)}

const result = await (async () => {
${body}
})()
console.log(${JSON.stringify(RESULT_MARKER)} + JSON.stringify(result))
`
  const env = { ...process.env }
  for (const key of [
    'SEARXNG_ENDPOINT',
    'SEARXNG_TOKEN',
    'SEARXNG_BASIC_USERNAME',
    'SEARXNG_BASIC_PASSWORD'
  ]) {
    delete env[key]
  }
  const { stdout } = await execFileAsync('bun', ['--eval', source], {
    cwd: process.cwd(),
    env: { ...env, ...environment },
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
    order: [
      'searxng',
      'exa',
      'parallel',
      'firecrawl',
      'startpage',
      'duckduckgo',
      'ecosia',
      'mojeek',
      'public'
    ],
    excluded: [
      'perplexity',
      'gemini',
      'anthropic',
      'codex',
      'xai',
      'zai',
      'tinyfish',
      'jina',
      'kagi',
      'tavily',
      'brave',
      'kimi',
      'synthetic',
      'google'
    ],
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
  enabled: cfgCompactionEnabled.get(settings),
  thresholdPercent: cfgCompactionThresholdPercent.get(settings),
  thresholdTokens: cfgCompactionThresholdTokens.get(settings),
  methodOrder: cfgCompactionMethodOrder.get(settings)
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
return createPhiSettings(persisted).webSearch.read()
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
return cfgMemoryBackend.get(settings)
`)

  assert.equal(result, 'local')
})

test('PhiSettings writes the effective SDK search role and fallback chain', async (t) => {
  const agentDir = temporarySettingsDirectory('phi-settings-search-chain-')
  t.after(() => rmSync(agentDir, { recursive: true, force: true }))
  writeConfig(
    agentDir,
    `modelRoles:
  default: anthropic/claude-haiku-4-5
retry:
  fallbackChains:
    default:
      - openai/gpt-4o-mini
searxng:
  token: retained-token
  basicUsername: ''
  basicPassword: ''
`
  )
  const result = await runSettingsScenario<{
    role: string
    chain: string[]
    resolved: string[]
    roles: unknown
    defaultChain: string[]
    afterReload: unknown
    credentials: unknown
    retiredKeys: unknown
    cleared: unknown
  }>(`
const agentDir = ${JSON.stringify(agentDir)}
const settings = await Settings.loadIsolated({ cwd: agentDir, agentDir })
const phi = createPhiSettings(settings)
phi.webSearch.write({
  order: ['searxng', 'exa', 'google'],
  excluded: ['google', 'brave', 'gemini', 'anthropic', 'codex', 'xai'],
  endpoint: 'https://search-chain.example.test',
  engines: 'science'
})
const role = settings.getModelRole('web')
const chain = cfgRetryFallbackChains.get(settings).web
const resolved = resolveRoleChain('web', settings, getBundledModels('web'))
  .map(({ model }) => model.provider + '/' + model.id)
await phi.flush()
const reloaded = await Settings.loadReadOnly({ cwd: agentDir, agentDir })
const afterReload = createPhiSettings(reloaded).webSearch.read()
const credentials = createPhiSettings(reloaded).webSearch.readSearxngCredentials()
phi.webSearch.write({ order: ['exa'], excluded: ['google'], endpoint: undefined, engines: undefined })
await phi.flush()
const cleared = createPhiSettings(await Settings.loadReadOnly({ cwd: agentDir, agentDir })).webSearch.read()
return {
  role, chain, resolved, roles: reloaded.getModelRoles(),
  defaultChain: cfgRetryFallbackChains.get(reloaded).default,
  afterReload, credentials,
  retiredKeys: reloaded.getGlobalSettings().providers ?? {},
  cleared
}
`)
  const expectedChain = [
    'web/exa',
    'web/perplexity',
    'web/zai',
    'web/tinyfish',
    'web/jina',
    'web/kagi',
    'web/tavily',
    'web/firecrawl',
    'web/kimi',
    'web/parallel',
    'web/synthetic',
    'web/startpage',
    'web/duckduckgo',
    'web/ecosia',
    'web/mojeek',
    'web/public'
  ]
  assert.equal(result.role, 'web/searxng')
  assert.deepEqual(result.chain, expectedChain)
  assert.deepEqual(result.resolved, ['web/searxng', ...expectedChain])
  assert.deepEqual(result.roles, {
    default: 'anthropic/claude-haiku-4-5',
    web: 'web/searxng'
  })
  assert.deepEqual(result.defaultChain, ['openai/gpt-4o-mini'])
  assert.deepEqual(result.afterReload, {
    order: ['searxng', 'exa', 'google'],
    excluded: ['google', 'brave', 'gemini', 'anthropic', 'codex', 'xai'],
    endpoint: 'https://search-chain.example.test',
    engines: 'science'
  })
  assert.deepEqual(result.credentials, {
    endpoint: 'https://search-chain.example.test',
    token: 'retained-token',
    basicUsername: '',
    basicPassword: ''
  })
  assert.deepEqual(result.retiredKeys, {})
  assert.deepEqual(result.cleared, { order: ['exa'], excluded: ['google'] })
})

test('PhiSettings maps grounding providers and ignores stale provider metadata', async () => {
  const result = await runSettingsScenario<{
    role: string
    chain: string[]
    changed: { order: string[]; excluded: string[] }
  }>(`
const settings = Settings.isolated()
const phi = createPhiSettings(settings)
phi.webSearch.write({ order: ['gemini', 'anthropic', 'codex', 'xai'], excluded: [], endpoint: undefined, engines: undefined })
const role = settings.getModelRole('web')
const chain = cfgRetryFallbackChains.get(settings).web
settings.setModelRole('web', 'web/brave')
cfgRetryFallbackChains.set(settings, { web: ['web/google'] })
const changed = phi.webSearch.read()
return { role, chain, changed }
`)
  assert.equal(result.role, 'google-gemini-cli/gemini-2.5-flash')
  assert.deepEqual(result.chain.slice(0, 5), [
    'google-antigravity/gemini-2.5-flash',
    'google/gemini-2.5-flash',
    'anthropic/claude-haiku-4-5',
    'openai-codex/gpt-5.6-luna',
    'xai/grok-4.5'
  ])
  assert.deepEqual(result.changed.order, ['brave', 'google'])
  assert.ok(result.changed.excluded.includes('gemini'))
  assert.ok(!result.changed.excluded.includes('brave'))
  assert.ok(!result.changed.excluded.includes('google'))
})

test('PhiSettings respects native roles and fallback chains during legacy migration', async (t) => {
  const agentDir = temporarySettingsDirectory('phi-settings-native-web-')
  t.after(() => rmSync(agentDir, { recursive: true, force: true }))
  writeConfig(
    agentDir,
    `providers:
  webSearchOrder:
    - searxng
  webSearchExclude:
    - google
modelRoles:
  web: web/brave
retry:
  fallbackChains:
    web:
      - web/exa
`
  )
  const result = await runSettingsScenario<{
    role: string
    chain: string[]
    read: { order: string[]; excluded: string[] }
  }>(`
const agentDir = ${JSON.stringify(agentDir)}
const settings = await Settings.loadIsolated({ cwd: agentDir, agentDir })
return {
  role: settings.getModelRole('web'),
  chain: cfgRetryFallbackChains.get(settings).web,
  read: createPhiSettings(settings).webSearch.read()
}
`)
  assert.equal(result.role, 'web/brave')
  assert.deepEqual(result.chain, ['web/exa'])
  assert.deepEqual(result.read.order, ['brave', 'exa'])
  assert.ok(result.read.excluded.includes('searxng'))
  assert.ok(result.read.excluded.includes('google'))
})

test('PhiSettings preserves project extension provenance and keeps overrides transient', async (t) => {
  const agentDir = temporarySettingsDirectory('phi-settings-project-')
  const projectDir = join(agentDir, 'project')
  const configDir = join(projectDir, '.omp')
  mkdirSync(configDir, { recursive: true })
  t.after(() => rmSync(agentDir, { recursive: true, force: true }))
  writeConfig(
    agentDir,
    `compaction:
  enabled: false
  thresholdPercent: 80
  thresholdTokens: 22222
  methodOrder:
    - soft
memory:
  backend: off
`
  )
  const extensionPath = join(projectDir, 'project-extension')
  writeFileSync(
    join(configDir, 'config.yml'),
    `extensions:\n  - ${JSON.stringify(extensionPath)}\n`
  )
  const result = await runSettingsScenario<{
    project: unknown
    override: unknown
    compaction: unknown
    persistedCompaction: unknown
    memory: string
    persistedMemory: string
  }>(`
const agentDir = ${JSON.stringify(agentDir)}
const projectDir = ${JSON.stringify(projectDir)}
const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir })
const phi = createPhiSettings(settings)
const project = phi.extensions.read()
project.configured.push('mutated-copy')
const projectAgain = phi.extensions.read()
cfgExtensions.override(settings, ['runtime-extension'])
const override = phi.extensions.read()
applyAutoCompactionOverrides(settings, { enabled: true, thresholdPercent: 0 })
phi.memory.useLocalBackend()
await phi.flush()
const persisted = await Settings.loadReadOnly({ cwd: projectDir, agentDir })
return {
  project: projectAgain, override,
  compaction: phi.compaction.read(),
  persistedCompaction: createPhiSettings(persisted).compaction.read(),
  memory: cfgMemoryBackend.get(settings),
  persistedMemory: cfgMemoryBackend.get(persisted)
}
`)
  assert.deepEqual(result.project, { configured: [extensionPath], sourceLevel: 'project' })
  assert.deepEqual(result.override, { configured: ['runtime-extension'], sourceLevel: 'user' })
  assert.deepEqual(result.compaction, {
    enabled: true,
    thresholdPercent: 0,
    thresholdTokens: -1,
    methodOrder: ['soft']
  })
  assert.deepEqual(result.persistedCompaction, {
    enabled: false,
    thresholdPercent: 80,
    thresholdTokens: 22222,
    methodOrder: ['soft']
  })
  assert.equal(result.memory, 'local')
  assert.equal(result.persistedMemory, 'off')
})

test('PhiSettings does not persist inherited project fallback chains', async (t) => {
  const agentDir = temporarySettingsDirectory('phi-settings-chain-scope-')
  const projectDir = join(agentDir, 'project')
  const configDir = join(projectDir, '.omp')
  mkdirSync(configDir, { recursive: true })
  t.after(() => rmSync(agentDir, { recursive: true, force: true }))
  writeConfig(
    agentDir,
    `retry:
  fallbackChains:
    default:
      - openai/gpt-4o-mini
`
  )
  writeFileSync(
    join(configDir, 'config.yml'),
    `retry:
  fallbackChains:
    image:
      - openai/gpt-image-2
`
  )
  const result = await runSettingsScenario<{ effective: unknown; global: unknown }>(`
const agentDir = ${JSON.stringify(agentDir)}
const projectDir = ${JSON.stringify(projectDir)}
const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir })
createPhiSettings(settings).webSearch.write({ order: ['exa'], excluded: [], endpoint: undefined, engines: undefined })
await settings.flush()
const global = await Settings.loadReadOnly({ cwd: agentDir, agentDir })
return {
  effective: cfgRetryFallbackChains.get(settings).image,
  global: cfgRetryFallbackChains.get(global).image ?? null
}
`)
  assert.deepEqual(result.effective, ['openai/gpt-image-2'])
  assert.equal(result.global, null)
})

test('PhiSettings preserves SearXNG environment fallback and empty Basic credentials', async () => {
  const result = await runSettingsScenario<{ fallback: unknown; configured: unknown }>(
    `
const fallback = createPhiSettings(Settings.isolated()).webSearch.readSearxngCredentials()
const settings = Settings.isolated({
  'searxng.endpoint': 'https://configured.example.test',
  'searxng.token': 'configured-token',
  'searxng.basicUsername': '',
  'searxng.basicPassword': ''
})
return { fallback, configured: createPhiSettings(settings).webSearch.readSearxngCredentials() }
`,
    {
      SEARXNG_ENDPOINT: 'https://environment.example.test',
      SEARXNG_TOKEN: 'environment-token',
      SEARXNG_BASIC_USERNAME: 'environment-user',
      SEARXNG_BASIC_PASSWORD: 'environment-password'
    }
  )
  assert.deepEqual(result.fallback, {
    endpoint: 'https://environment.example.test',
    token: 'environment-token',
    basicUsername: 'environment-user',
    basicPassword: 'environment-password'
  })
  assert.deepEqual(result.configured, {
    endpoint: 'https://configured.example.test',
    token: 'configured-token',
    basicUsername: '',
    basicPassword: ''
  })
})

test('PhiSettings expands native role aliases and rejects cycles like the SDK', async () => {
  const result = await runSettingsScenario<{
    alias: { order: string[]; excluded: string[]; resolved: string[] }
    cycle: { order: string[]; excluded: string[]; resolved: string[] }
    alternatives: { order: string[]; excluded: string[]; resolved: string[] }
  }>(`
const pool = getBundledModels('web')
const read = (settings) => ({
  ...createPhiSettings(settings).webSearch.read(),
  resolved: resolveRoleChain('web', settings, pool).map(({ model }) => model.id)
})
const alias = Settings.isolated()
alias.setModelRole('smol', 'web/exa')
alias.setModelRole('web', '@smol')
alias.setModelRole('backup-search', 'web/brave')
cfgRetryFallbackChains.set(alias, { web: ['@backup-search'] })
const aliasResult = read(alias)

const cycle = Settings.isolated()
cycle.setModelRole('first-search', '@second-search')
cycle.setModelRole('second-search', '@first-search')
cycle.setModelRole('web', '@first-search')
cfgRetryFallbackChains.set(cycle, { web: ['web/brave'] })

const alternatives = Settings.isolated()
alternatives.setModelRole('smol', 'web/exa')
alternatives.setModelRole('web', '@smol,web/google')
cfgRetryFallbackChains.set(alternatives, { web: ['web/brave', 'web/searxng:high'] })
return { alias: aliasResult, cycle: read(cycle), alternatives: read(alternatives) }
`)
  assert.deepEqual(result.alias.resolved, ['exa', 'brave'])
  assert.deepEqual(result.alias.order, result.alias.resolved)
  assert.ok(!result.alias.excluded.includes('exa'))
  assert.ok(!result.alias.excluded.includes('brave'))
  assert.deepEqual(result.cycle.resolved, ['brave'])
  assert.deepEqual(result.cycle.order, result.cycle.resolved)
  assert.deepEqual(result.alternatives.resolved, ['exa', 'brave', 'searxng'])
  // Comma patterns are availability alternatives inside one SDK attempt. Show
  // all configured alternatives without marking their providers as excluded.
  assert.deepEqual(result.alternatives.order, ['exa', 'google', 'brave', 'searxng'])
  for (const provider of result.alternatives.order) {
    assert.ok(!result.alternatives.excluded.includes(provider))
  }
})

test('PhiSettings invalidates provider metadata when an indirect role changes', async () => {
  const result = await runSettingsScenario<{
    before: { order: string[]; excluded: string[] }
    after: { order: string[]; excluded: string[] }
  }>(`
const settings = Settings.isolated()
const phi = createPhiSettings(settings)
phi.webSearch.write({ order: ['exa'], excluded: ['google'], endpoint: undefined, engines: undefined })
settings.setModelRole('smol', 'web/exa')
settings.setModelRole('web', '@smol')
const before = phi.webSearch.read()
settings.setModelRole('smol', 'web/google')
return { before, after: phi.webSearch.read() }
`)
  assert.deepEqual(result.before, { order: ['exa'], excluded: ['google'] })
  assert.equal(result.after.order[0], 'google')
  assert.ok(!result.after.excluded.includes('google'))
  assert.ok(result.after.excluded.includes('exa'))
})
