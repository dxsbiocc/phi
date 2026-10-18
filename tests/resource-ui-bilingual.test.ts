import { McpLocalConnectorForm } from '../src/renderer/src/features/mcp/components/McpLocalConnectorForm'
import { emptyLocalConnectorDraft } from '../src/renderer/src/features/mcp/lib/localConnectorDraft'
import { filterFeaturedConnectors } from '../src/renderer/src/features/mcp/lib/featuredConnectorFilters'
import { filterPhiPluginCatalog } from '../src/renderer/src/features/phi-plugin/lib/phiPluginCatalog'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material/styles'

import { getUiLanguage, setUiLanguage } from '../src/renderer/src/lib/i18n'
import {
  PACKAGE_TRUST_DESCRIPTIONS,
  PACKAGE_TRUST_LABELS
} from '../src/renderer/src/lib/packageTrust'
import { resourceUi } from '../src/renderer/src/lib/resourceUi'
import {
  connectorCopy,
  connectorSignInLabel
} from '../src/renderer/src/features/mcp/lib/connectorCopy'
import { skillCopy } from '../src/renderer/src/features/skill/lib/skillCopy'
import { pluginCopy } from '../src/renderer/src/features/phi-plugin/lib/pluginCopy'
import { McpFeaturedConnectorCard } from '../src/renderer/src/features/mcp/components/McpFeaturedConnectorCard'
import { McpConnectorCatalogToolbar } from '../src/renderer/src/features/mcp/components/McpConnectorCatalogToolbar'
import { SkillDetailBody } from '../src/renderer/src/features/skill/components/SkillDetailBody'
import {
  skillCatalogGroups,
  skillCatalogItems,
  filterSkillCatalogItems
} from '../src/renderer/src/features/skill/lib/skillCatalogBrowser'
import { skillSourceCategoryLabels } from '../src/renderer/src/features/skill/lib/skillCatalog'
import {
  phiPluginComponentSummary,
  phiPluginSourceCategoryLabels
} from '../src/renderer/src/features/phi-plugin/lib/phiPlugins'
import { PHI_PLUGIN_APPROVAL_LABELS } from '../src/renderer/src/features/phi-plugin/lib/phiPluginComponents'
import { PhiPluginEnvironmentDetails } from '../src/renderer/src/features/phi-plugin/components/PhiPluginEnvironmentDetails'
import { CatalogResourceRow } from '../src/renderer/src/components/CatalogResourceRow'
import type { FeaturedMcpConnector } from '../src/shared/mcpConnectorCatalog'

const render = (content: ReactElement): string =>
  renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme() }, content))

test.afterEach(() => setUiLanguage('en'))

test('resource management still defaults to English', () => {
  assert.equal(getUiLanguage(), 'en')
  assert.equal(connectorCopy.addConnector, 'Add Connector')
  assert.equal(skillCopy.catalogTitle, 'Skill Catalog')
  assert.equal(pluginCopy.catalog, 'Plugin Catalog')
})

test('cached formatters, nested dictionaries and source/trust labels follow each switch', () => {
  const savedFormatter = connectorCopy.addNamed
  const savedApprovals = PHI_PLUGIN_APPROVAL_LABELS
  setUiLanguage('zh-CN')
  assert.equal(savedFormatter('作者的工具'), '添加 作者的工具')
  assert.equal(savedApprovals.execute, '执行')
  assert.equal(PACKAGE_TRUST_LABELS.imported, '未签名')
  assert.match(PACKAGE_TRUST_DESCRIPTIONS.imported, /签名/)
  assert.equal(skillSourceCategoryLabels.project, '项目')
  assert.equal(phiPluginSourceCategoryLabels.bundled, '内置')
  assert.equal(
    phiPluginComponentSummary({ skills: ['a', 'b'], agents: ['c'] }),
    '1 个智能体 · 2 个技能'
  )
  setUiLanguage('en')
  assert.equal(savedFormatter('作者的工具'), 'Add 作者的工具')
  assert.equal(savedApprovals.execute, 'Execute')
  assert.equal(PACKAGE_TRUST_LABELS.imported, 'Unsigned')
  assert.equal(skillSourceCategoryLabels.project, 'Project')
  assert.equal(phiPluginSourceCategoryLabels.bundled, 'Built-in')
  assert.equal(
    phiPluginComponentSummary({ skills: ['a', 'b'], agents: ['c'] }),
    '1 agent · 2 skills'
  )
})

const connector: FeaturedMcpConnector = {
  id: 'author-service',
  version: '1.0.1',
  name: '作者的连接器',
  description: '作者说明保持原文',
  category: '生产力',
  publisher: 'Author',
  signIn: '需要登录',
  transport: 'http',
  auth: 'oauth',
  url: 'https://example.com/mcp',
  added: false,
  oauthAuthorizationOrigin: 'https://auth.example.com',
  source: { kind: 'official', label: 'Phi 官网', trust: 'imported' }
}

test('Connector presentation changes language without changing authorization or source trust', () => {
  const before = structuredClone(connector)
  for (const [language, status, action, source, unsigned] of [
    ['en', 'Sign-in required', 'Sign in to 作者的连接器', 'Phi Website', 'Unsigned'],
    ['zh-CN', '需要登录', '登录 作者的连接器', 'Phi 官网', '未签名']
  ] as const) {
    setUiLanguage(language)
    const markup = render(
      createElement(McpFeaturedConnectorCard, {
        connector,
        installed: false,
        authStatus: 'unauthenticated',
        busy: false,
        onOpen: () => undefined,
        onAdd: () => undefined,
        onAuthorize: () => undefined
      })
    )
    for (const text of [connector.name, connector.description, status, source, unsigned])
      assert.ok(markup.includes(text), text)
    assert.ok(markup.includes(`aria-label="${action}"`))
    assert.match(markup, /data-phi-connector-configured="false"/)
    assert.doesNotMatch(markup, /data-phi-connector-state="added"/)
    assert.equal(connectorSignInLabel('需要登录'), status)
    assert.deepEqual(connector, before)
  }
})

test('Connector sort labels update after import while raw filter keys stay stable', () => {
  for (const [language, sort, placeholder] of [
    ['en', 'Sort: Configured first', 'Search Connectors'],
    ['zh-CN', '排序：已配置优先', '搜索连接器']
  ] as const) {
    setUiLanguage(language)
    const markup = render(
      createElement(McpConnectorCatalogToolbar, {
        query: 'unchanged query',
        signIn: '需要登录',
        install: 'not-added',
        sort: 'added',
        onQueryChange: () => undefined,
        onSignInChange: () => undefined,
        onInstallChange: () => undefined,
        onSortChange: () => undefined
      })
    )
    assert.ok(markup.includes(sort))
    assert.ok(markup.includes(placeholder))
    assert.match(markup, /value="unchanged query"/)
  }
})

test('Skill group identifiers and authored detail text survive translated labels', () => {
  const entry = {
    id: 'skill-a',
    type: 'skill' as const,
    version: '1.0.0',
    title: '作者技能',
    summary: '原文说明',
    archive: 'a.tar.gz',
    sha256: 'a'.repeat(64),
    size: 12,
    dependsOn: [],
    registryDir: '/registry',
    group: 'science',
    groupLabel: '科学分析',
    category: '科学分析'
  }
  const before = structuredClone(entry)
  const items = skillCatalogItems([entry])
  for (const [language, group, description] of [
    ['en', 'Scientific Analysis', 'Description'],
    ['zh-CN', '科学分析', '说明']
  ] as const) {
    setUiLanguage(language)
    assert.deepEqual(
      skillCatalogGroups(items).map(({ id }) => id),
      ['all', 'group:science']
    )
    assert.equal(skillCatalogGroups(items)[1].label, group)
    assert.equal(filterSkillCatalogItems(items, 'group:science', group)[0].entry.id, 'skill-a')
    const markup = render(
      createElement(SkillDetailBody, {
        name: entry.title,
        description: entry.summary,
        enabled: true,
        sourceLabel: skillCopy.packageSource,
        sourceText: '/registry',
        markdown: { content: null, isLoading: false, error: null }
      })
    )
    for (const text of [entry.title, entry.summary, description])
      assert.ok(markup.includes(text), text)
    assert.deepEqual(entry, before)
  }
})

test('Plugin environment controls follow language without translating declared metadata', () => {
  for (const [language, environments, action] of [
    ['en', 'Environments', 'Review estimate and build'],
    ['zh-CN', '环境', '查看估算并构建']
  ] as const) {
    setUiLanguage(language)
    const markup = render(
      createElement(PhiPluginEnvironmentDetails, {
        environments: [
          {
            ref: 'plugin:viz',
            name: '作者环境',
            scope: 'private',
            warnings: [],
            state: 'absent',
            skillNames: ['author-skill'],
            agentNames: ['AuthorAgent']
          }
        ],
        busyEnvironment: null,
        busyPluginId: null,
        actionError: null,
        onDismissError: () => undefined,
        onBuild: () => undefined,
        onRebuild: () => undefined
      })
    )
    for (const text of [
      environments,
      action,
      '作者环境',
      'plugin:viz',
      'author-skill',
      'AuthorAgent'
    ])
      assert.ok(markup.includes(text), text)
  }
})

test('shared resource controls localize accessible actions while stable IDs are preserved', () => {
  for (const [language, action] of [
    ['en', 'Disable 作者技能'],
    ['zh-CN', '停用 作者技能']
  ] as const) {
    setUiLanguage(language)
    const markup = render(
      // eslint-disable-next-line react/no-children-prop -- Required typed content slot.
      createElement(CatalogResourceRow, {
        id: 'skill-a',
        resource: 'skills',
        label: '作者技能',
        icon: createElement('span'),
        enabled: true,
        onSelect: () => undefined,
        onEnabledChange: () => undefined,
        children: '作者原文'
      })
    )
    assert.ok(markup.includes(`aria-label="${action}"`))
    assert.match(markup, /data-phi-catalog-row="skill-a"/)
    assert.match(markup, /data-phi-catalog-status="enabled"/)
    assert.ok(markup.includes('作者原文'))
    assert.equal(resourceUi.skills, language === 'en' ? 'Skills' : '技能')
  }
})

test('resource catalog matching survives switching with English or Chinese category, source and sign-in queries', () => {
  const skillItems = skillCatalogItems([
    {
      id: 'skill-a',
      type: 'skill',
      version: '1.0.0',
      title: 'Author Skill',
      summary: 'Author description',
      archive: 'a.tar.gz',
      sha256: 'a'.repeat(64),
      size: 12,
      dependsOn: [],
      registryDir: '/registry',
      group: 'science',
      groupLabel: '科学分析',
      registryLabel: 'Phi 官网'
    }
  ])
  const pluginItems = [
    {
      id: 'plugin-a',
      title: 'Author Plugin',
      summary: 'Author description',
      version: '1.0.0',
      trust: 'imported' as const,
      category: '科学分析',
      source: 'Phi 官网'
    }
  ]
  for (const language of ['en', 'zh-CN', 'en'] as const) {
    setUiLanguage(language)
    for (const query of ['Productivity', '生产力', 'Sign-in required', '需要登录']) {
      assert.deepEqual(
        filterFeaturedConnectors([connector], {
          category: '生产力',
          signIn: '需要登录',
          install: 'not-added',
          sort: 'default',
          query,
          isInstalled: () => false
        }).map((item) => item.id),
        ['author-service']
      )
    }
    for (const query of ['Scientific Analysis', '科学分析', 'Phi Website', 'Phi 官网']) {
      assert.deepEqual(
        filterSkillCatalogItems(skillItems, 'group:science', query).map((item) => item.entry.id),
        ['skill-a']
      )
      assert.deepEqual(
        filterPhiPluginCatalog(pluginItems, '科学分析', query).map((item) => item.id),
        ['plugin-a']
      )
    }
  }
})

test('the bundled runtime option translates while its stable runtime value and command are retained', () => {
  const draft = { ...emptyLocalConnectorDraft(), runtime: { kind: 'bun' as const }, command: 'x' }
  for (const [language, label] of [
    ['en', 'Phi bundled Bun'],
    ['zh-CN', 'Phi 内置 Bun']
  ] as const) {
    setUiLanguage(language)
    const markup = render(
      createElement(McpLocalConnectorForm, {
        busy: false,
        runtimes: [{ kind: 'bun', ref: 'bun', label: 'Phi bundled Bun' }],
        runtimesLoading: false,
        draft,
        onDraftChange: () => undefined
      })
    )
    assert.ok(markup.includes(label))
    assert.match(markup, /value="__bun__"/)
    assert.match(markup, /value="x"/)
  }
})
