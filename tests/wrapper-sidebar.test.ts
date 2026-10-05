import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import type {
  WrapperCompositionCatalogItem,
  WrapperCompositionManifest
} from '../src/shared/wrapperCompositionManifestTypes'
import { WrapperSidebar } from '../src/renderer/src/features/wrapper/WrapperView'
import {
  filterWrappers,
  selectedWrappers,
  visibleWrapperTier
} from '../src/renderer/src/features/wrapper/lib/wrapperSidebar'

const catalog: WrapperCompositionManifest[] = [
  {
    id: 'nf-core/workflows/rnaseq',
    name: 'Transcriptome Analysis',
    summary: 'Quantify RNA-seq reads',
    params: {},
    outputs: {}
  },
  {
    id: 'local/modules/fastqc',
    name: 'Read Quality',
    summary: 'Inspect FASTQ quality',
    params: {},
    outputs: {}
  }
]

test('wrapper search matches display names, canonical ids, descriptions and provider', () => {
  assert.deepEqual(filterWrappers(catalog, '  TRANSCRIPTOME  '), [catalog[0]])
  assert.deepEqual(filterWrappers(catalog, 'rnaseq'), [catalog[0]])
  assert.deepEqual(filterWrappers(catalog, 'quantify'), [catalog[0]])
  assert.deepEqual(filterWrappers(catalog, 'local'), [catalog[1]])
  assert.deepEqual(filterWrappers(catalog, 'no-result'), [])
  assert.deepEqual(filterWrappers(catalog, '   '), catalog)
  assert.equal(catalog.length, 2)
})

test('wrapper search matches both canonical and localized tier names', () => {
  assert.deepEqual(filterWrappers(catalog, 'workflows'), [catalog[0]])
  assert.deepEqual(filterWrappers(catalog, '工作流'), [catalog[0]])
  assert.deepEqual(filterWrappers(catalog, '模块'), [catalog[1]])
})

test('search reveals a matching group while preserving manual collapse outside search', () => {
  const groups = [{ tier: 'workflows' }, { tier: 'modules' }]
  assert.equal(visibleWrapperTier(groups, 'modules', 'quality'), 'modules')
  assert.equal(visibleWrapperTier([groups[1]], 'workflows', 'quality'), 'modules')
  assert.equal(visibleWrapperTier(groups, null, 'quality'), 'workflows')
  assert.equal(visibleWrapperTier(groups, null, ''), null)
  assert.equal(visibleWrapperTier(groups, 'modules', ''), 'modules')
  assert.equal(visibleWrapperTier([], 'modules', 'no-result'), null)
})

test('wrapper sidebar exposes search and keeps a selected item beyond its initial page visible', () => {
  const modules = Array.from({ length: 30 }, (_, index) => ({
    ...catalog[1],
    id: `local/modules/m${index}`,
    name: `Module ${index}`
  }))
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(WrapperSidebar, {
        catalog: modules,
        selectedId: modules[25].id,
        isLoading: false,
        onSelect: () => undefined,
        onRefresh: () => undefined
      })
    )
  )
  assert.match(markup, /aria-label="搜索 wrapper"/)
  assert.match(markup, /aria-label="从目录添加"/)
  assert.match(markup, /title="m25"/)
  assert.doesNotMatch(markup, /title="m26"/)
  assert.match(markup, /还有 4 个/)
  assert.match(markup, /暂无工作流 wrapper/)
  assert.match(markup, /暂无子流程 wrapper/)
})

test('wrapper sidebar excludes untouched bundled packages and keeps explicitly disabled choices', () => {
  const entries: WrapperCompositionCatalogItem[] = [
    { ...catalog[0], packageId: 'workflow-rnaseq', packageSelected: false, packageEnabled: false },
    {
      ...catalog[1],
      packageId: 'module-fastqc',
      enablementId: 'module-fastqc',
      packageSelected: true,
      packageEnabled: false
    },
    { ...catalog[1], id: 'custom/modules/my-qc', enablementId: 'custom-qc', packageEnabled: true }
  ]
  assert.deepEqual(selectedWrappers(entries), entries.slice(1))
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(WrapperSidebar, {
        catalog: entries,
        selectedId: entries[1].id,
        isLoading: false,
        onSelect: () => undefined,
        onRefresh: () => undefined,
        onSetPackageEnabled: async () => true
      })
    )
  )
  assert.doesNotMatch(markup, /data-phi-catalog-row="nf-core\/workflows\/rnaseq"/)
  assert.match(markup, /data-phi-catalog-row="local\/modules\/fastqc"/)
  assert.match(markup, /data-phi-catalog-status="disabled"/)
  assert.match(markup, /data-phi-catalog-status="enabled"/)
  assert.match(markup, /aria-label="启用 fastqc"/)
  assert.match(markup, /aria-label="关闭 my-qc"/)
  assert.match(markup, /2 个 wrapper · 1 已启用/)
})
