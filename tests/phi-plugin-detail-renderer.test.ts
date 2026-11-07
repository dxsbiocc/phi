import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import type {
  PhiPluginCatalogDetail,
  PhiPluginDependencyManifest
} from '../src/shared/phiPluginDetailTypes'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import { PhiPluginCatalogDetailSections } from '../src/renderer/src/features/phi-plugin/components/PhiPluginCatalogPreview'
import { PhiPluginDependencySummary } from '../src/renderer/src/features/phi-plugin/components/PhiPluginEnvironmentSummary'

function themed(element: React.ReactElement): string {
  return renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme() }, element))
}

function dependencyMarkup(environmentId: string, manifest: PhiPluginDependencyManifest): string {
  return themed(createElement(PhiPluginDependencySummary, { environmentId, manifest }))
}

function detailFixture(manifest: PhiPluginDependencyManifest): PhiPluginCatalogDetail {
  return {
    id: 'visualization',
    title: 'Visualization',
    summary: 'Publication-ready figures.',
    version: '2.0.0',
    source: 'Official registry',
    official: true,
    agents: [{ name: 'Figure reviewer', description: 'Reviews the final figure.' }],
    skills: [{ name: 'scientific-visualization', description: 'Builds multi-panel figures.' }],
    scriptTools: [
      {
        name: 'viz_render',
        description: 'Renders the selected figure.',
        approval: 'write',
        skillName: 'scientific-visualization'
      }
    ],
    environments: [
      {
        id: 'phi:r@1',
        title: 'Built-in R environment',
        description: 'Shared scientific R runtime.',
        sharedNote: 'Shared runtime',
        usedBySkills: ['scientific-visualization'],
        usedByAgents: ['Figure reviewer'],
        channels: ['conda-forge'],
        dependencyManifest: manifest
      }
    ]
  }
}

test('available catalog detail renders component and environment sections', () => {
  const markup = themed(
    createElement(PhiPluginCatalogDetailSections, {
      detail: detailFixture({
        dependencies: [{ name: 'r-base', version: '4.5', kind: 'conda' }],
        yamlText: 'dependencies:\n  - r-base=4.5\n',
        sourceFile: 'environments/phi-r/environment.yml',
        lookedFor: []
      })
    })
  )

  assert.match(markup, /data-phi-plugin-catalog-sections="available"/)
  assert.match(markup, />Agents</)
  assert.match(markup, />Skills</)
  assert.match(markup, />Script Tools</)
  assert.match(markup, /Figure reviewer/)
  assert.match(markup, /Builds multi-panel figures./)
  assert.match(markup, /data-phi-description-lines="3"/)
  assert.match(markup, /data-phi-description-lines="2"/)
  assert.match(markup, /Approval: Write/)
  assert.match(markup, /Owning skill: scientific-visualization/)
  assert.match(markup, />Environments</)
  assert.match(markup, /Built-in R environment/)
  assert.match(markup, /Shared runtime/)
  assert.match(markup, /phi:r@1/)
  assert.match(markup, /Channels: conda-forge/)
  assert.match(markup, /Used by skills: scientific-visualization/)
  assert.match(markup, /Used by agents: Figure reviewer/)
  assert.match(markup, /Dependency packages/)
  assert.match(markup, /Source: environments\/phi-r\/environment.yml/)
  assert.ok(markup.includes('dependencies:\n  - r-base=4.5'))
})

test('dependency packages render parsed entries when YAML text is unavailable', () => {
  const markup = dependencyMarkup('plugin:demo', {
    dependencies: [
      { name: 'numpy', version: '2.1', kind: 'pip' },
      { name: 'viz-helper', version: 'abc123', kind: 'source' }
    ],
    sourceFile: 'package.json',
    lookedFor: []
  })

  assert.match(markup, /data-phi-plugin-dependency-state="packages"/)
  assert.match(markup, /Source: package.json/)
  assert.match(markup, /numpy=2.1/)
  assert.match(markup, /viz-helper@abc123/)
})

test('dependency packages render shared-runtime, empty-manifest and missing states honestly', () => {
  const shared = dependencyMarkup('phi:python@1', { dependencies: [], lookedFor: [] })
  assert.match(shared, /data-phi-plugin-dependency-state="shared-runtime"/)
  assert.match(shared, /uses the shared built-in runtime phi:python@1/)

  const empty = dependencyMarkup('plugin:empty', {
    dependencies: [],
    sourceFile: 'environment.yml',
    lookedFor: ['environment.yml']
  })
  assert.match(empty, /data-phi-plugin-dependency-state="empty-manifest"/)
  assert.match(
    empty,
    /environment.yml was read successfully and does not list any dependency packages/
  )
  assert.doesNotMatch(empty, /Troubleshooting paths/)

  const missing = dependencyMarkup('plugin:missing', {
    dependencies: [],
    lookedFor: ['environment.yml', 'renv.lock']
  })
  assert.match(missing, /data-phi-plugin-dependency-state="missing"/)
  assert.match(missing, /No parsable dependency manifest was found/)
  assert.match(missing, /Troubleshooting paths/)
  assert.match(missing, /environment.yml\nrenv.lock/)
})

test('new plugin detail labels switch to the required Simplified Chinese copy', () => {
  try {
    setUiLanguage('zh-CN')
    const detail = detailFixture({ dependencies: [], lookedFor: ['environment.yml'] })
    detail.environments[0]!.id = 'plugin:missing'
    const markup = themed(
      createElement(PhiPluginCatalogDetailSections, {
        detail
      })
    )
    for (const label of [
      '智能体',
      '技能',
      '脚本工具',
      '环境',
      '依赖包',
      '写入',
      '所属技能',
      '排查路径'
    ]) {
      assert.match(markup, new RegExp(label))
    }
  } finally {
    setUiLanguage('en')
  }
})
