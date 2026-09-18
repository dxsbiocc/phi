import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import SkillView, { SkillSidebar } from '../src/renderer/src/features/skill/SkillView'
import { skillMarkdownBody } from '../src/renderer/src/features/skill/lib/skillMarkdown'
import type { SkillSummary } from '../src/renderer/src/types'

const skills: SkillSummary[] = [
  {
    id: '/system/SKILL.md',
    name: 'system-skill',
    description: 'Built in fixture',
    filePath: '/system/SKILL.md',
    source: 'system',
    scope: 'user',
    sourceCategory: 'system',
    sourceCategoryLabel: 'System',
    disabled: false
  },
  {
    id: '/agents/SKILL.md',
    name: 'agent-skill',
    description: 'Generated fixture',
    filePath: '/agents/SKILL.md',
    source: 'agents:user',
    scope: 'user',
    sourceCategory: 'generated',
    sourceCategoryLabel: 'Agent',
    disabled: false
  }
]

function renderSkillView(skillList: SkillSummary[] = skills): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(SkillView, {
        skills: skillList,
        isLoading: false,
        activeSkillId: skillList[0]?.id ?? null,
        sidebarWidth: 320,
        onSelectSkill: () => undefined,
        onStartSidebarResize: () => undefined
      })
    )
  )
}

function renderSkillSidebar(skillList: SkillSummary[] = skills): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(SkillSidebar, {
        skills: skillList,
        isLoading: false,
        activeSkillId: skillList[0]?.id ?? null,
        sidebarWidth: 320,
        onSelectSkill: () => undefined
      })
    )
  )
}

test('skill view groups skills by source category and exposes the skill markdown panel', () => {
  const markup = renderSkillView()

  assert.match(markup, /System/)
  assert.match(markup, /内置/)
  assert.match(markup, /Agent/)
  assert.match(markup, /SKILL\.md/)
  assert.match(markup, /需要重启 Phi/)
  assert.doesNotMatch(markup, /文件结构/)
  assert.doesNotMatch(markup, /System · User/)
})

test('skill view derives source category for old skill summaries', () => {
  const legacySkill = {
    id: '/Users/example/.agents/skills/proteintalks/SKILL.md',
    name: 'proteintalks',
    description: 'Generated skill fixture',
    filePath: '/Users/example/.agents/skills/proteintalks/SKILL.md',
    source: 'agents:user',
    scope: 'user',
    disabled: false
  } as SkillSummary
  const markup = renderSkillView([legacySkill])

  assert.match(markup, /Agent/)
  assert.doesNotMatch(markup, /undefined/)
})

test('skill sidebar keeps management actions out of the browsing list', () => {
  const markup = renderSkillSidebar()

  assert.match(markup, /system-skill/)
  assert.doesNotMatch(markup, /卸载技能/)
  assert.doesNotMatch(markup, /启用技能|关闭技能/)
})

test('skill sidebar keeps group headers fixed while expanded group content scrolls', () => {
  const markup = renderSkillSidebar()

  assert.match(markup, /overflow:hidden/)
  assert.match(markup, /overflow-y:auto/)
})

test('skill detail management controls keep labels in hover text only', () => {
  const markup = renderSkillView()

  assert.doesNotMatch(markup, />启用</)
  assert.doesNotMatch(markup, />关闭</)
  assert.doesNotMatch(markup, />卸载</)
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
