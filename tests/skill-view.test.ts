import assert from 'node:assert/strict'
import test from 'node:test'
import { Children, createElement, isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import SkillView, { SkillDetail, SkillSidebar } from '../src/renderer/src/features/skill/SkillView'
import {
  SkillCatalogDialog,
  type SkillCatalogDialogProps
} from '../src/renderer/src/features/skill/components/SkillCatalogDialog'
import { skillMarkdownBody } from '../src/renderer/src/features/skill/lib/skillMarkdown'
import type { SkillSummary } from '../src/renderer/src/types'
import type { PackageRegistryEntryView } from '../src/shared/packageManagerTypes'
import { cacheResourceIconFixture } from './helpers/resourceIconFixture'

function skill(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    id: '/bundled/create-wrapper/SKILL.md',
    name: 'create-wrapper',
    description: 'Built in fixture',
    filePath: '/bundled/create-wrapper/SKILL.md',
    source: 'bundled',
    scope: 'user',
    sourceCategory: 'bundled',
    sourceCategoryLabel: '内置',
    enabled: true,
    globalEnabled: true,
    globalOverride: null,
    projectOverride: null,
    core: true,
    disabled: false,
    ...overrides
  }
}

const skills: SkillSummary[] = [
  skill(),
  skill({
    id: '/project/.phi/skills/project-skill/SKILL.md',
    name: 'project-skill',
    description: 'Project fixture',
    filePath: '/project/.phi/skills/project-skill/SKILL.md',
    source: '/project/.phi/skills',
    scope: 'project',
    sourceCategory: 'project',
    sourceCategoryLabel: '项目',
    core: false
  })
]

function themed(element: React.ReactElement): string {
  return renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme() }, element))
}

function renderSkillView(skillList: SkillSummary[] = skills): string {
  return themed(
    createElement(SkillView, {
      skills: skillList,
      isLoading: false,
      activeSkillId: skillList[0]?.id ?? null,
      sidebarWidth: 320,
      onSelectSkill: () => undefined,
      onStartSidebarResize: () => undefined
    })
  )
}

function renderSkillSidebar(skillList: SkillSummary[] = skills): string {
  return themed(
    createElement(SkillSidebar, {
      skills: skillList,
      isLoading: false,
      activeSkillId: skillList[0]?.id ?? null,
      sidebarWidth: 320,
      onSelectSkill: () => undefined
    })
  )
}

function renderSkillCatalog(
  overrides: Partial<SkillCatalogDialogProps> = {},
  observeRowKeys?: (keys: Array<string | null>) => void
): string {
  function ObservedTableBody({ children }: { children?: ReactNode }): React.ReactElement {
    const keys: Array<string | null> = []
    Children.forEach(children, (child) => {
      if (isValidElement(child)) keys.push(child.key)
    })
    observeRowKeys?.(keys)
    return createElement('tbody', null, children)
  }
  const theme = createTheme({
    components: {
      MuiDialog: { defaultProps: { disablePortal: true } },
      ...(observeRowKeys
        ? { MuiTableBody: { defaultProps: { component: ObservedTableBody } } }
        : {})
    }
  })
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(SkillCatalogDialog, {
        open: true,
        skills: [],
        onClose: () => undefined,
        onInstallPackage: () => undefined,
        ...overrides
      })
    )
  )
}

function packageEntry(
  id: string,
  overrides: Partial<PackageRegistryEntryView> = {}
): PackageRegistryEntryView {
  return {
    id,
    type: 'skill',
    version: '1.0.0',
    title: id,
    summary: `${id} package summary`,
    archive: `${id}.tar.gz`,
    sha256: 'a'.repeat(64),
    size: 1024,
    dependsOn: [],
    ...overrides
  }
}

test('skill view groups skills by source category and exposes the skill markdown panel', () => {
  const markup = renderSkillView()

  assert.match(markup, /内置/)
  assert.match(markup, /项目/)
  assert.match(markup, /内置·核心/)
  assert.match(markup, /SKILL\.md/)
  assert.match(markup, /需要重启 Phi/)
  assert.match(markup, /从目录添加/)
})

test('skill sidebar keeps management actions out of the browsing list', () => {
  const markup = renderSkillSidebar()

  assert.match(markup, /create-wrapper/)
  assert.doesNotMatch(markup, /卸载技能/)
  assert.doesNotMatch(markup, /全局启用技能/)
})

test('skills reuse their own icon in sidebar, detail, and package catalog rows', async () => {
  const key = 'owned-skill-icon'
  await cacheResourceIconFixture(key)
  const owned = skill({ icon: { key }, core: false, enabled: false, globalEnabled: false })
  const view = renderSkillView([owned])
  assert.equal(view.match(/data-phi-resource-icon-key="owned-skill-icon"/g)?.length, 2)
  assert.equal(view.match(/<img[^>]*src="data:image\/png;base64,iVBORw0KGgo="/g)?.length, 2)

  const catalog = renderSkillCatalog({
    skills: [owned],
    registry: {
      id: 'owned-icons',
      dir: '/owned-icons',
      trust: 'imported',
      schemaVersion: 1,
      generatedAt: '2026-10-08',
      packages: [packageEntry('available-icon-skill', { icon: { key } })]
    },
    registryDir: '/owned-icons'
  })
  assert.equal(catalog.match(/data-phi-resource-icon-key="owned-skill-icon"/g)?.length, 1)
  assert.equal(catalog.match(/<img[^>]*src="data:image\/png;base64,iVBORw0KGgo="/g)?.length, 1)
})

test('skill sidebar uses effective enablement and keeps core switches locked', () => {
  const markup = themed(
    createElement(SkillSidebar, {
      skills: [
        skill(),
        skill({
          id: '/bundled/scanpy/SKILL.md',
          name: 'scanpy',
          core: false,
          enabled: true,
          globalEnabled: false,
          projectOverride: true
        })
      ],
      isLoading: false,
      activeSkillId: null,
      onSelectSkill: () => undefined,
      onSetEnabled: async () => undefined
    })
  )

  assert.match(markup, /aria-label="打开 scanpy，已启用"/)
  assert.match(markup, /role="switch"[^>]*aria-label="关闭 scanpy"[^>]*aria-checked="true"/)
  assert.match(
    markup,
    /role="switch"[^>]*disabled=""[^>]*aria-label="核心技能由 Phi 依赖，不可关闭"/
  )
  assert.equal(markup.match(/data-phi-catalog-status="enabled"/g)?.length, 2)
})

test('skill sidebar has no selected row after its detail tab closes', () => {
  const markup = themed(
    createElement(SkillSidebar, {
      skills,
      isLoading: false,
      activeSkillId: null,
      onSelectSkill: () => undefined
    })
  )
  assert.equal(markup.match(/class="[^"]*Mui-selected[^"]*"/g)?.length ?? 0, 0)
})

test('skill sidebar keeps group headers fixed while expanded group content scrolls', () => {
  const markup = renderSkillSidebar()

  assert.match(markup, /overflow:hidden/)
  assert.match(markup, /overflow-y:auto/)
})

test('core skills render a locked state instead of enablement controls', () => {
  const markup = renderSkillView()

  assert.match(markup, /核心技能已锁定/)
  assert.doesNotMatch(markup, /aria-label="全局启用技能"/)
})

test('ordinary skills expose global enablement and project override controls', () => {
  const ordinary = skill({
    id: '/bundled/scanpy/SKILL.md',
    name: 'scanpy',
    filePath: '/bundled/scanpy/SKILL.md',
    core: false,
    enabled: false,
    globalEnabled: false,
    disabled: true
  })
  const markup = themed(
    createElement(SkillDetail, {
      selectedSkill: ordinary,
      projectCwd: '/project',
      onSetGlobalEnabled: () => undefined,
      onSetProjectOverride: () => undefined
    })
  )

  assert.match(markup, /aria-label="全局启用技能"/)
  assert.match(markup, /当前项目/)
  assert.match(markup, /跟随全局/)
})

test('plugin skills navigate to their plugin instead of exposing a toggle', () => {
  const pluginSkill = skill({
    id: '/plugins/visualization/skills/viz/SKILL.md',
    name: 'viz',
    filePath: '/plugins/visualization/skills/viz/SKILL.md',
    source: 'visualization',
    sourceId: 'visualization',
    sourceCategory: 'plugin',
    sourceCategoryLabel: '插件',
    core: false
  })
  const markup = themed(
    createElement(SkillDetail, {
      selectedSkill: pluginSkill,
      onNavigateToPlugin: () => undefined,
      onSetGlobalEnabled: () => undefined
    })
  )

  assert.match(markup, /插件: visualization/)
  assert.match(markup, /前往插件/)
  assert.doesNotMatch(markup, /aria-label="全局启用技能"/)
})

test('skill markdown body hides YAML front matter', () => {
  const markdown = `---
name: proteintalks
description: Internal metadata
---
# ProteinTalks

正文内容`

  assert.equal(skillMarkdownBody(markdown), '# ProteinTalks\n\n正文内容')
})

test('skill catalog renders ten package rows per page with navigation instead of accumulating rows', () => {
  const markup = renderSkillCatalog({
    registry: {
      id: 'phi-packages',
      dir: '/cache/generation',
      kind: 'official',
      label: 'Phi Packages',
      trust: 'official',
      schemaVersion: 1,
      generatedAt: '2026-10-08',
      packages: Array.from({ length: 12 }, (_, index) => packageEntry(`catalog-${index}`))
    }
  })
  assert.match(markup, /aria-label="技能目录分组"/)
  assert.match(markup, /全部技能/)
  assert.doesNotMatch(markup, /内置技能/)
  assert.match(markup, /aria-label="搜索技能名称或说明"/)
  assert.equal(markup.match(/data-phi-skill-catalog-card=/g)?.length, 10)
  assert.doesNotMatch(markup, /加载更多/)
  assert.match(markup, /aria-label="目录分页"/)
  assert.match(markup, /1–10 \/ 12/)
  assert.match(markup, /每页/)
  assert.match(markup, /aria-label="下一页"/)
  assert.match(markup, /aria-label="上一页"/)
  assert.match(markup, /<table[^>]*aria-label="技能目录结果"/)
  assert.equal(markup.match(/<tr[^>]*data-phi-skill-catalog-card=/g)?.length, 10)
  assert.match(markup, />来源</)
  assert.match(markup, /版本 \/ 大小/)
  assert.doesNotMatch(markup, />状态</)
  assert.match(markup, />操作</)
  assert.equal(markup.match(/>Phi Packages</g)?.length, 10)
})

test('skill catalog preserves official packages sharing bundled names and installed status', () => {
  const markup = renderSkillCatalog({
    skills: [
      skill({ name: 'shadowed', core: true }),
      skill({ name: 'installed', sourceId: 'installed', sourceCategory: 'installed-package' })
    ],
    registry: {
      id: 'explicit',
      dir: '/explicit',
      trust: 'imported',
      schemaVersion: 1,
      generatedAt: '2026-10-07',
      packages: [
        packageEntry('shadowed', { category: '成像' }),
        packageEntry('installed', { category: '成像' }),
        packageEntry('available'),
        packageEntry('wrapper-only', { type: 'wrapper' })
      ]
    },
    registryDir: '/explicit'
  })

  assert.match(markup, /成像/)
  assert.match(markup, /软件包/)
  assert.match(markup, /添加/)
  assert.match(markup, /已安装/)
  assert.equal(markup.match(/>已安装</g)?.length, 1)
  assert.match(markup, /软件包/)
  assert.match(markup, /v1\.0\.0 · 1 KB/)
  assert.doesNotMatch(markup, /未安装/)
  assert.equal(markup.match(/data-phi-skill-catalog-card=/g)?.length, 3)
  assert.match(markup, /data-phi-skill-catalog-card="available"/)
  assert.match(markup, /data-phi-skill-catalog-card="shadowed"/)
  assert.doesNotMatch(markup, /data-phi-skill-catalog-card="wrapper-only"/)
  assert.doesNotMatch(markup, /加载更多/)
})

test('skill catalog keeps loading and registry errors visible within the browser', () => {
  const markup = renderSkillCatalog({
    isSkillsLoading: true,
    isRegistryLoading: true,
    registryError: 'Directory unavailable',
    registry: {
      id: 'stale',
      dir: '/stale',
      trust: 'imported',
      schemaVersion: 1,
      generatedAt: '2026-10-07',
      packages: [packageEntry('stale-package')]
    }
  })

  assert.match(markup, /正在读取已安装技能/)
  assert.match(markup, /正在读取 Phi Packages 和本地目录/)
  assert.match(markup, /Directory unavailable/)
  assert.doesNotMatch(markup, /data-phi-skill-catalog-card="stale-package"/)
  assert.doesNotMatch(markup, /没有匹配的技能/)
})

test('bundled domain skills cannot become catalog enable actions', () => {
  const markup = renderSkillCatalog({
    skills: [
      skill({
        id: '/resources/scanpy/SKILL.md',
        name: 'scanpy',
        core: false,
        enabled: true,
        globalEnabled: false
      })
    ],
    registry: {
      id: 'phi-packages',
      dir: '/cache/generation',
      kind: 'official',
      label: 'Phi Packages',
      trust: 'official',
      schemaVersion: 1,
      generatedAt: '2026-10-08',
      packages: [packageEntry('scanpy')]
    }
  })
  assert.match(markup, /data-phi-skill-catalog-card="scanpy"/)
  assert.doesNotMatch(markup, /data-phi-skill-catalog-card="\/resources\/scanpy/)
  assert.match(markup, />安装<\/button>/)
  assert.doesNotMatch(markup, />启用<\/button>/)
})

test('skill catalog offers the newest explicit package version with a stable row key', () => {
  let rowKeys: Array<string | null> = []
  const markup = renderSkillCatalog(
    {
      skills: [
        skill({
          id: 'shared',
          name: 'bundled-fixture',
          core: false,
          enabled: false,
          globalEnabled: false
        })
      ],
      registry: {
        id: 'versions',
        dir: '/versions',
        trust: 'imported',
        schemaVersion: 1,
        generatedAt: '2026-10-07',
        packages: [
          packageEntry('shared', { version: '1.0.0', summary: 'First version' }),
          packageEntry('shared', { version: '2.0.0', summary: 'Second version' })
        ]
      },
      registryDir: '/versions'
    },
    (keys) => {
      rowKeys = keys
    }
  )

  assert.deepEqual(rowKeys, ['package:shared@2.0.0'])
  assert.equal(new Set(rowKeys).size, 1)
  assert.equal(markup.match(/<tr[^>]*data-phi-skill-catalog-card="shared"/g)?.length, 1)
  assert.doesNotMatch(markup, /v1\.0\.0/)
  assert.match(markup, /v2\.0\.0/)
  assert.doesNotMatch(markup, /First version/)
  assert.match(markup, /Second version/)
})
