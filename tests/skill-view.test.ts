import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import SkillView, { SkillDetail, SkillSidebar } from '../src/renderer/src/features/skill/SkillView'
import { skillMarkdownBody } from '../src/renderer/src/features/skill/lib/skillMarkdown'
import type { SkillSummary } from '../src/renderer/src/types'

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
