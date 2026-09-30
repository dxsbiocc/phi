import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import { WebSearchSettingsEditor } from '../src/renderer/src/features/settings/WebSearchSettingsPanel'
import { SearxngEnginePicker } from '../src/renderer/src/features/settings/components/SearxngEnginePicker'
import { webSearchSettingsFromValues } from '../src/main/agent/web-search-settings'
import { listSearchProviderPage } from '../src/renderer/src/features/settings/lib/searchProviderList'
import {
  filterSearxngEngines,
  listSearxngEnginePage,
  mergeSearxngEngines,
  SEARXNG_DEFAULT_ENGINES,
  toggleSearxngEngine
} from '../src/renderer/src/features/settings/lib/searxngEngines'
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

const instanceCatalog = [
  { name: 'sogou', shortcut: 'sogou', categories: ['general'], enabled: false },
  { name: 'sogou wechat', shortcut: 'sogouw', categories: ['news'], enabled: true },
  { name: 'bitbucket', categories: ['it'], enabled: false }
]

function renderEditor(
  snapshot = settings,
  catalog: typeof instanceCatalog | null = instanceCatalog
): string {
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
        searxngCatalog: catalog ?? undefined
      })
    )
  )
}

test('web search settings separate SearXNG engines from upstream providers', () => {
  const markup = renderEditor()

  assert.match(markup, /2\/3 已启用/)
  assert.match(markup, /aria-label="启用 SearXNG 搜索"/)
  assert.match(markup, /aria-label="更多 Exa 操作"/)
  assert.match(markup, /aria-label="更多 SearXNG 操作"/)
  assert.match(markup, /优先级/)
  assert.match(markup, /搜索服务/)
  assert.match(markup, /免凭据/)
  assert.match(markup, /自建/)
  assert.match(markup, /可选 Key/)
  assert.match(markup, /aria-label="启用 sogou wechat 引擎"/)
  assert.match(markup, /aria-label="启用 sogou 引擎"/)
  assert.match(markup, /默认关闭/)
  assert.match(markup, />仅此<\/button>/)
  const defaultOffInput = markup.match(/<input[^>]*aria-label="启用 sogou 引擎"[^>]*>/)?.[0]
  assert.ok(defaultOffInput)
  assert.doesNotMatch(defaultOffInput, /\bdisabled\b/)
  assert.match(markup, /已连接/)
  assert.match(markup, /sogou wechat/)
  assert.match(markup, />保存<\/button>/)
})

test('SearXNG settings explain when its upstream provider is disabled', () => {
  const markup = renderEditor({ ...settings, orderedEnabledIds: ['exa', 'google'] })

  assert.match(markup, /aria-label="启用 SearXNG 搜索"/)
  assert.match(markup, /启用来源/)
  assert.match(markup, /限定引擎名称（可选）/)
})

test('the paged catalog shows its full count and default-off Sogou switches before adding an instance', () => {
  const markup = renderEditor(
    {
      ...settings,
      searxngEndpoint: '',
      searxngEngines: ''
    },
    null
  )

  assert.match(markup, />添加实例<\/button>/)
  assert.match(markup, /未连接/)
  assert.equal(SEARXNG_DEFAULT_ENGINES.length, 352)
  assert.match(markup, /全部 352/)
  for (const preset of SEARXNG_DEFAULT_ENGINES.filter((engine) =>
    engine.name.startsWith('sogou')
  )) {
    const input = markup.match(
      new RegExp(`<input[^>]*aria-label="启用 ${preset.name} 引擎"[^>]*>`)
    )?.[0]
    assert.ok(input, `${preset.name} must be visible`)
    assert.doesNotMatch(input, /\bdisabled\b/)
    assert.doesNotMatch(input, /\bchecked\b/)
  }
  assert.ok(SEARXNG_DEFAULT_ENGINES.some((engine) => engine.inactive))
  assert.doesNotMatch(markup, /placeholder="http:\/\/127\.0\.0\.1:8888"/)
})

test('search, status filters, and pagination cover the full SearXNG catalog', () => {
  const options = {
    query: 'sogou',
    selection: 'all' as const,
    status: 'default-off' as const,
    selectedNames: new Set<string>(),
    rowsPerPage: 2,
    nameOrder: 'original' as const
  }
  const first = listSearxngEnginePage(SEARXNG_DEFAULT_ENGINES, { ...options, page: 0 })
  const second = listSearxngEnginePage(SEARXNG_DEFAULT_ENGINES, { ...options, page: 1 })

  assert.equal(first.total, 4)
  assert.deepEqual(
    first.rows.map((engine) => engine.name),
    ['sogou', 'sogou images']
  )
  assert.deepEqual(
    second.rows.map((engine) => engine.name),
    ['sogou videos', 'sogou wechat']
  )
  assert.equal(second.page, 1)
  assert.equal(listSearxngEnginePage(SEARXNG_DEFAULT_ENGINES, { ...options, page: 99 }).page, 1)
  const selected = listSearxngEnginePage(SEARXNG_DEFAULT_ENGINES, {
    ...options,
    query: '',
    selection: 'selected',
    status: 'all',
    selectedNames: new Set(['sogou']),
    page: 0
  })
  assert.deepEqual(
    selected.rows.map((engine) => engine.name),
    ['sogou']
  )
  assert.ok(
    listSearxngEnginePage(SEARXNG_DEFAULT_ENGINES, {
      ...options,
      query: '',
      selection: 'unavailable',
      status: 'admin-required',
      page: 0
    }).total > 0
  )
})

test('all built-in web_search providers are reachable through table pages', () => {
  const all = webSearchSettingsFromValues({
    order: [],
    excluded: [],
    endpoint: undefined,
    engines: undefined
  })
  const markup = renderEditor(all, null)

  assert.equal(all.providers.length, 23)
  assert.match(markup, /全部 23/)
  const pages = [0, 1, 2].flatMap((page) =>
    listSearchProviderPage(all.providers, all.orderedEnabledIds, {
      cost: 'all',
      enabled: 'all',
      query: '',
      page,
      rowsPerPage: 10
    }).rows.map((provider) => provider.id)
  )
  assert.deepEqual(new Set(pages), new Set(all.providers.map((provider) => provider.id)))
  assert.deepEqual(
    listSearchProviderPage(all.providers, all.orderedEnabledIds, {
      cost: 'metered',
      enabled: 'all',
      query: 'brave',
      page: 0,
      rowsPerPage: 10
    }).rows.map((provider) => provider.id),
    ['brave']
  )
  assert.doesNotMatch(markup, /上游搜索服务提供方（高级）/)
})

test('a default-disabled Sogou engine can be explicitly selected', () => {
  assert.equal(toggleSearxngEngine([], [], 'sogou'), 'sogou')
  assert.equal(toggleSearxngEngine([], ['google'], 'sogou'), 'google,sogou')
  assert.equal(toggleSearxngEngine(['sogou'], [], 'sogou'), null)
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

  assert.match(markup, /账号 \/ API/)
  assert.match(markup, /可能收费/)
  assert.match(markup, /API Key/)
  assert.match(markup, /已配置 Key/)
  assert.match(markup, /更换 Key/)
  assert.match(markup, /账号授权/)
})

test('SearXNG engine picker marks upstream entries absent from an instance as unavailable', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(SearxngEnginePicker, {
        endpoint: 'http://127.0.0.1:8888',
        engines: '',
        onChange: () => undefined,
        catalog: [{ name: 'sogou wechat', categories: ['news'], enabled: true }]
      })
    )
  )

  assert.match(markup, /sogou wechat/)
  assert.match(markup, /实例未提供/)
  assert.doesNotMatch(markup, /xAI/)
})

test('an instance can make an upstream inactive engine available', () => {
  const inactive = SEARXNG_DEFAULT_ENGINES.find((engine) => engine.inactive)
  assert.ok(inactive)
  const merged = mergeSearxngEngines([{ name: inactive.name, categories: [], enabled: false }])
  const available = merged.find((engine) => engine.name === inactive.name)
  assert.equal(available?.available, true)
  assert.equal(available?.inactive, false)
  assert.equal(merged.find((engine) => engine.name === 'sogou')?.available, false)
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
