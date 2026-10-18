import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { PhiAppSettings, PhiAppSettingsPatch } from '../src/shared/appSettingsTypes'
import { appCopy } from '../src/renderer/src/lib/appCopy'
import { getUiLanguage, normalizeUiLanguage, setUiLanguage } from '../src/renderer/src/lib/i18n'

const source = ts.createSourceFile(
  'App.tsx',
  readFileSync('src/renderer/src/App.tsx', 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
)
let updateSource = ''
let loadSource = ''
function findCallbacks(node: ts.Node): void {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(source) === 'onUpdateAppSettings' &&
    node.initializer &&
    ts.isCallExpression(node.initializer)
  ) {
    updateSource = node.initializer.arguments[0].getText(source)
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(source) === 'useEffect' &&
    node.arguments[0]?.getText(source).includes('.getAppSettings()')
  ) {
    loadSource = node.arguments[0].getText(source)
  }
  ts.forEachChild(node, findCallbacks)
}
findCallbacks(source)

function snapshot(uiLanguage: PhiAppSettings['uiLanguage']): PhiAppSettings {
  return {
    uiLanguage,
    noProjectTaskFolder: '/workspace',
    allowExternalFileRead: false,
    preventSleepDuringRuns: false,
    nextActionSuggestionsEnabled: true,
    fileOpenConversationLayout: 'sidebar'
  }
}

function harness(): {
  save: (patch: PhiAppSettingsPatch) => Promise<void>
  load: () => () => void
  writes: Array<{
    patch: PhiAppSettingsPatch
    resolve: (value: PhiAppSettings) => void
    reject: (error: Error) => void
  }>
  resolveRead: (value: PhiAppSettings) => void
  errors: string[]
  saving: boolean[]
} {
  const writes: Array<{
    patch: PhiAppSettingsPatch
    resolve: (value: PhiAppSettings) => void
    reject: (error: Error) => void
  }> = []
  const errors: string[] = []
  const saving: boolean[] = []
  let resolveRead!: (value: PhiAppSettings) => void
  const read = new Promise<PhiAppSettings>((resolve) => {
    resolveRead = resolve
  })
  const context = {
    ...snapshot('en'),
    appSettingsRevisionRef: { current: 0 },
    getUiLanguage,
    setUiLanguage,
    normalizeUiLanguage,
    appCopy,
    rendererApi: {
      updateAppSettings: (patch: PhiAppSettingsPatch) =>
        new Promise<PhiAppSettings>((resolve, reject) => writes.push({ patch, resolve, reject })),
      getAppSettings: () => read
    },
    applyAppSettings: (value: PhiAppSettings) => setUiLanguage(value.uiLanguage),
    setNoProjectTaskFolder: () => undefined,
    setAllowExternalFileRead: () => undefined,
    setPreventSleepDuringRuns: () => undefined,
    setNextActionSuggestionsEnabled: () => undefined,
    setFileOpenConversationLayout: () => undefined,
    setIsSavingAppSettings: (value: boolean) => saving.push(value),
    showSnackbarError: (_error: unknown, message: string) => errors.push(message)
  }
  function evaluate(text: string): unknown {
    assert.ok(text, 'the existing settings callback is available')
    return runInNewContext(
      ts.transpileModule(`(${text})`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
      }).outputText,
      context
    )
  }
  return {
    save: evaluate(updateSource) as (patch: PhiAppSettingsPatch) => Promise<void>,
    load: evaluate(loadSource) as () => () => void,
    writes,
    resolveRead,
    errors,
    saving
  }
}

test.afterEach(() => setUiLanguage('en'))

test('language selection applies immediately and sends only the preference to persistence', async () => {
  const f = harness()
  const saved = f.save({ uiLanguage: 'zh-CN' })
  assert.equal(getUiLanguage(), 'zh-CN')
  assert.deepEqual(f.writes[0].patch, { uiLanguage: 'zh-CN' })
  f.writes[0].resolve(snapshot('zh-CN'))
  await saved
  assert.equal(getUiLanguage(), 'zh-CN')
  assert.equal(f.saving.at(-1), false)
})

test('a failed preference write restores the previous interface language', async () => {
  const f = harness()
  const saved = f.save({ uiLanguage: 'zh-CN' })
  f.writes[0].reject(new Error('settings write unavailable'))
  await saved
  assert.equal(getUiLanguage(), 'en')
  assert.deepEqual(f.errors, ['Could not save general settings'])
})

test('a stale failed save cannot undo a newer successful language selection', async () => {
  const f = harness()
  const first = f.save({ uiLanguage: 'zh-CN' })
  const second = f.save({ uiLanguage: 'en' })
  f.writes[1].resolve(snapshot('en'))
  await second
  f.writes[0].reject(new Error('late failure'))
  await first
  assert.equal(getUiLanguage(), 'en')
  assert.deepEqual(f.errors, [])
  assert.equal(f.saving.at(-1), false)
})

test('a late startup settings read cannot overwrite the user selection', async () => {
  const f = harness()
  const dispose = f.load()
  const saved = f.save({ uiLanguage: 'zh-CN' })
  f.writes[0].resolve(snapshot('zh-CN'))
  await saved
  f.resolveRead(snapshot('en'))
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(getUiLanguage(), 'zh-CN')
  dispose()
})
