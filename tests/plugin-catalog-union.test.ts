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
  assert.match(markup, /全部插件 · 2/)
  assert.match(markup, /已安装 · 2/)
  assert.match(markup, /其他 · 2/)
  assert.match(markup, /办公文档/)
  assert.match(markup, /科研绘图/)
  assert.equal(markup.match(/>科研绘图</g)?.length, 1)
  assert.match(markup, /办公文档[\s\S]*?<button[^>]*disabled=""[^>]*>已安装<\/button>/)
})

test('installed plugins remain in all plugins when no remote entries are available', () => {
  const markup = render({ entries: [] })
  assert.match(markup, /全部插件 · 2/)
  assert.match(markup, /其他 · 2/)
  assert.match(markup, /办公文档/)
  assert.match(markup, /科研绘图/)
  assert.doesNotMatch(markup, /这个分组目前没有插件/)
})

test('all and category counts include installed-only plugins without duplicating remote IDs', () => {
  const markup = render({
    entries: [...entries, available('reviewer', '审稿助手', '科研')]
  })
  assert.match(markup, /全部插件 · 3/)
  assert.match(markup, /已安装 · 2/)
  assert.match(markup, /其他 · 2/)
  assert.match(markup, /科研 · 1/)
  assert.equal(markup.match(/>科研绘图</g)?.length, 1)
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
})

test('installed-only rows keep their icon and source without fabricated installation metadata', () => {
  const office = { ...plugins[0], icon: { key: 'office-icon' } }
  const row = buildPhiPluginCatalog([office], entries).find((item) => item.id === 'phi-office')
  assert.ok(row)
  assert.equal(row.entry, undefined)
  assert.deepEqual(row.icon, office.icon)
  assert.equal(row.source, '软件源')
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
