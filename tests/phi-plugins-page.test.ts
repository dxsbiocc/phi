import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import type { EnvironmentBuild } from '../src/shared/environmentBuildTypes'
import type { PackageUpdateView } from '../src/shared/packageManagerTypes'
import type { PhiPluginProblemView } from '../src/shared/phiPluginTypes'
import { EnvironmentBuildConfirmDialog } from '../src/renderer/src/components/EnvironmentBuildConfirmDialog'
import PhiPluginsView, {
  PhiPluginCatalogContent,
  PhiPluginSidebar,
  type PhiPluginCatalogEntry
} from '../src/renderer/src/features/phi-plugin/PhiPluginsView'
import {
  applyEnvironmentBuildToPlugins,
  type PhiPluginDisplayItem
} from '../src/renderer/src/features/phi-plugin/hooks/usePhiPlugins'
import { requestPhiPluginEnvironmentBuild } from '../src/renderer/src/features/phi-plugin/lib/environmentBuild'
import { phiPluginCatalogAction } from '../src/renderer/src/features/phi-plugin/lib/phiPluginCatalog'
import {
  filterPhiPlugins,
  groupPhiPlugins,
  visiblePhiPluginCategory
} from '../src/renderer/src/features/phi-plugin/lib/phiPluginSidebar'
import {
  formatPhiPluginProblems,
  isSemanticUpgrade,
  phiPluginComponentName,
  phiPluginComponentSummary,
  phiPluginDistributionLabel,
  phiPluginEnabledLabel,
  phiPluginEnvironmentStateLabel,
  phiPluginSourceLabel
} from '../src/renderer/src/features/phi-plugin/lib/phiPlugins'

function plugin(overrides: Partial<PhiPluginDisplayItem> = {}): PhiPluginDisplayItem {
  return {
    id: 'visualization',
    version: '1.2.0',
    title: '科研绘图',
    summary: '生成可发表的科研图表。',
    enabled: true,
    source: 'bundled',
    distribution: 'bundled',
    trust: 'builtin',
    installedAt: '2026-10-01T00:00:00.000Z',
    directory: '/plugins/visualization/1.2.0',
    agents: ['agents/Visualization.md'],
    skills: ['skills/omics-visualization'],
    scriptTools: ['viz_prepare', 'viz_render'],
    environments: [{ name: 'viz', ref: 'plugin:viz' }],
    environmentStatuses: [{ name: 'viz', ref: 'plugin:viz', state: 'ready' }],
    ...overrides
  }
}

const installedPlugins = [
  plugin(),
  plugin({
    id: 'registry-reviewer',
    title: '软件源审稿助手',
    version: '1.0.0',
    source: 'local',
    distribution: 'registry',
    trust: 'official',
    directory: '/plugins/registry-reviewer/1.0.0'
  }),
  plugin({
    id: 'local-tools',
    title: '本地工具',
    version: '0.4.0',
    enabled: false,
    source: 'local',
    distribution: 'local',
    trust: 'imported',
    directory: '/tmp/local-tools'
  })
]

function themed(element: React.ReactElement): string {
  return renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme() }, element))
}

function catalogEntry(id: string, title: string): PhiPluginCatalogEntry {
  return {
    id,
    type: 'plugin',
    version: '2.0.0',
    title,
    summary: `${title} summary`,
    archive: `${id}.zip`,
    sha256: id.padEnd(64, '0'),
    size: 1024,
    dependsOn: [],
    category: '科研',
    registryPath: '/registry',
    trust: 'official'
  }
}

test('Phi plugin labels use concise Chinese product language', () => {
  assert.equal(phiPluginSourceLabel('bundled'), '内置')
  assert.equal(phiPluginSourceLabel('local'), '本地')
  assert.equal(phiPluginDistributionLabel('registry'), '软件源')
  assert.equal(phiPluginDistributionLabel('local'), '本地目录')
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

test('plugin sidebar groups installed plugins by source and exposes search/filter metadata', () => {
  const markup = themed(
    createElement(PhiPluginSidebar, {
      plugins: installedPlugins,
      loading: false,
      activePluginId: 'registry-reviewer',
      onSelectPlugin: () => undefined,
      onOpenCatalog: () => undefined
    })
  )

  assert.match(markup, /3 个已安装/)
  assert.match(markup, /内置/)
  assert.match(markup, /软件源/)
  assert.match(markup, /本地目录/)
  assert.match(markup, /registry-reviewer · v1\.0\.0/)
  assert.match(markup, /aria-label="已启用"/)
  assert.equal(
    groupPhiPlugins(installedPlugins)
      .map((group) => group.category)
      .join(','),
    'bundled,registry,local'
  )
  assert.deepEqual(
    filterPhiPlugins(installedPlugins, '审稿').map((item) => item.id),
    ['registry-reviewer']
  )
  assert.deepEqual(
    filterPhiPlugins(installedPlugins, '0.4.0').map((item) => item.id),
    ['local-tools']
  )
  const groups = groupPhiPlugins(installedPlugins)
  assert.equal(visiblePhiPluginCategory(groups, null, ''), null)
  assert.equal(
    visiblePhiPluginCategory(
      groupPhiPlugins(filterPhiPlugins(installedPlugins, '审稿')),
      null,
      '审稿'
    ),
    'registry'
  )
})

test('plugin sidebar renders the requested empty state with an add action', () => {
  const markup = themed(
    createElement(PhiPluginSidebar, {
      plugins: [],
      loading: false,
      activePluginId: null,
      onSelectPlugin: () => undefined,
      onOpenCatalog: () => undefined
    })
  )

  assert.match(markup, /尚未安装插件/)
  assert.match(markup, /aria-label="添加插件"/)
})

test('plugin detail contains management, components, environment state and source metadata', () => {
  const selected = plugin({
    environmentStatuses: [
      { name: 'viz', ref: 'plugin:viz', envId: 'viz-123', state: 'drifted' },
      { name: 'stats', ref: 'plugin:stats', state: 'absent' }
    ]
  })
  const markup = themed(
    createElement(PhiPluginsView, {
      plugin: selected,
      busyPluginId: null,
      error: null,
      notice: null,
      onClearError: () => undefined,
      onClearNotice: () => undefined,
      onRefresh: async () => undefined,
      onSetEnabled: async () => true,
      onUninstall: async () => true
    })
  )

  assert.match(markup, /科研绘图/)
  assert.match(markup, /visualization · v1\.2\.0/)
  assert.match(markup, /智能体/)
  assert.match(markup, /技能/)
  assert.match(markup, /脚本工具（最终名称）/)
  assert.match(markup, /viz_prepare/)
  assert.match(markup, /需要修复/)
  assert.match(markup, /未构建/)
  assert.match(markup, /\/plugins\/visualization\/1\.2\.0/)
  assert.match(markup, /卸载/)
})

test('plugin detail builds an absent private environment through the shared confirmation flow', async () => {
  const estimate = {
    packages: 12,
    cachedPackages: 5,
    remainingBytes: 4 * 1024 * 1024
  }
  const selected = plugin({
    environmentStatuses: [
      {
        name: 'viz',
        ref: 'plugin:viz',
        envId: 'plugin-visualization-viz-0123456789ab',
        state: 'absent',
        estimate
      }
    ]
  })
  const markup = themed(
    createElement(PhiPluginsView, {
      plugin: selected,
      busyPluginId: null,
      error: null,
      notice: null,
      onClearError: () => undefined,
      onClearNotice: () => undefined,
      onRefresh: async () => undefined,
      onSetEnabled: async () => true,
      onUninstall: async () => true
    })
  )
  assert.match(markup, /查看估算并构建/)

  const dialogSource = readFileSync(
    'src/renderer/src/components/EnvironmentBuildConfirmDialog.tsx',
    'utf8'
  )
  const detailSource = readFileSync(
    'src/renderer/src/features/phi-plugin/components/PhiPluginDetail.tsx',
    'utf8'
  )
  const settingsSource = readFileSync(
    'src/renderer/src/features/environment/components/EnvironmentSettingsPanel.tsx',
    'utf8'
  )
  assert.match(dialogSource, /构建 .*？/)
  assert.match(dialogSource, /确认后会在后台构建，进度可在后台任务面板查看/)
  assert.match(dialogSource, /开始构建/)
  assert.match(detailSource, /setPendingBuild\(\{ pluginId: plugin\.id, environment \}\)/)
  assert.match(detailSource, /<EnvironmentBuildConfirmDialog/)
  assert.match(settingsSource, /<EnvironmentBuildConfirmDialog/)
  assert.match(
    settingsSource,
    /buildManagedEnvironment\([\s\S]{0,160}action\.environment\.pluginId/
  )

  const calls: unknown[][] = []
  const result = await requestPhiPluginEnvironmentBuild(
    {
      buildManagedEnvironment: async (...args: unknown[]) => {
        calls.push(args)
        return { envId: 'plugin-visualization-viz-0123456789ab' }
      }
    },
    selected.id,
    selected.environmentStatuses[0]!
  )
  assert.equal(result.envId, 'plugin-visualization-viz-0123456789ab')
  assert.deepEqual(calls, [['plugin:viz', undefined, 'visualization']])

  const dialogMarkup = themed(
    createElement(EnvironmentBuildConfirmDialog, {
      environment: { ref: 'plugin:viz', label: 'viz', estimate },
      working: false,
      onClose: () => undefined,
      onConfirm: () => undefined
    })
  )
  assert.match(dialogMarkup, /构建 viz？/)
  assert.match(dialogMarkup, /预计下载 4\.0 MB · 12 个包（5 个已缓存）/)
  assert.match(dialogMarkup, /开始构建/)
})

test('plugin environment build events drive building progress and ready state', () => {
  const selected = plugin({
    environmentStatuses: [
      {
        name: 'viz',
        ref: 'plugin:viz',
        envId: 'plugin-visualization-viz-0123456789ab',
        state: 'absent',
        estimate: { packages: 12, cachedPackages: 5 }
      }
    ]
  })
  const building: EnvironmentBuild = {
    envId: 'plugin-visualization-viz-0123456789ab',
    ref: 'plugin:viz',
    state: 'building',
    phase: 'create',
    message: '正在下载软件包',
    startedAt: '2026-10-03T00:00:00.000Z',
    estimate: { packages: 12, cachedPackages: 5 },
    progress: { packages: 12, packagesDone: 8 }
  }

  const active = applyEnvironmentBuildToPlugins([selected], building)[0]!
  assert.equal(active.environmentStatuses[0]?.state, 'building')
  assert.equal(active.environmentStatuses[0]?.build?.progress.packagesDone, 8)
  const activeMarkup = themed(
    createElement(PhiPluginsView, {
      plugin: active,
      busyPluginId: null,
      error: null,
      notice: null,
      onClearError: () => undefined,
      onClearNotice: () => undefined,
      onRefresh: async () => undefined,
      onSetEnabled: async () => true,
      onUninstall: async () => true
    })
  )
  assert.match(activeMarkup, /正在下载软件包/)
  assert.match(activeMarkup, /8 \/ 12 个包/)
  assert.match(activeMarkup, /disabled=""/)

  const ready = applyEnvironmentBuildToPlugins([active], {
    ...building,
    state: 'ready',
    phase: 'ready',
    message: 'ready',
    finishedAt: '2026-10-03T00:01:00.000Z',
    progress: { packages: 12, packagesDone: 12 }
  })[0]!
  assert.equal(ready.environmentStatuses[0]?.state, 'ready')
  assert.equal(ready.environmentStatuses[0]?.error, undefined)
})

test('legacy plugin resource tabs render a safe empty-selection detail', () => {
  const markup = themed(
    createElement(PhiPluginsView, {
      plugin: null,
      busyPluginId: null,
      error: null,
      notice: null,
      onClearError: () => undefined,
      onClearNotice: () => undefined,
      onRefresh: async () => undefined,
      onSetEnabled: async () => true,
      onUninstall: async () => true
    })
  )

  assert.match(markup, /从左侧选择插件查看详情/)
  assert.match(markup, /旧版插件标签页会保留/)
})

test('catalog shows installed, update and install states plus local-directory action', () => {
  const entries = [
    catalogEntry('registry-reviewer', '软件源审稿助手'),
    catalogEntry('local-tools', '本地工具'),
    catalogEntry('new-plugin', '新插件')
  ]
  const updates: PackageUpdateView[] = [
    {
      id: 'local-tools',
      type: 'plugin',
      title: '本地工具',
      currentVersion: '0.4.0',
      newVersion: '2.0.0',
      registryId: 'official',
      registryPath: '/registry',
      trust: 'official'
    }
  ]
  const markup = themed(
    createElement(PhiPluginCatalogContent, {
      plugins: installedPlugins,
      entries,
      updates,
      loading: false,
      busyId: null,
      initialCategory: '科研',
      onChooseDirectory: () => undefined,
      onInstall: () => undefined
    })
  )

  assert.match(markup, /已安装 · 3/)
  assert.match(markup, /科研 · 3/)
  assert.match(markup, /从本地目录安装/)
  assert.match(markup, /搜索插件目录/)
  assert.match(markup, />已安装</)
  assert.match(markup, />更新</)
  assert.match(markup, />安装</)
  assert.match(markup, /官方/)
  const installedIds = new Set(installedPlugins.map((item) => item.id))
  assert.equal(phiPluginCatalogAction(entries[0], installedIds, updates), 'installed')
  assert.equal(phiPluginCatalogAction(entries[1], installedIds, updates), 'update')
  assert.equal(phiPluginCatalogAction(entries[2], installedIds, updates), 'install')

  const busyMarkup = themed(
    createElement(PhiPluginCatalogContent, {
      plugins: installedPlugins,
      entries,
      updates,
      loading: false,
      busyId: 'local-tools',
      initialCategory: '科研',
      onChooseDirectory: () => undefined,
      onInstall: () => undefined
    })
  )
  assert.equal(busyMarkup.match(/disabled=""/g)?.length ?? 0, 4)
})

test('plugin selection uses resource tabs, keeps the sidebar open, and uninstall stays confirmed', () => {
  const appSource = readFileSync('src/renderer/src/App.tsx', 'utf8')
  const detailSource = readFileSync(
    'src/renderer/src/features/phi-plugin/components/PhiPluginDetail.tsx',
    'utf8'
  )
  const sidebarHostSource = readFileSync('src/renderer/src/AppWorkspaceSidebar.tsx', 'utf8')

  assert.match(appSource, /const onOpenPhiPluginTab = useCallback/)
  assert.match(appSource, /kind: 'plugins',[\s\S]{0,80}itemId: plugin\.id/)
  assert.match(appSource, /const onOpenPhiPlugins = useCallback[\s\S]{0,160}itemId: 'installed'/)
  assert.match(appSource, /activeResourcePhiPlugin[\s\S]{0,700}<PhiPluginsView/)
  assert.doesNotMatch(appSource, /setIsSidebarOpen\(tab\.kind !== 'plugins'\)/)
  assert.match(
    appSource,
    /setWorkspaceSidebarMode\(workspaceResourceKindToSidebarMode\(tab\.kind\)\)[\s\S]{0,80}setIsSidebarOpen\(true\)/
  )
  assert.match(
    sidebarHostSource,
    /workspaceSidebarMode === 'plugins'[\s\S]{0,180}<PhiPluginSidebar/
  )
  assert.match(detailSource, /onClick=\{\(\) => setPendingUninstall\(plugin\)\}/)
  assert.match(detailSource, /open=\{pendingUninstall !== null\}/)
  assert.match(detailSource, /确认卸载/)
})
