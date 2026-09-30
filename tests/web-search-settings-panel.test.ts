import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import { WebSearchSettingsEditor } from '../src/renderer/src/features/settings/WebSearchSettingsPanel'
import { SearxngEnginePicker } from '../src/renderer/src/features/settings/components/SearxngEnginePicker'
import { filterSearxngEngines } from '../src/renderer/src/features/settings/lib/searxngEngines'
import type { WebSearchSettings } from '../src/shared/webSearchSettingsTypes'

const settings: WebSearchSettings = {
  providers: [
    {
      id: 'searxng',
      label: 'SearXNG',
      description: 'Self-hosted search',
      access: 'self-hosted',
      auth: 'endpoint'
    },
    {
      id: 'exa',
      label: 'Exa',
      description: 'Search API',
      access: 'free',
      auth: 'optional',
      apiKeyEnv: 'EXA_API_KEY'
    },
    { id: 'google', label: 'Google', description: 'Public search', access: 'free', auth: 'none' }
  ],
  orderedEnabledIds: ['searxng', 'exa'],
  searxngEndpoint: 'http://127.0.0.1:8888',
  searxngEngines: 'sogou wechat'
}

function renderEditor(snapshot = settings): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(WebSearchSettingsEditor, {
        settings: snapshot,
        onSave: async () => undefined,
        onSetApiKey: async () => ({ apiKeyConfigured: true, apiKeyStored: true }),
        onClearApiKey: async () => ({ apiKeyConfigured: false, apiKeyStored: false }),
        onOpenProviderSettings: () => undefined,
        searxngCatalog: [
          { name: 'sogou', shortcut: 'sogou', categories: ['general'], enabled: false },
          { name: 'sogou wechat', shortcut: 'sogouw', categories: ['news'], enabled: true },
          { name: 'bitbucket', categories: ['it'], enabled: false }
        ]
      })
    )
  )
}

test('web search settings separate SearXNG engines from upstream providers', () => {
  const markup = renderEditor()

  assert.match(markup, /已启用 2 \/ 3/)
  assert.match(markup, /aria-label="启用 SearXNG 搜索"/)
  assert.match(markup, /aria-label="上移 Exa"/)
  assert.match(markup, /aria-label="下移 SearXNG"/)
  assert.match(markup, />置顶<\/button>/)
  assert.match(markup, /上游搜索服务提供方（高级）/)
  assert.match(markup, /免凭据可用/)
  assert.match(markup, /自建实例/)
  assert.match(markup, /免凭据后备可用/)
  assert.match(markup, /aria-label="选择 sogou wechat 引擎"/)
  assert.match(markup, /aria-label="选择 sogou 引擎"/)
  assert.match(markup, /默认关闭/)
  assert.match(markup, />仅此<\/button>/)
  const defaultOffInput = markup.match(/<input[^>]*aria-label="选择 sogou 引擎"[^>]*>/)?.[0]
  assert.ok(defaultOffInput)
  assert.doesNotMatch(defaultOffInput, /\bdisabled\b/)
  assert.match(markup, /http:\/\/127\.0\.0\.1:8888/)
  assert.match(markup, /sogou wechat/)
  assert.match(markup, /保存搜索设置/)
})

test('SearXNG settings explain when its upstream provider is disabled', () => {
  const markup = renderEditor({ ...settings, orderedEnabledIds: ['exa', 'google'] })

  assert.match(markup, /aria-label="启用 SearXNG 搜索"/)
  assert.match(markup, /SearXNG 服务提供方已关闭/)
  assert.match(markup, /限定引擎名称（可选）/)
})

test('provider groups explain cost and authentication before enabling a service', () => {
  const markup = renderEditor({
    ...settings,
    providers: [
      ...settings.providers,
      {
        id: 'brave',
        label: 'Brave',
        description: 'API search',
        access: 'metered',
        auth: 'api-key',
        apiKeyEnv: 'BRAVE_API_KEY',
        apiKeyConfigured: true,
        apiKeyStored: true
      },
      {
        id: 'codex',
        label: 'OpenAI',
        description: 'Account search',
        access: 'metered',
        auth: 'oauth'
      }
    ]
  })

  assert.match(markup, /账号或 API 服务/)
  assert.match(markup, /可能有免费额度或需要付费/)
  assert.match(markup, /需要 API Key/)
  assert.match(markup, /BRAVE_API_KEY/)
  assert.match(markup, /已配置 Key/)
  assert.match(markup, /清除 Key/)
  assert.match(markup, /需要账号授权/)
  assert.match(markup, /到 Provider 设置授权/)
})

test('SearXNG engine picker lists only names returned by its instance', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(SearxngEnginePicker, {
        endpoint: 'http://127.0.0.1:8888',
        savedEndpoint: 'http://127.0.0.1:8888',
        engines: '',
        onChange: () => undefined,
        catalog: [{ name: 'sogou wechat', categories: ['news'], enabled: true }]
      })
    )
  )

  assert.match(markup, /sogou wechat/)
  assert.doesNotMatch(markup, /xAI/)
})

test('SearXNG engine filter finds ordinary Sogou and its WeChat variant', () => {
  const catalog = [
    { name: 'google', categories: ['general'], enabled: true },
    { name: 'sogou', shortcut: 'sogou', categories: ['general'], enabled: false },
    { name: 'sogou images', shortcut: 'sogoui', categories: ['images'], enabled: false },
    { name: 'sogou videos', shortcut: 'sogouv', categories: ['videos'], enabled: false },
    { name: 'sogou wechat', shortcut: 'sogouw', categories: ['news'], enabled: false }
  ]

  assert.deepEqual(
    filterSearxngEngines(catalog, 'sogou').map((engine) => engine.name),
    ['sogou', 'sogou images', 'sogou videos', 'sogou wechat']
  )
})
