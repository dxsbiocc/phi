import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import {
  PhiPluginCatalogContent,
  type PhiPluginCatalogContentProps
} from '../src/renderer/src/features/phi-plugin/components/PhiPluginCatalogDialog'
import type { PhiPluginDisplayItem } from '../src/renderer/src/features/phi-plugin/hooks/usePhiPlugins'
import {
  buildPhiPluginCatalog,
  filterPhiPluginCatalog,
  phiPluginCatalogAction,
  type PhiPluginCatalogEntry
} from '../src/renderer/src/features/phi-plugin/lib/phiPluginCatalog'
import { phiPluginDisplayTitle } from '../src/renderer/src/features/phi-plugin/lib/phiPlugins'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'

function installed(id: string, title: string): PhiPluginDisplayItem {
  return {
    id,
    title,
    summary: `${title} summary`,
    version: '1.0.0',
    enabled: true,
    source: 'local',
    distribution: 'registry',
    trust: 'official',
    installedAt: '2026-10-08T00:00:00.000Z',
    directory: `/packages/plugin/${id}/1.0.0`,
    agents: [],
    skills: [],
    scriptTools: [],
    environments: [],
    environmentStatuses: []
  }
}

function available(
  id: string,
  title: string,
  category = '其他',
  version = '1.0.0'
): PhiPluginCatalogEntry {
  return {
    id,
    title,
    summary: `${title} summary`,
    type: 'plugin',
    version,
    category,
    archive: `${id}-${version}.tar.gz`,
    sha256: 'a'.repeat(64),
    size: 1024,
    dependsOn: [],
    registryPath: '/catalog/official',
    registryLabel: '软件源',
    trust: 'official'
  }
}

const plugins = [installed('phi-office', '办公文档'), installed('visualization', '科研绘图')]
const entries = [available('visualization', '科研绘图')]

function render(overrides: Partial<PhiPluginCatalogContentProps> = {}): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(PhiPluginCatalogContent, {
        plugins,
        entries,
        updates: [],
        loading: false,
        busyId: null,
        onChooseDirectory: () => undefined,
        onInstall: () => assert.fail('installed-only rows must not request an installation'),
        ...overrides
      })
    )
  ).replace(/<style[^>]*>[\s\S]*?<\/style>/g, '')
}

test('all plugins includes installed Office when only visualization is available remotely', () => {
  const markup = render()
  assert.match(markup, /All Plugins · 2/)
  assert.match(markup, /Installed · 2/)
  assert.match(markup, /Other · 2/)
  assert.match(markup, /办公文档/)
  assert.match(markup, /科研绘图/)
  assert.equal(markup.match(/>Visualization</g)?.length, 1)
  assert.match(markup, /办公文档[\s\S]*?<button[^>]*disabled=""[^>]*>Installed<\/button>/)
})

test('installed plugins remain in all plugins when no remote entries are available', () => {
  const markup = render({ entries: [] })
  assert.match(markup, /All Plugins · 2/)
  assert.match(markup, /Other · 2/)
  assert.match(markup, /办公文档/)
  assert.match(markup, /科研绘图/)
  assert.doesNotMatch(markup, /No plugins in this group/)
})

test('all and category counts include installed-only plugins without duplicating remote IDs', () => {
  const markup = render({
    entries: [...entries, available('reviewer', '审稿助手', '科研')]
  })
  assert.match(markup, /All Plugins · 3/)
  assert.match(markup, /Installed · 2/)
  assert.match(markup, /Other · 2/)
  assert.match(markup, /Research · 1/)
  assert.equal(markup.match(/>Visualization</g)?.length, 1)
  const category = render({ initialCategory: '其他' })
  assert.match(category, /办公文档/)
  assert.match(category, /科研绘图/)
})

test('search and category filtering use the same union as catalog counts', () => {
  const catalog = buildPhiPluginCatalog(plugins, [
    available('visualization', '科研绘图', '科研'),
    available('reviewer', '审稿助手', '科研')
  ])
  assert.deepEqual(
    filterPhiPluginCatalog(catalog, 'all', '  PHI-OFFICE ').map((item) => item.id),
    ['phi-office']
  )
  assert.deepEqual(
    filterPhiPluginCatalog(catalog, '其他', '办公').map((item) => item.id),
    ['phi-office']
  )
  assert.deepEqual(filterPhiPluginCatalog(catalog, '科研', '办公'), [])
  assert.equal(filterPhiPluginCatalog(catalog, '科研', '').length, 2)
  assert.deepEqual(
    filterPhiPluginCatalog(catalog, 'all', 'research').map((item) => item.id),
    ['visualization', 'reviewer']
  )
  assert.equal(filterPhiPluginCatalog(catalog, '科研', '科研').length, 2)
  assert.equal(catalog[0].title, 'Visualization')
  assert.equal(catalog[0].category, '科研')
})

test('the legacy Visualization title stays English in both UI languages without changing package metadata', () => {
  const legacy = installed('visualization', '科研绘图')
  const author = installed('custom-visualization', '我的绘图工具')
  try {
    for (const language of ['en', 'zh-CN'] as const) {
      setUiLanguage(language)
      assert.equal(phiPluginDisplayTitle(legacy), 'Visualization')
      const catalog = buildPhiPluginCatalog([legacy, author], [])
      assert.equal(catalog[0].title, 'Visualization')
      assert.equal(catalog[1].title, '我的绘图工具')
      assert.equal(legacy.title, '科研绘图')
      assert.equal(legacy.id, 'visualization')
      assert.equal(legacy.version, '1.0.0')
    }
  } finally {
    setUiLanguage('en')
  }
})

test('installed-only rows keep their icon and source without fabricated installation metadata', () => {
  const office = { ...plugins[0], icon: { key: 'office-icon' } }
  const row = buildPhiPluginCatalog([office], entries).find((item) => item.id === 'phi-office')
  assert.ok(row)
  assert.equal(row.entry, undefined)
  assert.deepEqual(row.icon, office.icon)
  assert.equal(row.source, 'Registry')
  assert.equal(row.version, office.version)
})

test('duplicate remote versions select the newest entry and retain its update action', () => {
  const latest = available('visualization', '科研绘图新版', '科研', '1.2.0')
  const older = available('visualization', '科研绘图旧版', '旧分类', '1.1.0')
  const catalog = buildPhiPluginCatalog(plugins, [latest, older, entries[0]])
  assert.equal(catalog.length, 2)
  assert.equal(catalog[0].entry, latest)
  assert.equal(catalog[0].category, '科研')
  assert.equal(
    phiPluginCatalogAction(latest, new Set(plugins.map((item) => item.id)), [
      {
        id: latest.id,
        type: 'plugin',
        title: latest.title,
        currentVersion: '1.0.0',
        newVersion: latest.version,
        registryId: 'official',
        registryPath: latest.registryPath,
        trust: latest.trust
      }
    ]),
    'update'
  )
})
