import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import {
  readVisualizationTemplateCatalog,
  visualizationTemplateCatalog
} from '../src/main/agent/plugins/visualization-catalog'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import PhiPluginsView from '../src/renderer/src/features/phi-plugin/PhiPluginsView'
import type { PhiPluginDisplayItem } from '../src/renderer/src/features/phi-plugin/hooks/usePhiPlugins'
import { VisualizationPanel } from '../src/renderer/src/features/visualization/VisualizationPanel'
import { VisualizationPreviewStage } from '../src/renderer/src/features/visualization/components/VisualizationTemplateGrid'
import {
  filteredVisualizationGroups,
  selectedVisualizationGroupId,
  visibleVisualizationTemplates
} from '../src/renderer/src/features/visualization/lib/visualizationTemplates'
import type { VisualizationTemplateCatalog } from '../src/shared/visualizationTemplateTypes'

function themed(element: React.ReactElement): string {
  return renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme() }, element))
}

function writePreview(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'png')
}

function writeSkill(root: string): string {
  const skill = join(root, 'omics-visualization')
  mkdirSync(join(skill, 'references', 'catalog'), { recursive: true })
  writePreview(join(skill, 'scripts', 'scatter', 'basic', 'preview.png'))
  writePreview(join(skill, 'scripts', 'heatmap', 'clustered', 'preview.png'))
  writePreview(join(skill, 'scripts', 'layouts', 'equal_2x2', 'preview.png'))
  writePreview(join(root, 'outside', 'preview.png'))
  writeFileSync(
    join(skill, 'references', 'plots.yaml'),
    `groups:
  scatter:
    title: "Scatter and point-based plots"
    catalog: "references/catalog/scatter.yaml"
  heatmap:
    title: "Heatmaps and matrix displays"
    catalog: "references/catalog/heatmap.yaml"
  leaked:
    title: "Leaked"
    catalog: "../outside/catalog.yaml"
  missing:
    title: "Missing family"
    catalog: "references/catalog/missing.yaml"
`
  )
  writeFileSync(
    join(skill, 'references', 'catalog', 'scatter.yaml'),
    `templates:
  - id: scatter-basic
    title: "Basic scatter plot"
    aliases: ["散点图", "散点图", "xy scatter"]
    preview: "scripts/scatter/basic/preview.png"
  - id: scatter-wrong-family
    title: "Wrong family"
    preview: "scripts/heatmap/clustered/preview.png"
  - id: scatter-escape
    title: "Escape"
    preview: "scripts/scatter/../../outside/preview.png"
  - id: "bad id"
    title: "Bad id"
    preview: "scripts/scatter/basic/preview.png"
`
  )
  writeFileSync(
    join(skill, 'references', 'catalog', 'heatmap.yaml'),
    `templates:
  - id: heatmap-clustered
    title: "Clustered heatmap"
    aliases: ["热图"]
    preview: "scripts/heatmap/clustered/preview.png"
`
  )
  writeFileSync(
    join(root, 'outside', 'catalog.yaml'),
    `templates:
  - id: outside
    title: "Outside"
    preview: "preview.png"
`
  )
  return skill
}

const sampleCatalog: VisualizationTemplateCatalog = {
  groups: [
    {
      id: 'scatter',
      title: 'Scatter and point-based plots',
      templates: [
        {
          id: 'scatter-basic',
          title: 'Basic scatter plot',
          aliases: ['散点图'],
          previewPath: '/plugins/visualization/scripts/scatter/basic/preview.png'
        }
      ]
    },
    {
      id: 'heatmap',
      title: 'Heatmaps and matrix displays',
      templates: [
        {
          id: 'heatmap-clustered',
          title: 'Clustered heatmap',
          aliases: ['热图'],
          previewPath: '/plugins/visualization/scripts/heatmap/clustered/preview.png'
        }
      ]
    }
  ]
}

function plugin(id: string): PhiPluginDisplayItem {
  return {
    id,
    version: '1.0.3',
    title: id,
    summary: 'Summary',
    enabled: true,
    source: 'local',
    distribution: 'local',
    trust: 'imported',
    installedAt: '2026-10-01T00:00:00.000Z',
    directory: `/plugins/${id}`,
    agents: [],
    skills: [],
    scriptTools: [],
    environments: [],
    environmentStatuses: []
  }
}

test('visualization catalog keeps plot families and drops previews outside the family', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phi-viz-catalog-')))
  try {
    const skill = writeSkill(root)
    const catalog = readVisualizationTemplateCatalog(skill)
    assert.deepEqual(
      catalog.groups.map((group) => group.id),
      ['scatter', 'heatmap']
    )
    assert.deepEqual(catalog.groups[0]?.templates, [
      {
        id: 'scatter-basic',
        title: 'Basic scatter plot',
        aliases: ['散点图', 'xy scatter'],
        previewPath: realpathSync(join(skill, 'scripts', 'scatter', 'basic', 'preview.png'))
      }
    ])
    assert.equal(catalog.groups[1]?.templates[0]?.id, 'heatmap-clustered')
    assert.equal(
      catalog.groups.some((group) =>
        group.templates.some((template) => template.previewPath.includes('layouts'))
      ),
      false
    )
    assert.deepEqual(visualizationTemplateCatalog({ agentDir: root }), { groups: [] })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('template search matches titles and aliases and keeps the selected group when it still matches', () => {
  assert.deepEqual(
    visibleVisualizationTemplates(sampleCatalog.groups, '散点', null).map(
      (template) => template.id
    ),
    ['scatter-basic']
  )
  assert.deepEqual(
    filteredVisualizationGroups(sampleCatalog.groups, '热图').map((group) => group.id),
    ['heatmap']
  )
  assert.equal(
    selectedVisualizationGroupId(
      filteredVisualizationGroups(sampleCatalog.groups, '热图'),
      'scatter'
    ),
    null
  )
  assert.equal(
    selectedVisualizationGroupId(filteredVisualizationGroups(sampleCatalog.groups, ''), 'heatmap'),
    'heatmap'
  )
  assert.deepEqual(
    visibleVisualizationTemplates(sampleCatalog.groups, '', 'heatmap').map(
      (template) => template.id
    ),
    ['heatmap-clustered']
  )
})

test('template gallery shows the image grid and the group panel', () => {
  const markup = themed(createElement(VisualizationPanel, { catalog: sampleCatalog }))
  assert.match(markup, /data-phi-visualization-gallery="true"/)
  assert.match(markup, /data-phi-visualization-groups="true"/)
  assert.match(markup, /data-phi-visualization-group="all"/)
  assert.match(markup, /data-phi-visualization-group="scatter"/)
  assert.match(markup, /data-phi-visualization-group="heatmap"/)
  assert.match(markup, /data-phi-template-id="scatter-basic"/)
  assert.match(markup, /data-phi-template-id="heatmap-clustered"/)
  assert.match(markup, /Open preview of Basic scatter plot/)
  assert.doesNotMatch(markup, />Basic scatter plot</)
  assert.match(markup, />Scatter</)
  assert.match(markup, />Heatmap</)
  assert.doesNotMatch(markup, /Scatter and point-based plots/)
  assert.match(markup, /#fff/)
  assert.ok(
    markup.indexOf('data-phi-visualization-groups') < markup.indexOf('data-phi-visualization-grid')
  )
  assert.doesNotMatch(markup, /data-phi-visualization-loading/)

  const stage = themed(
    createElement(VisualizationPreviewStage, {
      title: 'Basic scatter plot',
      dataUrl: null,
      hasPrevious: false,
      hasNext: true,
      onPrevious: () => undefined,
      onNext: () => undefined
    })
  )
  assert.match(stage, /aria-label="Previous template"/)
  assert.match(stage, /phi-carousel-nav/)
  assert.match(stage, /opacity:0/)
  const previousButton = stage.slice(
    Math.max(0, stage.indexOf('Previous template') - 240),
    stage.indexOf('Previous template')
  )
  assert.match(previousButton, /disabled/)
})

test('only the visualization plugin detail offers the template gallery', () => {
  const detailProps = {
    busyPluginId: null,
    error: null,
    notice: null,
    onClearError: () => undefined,
    onClearNotice: () => undefined,
    onRefresh: async () => undefined,
    onSetEnabled: async () => true,
    onUninstall: async () => true
  }
  const visualization = themed(
    createElement(PhiPluginsView, { ...detailProps, plugin: plugin('visualization') })
  )
  const office = themed(createElement(PhiPluginsView, { ...detailProps, plugin: plugin('office') }))
  assert.match(visualization, /data-phi-visualization-segment="overview"/)
  assert.match(visualization, />Overview</)
  assert.match(visualization, />Templates</)
  assert.doesNotMatch(visualization, /data-phi-visualization-gallery/)
  assert.doesNotMatch(office, /data-phi-visualization-segment/)

  try {
    setUiLanguage('zh-CN')
    const chinese = themed(
      createElement(PhiPluginsView, { ...detailProps, plugin: plugin('visualization') })
    )
    const gallery = themed(createElement(VisualizationPanel, { catalog: sampleCatalog }))
    assert.match(chinese, />概览</)
    assert.match(chinese, />模板</)
    assert.match(gallery, />全部</)
    assert.match(gallery, />散点图</)
    assert.match(gallery, />热图</)
    assert.match(gallery, /搜索模板/)
  } finally {
    setUiLanguage('en')
  }
})
