import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import type { PhiPluginProblemView } from '../src/shared/phiPluginTypes'
import { PhiPluginsCatalog } from '../src/renderer/src/features/phi-plugin/components/PhiPluginsCatalog'
import type { PhiPluginDisplayItem } from '../src/renderer/src/features/phi-plugin/hooks/usePhiPlugins'
import {
  formatPhiPluginProblems,
  isSemanticUpgrade,
  phiPluginComponentName,
  phiPluginComponentSummary,
  phiPluginEnabledLabel,
  phiPluginEnvironmentStateLabel,
  phiPluginSourceLabel
} from '../src/renderer/src/features/phi-plugin/lib/phiPlugins'

function renderCatalog(plugins: PhiPluginDisplayItem[]): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(PhiPluginsCatalog, {
        plugins,
        loading: false,
        busyPluginId: null,
        onChooseDirectory: () => undefined,
        onSetEnabled: () => undefined,
        onRequestUninstall: () => undefined
      })
    )
  )
}

test('Phi plugin labels use concise Chinese product language', () => {
  assert.equal(phiPluginSourceLabel('bundled'), '内置')
  assert.equal(phiPluginSourceLabel('local'), '本地')
  assert.equal(phiPluginEnabledLabel(true), '已启用')
  assert.equal(phiPluginEnabledLabel(false), '已停用')
  assert.equal(phiPluginEnvironmentStateLabel('absent'), '未构建')
  assert.equal(phiPluginEnvironmentStateLabel('ready'), '已就绪')
  assert.equal(phiPluginEnvironmentStateLabel('drifted'), '需要修复')
})

test('Phi plugin component summaries omit empty categories and preserve final tool names', () => {
  assert.equal(
    phiPluginComponentSummary({
      agents: ['agents/Visualization.md', 'agents/Reviewer.md'],
      skills: ['skills/omics-visualization'],
      scriptTools: ['viz_render', 'viz_prepare'],
      environments: [{ name: 'viz', ref: 'plugin:viz' }]
    }),
    '2 个智能体 · 1 个技能 · 2 个脚本工具 · 1 个环境'
  )
  assert.equal(phiPluginComponentSummary({}), '未声明可显示的组件')
  assert.equal(phiPluginComponentName('agents/Visualization.md'), 'Visualization')
  assert.equal(phiPluginComponentName('skills\\omics-visualization'), 'omics-visualization')
  assert.equal(phiPluginComponentName('viz_render'), 'viz_render')
})

test('semantic upgrade detection accepts only strictly newer valid versions', () => {
  assert.equal(isSemanticUpgrade('1.2.3', '1.3.0'), true)
  assert.equal(isSemanticUpgrade('1.2.3-beta.1', '1.2.3'), true)
  assert.equal(isSemanticUpgrade('1.2.3', '1.2.3'), false)
  assert.equal(isSemanticUpgrade('2.0.0', '1.9.9'), false)
  assert.equal(isSemanticUpgrade('current', '2.0.0'), false)
  assert.equal(isSemanticUpgrade(undefined, '2.0.0'), false)
})

test('validation problems prefer localized display messages and format a readable fallback', () => {
  const problems: PhiPluginProblemView[] = [
    {
      level: 'error',
      path: 'phi-package.yaml',
      message: 'schemaVersion is required',
      displayMessage: '错误（phi-package.yaml）：缺少 schemaVersion'
    },
    {
      level: 'warning',
      path: 'README.md',
      message: 'README is missing',
      displayMessage: ''
    }
  ]

  assert.equal(
    formatPhiPluginProblems(problems),
    '错误（phi-package.yaml）：缺少 schemaVersion\n警告（README.md）：缺少插件合同要求的必填内容。技术详情：README is missing'
  )
  assert.equal(formatPhiPluginProblems([], '没有可用详情'), '没有可用详情')
})

test('Phi plugins catalog renders its empty state', () => {
  const markup = renderCatalog([])

  assert.match(markup, /尚未安装 Phi 插件/)
  assert.match(markup, /phi-package\.yaml/)
  assert.match(markup, /选择插件目录/)
})

test('Phi plugins catalog renders installed metadata, components and environment state', () => {
  const plugin: PhiPluginDisplayItem = {
    id: 'visualization',
    version: '1.2.0',
    title: '科研绘图',
    summary: '生成可发表的科研图表。',
    enabled: true,
    source: 'bundled',
    installedAt: '2026-10-01T00:00:00.000Z',
    directory: '/plugins/visualization/1.2.0',
    agents: ['agents/Visualization.md'],
    skills: ['skills/omics-visualization'],
    scriptTools: ['viz_prepare', 'viz_render'],
    environments: [{ name: 'viz', ref: 'plugin:viz' }],
    environmentStatuses: [{ name: 'viz', ref: 'plugin:viz', state: 'ready' }]
  }
  const markup = renderCatalog([plugin])

  assert.match(markup, /科研绘图/)
  assert.match(markup, /visualization/)
  assert.match(markup, /v1\.2\.0/)
  assert.match(markup, /内置/)
  assert.match(markup, /Visualization/)
  assert.match(markup, /omics-visualization/)
  assert.match(markup, /viz_prepare/)
  assert.match(markup, /viz_render/)
  assert.match(markup, /viz · 已就绪/)
})
