import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import { PhiPluginComponentDetails } from '../src/renderer/src/features/phi-plugin/components/PhiPluginComponentDetails'
import { PhiPluginComponentDialog } from '../src/renderer/src/features/phi-plugin/components/PhiPluginComponentDialog'
import {
  phiPluginComponentEnvironments,
  phiPluginInspectableComponents
} from '../src/renderer/src/features/phi-plugin/lib/phiPluginComponents'
import type { PhiPluginDisplayItem } from '../src/renderer/src/features/phi-plugin/hooks/usePhiPlugins'

function plugin(overrides: Partial<PhiPluginDisplayItem> = {}): PhiPluginDisplayItem {
  return {
    id: 'visualization',
    version: '1.0.2',
    title: '科研绘图',
    summary: '绘图工具',
    enabled: true,
    source: 'bundled',
    distribution: 'bundled',
    trust: 'builtin',
    installedAt: '2026-10-07',
    directory: '/plugins/visualization',
    agents: ['agents/Visualization.md'],
    skills: ['skills/omics-visualization'],
    scriptTools: ['viz_render'],
    environments: [{ name: 'viz', ref: 'plugin:viz' }],
    agentDetails: [{ name: 'Visualization', description: '规划与审查图表。' }],
    skillDetails: [
      {
        name: 'omics-visualization',
        description: '完整技能说明。',
        enabled: false,
        environmentRef: 'plugin:viz',
        environmentWarning: '环境需要修复。'
      }
    ],
    scriptToolDetails: [
      {
        name: 'viz_render',
        description: '读取输入并输出图表。\n保留完整第二行说明。',
        approval: 'write',
        skillName: 'omics-visualization'
      }
    ],
    environmentStatuses: [
      {
        name: '绘图环境',
        ref: 'plugin:viz',
        scope: 'private',
        skillNames: ['omics-visualization'],
        agentNames: ['Visualization'],
        warnings: [],
        state: 'ready'
      }
    ],
    ...overrides
  }
}

function themed(content: React.ReactElement): string {
  const theme = createTheme({
    components: { MuiDialog: { defaultProps: { disablePortal: true } } }
  })
  return renderToStaticMarkup(createElement(ThemeProvider, { theme }, content))
}

test('component inspection derives only declared relationships and preserves script names', () => {
  const components = phiPluginInspectableComponents(plugin())
  assert.deepEqual(
    components.map((component) => component.key),
    ['agent:Visualization', 'skill:omics-visualization', 'script:viz_render']
  )
  assert.ok(components.every((component) => component.environmentRefs.length === 1))
  assert.deepEqual(components[2].environmentRefs, ['plugin:viz'])
  assert.equal(components[2].skillName, 'omics-visualization')
  assert.equal(components[2].approval, 'write')
  assert.equal(components[1].enabled, false)
  assert.equal(components[1].warning, '环境需要修复。')
})

test('legacy component names remain inspectable without guessing missing metadata', () => {
  const components = phiPluginInspectableComponents(
    plugin({
      agentDetails: undefined,
      skillDetails: undefined,
      scriptToolDetails: undefined,
      environmentStatuses: []
    })
  )
  assert.deepEqual(
    components.map((component) => component.name),
    ['Visualization', 'omics-visualization', 'viz_render']
  )
  assert.ok(
    components.every(
      (component) => component.description === '' && component.environmentRefs.length === 0
    )
  )
  assert.equal(components[1].enabled, undefined)
  assert.equal(components[2].approval, undefined)
  assert.deepEqual(
    phiPluginInspectableComponents(
      plugin({
        agents: [],
        skills: [],
        scriptTools: [],
        agentDetails: [],
        skillDetails: [],
        scriptToolDetails: []
      })
    ),
    []
  )
})

test('each component is a named native button with its matching icon and dialog affordance', () => {
  const markup = themed(createElement(PhiPluginComponentDetails, { plugin: plugin() }))
  for (const [key, label, kind] of [
    ['agent:Visualization', '查看智能体 Visualization', 'agent'],
    ['skill:omics-visualization', '查看技能 omics-visualization', 'skill'],
    ['script:viz_render', '查看脚本工具 viz_render', 'script']
  ]) {
    assert.match(
      markup,
      new RegExp(
        `<button[^>]*aria-label="${label}"[^>]*aria-haspopup="dialog"[^>]*data-phi-plugin-component="${key}"`
      )
    )
    assert.ok(markup.includes(`data-phi-component-icon="${kind}"`))
  }
  assert.doesNotMatch(markup, /role="dialog"/)
})

test('plugin skill details omit enablement status while retaining description and environments', () => {
  for (const enabled of [true, false, undefined]) {
    const item = plugin()
    item.skillDetails![0].enabled = enabled
    const component = phiPluginInspectableComponents(item)[1]
    const listMarkup = themed(createElement(PhiPluginComponentDetails, { plugin: item }))
    const dialogMarkup = themed(
      createElement(PhiPluginComponentDialog, {
        plugin: item,
        component,
        open: true,
        icon: createElement('span'),
        onClose: () => undefined
      })
    )

    for (const markup of [listMarkup, dialogMarkup]) {
      assert.match(markup, /omics-visualization/)
      assert.match(markup, /完整技能说明。/)
      assert.doesNotMatch(markup, /已启用|已停用|状态未知/)
    }
    assert.match(dialogMarkup, /技能详情/)
    assert.match(dialogMarkup, /科研绘图 · v1.0.2/)
    assert.match(dialogMarkup, /绘图环境/)
    assert.match(dialogMarkup, /plugin:viz/)
    assert.match(dialogMarkup, /环境需要修复。/)
    assert.doesNotMatch(dialogMarkup, />状态</)
  }
})

test('inspection dialog shows complete script description, owner, approval and environment', () => {
  const item = plugin(),
    component = phiPluginInspectableComponents(item)[2]
  const markup = themed(
    createElement(PhiPluginComponentDialog, {
      plugin: item,
      component,
      open: true,
      icon: createElement('span'),
      onClose: () => undefined
    })
  )
  assert.match(markup, /脚本工具详情/)
  assert.match(markup, /保留完整第二行说明/)
  assert.match(markup, /科研绘图 · v1.0.2/)
  assert.match(markup, /写入/)
  assert.match(markup, /omics-visualization/)
  assert.match(markup, /绘图环境/)
  assert.match(markup, /plugin:viz/)
  assert.match(markup, /aria-label="关闭组件详情"/)
  assert.doesNotMatch(markup, /data-phi-description-truncated/)
})

test('relative environments keep owning-skill identity and scripts inherit environment warnings', () => {
  const scoped = plugin({
    skills: ['skills/first', 'skills/second'],
    skillDetails: [
      { name: 'first', description: '', enabled: true, environmentRef: './environment.yml' },
      {
        name: 'second',
        description: '',
        enabled: true,
        environmentRef: './environment.yml',
        environmentWarning: '第二个技能的环境需要修复。'
      }
    ],
    scriptToolDetails: [
      { name: 'second_render', description: '', approval: 'write', skillName: 'second' }
    ],
    environmentStatuses: [
      {
        name: '第一个技能环境',
        ref: './environment.yml',
        scope: 'skill',
        skillNames: ['first'],
        agentNames: [],
        warnings: []
      },
      {
        name: '第二个技能环境',
        ref: './environment.yml',
        scope: 'skill',
        skillNames: ['second'],
        agentNames: [],
        warnings: []
      }
    ]
  })
  const components = phiPluginInspectableComponents(scoped)
  const first = components.find((component) => component.key === 'skill:first')!
  const second = components.find((component) => component.key === 'skill:second')!
  const script = components.find((component) => component.key === 'script:second_render')!
  assert.deepEqual(phiPluginComponentEnvironments(scoped, first), [
    { ref: './environment.yml', name: '第一个技能环境' }
  ])
  assert.deepEqual(phiPluginComponentEnvironments(scoped, second), [
    { ref: './environment.yml', name: '第二个技能环境' }
  ])
  assert.deepEqual(phiPluginComponentEnvironments(scoped, script), [
    { ref: './environment.yml', name: '第二个技能环境' }
  ])
  assert.equal(script.warning, '第二个技能的环境需要修复。')
  const markup = themed(
    createElement(PhiPluginComponentDialog, {
      plugin: scoped,
      component: script,
      open: true,
      icon: createElement('span'),
      onClose: () => undefined
    })
  )
  assert.match(markup, /第二个技能环境/)
  assert.match(markup, /第二个技能的环境需要修复/)
  assert.doesNotMatch(markup, /第一个技能环境/)
  assert.deepEqual(
    phiPluginComponentEnvironments(
      { ...scoped, environmentStatuses: scoped.environmentStatuses.slice(0, 1) },
      second
    ),
    [{ ref: './environment.yml' }]
  )
})
