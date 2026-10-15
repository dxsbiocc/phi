import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  findInlineComposerReferences,
  inlineReferenceInsertion
} from '../src/renderer/src/features/chat/lib/composerReferences'
import { ComposerReferenceChip } from '../src/renderer/src/features/chat/components/ComposerReferenceChip'
import type { ChatResourceMention } from '../src/renderer/src/lib/chatResourceMentions'

const resources: ChatResourceMention[] = [
  { kind: 'skill', id: '/skills/scanpy/SKILL.md', name: 'scanpy', icon: { key: 'skill-icon' } },
  {
    kind: 'agent',
    id: '/agents/Reviewer.md',
    name: 'Reviewer',
    icon: { key: 'agent-icon' },
    onOpen: () => undefined
  },
  { kind: 'wrapper', id: 'nf-core/rnaseq', name: 'RNA-seq', icon: { key: 'wrapper-icon' } },
  {
    kind: 'mcp',
    id: 'pubmed',
    name: 'PubMed',
    aliases: ['pubmed-server'],
    icon: { key: 'mcp-icon' }
  },
  { kind: 'plugin', id: 'office', name: 'Office', icon: { key: 'plugin-icon' } }
]

test('all reference kinds retain their inline positions and complete source ranges', () => {
  const source =
    '请用 $scanpy 分析，交给 /agent:Reviewer 审阅，再用 wrapper://nf-core%2Frnaseq、connector:pubmed-server 和 plugin://office。参考 [文献](https://example.com/paper(1))。'
  const references = findInlineComposerReferences(source, resources)
  assert.deepEqual(
    references.map((reference) => reference.kind),
    ['skill', 'agent', 'wrapper', 'mcp', 'plugin', 'web']
  )
  for (const reference of references)
    assert.equal(source.slice(reference.from, reference.to), reference.text)
  assert.equal(references[0].from, source.indexOf('$scanpy'))
  assert.equal(references[2].id, 'nf-core/rnaseq')
  assert.equal(references[5].name, '文献')
  assert.equal(references[5].url, 'https://example.com/paper(1)')
})

test('ordinary names, paths and unknown references stay ordinary editor text', () => {
  const source = 'scanpy Reviewer Office /skills/scanpy/SKILL.md $unknown wrapper://unknown $HOME'
  assert.deepEqual(findInlineComposerReferences(source, resources), [])
})

test('fenced, indented, multiline and unfinished inline code never becomes reference widgets', () => {
  const samples = [
    '```text\n$scanpy\nhttps://example.com/code\n```',
    '~~~text\n/agent:Reviewer\n~~~~',
    '`\nplugin://office\nhttps://example.com/code\n`',
    '``\n$scanpy\n`\n/agent:Reviewer\n``',
    '`\n$scanpy\n',
    '    wrapper://nf-core%2Frnaseq'
  ]
  for (const source of samples)
    assert.deepEqual(findInlineComposerReferences(source, resources), [], source)
  const afterFence = '```text\n$scanpy\n````\n$scanpy'
  assert.equal(findInlineComposerReferences(afterFence, resources).length, 1)
})

test('web URLs support inline prose, uppercase schemes, balanced parentheses and Markdown titles', () => {
  const opened: string[] = []
  const references = findInlineComposerReferences(
    '阅读 HTTPS://example.com/a(1)，以及 [资料](https://example.org/b)。',
    resources,
    (url) => opened.push(url)
  )
  assert.equal(references.length, 2)
  assert.equal(references[0].url, 'HTTPS://example.com/a(1)')
  assert.equal(references[1].name, '资料')
  references[0].onOpen?.()
  assert.deepEqual(opened, ['HTTPS://example.com/a(1)'])
})

test('resource Markdown links become one widget and exact IDs preserve distinct same-name resources', () => {
  const catalog = [...resources, { ...resources[2], id: 'other/rnaseq' }]
  const references = findInlineComposerReferences(
    '[Office](plugin://office) wrapper://other%2Frnaseq',
    catalog
  )
  assert.equal(references.length, 2)
  assert.equal(references[0].text, '[Office](plugin://office)')
  assert.equal(references[1].id, 'other/rnaseq')
})

test('caret insertion replaces only the selection and leaves source text in order', () => {
  const source = '前文待替换后文'
  const insertion = inlineReferenceInsertion(source, 2, 5, '$scanpy')
  assert.equal(
    source.slice(0, insertion.from) + insertion.insert + source.slice(insertion.to),
    '前文 $scanpy 后文'
  )
  assert.equal(insertion.cursor, 11)
  const spaced = inlineReferenceInsertion('前文 后文', 3, 3, '/agent:Reviewer')
  assert.equal(spaced.insert, '/agent:Reviewer ')
})

test('inline chips reuse artwork and expose independent detail and removal actions', () => {
  const reference = findInlineComposerReferences('/agent:Reviewer', resources)[0]
  const markup = renderToStaticMarkup(
    createElement(ComposerReferenceChip, { reference, onRemove: () => undefined })
  )
  assert.match(markup, /data-phi-resource-icon-key="agent-icon"/)
  assert.match(markup, /aria-label="查看智能体 Reviewer"/)
  assert.match(markup, /aria-label="移除智能体引用 Reviewer"/)
  assert.doesNotMatch(markup, /composer-reference-chips/)
})
