import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  getAppSettingsPath,
  readAppSettings,
  updateAppSettings
} from '../src/main/agent/app-settings'
import {
  getModelAvailabilityPath,
  isModelEnabled,
  readModelAvailability,
  writeModelAvailabilityChange
} from '../src/main/agent/model-availability'
import { getModelAvailability, setModelEnabled } from '../src/main/agent/model-management'
import type { RuntimeSnapshot } from '../src/main/agent/engine/types'

const catalog: RuntimeSnapshot = {
  providers: [
    { id: 'chat', name: 'Chat', status: { configured: true } },
    { id: 'native', name: 'Native', status: { configured: true } },
    { id: 'empty', name: 'Empty' }
  ],
  models: ['one', 'two'].map((id) => ({ provider: 'chat', id, name: id, reasoning: false })),
  credentials: [{ providerId: 'chat', type: 'api_key', label: 'kept' }]
}
const native = { providerId: 'native', modelId: 'jev', name: 'JEV', configured: true }
function engine(
  snapshot: () => Promise<RuntimeSnapshot> = async () => catalog
): NonNullable<Parameters<typeof getModelAvailability>[1]> {
  return { models: { snapshot }, decisions: { models: async () => [native] } }
}
function fixture(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'phi-model-availability-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('availability defaults enabled; provider suppression preserves independent model choices and credentials across reads', async (t) => {
  const dir = fixture(t)
  const secrets = join(dir, 'auth.json')
  writeFileSync(secrets, '{"synthetic":"preserve byte-for-byte"}')
  writeFileSync(getAppSettingsPath(dir), JSON.stringify({ custom: 'keep', decisionModel: native }))
  assert.deepEqual(readModelAvailability(dir), { disabledProviders: [], disabledModels: [] })
  const initial = await getModelAvailability(dir, engine())
  assert.equal(initial.models.length, 3)
  assert.equal(
    initial.models.every((model) => model.enabled),
    true
  )
  assert.equal(initial.models.at(-1)?.kind, 'decision')
  await setModelEnabled({ providerId: 'chat', modelId: 'one', enabled: false }, dir, engine())
  const off = await setModelEnabled({ providerId: 'chat', enabled: false }, dir, engine())
  assert.equal(
    off.models.filter((model) => model.providerId === 'chat').every((model) => !model.enabled),
    true
  )
  const on = await setModelEnabled({ providerId: 'chat', enabled: true }, dir, engine())
  assert.equal(on.models.find((model) => model.modelId === 'one')?.enabled, false)
  assert.equal(on.models.find((model) => model.modelId === 'two')?.enabled, true)
  assert.deepEqual(readAppSettings(dir).modelAvailability, readModelAvailability(dir))
  assert.equal(readFileSync(secrets, 'utf8'), '{"synthetic":"preserve byte-for-byte"}')
  assert.equal(JSON.parse(readFileSync(getAppSettingsPath(dir), 'utf8')).custom, 'keep')
  assert.deepEqual((await getModelAvailability(dir, engine())).disabledModels, [
    { providerId: 'chat', modelId: 'one' }
  ])
})

test('independent async model toggles merge into fresh saved policy without losing unrelated preferences', async (t) => {
  const dir = fixture(t)
  const releases: Array<(value: RuntimeSnapshot) => void> = []
  const waiting = engine(() => new Promise((resolve) => releases.push(resolve)))
  const first = setModelEnabled(
    { providerId: 'chat', modelId: 'one', enabled: false },
    dir,
    waiting
  )
  const second = setModelEnabled({ providerId: 'native', enabled: false }, dir, waiting)
  updateAppSettings({ uiLanguage: 'zh-CN', nextActionSuggestionsEnabled: false }, dir)
  releases[1](catalog)
  await second
  releases[0](catalog)
  const result = await first
  assert.deepEqual(result.disabledProviders, ['native'])
  assert.deepEqual(result.disabledModels, [{ providerId: 'chat', modelId: 'one' }])
  assert.equal(readAppSettings(dir).uiLanguage, 'zh-CN')
  assert.equal(readAppSettings(dir).nextActionSuggestionsEnabled, false)
})

test('invalid or unknown targets and failed catalogs never change settings', async (t) => {
  const dir = fixture(t)
  updateAppSettings({ uiLanguage: 'zh-CN' }, dir)
  const before = readFileSync(getAppSettingsPath(dir), 'utf8')
  for (const value of [
    null,
    {},
    { providerId: ' chat', enabled: false },
    { providerId: 'chat', enabled: 'no' },
    { providerId: 'chat', modelId: '', enabled: false },
    { providerId: 'chat', modelId: undefined, enabled: false },
    { providerId: 'chat\n', enabled: false },
    { providerId: 'chat', enabled: false, apiKey: 'secret' },
    { providerId: 'missing', enabled: false },
    { providerId: 'chat', modelId: 'missing', enabled: false }
  ])
    await assert.rejects(setModelEnabled(value, dir, engine()), /Invalid|Unknown/)
  await assert.rejects(
    setModelEnabled(
      { providerId: 'chat', enabled: false },
      dir,
      engine(async () => {
        throw new Error('discovery failed')
      })
    ),
    /discovery failed/
  )
  assert.equal(readFileSync(getAppSettingsPath(dir), 'utf8'), before)
})

test('legacy availability is read narrowly and corrupt dedicated policy never silently enables models', (t) => {
  const dir = fixture(t)
  writeFileSync(
    getAppSettingsPath(dir),
    JSON.stringify({
      modelAvailability: {
        disabledProviders: ['chat', 'chat', '', 'bad\n', 1],
        disabledModels: [
          { providerId: 'chat', modelId: 'one' },
          { providerId: 'chat', modelId: 'one' },
          { providerId: 'chat' }
        ]
      }
    })
  )
  const saved = readModelAvailability(dir)
  assert.deepEqual(saved, {
    disabledProviders: ['chat'],
    disabledModels: [{ providerId: 'chat', modelId: 'one' }]
  })
  assert.equal(isModelEnabled(saved, 'chat'), false)
  assert.equal(isModelEnabled(saved, 'native', 'jev'), true)
  const dedicated = getModelAvailabilityPath(dir)
  writeFileSync(dedicated, '{invalid')
  assert.throws(
    () => writeModelAvailabilityChange({ providerId: 'chat', enabled: true }, dir),
    /could not be read/
  )
  assert.throws(() => readModelAvailability(dir), /could not be read/)
  assert.equal(readFileSync(dedicated, 'utf8'), '{invalid')
  for (const malformed of [
    null,
    {},
    { disabledProviders: ['chat'], disabledModels: [{}] },
    { disabledProviders: [false], disabledModels: [] }
  ]) {
    writeFileSync(dedicated, JSON.stringify(malformed))
    assert.throws(() => readModelAvailability(dir), /could not be read/)
  }
})

test('dedicated policy owns subsequent writes and overrides legacy settings and SDK backup fields', (t) => {
  const dir = fixture(t)
  const legacy = join(dir, 'settings.json.bak')
  const legacyText = JSON.stringify({
    modelAvailability: { disabledProviders: ['native'], disabledModels: [] },
    unrelated: 'keep'
  })
  writeFileSync(legacy, legacyText)
  assert.deepEqual(readModelAvailability(dir).disabledProviders, ['native'])
  writeModelAvailabilityChange({ providerId: 'native', enabled: true }, dir)
  assert.deepEqual(readModelAvailability(dir), { disabledProviders: [], disabledModels: [] })
  writeFileSync(
    getAppSettingsPath(dir),
    JSON.stringify({ modelAvailability: { disabledProviders: ['chat'], disabledModels: [] } })
  )
  assert.deepEqual(readModelAvailability(dir).disabledProviders, [])
  updateAppSettings({ preventSleepDuringRuns: true }, dir)
  assert.deepEqual(readAppSettings(dir).modelAvailability, {
    disabledProviders: [],
    disabledModels: []
  })
  assert.equal(readFileSync(legacy, 'utf8'), legacyText)
})
