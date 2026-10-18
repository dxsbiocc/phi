import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as uiLanguage from '../src/shared/uiLanguage'

test('the primary system language selects Chinese variants or falls back to English', () => {
  for (const language of ['zh', 'zh-CN', 'zh-Hans-CN', 'zh-Hant-TW', 'zh-HK', 'ZH_cn', ' zh-SG ']) {
    assert.equal(uiLanguage.systemUiLanguage([language, 'en-US']), 'zh-CN')
  }
  for (const languages of [[], ['en-US'], ['ja-JP'], ['fr-CN'], ['de-DE', 'zh-CN'], ['zhongwen']]) {
    assert.equal(uiLanguage.systemUiLanguage(languages), 'en')
  }
  assert.equal(uiLanguage.systemUiLanguage(['', 'zh-CN']), 'zh-CN')
})

function loadRendererLanguage(options: {
  languages?: string[]
  language?: string
  cached?: string | null
  unavailableStorage?: boolean
}): { getUiLanguage: () => string; documentLanguage: () => string } {
  const source = ts.transpileModule(readFileSync('src/renderer/src/lib/i18n.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const document = { documentElement: { lang: '' } }
  const module = { exports: {} as { getUiLanguage: () => string } }
  runInNewContext(source, {
    module,
    exports: module.exports,
    require(name: string): unknown {
      if (name === 'react') return {}
      if (name === '../../../shared/uiLanguage') return uiLanguage
      throw new Error(`Unexpected module ${name}`)
    },
    navigator: { languages: options.languages, language: options.language },
    document,
    window: {
      localStorage: {
        getItem: (): string | null => {
          if (options.unavailableStorage) throw new Error('Storage is unavailable')
          return options.cached ?? null
        }
      },
      addEventListener: (): void => undefined
    }
  })
  return {
    getUiLanguage: module.exports.getUiLanguage,
    documentLanguage: () => document.documentElement.lang
  }
}

test('renderer first paint detects system language even when storage is unavailable', () => {
  for (const unavailableStorage of [false, true]) {
    const renderer = loadRendererLanguage({ languages: ['zh-Hans-CN'], unavailableStorage })
    assert.equal(renderer.getUiLanguage(), 'zh-CN')
    assert.equal(renderer.documentLanguage(), 'zh-CN')
  }
  assert.equal(loadRendererLanguage({ language: 'zh-TW' }).getUiLanguage(), 'zh-CN')
  assert.equal(loadRendererLanguage({ languages: ['fr-FR', 'zh-CN'] }).getUiLanguage(), 'en')
  assert.equal(loadRendererLanguage({}).getUiLanguage(), 'en')
})

test('renderer cached manual choice wins over detection, and invalid cached values use the system', () => {
  assert.equal(loadRendererLanguage({ languages: ['zh-CN'], cached: 'en' }).getUiLanguage(), 'en')
  assert.equal(
    loadRendererLanguage({ languages: ['en-US'], cached: 'zh-CN' }).getUiLanguage(),
    'zh-CN'
  )
  assert.equal(
    loadRendererLanguage({ languages: ['zh-CN'], cached: 'unsupported' }).getUiLanguage(),
    'zh-CN'
  )
})
