import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createChatResourceMatcher,
  type ChatResourceMention
} from '../src/renderer/src/lib/chatResourceMentions'

const grill: ChatResourceMention = { kind: 'skill', id: 'skill-grill', name: 'grill-me' }
const grilling: ChatResourceMention = { kind: 'skill', id: 'grilling', name: 'grilling' }
const wrapper: ChatResourceMention = {
  kind: 'wrapper',
  id: 'rnaseq',
  name: 'RNA-seq workflow',
  aliases: ['RNA-seq']
}
const plugin: ChatResourceMention = { kind: 'plugin', id: 'notebook', name: 'Jupyter' }
const connector: ChatResourceMention = {
  kind: 'mcp',
  id: 'brave-search',
  name: 'Brave Search',
  aliases: ['Brave']
}
const matcher = createChatResourceMatcher([grill, grilling, wrapper, plugin, connector])

function mentions(text: string, catalog = matcher): string[] {
  return catalog
    .tokenize(text)
    .flatMap((token) =>
      token.kind === 'resource' ? [`${token.resource.kind}:${token.resource.id}:${token.text}`] : []
    )
}

test('typed skill invocations and ordinary resource names retain surrounding text', () => {
  const input = '$grill-me\n怎么开发一个 ios app'
  assert.deepEqual(matcher.tokenize(input), [
    { kind: 'resource', text: '$grill-me', resource: grill },
    { kind: 'text', text: '\n怎么开发一个 ios app' }
  ])
  assert.deepEqual(mentions('已接入（grill-me、grilling），使用 RNA-seq 和 Jupyter。'), [
    'skill:skill-grill:grill-me',
    'skill:grilling:grilling',
    'wrapper:rnaseq:RNA-seq',
    'plugin:notebook:Jupyter'
  ])
})

test('names, ids and aliases resolve known resources case insensitively', () => {
  for (const text of ['skill-grill', 'grill-me', '$grill-me', 'skill:grill-me']) {
    assert.equal(matcher.resolveExact(text), grill)
  }
  assert.equal(matcher.resolveExact('wrapper:rnaseq'), wrapper)
  assert.equal(matcher.resolveExact('plugin:JUPYTER'), plugin)
  assert.equal(matcher.resolveExact('connector:Brave'), connector)
  assert.equal(matcher.resolveExact('mcp:brave-search'), connector)
  assert.equal(matcher.resolveExact('unknown'), undefined)
  assert.equal(matcher.resolveExact('$HOME'), undefined)
  assert.equal(matcher.resolveExact('$Jupyter'), undefined)
})

test('longest catalog name wins over a shorter alias', () => {
  assert.deepEqual(mentions('Brave Search, Brave; RNA-seq workflow.'), [
    'mcp:brave-search:Brave Search',
    'mcp:brave-search:Brave',
    'wrapper:rnaseq:RNA-seq workflow'
  ])
})

test('Latin resource references can touch Han prose without matching identifier substrings', () => {
  assert.deepEqual(mentions('使用grill-me技能，$grill-me怎么开发，接入Jupyter。'), [
    'skill:skill-grill:grill-me',
    'skill:skill-grill:$grill-me',
    'plugin:notebook:Jupyter'
  ])
  assert.deepEqual(mentions('使用mygrill-me技能，$grill-me_suffix怎么开发'), [])
  const chinese = createChatResourceMatcher([{ kind: 'skill', id: 'analysis', name: '分析' }])
  assert.deepEqual(mentions('请分析数据', chinese), [])
  assert.deepEqual(mentions('使用（分析）。', chinese), ['skill:analysis:分析'])
})

test('ambiguous bare references stay plain while explicit kinds disambiguate', () => {
  const sharedSkill: ChatResourceMention = { kind: 'skill', id: 'skill-shared', name: 'shared' }
  const sharedPlugin: ChatResourceMention = { kind: 'plugin', id: 'plugin-shared', name: 'shared' }
  const ambiguous = createChatResourceMatcher([sharedSkill, sharedPlugin])
  assert.equal(ambiguous.resolveExact('shared'), undefined)
  assert.equal(ambiguous.resolveExact('$shared'), sharedSkill)
  assert.equal(ambiguous.resolveExact('skill:shared'), sharedSkill)
  assert.equal(ambiguous.resolveExact('plugin:shared'), sharedPlugin)
  assert.deepEqual(mentions('shared $shared plugin:shared wrapper:shared', ambiguous), [
    'skill:skill-shared:$shared',
    'plugin:plugin-shared:plugin:shared'
  ])
})

test('duplicate catalog entries do not make the same resource ambiguous', () => {
  const duplicated = createChatResourceMatcher([grill, { ...grill, aliases: ['grill-me'] }])
  assert.equal(duplicated.resolveExact('grill-me'), grill)
  assert.deepEqual(mentions('grill-me', duplicated), ['skill:skill-grill:grill-me'])
})

test('same-name skills from different paths resolve one invocation while retaining exact identities', () => {
  const first: ChatResourceMention = {
    ...grill,
    id: '/agents/skills/grill-me/SKILL.md',
    icon: { key: 'first' },
    onOpen: () => undefined
  }
  const second: ChatResourceMention = {
    ...first,
    id: '/codex/skills/grill-me/SKILL.md',
    icon: { key: 'second' },
    onOpen: () => undefined
  }
  const catalog = createChatResourceMatcher([first, second])
  for (const text of ['$grill-me', 'grill-me', 'skill:grill-me']) {
    assert.equal(catalog.resolveExact(text), first, text)
  }
  assert.equal(catalog.resolveHref('skill://grill-me'), first)
  assert.equal(catalog.resolveHref(`skill://${encodeURIComponent(first.id)}`), first)
  assert.equal(catalog.resolveHref(`skill://${encodeURIComponent(second.id)}`), second)
  assert.deepEqual(mentions('$grill-me\n怎么开发一个 ios app', catalog), [
    `skill:${first.id}:$grill-me`
  ])
})

test('different skill names sharing an alias remain ambiguous', () => {
  const catalog = createChatResourceMatcher([
    { ...grill, aliases: ['review'] },
    { ...grilling, aliases: ['review'] }
  ])
  assert.equal(catalog.resolveExact('$review'), undefined)
  assert.equal(catalog.resolveExact('skill:review'), undefined)
  assert.equal(catalog.resolveExact('review'), undefined)
})

test('substrings, filenames, paths, shell variables and external URLs stay plain', () => {
  const values = [
    'my-grill-me grill-me-extra grill-mes grilling2 pregrilling',
    'grill-me.md grilling.json Jupyter.ipynb',
    '/skills/grill-me ./grill-me ../grilling grill-me/SKILL.md C:\\skills\\grilling',
    '$HOME $UNKNOWN ${grill-me} $Jupyter $grill-me_suffix',
    'https://example.com/grill-me?skill=grilling https://grill-me.example.com',
    'www.example.com/Brave Search https://example.com?q=Brave',
    'wrapper:grill-me plugin:grilling unknown:grill-me person@Jupyter.example',
    'égrill-me grill-meé'
  ]
  for (const value of values) assert.deepEqual(mentions(value), [], value)
})

test('known root resource links resolve safely and preserve the resource kind', () => {
  assert.equal(matcher.resolveHref('skill://grill-me'), grill)
  assert.equal(matcher.resolveHref('skill://skill-grill/'), grill)
  assert.equal(matcher.resolveHref('wrapper://RNA-seq%20workflow'), wrapper)
  assert.equal(matcher.resolveHref('plugin://notebook'), plugin)
  assert.equal(matcher.resolveHref('connector://brave-search'), connector)
  assert.equal(matcher.resolveHref('mcp://Brave%20Search'), connector)
  assert.equal(matcher.resolveHref('MCP://brave-search'), connector)
  for (const href of [
    undefined,
    'skill://missing',
    'skill://grill-me/SKILL.md',
    'skill://grill-me?query=1',
    'skill://grill-me#section',
    'skill://grill-me%3Fquery',
    'skill://grill-me%2FSKILL.md',
    'skill://grill-me%00',
    'skill://%ZZ',
    'plugin://grill-me',
    'https://example.com/grill-me',
    'file:///skills/grill-me',
    ' skill://grill-me'
  ]) {
    assert.equal(matcher.resolveHref(href), undefined, href)
  }
})

test('percent-encoded catalog ids may contain slashes without resolving resource subpaths', () => {
  const pathSkill: ChatResourceMention = {
    kind: 'skill',
    id: '/skills/grill-me/SKILL.md',
    name: 'grill-me'
  }
  const namespacedWrapper: ChatResourceMention = {
    kind: 'wrapper',
    id: 'nf-core/modules/salmon',
    name: 'Salmon'
  }
  const catalog = createChatResourceMatcher([pathSkill, namespacedWrapper])
  assert.equal(catalog.resolveHref(`skill://${encodeURIComponent(pathSkill.id)}`), pathSkill)
  assert.equal(
    catalog.resolveHref(`wrapper://${encodeURIComponent(namespacedWrapper.id)}`),
    namespacedWrapper
  )
  for (const href of [
    'skill:///skills/grill-me/SKILL.md',
    'skill://grill-me/SKILL.md',
    'skill://grill-me%2FSKILL.md',
    'skill://%2Fskills%2Fmissing%2FSKILL.md',
    'wrapper://nf-core/modules/salmon',
    'wrapper://nf-core%2Fmodules%2Fsalmon/README.md',
    'wrapper://nf-core%2Fmodules%2Fsalmon?query=1',
    'wrapper://nf-core%2Fmodules%2Fsalmon%23section'
  ]) {
    assert.equal(catalog.resolveHref(href), undefined, href)
  }
})

test('filesystem identifiers resolve explicitly without consuming ordinary file references', () => {
  const pathSkill: ChatResourceMention = {
    kind: 'skill',
    id: '/skills/grill-me/SKILL.md',
    name: 'grill-me',
    aliases: ['C:\\skills\\grill-me\\SKILL.md', './skills/grill-me/SKILL.md']
  }
  const namespacedWrapper: ChatResourceMention = {
    kind: 'wrapper',
    id: 'nf-core/rnaseq',
    name: 'RNA-seq'
  }
  const catalog = createChatResourceMatcher([pathSkill, namespacedWrapper])
  const input = '读取 /skills/grill-me/SKILL.md'
  assert.deepEqual(catalog.tokenize(input), [{ kind: 'text', text: input }])
  assert.deepEqual(
    mentions('C:\\skills\\grill-me\\SKILL.md ./skills/grill-me/SKILL.md', catalog),
    []
  )
  assert.deepEqual(mentions('$/skills/grill-me/SKILL.md $./skills/grill-me/SKILL.md', catalog), [])
  assert.equal(catalog.resolveExact(pathSkill.id), pathSkill)
  assert.equal(catalog.resolveExact(`skill:${pathSkill.id}`), pathSkill)
  assert.equal(catalog.resolveExact(`$${pathSkill.id}`), undefined)
  assert.equal(catalog.resolveHref(`skill://${encodeURIComponent(pathSkill.id)}`), pathSkill)
  assert.equal(
    catalog.resolveHref(`skill://${encodeURIComponent('C:\\skills\\grill-me\\SKILL.md')}`),
    pathSkill
  )
  assert.deepEqual(mentions('skill:/skills/grill-me/SKILL.md nf-core/rnaseq', catalog), [
    'skill:/skills/grill-me/SKILL.md:skill:/skills/grill-me/SKILL.md',
    'wrapper:nf-core/rnaseq:nf-core/rnaseq'
  ])
})

test('tokenization treats resource root URIs as a whole and rejects invalid link prefixes', () => {
  const input = '使用 skill://grill-me，connector://brave-search。'
  assert.deepEqual(mentions(input), [
    'skill:skill-grill:skill://grill-me',
    'mcp:brave-search:connector://brave-search'
  ])
  assert.deepEqual(mentions('skill://grill-me?bad=1 skill://grill-me/SKILL.md'), [])
})

test('empty catalogs and repeated matching preserve plain text and source characters', () => {
  assert.deepEqual(createChatResourceMatcher([]).tokenize('hello $grill-me'), [
    { kind: 'text', text: 'hello $grill-me' }
  ])
  assert.deepEqual(matcher.tokenize(''), [])
  const input = 'grill-me, $grilling. Brave Search\nJupyter!'
  for (let run = 0; run < 3; run++) {
    const tokens = matcher.tokenize(input)
    assert.equal(tokens.map((token) => token.text).join(''), input)
    assert.equal(tokens.filter((token) => token.kind === 'resource').length, 4)
  }
})

test('agent invocations and encoded root links resolve to the agent without consuming paths', () => {
  const agent: ChatResourceMention = {
    kind: 'agent',
    id: '/agents/Reviewer.md',
    name: 'Reviewer'
  }
  const catalog = createChatResourceMatcher([agent])
  for (const reference of ['/agent:Reviewer', '/prompts:Reviewer', '调用智能体：Reviewer']) {
    assert.equal(catalog.resolveExact(reference), agent)
    assert.deepEqual(mentions(`${reference}\n请检查`, catalog), [`agent:${agent.id}:${reference}`])
  }
  assert.equal(catalog.resolveExact('agent:Reviewer'), agent)
  assert.equal(catalog.resolveHref(`agent://${encodeURIComponent(agent.id)}`), agent)
  assert.deepEqual(mentions('调用智能体：Reviewer检查这些文件。', catalog), [
    `agent:${agent.id}:调用智能体：Reviewer`
  ])
  for (const text of [
    '/agents/Reviewer.md',
    '/tmp/agent:Reviewer',
    './prompts:Reviewer',
    '/agent:Reviewer.md',
    '/agent:Reviewer/path',
    'https://example.com/agent:Reviewer',
    'agent://Reviewer?execute=1',
    'agent://Reviewer/instructions',
    '/agent:Unknown'
  ]) {
    assert.deepEqual(mentions(text, catalog), [], text)
  }
})

test('agent name-only invocations prefer an available source while exact IDs preserve metadata', () => {
  const pending: ChatResourceMention = {
    kind: 'agent',
    id: 'server:Reviewer',
    name: 'Reviewer',
    available: false
  }
  const local: ChatResourceMention = {
    ...pending,
    id: '/agents/Reviewer.md',
    available: true
  }
  const catalog = createChatResourceMatcher([pending, local])
  assert.equal(catalog.resolveExact('/agent:Reviewer'), local)
  assert.equal(catalog.resolveExact('/prompts:Reviewer'), local)
  assert.equal(catalog.resolveExact('调用智能体：Reviewer'), local)
  assert.equal(catalog.resolveHref('agent://server%3AReviewer'), pending)
  const ambiguous = createChatResourceMatcher([
    { ...local, aliases: ['shared'] },
    { ...local, id: '/agents/Writer.md', name: 'Writer', aliases: ['shared'] }
  ])
  assert.equal(ambiguous.resolveExact('/agent:shared'), undefined)
})
