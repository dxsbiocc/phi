import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import MarkdownContent from '../src/renderer/src/components/MarkdownContent'
import { ChatUserMessage } from '../src/renderer/src/components/chat/ChatUserMessage'
import { ResourceMentionsProvider } from '../src/renderer/src/components/ResourceMention'
import type { ChatResourceMention } from '../src/renderer/src/lib/chatResourceMentions'

const resources: ChatResourceMention[] = [
  { kind: 'skill', id: 'skill-1', name: 'grill-me' },
  { kind: 'skill', id: 'skill-2', name: 'grilling' },
  { kind: 'wrapper', id: 'salmon', name: 'Salmon', aliases: ['salmon'] },
  { kind: 'plugin', id: 'office', name: 'Office' },
  { kind: 'mcp', id: 'serena', name: 'Serena', aliases: ['serena'] }
]

function render(text: string, user = false, catalog = resources): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(
        ResourceMentionsProvider,
        { resources: catalog },
        user
          ? createElement(ChatUserMessage, {
              message: { id: 'user-1', role: 'user', content: text }
            })
          : createElement(MarkdownContent, { text })
      )
    )
  )
}

test('a sent skill reference renders as icon and name in the user bubble', () => {
  const markup = render('$grill-me\n怎么开发一个 ios app', true)
  assert.match(markup, /data-phi-resource-mention="skill"/)
  assert.match(markup, /data-phi-resource-icon="skill"/)
  assert.match(markup, /grill-me/)
  assert.match(markup, /怎么开发一个 ios app/)
  assert.doesNotMatch(markup, />\$grill-me/)
})

test('a sent same-name skill from multiple sources renders one clickable icon component', () => {
  const first: ChatResourceMention = {
    kind: 'skill',
    id: '/agents/skills/grill-me/SKILL.md',
    name: 'grill-me',
    icon: { key: 'first-grill' },
    onOpen: () => undefined
  }
  const catalog = [
    first,
    { ...first, id: '/codex/skills/grill-me/SKILL.md', icon: { key: 'second-grill' } }
  ]
  const markup = render('$grill-me\n怎么开发一个 ios app', true, catalog)
  assert.equal((markup.match(/data-phi-resource-mention="skill"/g) ?? []).length, 1)
  assert.match(markup, /<button[^>]*data-phi-resource-mention="skill"/)
  assert.match(markup, /data-phi-resource-icon-key="first-grill"/)
  assert.match(markup, /怎么开发一个 ios app/)
  assert.doesNotMatch(markup, />\$grill-me/)
})

test('assistant prose, emphasis, inline names and resource links use the same resource components', () => {
  const markup = render(
    '已接入 grill-me 和 **grilling**，使用 `salmon`、Office 和 [Serena](connector://serena)。'
  )
  assert.equal((markup.match(/data-phi-resource-mention="skill"/g) ?? []).length, 2)
  for (const kind of ['wrapper', 'plugin', 'mcp']) {
    assert.match(markup, new RegExp(`data-phi-resource-mention="${kind}"`))
    assert.match(markup, new RegExp(`data-phi-resource-icon="${kind}"`))
  }
})

test('code samples, unknown names and external links retain their original meaning', () => {
  const assistant = render(
    '```sh\necho "$grill-me"\n```\n\n[grill-me](https://example.com/grill-me) $HOME $unknown grill-me-guide.md'
  )
  assert.doesNotMatch(assistant, /data-phi-resource-mention=/)
  assert.match(assistant, /href="https:\/\/example.com\/grill-me"/)
  const user = render('示例：\n```sh\necho "$grill-me"\n```\n`grill-me`', true)
  assert.doesNotMatch(user, /data-phi-resource-mention=/)
})

test('ordinary conversation rendering stays plain without a matching catalog', () => {
  assert.doesNotMatch(render('$grill-me 和 Office', false, []), /data-phi-resource-mention=/)
})

test('known resource file identities still render as ordinary local paths', () => {
  const markup = render('请读取 /skills/grill-me/SKILL.md', false, [
    { kind: 'skill', id: '/skills/grill-me/SKILL.md', name: 'grill-me' }
  ])
  assert.doesNotMatch(markup, /data-phi-resource-mention=/)
  assert.match(markup, /SKILL\.md/)
})

test('sent and assistant agent invocations share an interactive icon and name component', () => {
  const agent: ChatResourceMention = {
    kind: 'agent',
    id: '/agents/Reviewer.md',
    name: 'Reviewer',
    icon: { key: 'reviewer-icon' },
    onOpen: () => undefined
  }
  for (const reference of ['/agent:Reviewer', '/prompts:Reviewer', '调用智能体：Reviewer']) {
    const markup = render(`${reference}\n请检查文件`, true, [agent])
    assert.match(markup, /<button[^>]*data-phi-resource-mention="agent"/)
    assert.match(markup, /data-phi-resource-icon="agent"/)
    assert.match(markup, /data-phi-resource-icon-key="reviewer-icon"/)
    assert.match(markup, /请检查文件/)
  }
  const linked = render(`[审查](agent://${encodeURIComponent(agent.id)})`, false, [agent])
  assert.match(linked, /<button[^>]*data-phi-resource-mention="agent"/)
  const code = render('```sh\n/agent:Reviewer\n```\n\n`/prompts:Reviewer`', true, [agent])
  assert.doesNotMatch(code, /data-phi-resource-mention=/)
})
