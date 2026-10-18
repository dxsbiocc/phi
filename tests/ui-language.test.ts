import assert from 'node:assert/strict'
import test from 'node:test'
import {
  defineCopy,
  getUiLanguage,
  getUiLocale,
  normalizeUiLanguage,
  setUiLanguage,
  subscribeUiLanguage
} from '../src/renderer/src/lib/i18n'
import {
  resourceCategoryLabel,
  resourceSourceLabel,
  resourceUi
} from '../src/renderer/src/lib/resourceUi'
import { modelOptionFromSelection } from '../src/renderer/src/useModelSelection'
import { themePaletteDefinition } from '../src/renderer/src/themePalettes'

test.afterEach(() => setUiLanguage('en'))

test('only supported language identifiers are accepted and English is the final fallback', () => {
  setUiLanguage('en')
  assert.equal(getUiLanguage(), 'en')
  for (const value of [undefined, null, '', 'zh', 'en-US', '__proto__']) {
    assert.equal(normalizeUiLanguage(value), 'en')
  }
  assert.equal(normalizeUiLanguage('zh-CN'), 'zh-CN')
  assert.equal(getUiLocale(), 'en-US')
})

test('language changes update nested copy and previously captured formatters without rebuilding them', () => {
  const copy = defineCopy(
    { title: 'Files', actions: { open: 'Open' }, count: (count: number) => `${count} files` },
    { title: '文件', actions: { open: '打开' }, count: (count) => `${count} 个文件` }
  )
  const format = copy.count
  const nested = copy.actions
  let changes = 0
  const unsubscribe = subscribeUiLanguage(() => changes++)
  setUiLanguage('zh-CN')
  assert.equal(copy.title, '文件')
  assert.equal(nested.open, '打开')
  assert.equal(format(3), '3 个文件')
  assert.equal(getUiLocale(), 'zh-CN')
  setUiLanguage('zh-CN')
  assert.equal(changes, 1)
  setUiLanguage('en')
  assert.equal(format(3), '3 files')
  assert.equal(nested.open, 'Open')
  assert.equal(changes, 2)
  unsubscribe()
})

test('resource presentation follows the language while source values and custom labels stay intact', () => {
  const raw = { category: '生产力', source: 'Phi 官网', name: '我的研究工具' }
  setUiLanguage('zh-CN')
  assert.equal(resourceUi.connectors, '连接器')
  assert.equal(resourceCategoryLabel(raw.category), '生产力')
  assert.equal(resourceSourceLabel(raw.source), 'Phi 官网')
  setUiLanguage('en')
  assert.equal(resourceUi.connectors, 'Connectors')
  assert.equal(resourceCategoryLabel(raw.category), 'Productivity')
  assert.equal(resourceSourceLabel(raw.source), 'Phi Website')
  for (const language of ['en', 'zh-CN'] as const) {
    setUiLanguage(language)
    assert.equal(resourceCategoryLabel(raw.name), raw.name)
    assert.equal(resourceCategoryLabel('__proto__'), '__proto__')
  }
  assert.deepEqual(raw, { category: '生产力', source: 'Phi 官网', name: '我的研究工具' })
})

test('saved unavailable model and palette labels switch without changing their identifiers or colors', () => {
  const missing = modelOptionFromSelection({ providerId: 'fixture', modelId: 'saved-model' }, [])
  const minimal = themePaletteDefinition('minimal')
  const watercolor = themePaletteDefinition('chinese-watercolor')
  const originalColors = [...watercolor.colors]
  assert.ok(missing)
  for (const language of ['en', 'zh-CN', 'en'] as const) {
    setUiLanguage(language)
    assert.equal(
      missing.name,
      language === 'en' ? 'fixture/saved-model (unavailable)' : 'fixture/saved-model（不可用）'
    )
    assert.equal(minimal.label, language === 'en' ? 'Minimal (default)' : 'Minimal（默认）')
    assert.equal(watercolor.label, language === 'en' ? 'Chinese Watercolor' : '中国水墨画')
    assert.equal(missing.providerId, 'fixture')
    assert.equal(missing.modelId, 'saved-model')
    assert.equal(watercolor.id, 'chinese-watercolor')
    assert.deepEqual(watercolor.colors, originalColors)
  }
})
