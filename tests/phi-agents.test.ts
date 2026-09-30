import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { discoverPhiAgents } from '../src/main/agent/agents/discovery'
import {
  AGENT_CONTRACT_VERSION,
  PhiAgentParseError,
  isPhiAgentDefinition,
  isValidPhiAgentName,
  normalizeToolName,
  parsePhiAgent,
  toPhiAgentName,
  validateAgent,
  validateAgentFile,
  type PhiAgentDefinition
} from '../src/main/agent/agents/definition'
import { selectAgentModel } from '../src/main/agent/agents/model-selection'
import { buildAgentLeaderPrompt } from '../src/main/agent/agents/leader-prompt'
import { AGENT_REPORT_PROTOCOL } from '../src/main/agent/agents/report'
import {
  AgentCancelledError,
  AgentTimeoutError,
  createAgentRunner,
  describeToolStart,
  extractAssistantText,
  type AgentSessionLike
} from '../src/main/agent/agents/runner'
import {
  buildScopedPhiToolMap,
  resolveAgentTools,
  visualizationToolNamesForWorkflow
} from '../src/main/agent/agents/tool-resolution'
import { buildAgentTool, type AgentRunner } from '../src/main/agent/agents/tool'

const REPO_AGENTS_DIR = join(import.meta.dirname, '..', 'resources', 'agents')
const REPO_SKILLS_DIR = join(import.meta.dirname, '..', 'resources', 'skills')
const REPO_VIZ_AGENT = join(
  import.meta.dirname,
  '..',
  'resources',
  'plugins',
  'visualization',
  'agents',
  'Visualization.md'
)
const REPO_VIZ_SKILL_DIR = join(
  import.meta.dirname,
  '..',
  'resources',
  'plugins',
  'visualization',
  'skills',
  'omics-visualization'
)

function agentMarkdown(fields: Record<string, string>, body = 'You are a specialist.'): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`)
  return `---\n${lines.join('\n')}\n---\n${body}\n`
}

const NATIVE_FIELDS = {
  name: 'Alpha',
  description: 'Does alpha things.',
  tools: '[read, bash]'
}

function withTree(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'phi-agents-'))
  try {
    fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function put(root: string, relative: string, content: string): void {
  const full = join(root, relative)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
}

// ── naming ────────────────────────────────────────────────────────────────

test('agent names are capitalised and never carry an Agent suffix', () => {
  for (const ok of ['Wrapper', 'CodeReviewer', 'Rna2Seq'])
    assert.equal(isValidPhiAgentName(ok), true, ok)
  for (const bad of [
    'wrapper',
    'wrapper_agent',
    'WrapperAgent',
    'Agent',
    'Wrap-per',
    '',
    '9Lives'
  ]) {
    assert.equal(isValidPhiAgentName(bad), false, bad)
  }
})

test('foreign agent names are normalised to that convention', () => {
  assert.equal(toPhiAgentName('code-reviewer'), 'CodeReviewer')
  assert.equal(toPhiAgentName('security_reviewer'), 'SecurityReviewer')
  assert.equal(toPhiAgentName('planner-agent'), 'Planner')
  assert.equal(toPhiAgentName('wrapper_agent'), 'Wrapper')
  assert.equal(toPhiAgentName('scout'), 'Scout')
  assert.equal(toPhiAgentName('reviewerAgent'), 'Reviewer')
  assert.equal(toPhiAgentName('agent'), '')
  assert.equal(toPhiAgentName('!!!'), '')
})

test('foreign tool names map onto Phi built-ins; unknown ones are dropped', () => {
  assert.equal(normalizeToolName('Read'), 'read')
  assert.equal(normalizeToolName('Bash'), 'bash')
  assert.equal(normalizeToolName('MultiEdit'), 'edit')
  assert.equal(normalizeToolName('WebSearch'), 'web_search')
  assert.equal(normalizeToolName('grep'), 'grep')
  assert.equal(normalizeToolName('WebFetch'), undefined)
  assert.equal(normalizeToolName('mcp__github__list'), undefined)
})

// ── parsing ───────────────────────────────────────────────────────────────

test('a native definition parses into a complete agent', () => {
  const agent = parsePhiAgent(
    '/x/Alpha.md',
    agentMarkdown(
      { ...NATIVE_FIELDS, skills: '[one, two]', delegation: '"Delegate alpha work."' },
      'System prompt body.'
    ),
    'phi'
  )
  assert.deepEqual(agent, {
    name: 'Alpha',
    description: 'Does alpha things.',
    tools: ['read', 'bash'],
    skills: ['one', 'two'],
    delegation: 'Delegate alpha work.',
    systemPrompt: 'System prompt body.',
    source: 'phi',
    filePath: '/x/Alpha.md',
    visibility: 'entry',
    warnings: []
  })
})

test('a native definition is rejected for a bad name, a name that differs from the file, or missing fields', () => {
  const parse = (fields: Record<string, string>, body?: string, file = '/x/Alpha.md'): unknown =>
    parsePhiAgent(file, agentMarkdown(fields, body), 'phi')

  assert.throws(() => parse({ ...NATIVE_FIELDS, name: 'alpha' }, undefined, '/x/alpha.md'), /name/i)
  assert.throws(
    () => parse({ ...NATIVE_FIELDS, name: 'AlphaAgent' }, undefined, '/x/AlphaAgent.md'),
    /Agent/
  )
  assert.throws(() => parse({ ...NATIVE_FIELDS, name: 'Beta' }), /file name/i)
  assert.throws(() => parse({ name: 'Alpha', tools: '[read]' }), /description/i)
  assert.throws(() => parse({ name: 'Alpha', description: 'd' }), /tools/i)
  assert.throws(() => parse({ ...NATIVE_FIELDS }, '   '), /prompt|body/i)
  assert.throws(() => parsePhiAgent('/x/Alpha.md', 'no frontmatter', 'phi'), /frontmatter/i)
})

test('a compat definition is normalised: name, comma-separated tools, default toolbox', () => {
  const agent = parsePhiAgent(
    '/p/.claude/agents/code-reviewer.md',
    agentMarkdown({
      name: 'code-reviewer',
      description: 'Reviews code.',
      tools: 'Read, Grep, Bash, WebFetch'
    }),
    'compat'
  )
  assert.equal(agent.name, 'CodeReviewer')
  assert.deepEqual(agent.tools, ['read', 'grep', 'bash'])
  assert.equal(agent.source, 'compat')

  const fallback = parsePhiAgent(
    '/p/.omp/agents/scout.md',
    agentMarkdown({ description: 'Scouts.' }),
    'compat'
  )
  assert.equal(fallback.name, 'Scout')
  assert.ok(fallback.tools.includes('read') && fallback.tools.includes('bash'))
})

test('isPhiAgentDefinition guards the worker boundary', () => {
  const good: PhiAgentDefinition = {
    name: 'Alpha',
    description: 'd',
    tools: ['read'],
    skills: [],
    systemPrompt: 'p',
    source: 'phi',
    filePath: '/x',
    visibility: 'entry',
    warnings: []
  }
  assert.equal(isPhiAgentDefinition(good), true)
  assert.equal(
    isPhiAgentDefinition({
      ...good,
      environment: 'phi:python@1',
      model: ['openai/gpt'],
      thinkingLevel: 'low',
      warnings: ['legacy alias']
    }),
    true
  )
  assert.equal(isPhiAgentDefinition({ ...good, tools: 'read' }), false)
  assert.equal(isPhiAgentDefinition({ ...good, name: 'alpha' }), false)
  assert.equal(isPhiAgentDefinition({ ...good, thinkingLevel: 'max' }), false)
  assert.equal(isPhiAgentDefinition({ ...good, visibility: 'internal' }), false)
  assert.equal(isPhiAgentDefinition({ ...good, model: 'openai/gpt' }), false)
  assert.equal(isPhiAgentDefinition(null), false)
})

function agentDocument(frontmatter: string, body = 'You are a specialist.'): string {
  return `---\n${frontmatter.trim()}\n---\n${body}\n`
}

const PHI_FRONTMATTER = `name: Alpha
description: Does alpha things.
tools: [read, bash]`

test('contract v1 accepts each field and rejects each broken rule', () => {
  assert.equal(AGENT_CONTRACT_VERSION, '1.0.0')

  const passing = validateAgentFile(
    '/x/Alpha.md',
    agentDocument(`
name: Alpha
description: ${'d'.repeat(1024)}
tools: [read]
skills: [one, two]
environment: phi:python@1
model:
  - openai/gpt-4
  - anthropic/claude
thinkingLevel: high
visibility: entry
delegationMode: preferred
delegation: Hand over alpha work.
fallback:
  afterFailures: 2
  tools: [bash]
  match: [ncbi]
`),
    'phi'
  )
  assert.equal(passing.ok, true, passing.errors.map((error) => error.message).join('\n'))
  assert.deepEqual(passing.warnings, [])
  assert.equal(passing.agent?.description.length, 1024)
  assert.deepEqual(passing.agent?.skills, ['one', 'two'])
  assert.equal(passing.agent?.environment, 'phi:python@1')
  assert.deepEqual(passing.agent?.model, ['openai/gpt-4', 'anthropic/claude'])
  assert.equal(passing.agent?.thinkingLevel, 'high')
  assert.equal(passing.agent?.visibility, 'entry')
  assert.equal(passing.agent?.delegationMode, 'preferred')
  assert.equal(passing.agent?.fallback?.afterFailures, 2)

  for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const) {
    const result = validateAgentFile(
      '/x/Alpha.md',
      agentDocument(`${PHI_FRONTMATTER}\nthinkingLevel: ${level}`),
      'phi'
    )
    assert.equal(result.ok, true, level)
    assert.equal(result.agent?.thinkingLevel, level)
  }
  for (const mode of ['required-first', 'preferred', 'optional'] as const) {
    const result = validateAgentFile(
      '/x/Alpha.md',
      agentDocument(`${PHI_FRONTMATTER}\ndelegationMode: ${mode}`),
      'phi'
    )
    assert.equal(result.ok, true, mode)
    assert.equal(result.agent?.delegationMode, mode)
  }
  for (const ref of ['phi:python@1', 'plugin:viz', 'project:default']) {
    const result = validateAgentFile(
      '/x/Alpha.md',
      agentDocument(`${PHI_FRONTMATTER}\nenvironment: ${ref}`),
      'phi'
    )
    assert.equal(result.ok, true, ref)
    assert.equal(result.agent?.environment, ref)
  }

  const stringModel = parsePhiAgent(
    '/x/Alpha.md',
    agentDocument(`${PHI_FRONTMATTER}\nmodel: openai/gpt-4`),
    'phi'
  )
  assert.deepEqual(stringModel.model, ['openai/gpt-4'])

  const omitted = parsePhiAgent('/x/Alpha.md', agentDocument(PHI_FRONTMATTER), 'phi')
  assert.equal(omitted.visibility, 'entry')
  assert.equal(omitted.environment, undefined)
  assert.equal(omitted.model, undefined)
  assert.equal(omitted.thinkingLevel, undefined)
  assert.deepEqual(omitted.warnings, [])

  const failures: Array<[string, RegExp]> = [
    [`name: nope\ndescription: d\ntools: [read]`, /capitalised|Agent/i],
    [`${PHI_FRONTMATTER.replace('Alpha', 'Beta')}`, /file name/i],
    [`name: Alpha\ntools: [read]`, /description/i],
    [`name: Alpha\ndescription: ${'d'.repeat(1025)}\ntools: [read]`, /1-1024/],
    [`name: Alpha\ndescription: d\ntools: []`, /tools/i],
    [`${PHI_FRONTMATTER}\nmodel: []`, /model/],
    [`${PHI_FRONTMATTER}\nmodel: 1`, /model/],
    [`${PHI_FRONTMATTER}\nthinkingLevel: max`, /thinkingLevel/],
    [`${PHI_FRONTMATTER}\nskills: 1`, /skills/],
    [`${PHI_FRONTMATTER}\nenvironment: phi:python`, /environment/],
    [`${PHI_FRONTMATTER}\nenvironment: ./environment.yml`, /environment/],
    [`${PHI_FRONTMATTER}\nvisibility: internal`, /reserved/],
    [`${PHI_FRONTMATTER}\nvisibility: hidden`, /entry/],
    [`${PHI_FRONTMATTER}\ndelegationMode: sometimes`, /delegationMode/],
    [`${PHI_FRONTMATTER}\ndelegation: 1`, /delegation/],
    [
      `${PHI_FRONTMATTER}\nfallback:\n  afterFailures: 0\n  tools: [bash]\n  match: [ncbi]`,
      /positive integer/
    ],
    [
      `${PHI_FRONTMATTER}\nfallback:\n  afterFailures: 1\n  tools: []\n  match: [ncbi]`,
      /fallback.tools/
    ],
    [`${PHI_FRONTMATTER}\nspawns: [Other]`, /reserved/],
    [`${PHI_FRONTMATTER}\noutputSchema:\n  type: object`, /reserved/]
  ]
  for (const [frontmatter, pattern] of failures) {
    const result = validateAgentFile('/x/Alpha.md', agentDocument(frontmatter), 'phi')
    assert.equal(result.ok, false, frontmatter)
    assert.equal(result.agent, undefined)
    assert.ok(
      result.errors.some((error) => pattern.test(error.message)),
      `${frontmatter}\n${result.errors.map((error) => error.message).join('\n')}`
    )
  }

  assert.throws(
    () => parsePhiAgent('/x/Alpha.md', agentDocument('name: nope\ntools: []'), 'phi'),
    (error: unknown) => {
      assert.ok(error instanceof PhiAgentParseError)
      assert.match(error.message, /name/i)
      assert.match(error.message, /description/i)
      assert.match(error.message, /tools/i)
      return true
    }
  )
})

test('legacy aliases warn and name the new spelling; unknown keys warn and are ignored', () => {
  const result = validateAgentFile(
    '/x/Alpha.md',
    agentDocument(`
name: Alpha
description: Does alpha things.
tools: [read]
delegation_mode: required-first
extra: true
fallback:
  after_failures: 1
  tools: [bash]
  match: [ncbi]
  note: leftover
`),
    'phi'
  )
  assert.equal(result.ok, true, result.errors.map((error) => error.message).join('\n'))
  assert.equal(result.agent?.delegationMode, 'required-first')
  assert.equal(result.agent?.fallback?.afterFailures, 1)
  const messages = result.warnings.map((warning) => warning.message)
  assert.ok(messages.some((message) => message.includes('delegationMode')))
  assert.ok(messages.some((message) => message.includes('afterFailures')))
  assert.ok(messages.some((message) => message.includes('extra')))
  assert.ok(messages.some((message) => message.includes('note')))
  assert.deepEqual(result.agent?.warnings, messages)
})

test('compatibility mode ignores Phi fields, including environment and spawns', () => {
  const result = validateAgentFile(
    '/p/.claude/agents/code-reviewer.md',
    agentDocument(
      `
name: code-reviewer
description: Reviews code.
tools: Read, Bash
environment: not-a-ref
spawns: [Other]
outputSchema:
  type: object
visibility: internal
delegation_mode: not-a-mode
skills: 12
fallback: nope
thinkingLevel: max
model: openai/gpt-4
`,
      'Review the diff.'
    ),
    'compat'
  )
  assert.equal(result.ok, true, result.errors.map((error) => error.message).join('\n'))
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.warnings, [])
  assert.equal(result.agent?.name, 'CodeReviewer')
  assert.deepEqual(result.agent?.tools, ['read', 'bash'])
  assert.equal(result.agent?.environment, undefined)
  assert.equal(result.agent?.delegationMode, undefined)
  assert.equal(result.agent?.visibility, 'entry')
  assert.deepEqual(result.agent?.skills, [])
  assert.equal(result.agent?.thinkingLevel, undefined)
  assert.deepEqual(result.agent?.model, ['openai/gpt-4'])
  assert.deepEqual(result.agent?.warnings, [])
})

test('discovery logs warnings without skipping the agent', () => {
  withTree((root) => {
    put(root, 'project/.phi/agents/Alpha.md', agentDocument(`${PHI_FRONTMATTER}\nextra: true`))
    put(root, 'project/.phi/agents/Bad.md', agentDocument('name: Bad\ndescription: d\ntools: []'))
    const { agents, diagnostics } = discoverPhiAgents({
      cwd: join(root, 'project'),
      agentDir: join(root, 'home', '.phi'),
      homeDir: join(root, 'home'),
      pluginAgentDirs: []
    })
    assert.deepEqual(
      agents.map((agent) => agent.name),
      ['Alpha']
    )
    assert.ok(agents[0].warnings.some((warning) => warning.includes('extra')))
    assert.ok(
      diagnostics.some(
        (diagnostic) => diagnostic.level === 'warning' && diagnostic.message.includes('extra')
      )
    )
    assert.ok(
      diagnostics.some(
        (diagnostic) => diagnostic.level === 'error' && diagnostic.filePath.endsWith('Bad.md')
      )
    )
  })
})

test('the bundled agents validate with no errors and no warnings', () => {
  const files = [
    join(REPO_AGENTS_DIR, 'Database.md'),
    join(REPO_AGENTS_DIR, 'Wrapper.md'),
    REPO_VIZ_AGENT
  ]
  for (const file of files) {
    const result = validateAgent(file)
    assert.equal(
      result.ok,
      true,
      result.errors.map((error) => `${error.path}: ${error.message}`).join('\n')
    )
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.warnings, [])
    assert.deepEqual(result.agent?.warnings, [])
    assert.equal(result.agent?.visibility, 'entry')
    assert.equal(result.agent?.delegationMode, 'required-first')
  }
})

test('selectAgentModel uses the first selector that resolves', async () => {
  const calls: string[] = []
  const parent = { provider: 'parent', id: 'p' }
  const result = await selectAgentModel(
    'Alpha',
    ['missing/a', 'found/b', 'later/c'],
    (selector) => {
      calls.push(selector)
      return selector === 'found/b' ? { provider: 'found', id: 'b' } : undefined
    },
    parent
  )
  assert.deepEqual(calls, ['missing/a', 'found/b'])
  assert.deepEqual(result, { model: { provider: 'found', id: 'b' } })
})

test('selectAgentModel keeps the parent model when no selector resolves', async () => {
  const parent = { provider: 'parent', id: 'p' }
  let called = false
  const absent = await selectAgentModel(
    'Alpha',
    undefined,
    () => {
      called = true
      return undefined
    },
    parent
  )
  assert.equal(called, false)
  assert.deepEqual(absent, { model: parent })

  const missing = await selectAgentModel(
    'Alpha',
    ['missing/a', 'missing/b'],
    () => undefined,
    parent
  )
  assert.equal(missing.model, parent)
  assert.equal(
    missing.warning,
    "Phi agent Alpha: model missing/a, missing/b not available; using the conversation's model"
  )
})

// ── discovery ─────────────────────────────────────────────────────────────

test('discovery scans the Phi roots first and never reads a legacy directory as native', () => {
  withTree((root) => {
    const cwd = join(root, 'project')
    const agentDir = join(root, 'home', '.phi')
    const bundled = join(root, 'bundled')
    put(root, 'project/.phi/agents/Alpha.md', agentMarkdown({ ...NATIVE_FIELDS }, 'project alpha'))
    put(
      root,
      'home/.phi/agents/Beta.md',
      agentMarkdown({ name: 'Beta', description: 'b', tools: '[read]' })
    )
    put(
      root,
      'bundled/Gamma.md',
      agentMarkdown({ name: 'Gamma', description: 'g', tools: '[read]' })
    )
    put(root, 'project/.phi/agents/notes.txt', 'ignored')

    const { agents, diagnostics } = discoverPhiAgents({
      cwd,
      agentDir,
      bundledDir: bundled,
      homeDir: join(root, 'home'),
      pluginAgentDirs: []
    })
    assert.deepEqual(
      agents.map((a) => [a.name, a.source]),
      [
        ['Alpha', 'phi'],
        ['Beta', 'phi'],
        ['Gamma', 'phi']
      ]
    )
    assert.deepEqual(diagnostics, [])
  })
})

test('discovery is compatible with .omp, .pi and .claude agents, project and user level', () => {
  withTree((root) => {
    const cwd = join(root, 'project')
    const home = join(root, 'home')
    put(
      root,
      'project/.omp/agents/reviewer.md',
      agentMarkdown({ name: 'reviewer', description: 'r' })
    )
    put(
      root,
      'project/.pi/agents/planner-agent.md',
      agentMarkdown({ name: 'planner-agent', description: 'p' })
    )
    put(
      root,
      'project/.claude/agents/tester.md',
      agentMarkdown({ name: 'tester', description: 't', tools: 'Read, Bash' })
    )
    put(root, 'home/.omp/agent/agents/scout.md', agentMarkdown({ name: 'scout', description: 's' }))
    put(root, 'home/.claude/agents/writer.md', agentMarkdown({ name: 'writer', description: 'w' }))

    const { agents } = discoverPhiAgents({
      cwd,
      agentDir: join(home, '.phi'),
      homeDir: home,
      pluginAgentDirs: []
    })
    assert.deepEqual(agents.map((a) => a.name).sort(), [
      'Planner',
      'Reviewer',
      'Scout',
      'Tester',
      'Writer'
    ])
    assert.ok(agents.every((a) => a.source === 'compat'))
  })
})

test('a Phi definition beats a compat one with the same name, and project beats user beats bundled', () => {
  withTree((root) => {
    const cwd = join(root, 'project')
    const home = join(root, 'home')
    put(
      root,
      'project/.omp/agents/alpha.md',
      agentMarkdown({ name: 'alpha', description: 'legacy alpha' })
    )
    put(root, 'bundled/Alpha.md', agentMarkdown({ ...NATIVE_FIELDS, description: 'bundled alpha' }))
    put(
      root,
      'home/.phi/agents/Alpha.md',
      agentMarkdown({ ...NATIVE_FIELDS, description: 'user alpha' })
    )

    let result = discoverPhiAgents({
      cwd,
      agentDir: join(home, '.phi'),
      bundledDir: join(root, 'bundled'),
      homeDir: home,
      pluginAgentDirs: []
    })
    assert.equal(result.agents.length, 1)
    assert.equal(result.agents[0].description, 'user alpha')

    put(
      root,
      'project/.phi/agents/Alpha.md',
      agentMarkdown({ ...NATIVE_FIELDS, description: 'project alpha' })
    )
    result = discoverPhiAgents({
      cwd,
      agentDir: join(home, '.phi'),
      bundledDir: join(root, 'bundled'),
      homeDir: home,
      pluginAgentDirs: []
    })
    assert.equal(result.agents[0].description, 'project alpha')
  })
})

test('an invalid definition becomes a diagnostic and never blocks the others', () => {
  withTree((root) => {
    put(
      root,
      'project/.phi/agents/Good.md',
      agentMarkdown({ name: 'Good', description: 'g', tools: '[read]' })
    )
    put(
      root,
      'project/.phi/agents/bad_name.md',
      agentMarkdown({ name: 'bad_name', description: 'x', tools: '[read]' })
    )
    put(root, 'project/.phi/agents/Broken.md', 'no frontmatter at all')

    const { agents, diagnostics } = discoverPhiAgents({
      cwd: join(root, 'project'),
      agentDir: join(root, 'home', '.phi'),
      homeDir: join(root, 'home'),
      pluginAgentDirs: []
    })
    assert.deepEqual(
      agents.map((a) => a.name),
      ['Good']
    )
    assert.equal(diagnostics.length, 2)
    assert.ok(diagnostics.every((d) => d.filePath.includes('.phi/agents') && d.message.length > 0))
  })
})

test('missing directories are fine', () => {
  withTree((root) => {
    const result = discoverPhiAgents({
      cwd: join(root, 'nope'),
      agentDir: join(root, 'nope2'),
      homeDir: join(root, 'nope3'),
      pluginAgentDirs: []
    })
    assert.deepEqual(result, { agents: [], diagnostics: [] })
  })
})

// ── the bundled Wrapper agent ─────────────────────────────────────────────

test('the bundled Wrapper agent is a valid, well-formed definition', () => {
  const { agents, diagnostics } = discoverPhiAgents({
    cwd: '/nonexistent/cwd',
    agentDir: '/nonexistent/agentdir',
    bundledDir: REPO_AGENTS_DIR,
    homeDir: '/nonexistent/home'
  })
  assert.deepEqual(diagnostics, [])
  const wrapper = agents.find((a) => a.name === 'Wrapper')
  assert.ok(wrapper, 'resources/agents/Wrapper.md should define Wrapper')
  assert.equal(wrapper.source, 'phi')
  for (const tool of [
    'wrapper_search',
    'wrapper_inspect',
    'wrapper_run',
    'wrapper_status',
    'wrapper_wait',
    'wrapper_cancel',
    'read',
    'bash',
    'write',
    'edit'
  ]) {
    assert.ok(wrapper.tools.includes(tool), `Wrapper should have ${tool}`)
  }
  assert.deepEqual([...wrapper.skills].sort(), ['create-wrapper', 'nextflow'])
  assert.match(wrapper.systemPrompt, /final message/i)
  // Long runs are background jobs: the agent must know not to block on them by default.
  assert.match(wrapper.systemPrompt, /background/i)
  assert.match(wrapper.systemPrompt, /wrapper_wait/)
  assert.match(wrapper.delegation ?? '', /background/i)
  assert.match(wrapper.delegation ?? '', /run id/i)
  // The leader must know it will be woken (and by what), so it neither waits nor polls.
  assert.match(wrapper.delegation ?? '', /<phi_wrapper_run_finished>/)
  assert.match(wrapper.delegation ?? '', /not the user/i)
  assert.match(wrapper.delegation ?? '', /don't continue/i)
  assert.match(wrapper.systemPrompt, /continue_when_done/)
  assert.match(wrapper.systemPrompt, /skill:\/\/create-wrapper/)
  assert.ok(wrapper.delegation && wrapper.delegation.length > 0)
})

test('the bundled Database agent owns only biological database tools', () => {
  const { agents, diagnostics } = discoverPhiAgents({
    cwd: '/nonexistent/cwd',
    agentDir: '/nonexistent/agentdir',
    bundledDir: REPO_AGENTS_DIR,
    homeDir: '/nonexistent/home'
  })
  assert.deepEqual(diagnostics, [])
  const database = agents.find((agent) => agent.name === 'Database')
  assert.ok(database, 'resources/agents/Database.md should define Database')
  assert.equal(database.source, 'phi')
  assert.deepEqual(database.tools, [
    'db_search',
    'db_resolve',
    'db_routes',
    'db_domain',
    'db_docs_search',
    'db_query',
    'db_download'
  ])
  for (const tool of ['read', 'glob', 'grep', 'bash', 'write', 'edit', 'eval', 'web_search']) {
    assert.ok(!database.tools.includes(tool), `Database must not have system tool ${tool}`)
  }
  assert.deepEqual(database.skills, [])
  assert.equal(existsSync(join(REPO_SKILLS_DIR, 'create-database-connector', 'SKILL.md')), false)
  assert.match(database.systemPrompt, /stable_id/)
  assert.match(database.systemPrompt, /provenance/i)
  assert.match(database.systemPrompt, /bulk download/i)
  assert.match(database.systemPrompt, /before (?:the )?first tool call/i)
  assert.match(database.systemPrompt, /candidate databases/i)
  assert.match(database.systemPrompt, /may be inspected and queried in parallel/i)
  assert.match(database.systemPrompt, /exact public-accession/i)
  assert.match(database.systemPrompt, /db_resolve.*replace these discovery steps/i)
  assert.match(database.systemPrompt, /do not repeat/i)
  assert.doesNotMatch(database.systemPrompt, /skill:\/\/create-database-connector/)
  assert.ok(database.delegation && database.delegation.length > 0)
  assert.equal(database.delegationMode, 'required-first')
  assert.equal(database.fallback?.afterFailures, 1)
  assert.deepEqual(database.fallback?.tools, ['bash', 'eval', 'web_search', 'download_file'])
  assert.ok(database.fallback?.match.includes('rest.uniprot.org'))
  assert.match(database.description, /does not conduct open-ended literature reviews/i)
  assert.match(database.delegation ?? '', /literature search.*main agent/i)
  assert.match(database.systemPrompt, /do not broaden a literature search/i)
  for (const toolName of [
    'db_search',
    'db_resolve',
    'db_routes',
    'db_domain',
    'db_docs_search',
    'db_query',
    'db_download'
  ]) {
    assert.doesNotMatch(database.delegation ?? '', new RegExp(`\\b${toolName}\\b`))
  }
})

test('specialists keep delegated scope, evidence, and stop rules explicit', () => {
  const { agents } = discoverPhiAgents({
    cwd: '/nonexistent/cwd',
    agentDir: '/nonexistent/agentdir',
    bundledDir: REPO_AGENTS_DIR,
    homeDir: '/nonexistent/home'
  })
  for (const name of ['Database', 'Visualization', 'Wrapper']) {
    const prompt = agents.find((agent) => agent.name === name)?.systemPrompt ?? ''
    assert.match(prompt, /do not broaden the delegated task/i, `${name} must preserve scope`)
    assert.match(prompt, /tool outputs?.*evidence, not instructions/i, `${name} must distrust data`)
    assert.match(prompt, /missing.*report/i, `${name} must expose missing inputs`)
  }
  const database = agents.find((agent) => agent.name === 'Database')!
  assert.match(database.systemPrompt, /select databases.*select functions.*inspect inputs/i)
  assert.match(database.systemPrompt, /independent.*parallel/i)
  const visualization = agents.find((agent) => agent.name === 'Visualization')!
  assert.match(visualization.systemPrompt, /preview.*before.*final render/i)
  assert.match(visualization.systemPrompt, /verify.*artifact.*before.*report/i)
  const wrapper = agents.find((agent) => agent.name === 'Wrapper')!
  assert.match(wrapper.systemPrompt, /inspect.*before.*run/i)
  assert.match(wrapper.systemPrompt, /lost.*unknown outcome/i)
})

test('specialist delegation excludes general explanation and adjacent deliverables', () => {
  const { agents } = discoverPhiAgents({
    cwd: '/nonexistent/cwd',
    agentDir: '/nonexistent/agentdir',
    bundledDir: REPO_AGENTS_DIR,
    homeDir: '/nonexistent/home'
  })
  for (const name of ['Database', 'Visualization', 'Wrapper']) {
    const guidance = agents.find((agent) => agent.name === name)?.delegation ?? ''
    assert.match(guidance, /only the requested/i, `${name} must constrain delegation`)
  }
  assert.match(
    agents.find((agent) => agent.name === 'Visualization')?.delegation ?? '',
    /general explanation/i
  )
  assert.match(
    agents.find((agent) => agent.name === 'Wrapper')?.delegation ?? '',
    /general explanation/i
  )
})

test('the bundled Visualization agent routes template previews through omics visualization', () => {
  const { agents, diagnostics } = discoverPhiAgents({
    cwd: '/nonexistent/cwd',
    agentDir: '/nonexistent/agentdir',
    bundledDir: REPO_AGENTS_DIR,
    homeDir: '/nonexistent/home'
  })
  assert.deepEqual(diagnostics, [])
  const visualization = agents.find((agent) => agent.name === 'Visualization')
  assert.ok(visualization, 'the visualization plugin should define Visualization')
  assert.equal(visualization.filePath, REPO_VIZ_AGENT)
  assert.equal(visualization.source, 'phi')
  for (const tool of ['read', 'glob', 'grep', 'bash', 'write', 'edit']) {
    assert.ok(visualization.tools.includes(tool), `Visualization should have ${tool}`)
  }
  assert.ok(visualization.tools.includes('viz_examples'))
  assert.deepEqual(visualization.skills, ['omics-visualization'])
  assert.equal(existsSync(join(REPO_VIZ_SKILL_DIR, 'SKILL.md')), true)
  assert.equal(visualization.delegationMode, 'required-first')
  assert.equal(visualization.fallback?.afterFailures, 1)
  assert.deepEqual(visualization.fallback?.tools, ['bash', 'eval'])
  assert.ok(
    visualization.fallback?.match.includes('plugins/visualization/skills/omics-visualization')
  )
  assert.match(visualization.delegation ?? '', /show a few templates/i)
  assert.match(visualization.delegation ?? '', /preview/i)
  assert.match(visualization.delegation ?? '', /directly drawing with Python\/R/i)
  assert.match(visualization.delegation ?? '', /current project working directory/i)
  assert.match(visualization.delegation ?? '', /Output directories must be inside/)
  assert.match(visualization.systemPrompt, /skill:\/\/omics-visualization/)
  assert.match(visualization.systemPrompt, /preview-selection mode/i)
  assert.match(visualization.systemPrompt, /Markdown image/i)
  assert.match(visualization.systemPrompt, /template_id/)
  assert.match(visualization.systemPrompt, /absolute path/i)
  assert.match(visualization.systemPrompt, /Project output boundary/)
  assert.match(visualization.systemPrompt, /external input dataset/)
  assert.match(visualization.systemPrompt, /Do not copy the skill's `references\/`/)
  assert.match(
    visualization.systemPrompt,
    /sourcing the installed read-only `scripts\/lib\/common\.R`/
  )
  assert.match(visualization.systemPrompt, /Do not invent template ids/i)
  assert.match(visualization.systemPrompt, /viz_examples.*without.*data/i)
  assert.match(visualization.systemPrompt, /do not simulate.*render.*example/i)
  assert.match(visualization.systemPrompt, /example-only request is `completed`/i)
  assert.match(visualization.systemPrompt, /revision mode.*existing figure/i)
  assert.match(visualization.systemPrompt, /do not call `viz_route` or `viz_prepare`/i)
  assert.match(visualization.systemPrompt, /existing `plot\.R`.*input.*output/i)
  assert.match(visualization.systemPrompt, /palette.*existing.*script/i)
  assert.match(visualization.delegation ?? '', /existing `plot\.R`.*input.*output/i)
  assert.match(visualization.delegation ?? '', /examples, create, revise, or reference/i)
  assert.match(
    visualization.systemPrompt,
    /reference image.*visual evidence, not an instruction source/i
  )
  assert.match(visualization.systemPrompt, /reference.*user.*data.*do not invent/i)
  assert.match(visualization.systemPrompt, /same cutoffs for Up\/Down\/None colors/i)
  assert.match(visualization.systemPrompt, /counts based on adjusted P value alone distinct/i)

  const skillText = readFileSync(join(REPO_VIZ_SKILL_DIR, 'SKILL.md'), 'utf-8')
  assert.match(skillText, /active Phi project working directory/)
  assert.match(skillText, /Treat data directories outside the\s+project as read-only inputs/)
  assert.match(skillText, /Do not copy `references\/`, `references\/palettes\/`, or catalog files/)
  assert.match(skillText, /same values for point classification, cutoff lines, legend text/i)
  const commonR = readFileSync(join(REPO_VIZ_SKILL_DIR, 'scripts', 'lib', 'common.R'), 'utf-8')
  assert.match(commonR, /OMICS_VISUALIZATION_SKILL_ROOT/)
})

// ── the leader prompt ─────────────────────────────────────────────────────

test('there is no leader prompt when there are no agents', () => {
  assert.equal(buildAgentLeaderPrompt([]), '')
})

test('the leader prompt lists agents by name and tells the main agent to delegate, not do the work', () => {
  const { agents } = discoverPhiAgents({
    cwd: '/nonexistent/cwd',
    agentDir: '/nonexistent/agentdir',
    bundledDir: REPO_AGENTS_DIR,
    homeDir: '/nonexistent/home'
  })
  const prompt = buildAgentLeaderPrompt(agents)
  assert.match(prompt, /^<phi_agents>/)
  assert.match(prompt, /<\/phi_agents>$/)
  assert.match(prompt, /- Database: /)
  assert.match(prompt, /- Visualization: /)
  assert.match(prompt, /- Wrapper: /)
  assert.match(prompt, /self-contained/i)
  assert.match(prompt, /absolute/i)
  assert.match(prompt, /cannot (see|ask)/i)
  assert.match(prompt, /show a few templates/i)
  assert.match(prompt, /nextflow/i)
  assert.match(prompt, /do not/i)
  assert.match(prompt, /required-first/i)
  assert.match(prompt, /literature search.*main agent/i)
  assert.match(prompt, /only the requested subtask/i)
  assert.match(prompt, /follow-up edit.*exact source, input, and prior output paths/i)
  assert.match(prompt, /controlled fallback/i)
  assert.match(prompt, /not_found/i)
  assert.match(prompt, /new and modified user-facing files separately/i)
  assert.match(prompt, /exact path and purpose/i)
  // The leader never learns the specialist's own tool functions.
  for (const name of [
    'wrapper_search',
    'wrapper_inspect',
    'wrapper_run',
    'db_search',
    'db_routes',
    'db_domain',
    'db_docs_search',
    'db_query',
    'db_download'
  ]) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(prompt), `leader prompt must not mention ${name}`)
  }
})

test('specialist reporting requires a verifiable file inventory', () => {
  assert.match(AGENT_REPORT_PROTOCOL, /distinguish new files from modified files/i)
  assert.match(AGENT_REPORT_PROTOCOL, /exact path of each user-facing result/i)
  assert.match(AGENT_REPORT_PROTOCOL, /A top-level folder alone is not a file inventory/i)
})

// ── tool resolution ───────────────────────────────────────────────────────

test('resolveAgentTools separates Phi tool functions from SDK built-ins', () => {
  const fn = { name: 'wrapper_search' } as never
  const { toolNames, customTools } = resolveAgentTools(
    ['read', 'wrapper_search', 'bash', 'wrapper_search', 'not_registered'],
    new Map([['wrapper_search', fn]])
  )
  assert.deepEqual(toolNames, ['read', 'wrapper_search', 'bash', 'not_registered'])
  assert.deepEqual(customTools, [fn])
})

test('resolveAgentTools resolves Database tools only when provided by its scoped registry', () => {
  const dbQuery = { name: 'db_query' } as never
  const declared = ['db_search', 'db_query']
  assert.deepEqual(resolveAgentTools(declared, new Map()).customTools, [])
  assert.deepEqual(resolveAgentTools(declared, new Map([['db_query', dbQuery]])).customTools, [
    dbQuery
  ])
})

test('Visualization exposes only tools appropriate to its selected workflow', () => {
  const declared = ['read', 'edit', 'viz_examples', 'viz_route', 'viz_prepare', 'viz_render']
  assert.deepEqual(visualizationToolNamesForWorkflow(declared, 'examples'), [
    'read',
    'edit',
    'viz_examples'
  ])
  assert.deepEqual(visualizationToolNamesForWorkflow(declared, 'revise'), [
    'read',
    'edit',
    'viz_render'
  ])
  for (const workflow of ['create', 'reference'] as const) {
    assert.deepEqual(visualizationToolNamesForWorkflow(declared, workflow), [
      'read',
      'edit',
      'viz_route',
      'viz_prepare',
      'viz_render'
    ])
  }
})

test('Phi tool ownership isolates Wrapper and Database internals', () => {
  const wrapper = { name: 'wrapper_run' } as never
  const database = { name: 'db_query' } as never
  const groups = { wrapper: [wrapper], database: [database] }
  assert.deepEqual([...buildScopedPhiToolMap('Wrapper', groups).keys()], ['wrapper_run'])
  assert.deepEqual([...buildScopedPhiToolMap('Database', groups).keys()], ['db_query'])
  assert.deepEqual([...buildScopedPhiToolMap('Other', groups).keys()], [])
})

// ── delegation tool ───────────────────────────────────────────────────────

const WRAPPER: PhiAgentDefinition = {
  name: 'Wrapper',
  description: 'Runs and creates Nextflow wrappers.',
  tools: ['read'],
  skills: [],
  systemPrompt: 'p',
  source: 'phi',
  filePath: '/x/Wrapper.md',
  visibility: 'entry',
  warnings: []
}

const VISUALIZATION: PhiAgentDefinition = {
  name: 'Visualization',
  description: 'Specialist for template-guided omics visualization.',
  tools: ['read', 'bash', 'write'],
  skills: ['omics-visualization'],
  systemPrompt: 'p',
  source: 'phi',
  filePath: '/x/Visualization.md',
  visibility: 'entry',
  warnings: []
}

test('the delegation tool is named after the agent, so the agent is the tool', () => {
  const tool = buildAgentTool(WRAPPER, async () => ({ text: 'x', toolCalls: 0 }))
  assert.equal(tool.name, 'Wrapper')
  assert.equal(tool.label, 'Wrapper')
  assert.match(tool.description, /Runs and creates Nextflow wrappers\./)
  assert.deepEqual((tool.parameters as { required: string[] }).required, ['task'])
  assert.equal(tool.approval, 'read')
  assert.equal((tool as { loadMode?: string }).loadMode, 'essential')
})

test('the tool passes the trimmed task to the runner and returns its report', async () => {
  const seen: string[] = []
  const runner: AgentRunner = async (request) => {
    seen.push(request.task)
    return { text: 'Ran fastqc; outputs in /tmp/out.', toolCalls: 3 }
  }
  const result = await buildAgentTool(WRAPPER, runner).execute('call-1', { task: '  run fastqc  ' })
  assert.deepEqual(seen, ['run fastqc'])
  assert.equal(result.isError, undefined)
  assert.equal(
    JSON.stringify(result.content),
    JSON.stringify([{ type: 'text', text: 'Ran fastqc; outputs in /tmp/out.' }])
  )
  assert.deepEqual(result.details, {
    kind: 'agent_result',
    agent: 'Wrapper',
    status: 'completed',
    missingInputs: [],
    toolCalls: 3
  })
})

test('the Visualization delegation tool injects the project output boundary', async () => {
  const seen: string[] = []
  const runner: AgentRunner = async (request) => {
    seen.push(request.task)
    return { text: 'Rendered output in project.', toolCalls: 1 }
  }
  const tool = buildAgentTool(VISUALIZATION, runner, undefined, { cwd: '/project/root' })
  assert.match(tool.description, /Project output boundary for Visualization/)
  assert.match(tool.description, /\/project\/root\/visualizations/)

  const result = await tool.execute('call-viz', {
    task: '  render /data/results.tsv  ',
    workflow: 'create'
  })

  assert.equal(result.isError, undefined)
  assert.equal(seen.length, 1)
  assert.match(seen[0], /Phi execution context:/)
  assert.match(seen[0], /Current project working directory \(cwd\): \/project\/root/)
  assert.match(seen[0], /Treat input\/data paths outside cwd as read-only/)
  assert.match(seen[0], /Do not create sibling plots/)
  assert.match(seen[0], /Delegated task:\nrender \/data\/results\.tsv/)
})

test('Visualization delegation distinguishes examples, creation, revision, and reference imitation', async () => {
  const seen: Array<{ task: string; images?: unknown[]; workflow?: string }> = []
  const tool = buildAgentTool(
    VISUALIZATION,
    async (request) => {
      seen.push(request)
      return { text: 'Done.', toolCalls: 0 }
    },
    undefined,
    { cwd: '/project/root' }
  )
  const parameters = tool.parameters as {
    required: string[]
    properties: { workflow: { enum: string[] } }
  }
  assert.deepEqual(parameters.required, ['task', 'workflow'])
  assert.deepEqual(parameters.properties.workflow.enum, [
    'examples',
    'create',
    'revise',
    'reference'
  ])
  const missing = await tool.execute('missing-mode', { task: '修改刚才的配色' })
  assert.equal(missing.isError, true)
  const misplacedReference = await tool.execute('wrong-mode-reference', {
    workflow: 'revise',
    task: 'Edit /project/plots/plot.R colors.',
    reference_image_path: '/project/example.png'
  })
  assert.equal(misplacedReference.isError, true)

  await tool.execute('revision', {
    workflow: 'revise',
    task: 'Edit /project/plots/plot.R colors using /project/data.tsv; update /project/plots/figure.png.'
  })
  assert.match(seen[0]?.task ?? '', /Workflow: revise/)
  assert.equal(seen[0]?.workflow, 'revise')
  assert.equal(seen[0]?.images, undefined)

  await tool.execute('examples', { workflow: 'examples', task: 'Show installed heatmap examples.' })
  assert.match(seen[1]?.task ?? '', /Workflow: examples/)
  assert.match(seen[1]?.task ?? '', /without creating project files/)
})

test('reference imitation forwards the user image into the specialist prompt', async () => {
  let forwarded: unknown
  const tool = buildAgentTool(VISUALIZATION, async (request) => {
    forwarded = request.images
    return { text: 'Reference inspected.', toolCalls: 0 }
  })
  const ctx = {
    sessionManager: {
      getBranch: () => [
        {
          type: 'message',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: '参考这张图画我的数据' },
              { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }
            ]
          }
        }
      ]
    }
  } as never
  const result = await tool.execute(
    'reference',
    { workflow: 'reference', task: 'Use the attached reference image with /project/data.tsv.' },
    undefined,
    ctx
  )
  assert.equal(result.isError, undefined)
  assert.deepEqual(forwarded, [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }])
  const absent = await tool.execute('no-reference', {
    workflow: 'reference',
    task: '模仿一张图绘制 /project/data.tsv，输出 /project/plot.png'
  })
  assert.equal(absent.isError, true)
  assert.match(JSON.stringify(absent.content), /reference image/i)

  const byPath = await tool.execute('reference-path', {
    workflow: 'reference',
    reference_image_path: '/project/reference.png',
    task: 'Use /project/data.tsv and save /project/result.png.'
  })
  assert.equal(byPath.isError, undefined)
})

test('the tool rejects a missing, blank or oversized task without running the agent', async () => {
  let runs = 0
  const tool = buildAgentTool(WRAPPER, async () => {
    runs += 1
    return { text: 'x', toolCalls: 0 }
  })
  for (const params of [undefined, {}, { task: '   ' }, { task: 7 }, { task: 'x'.repeat(20001) }]) {
    const result = await tool.execute('call', params as never)
    assert.equal(result.isError, true)
  }
  assert.equal(runs, 0)
})

test('the tool forwards runner progress to onUpdate as text updates', async () => {
  const updates: string[] = []
  const tool = buildAgentTool(WRAPPER, async ({ onProgress }) => {
    onProgress?.('wrapper_search fastqc')
    onProgress?.('wrapper_run nf-core/modules/fastqc')
    return { text: 'done', toolCalls: 2 }
  })
  await tool.execute(
    'call',
    { task: 'go' },
    (partial: { content: Array<{ text: string }> }) => updates.push(partial.content[0].text),
    undefined as never
  )
  assert.deepEqual(updates, ['wrapper_search fastqc', 'wrapper_run nf-core/modules/fastqc'])
})

test('the delegation tool forwards structured runner steps to onUpdate details', async () => {
  const updates: Array<{ text: string; details: unknown }> = []
  const tool = buildAgentTool(WRAPPER, async ({ onToolStep }) => {
    onToolStep?.({
      id: 'step-1',
      toolName: 'wrapper_search',
      status: 'running',
      args: { query: 'fastqc' },
      createdAt: '2026-09-20T00:00:00.000Z'
    })
    onToolStep?.({
      id: 'step-1',
      toolName: 'wrapper_search',
      status: 'done',
      output: 'found fastqc',
      completedAt: '2026-09-20T00:00:01.000Z'
    })
    return { text: 'done', toolCalls: 1 }
  })

  await tool.execute(
    'call',
    { task: 'go' },
    (partial: { content: Array<{ text: string }>; details?: unknown }) =>
      updates.push({ text: partial.content[0].text, details: partial.details }),
    undefined as never
  )

  assert.deepEqual(
    updates.map((update) => update.text),
    ['wrapper_search fastqc', 'wrapper_search 完成']
  )
  assert.deepEqual(updates[0].details, {
    kind: 'agent_step',
    agent: 'Wrapper',
    agentRunId: 'run_1',
    step: {
      id: 'step-1',
      toolName: 'wrapper_search',
      status: 'running',
      args: { query: 'fastqc' },
      createdAt: '2026-09-20T00:00:00.000Z'
    }
  })
})

test('the tool turns failures, cancellation, timeouts and empty reports into errors naming the agent', async () => {
  const run = async (runner: AgentRunner): Promise<{ isError?: boolean; text: string }> => {
    const result = await buildAgentTool(WRAPPER, runner).execute('call', { task: 'go' })
    return { isError: result.isError, text: JSON.stringify(result.content) }
  }
  const failed = await run(async () => {
    throw new Error('model unavailable')
  })
  assert.equal(failed.isError, true)
  assert.match(failed.text, /Wrapper/)
  assert.match(failed.text, /model unavailable/)

  const cancelled = await run(async () => {
    throw new AgentCancelledError('Wrapper')
  })
  assert.equal(cancelled.isError, true)
  assert.match(cancelled.text, /cancelled/i)

  const timedOut = await run(async () => {
    throw new AgentTimeoutError('Wrapper', 5000)
  })
  assert.equal(timedOut.isError, true)
  assert.match(timedOut.text, /timed out/i)

  const empty = await run(async () => ({ text: '  ', toolCalls: 1 }))
  assert.equal(empty.isError, true)
  assert.match(empty.text, /no report/i)
})

// ── runner ────────────────────────────────────────────────────────────────

type Listener = (event: unknown) => void

function fakeSession(
  options: {
    onPrompt?: (emit: Listener, text: string) => Promise<void> | void
    message?: unknown
  } = {}
): AgentSessionLike & { prompts: string[]; aborted: number; disposed: number } {
  const listeners = new Set<Listener>()
  const emit: Listener = (event) => listeners.forEach((listener) => listener(event))
  const state = {
    prompts: [] as string[],
    promptOptions: [] as Array<
      { images?: Array<{ type: 'image'; data: string; mimeType: string }> } | undefined
    >,
    aborted: 0,
    disposed: 0
  }
  return Object.assign(state, {
    subscribe(listener: Listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async prompt(
      text: string,
      promptOptions?: { images?: Array<{ type: 'image'; data: string; mimeType: string }> }
    ) {
      state.prompts.push(text)
      state.promptOptions.push(promptOptions)
      await options.onPrompt?.(emit, text)
    },
    async abort() {
      state.aborted += 1
    },
    async dispose() {
      state.disposed += 1
    },
    getLastAssistantMessage() {
      return (options.message ?? {
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Report body' }]
      }) as never
    }
  })
}

test('the specialist runner sends reference images with the delegated prompt', async () => {
  const session = fakeSession()
  let createdWith: unknown
  const runner = createAgentRunner({
    agent: 'Visualization',
    createSession: async (request) => {
      createdWith = request
      return session
    }
  })
  const images = [{ type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' }]
  await runner({ task: 'Use the reference image.', images, workflow: 'reference' })
  assert.deepEqual(createdWith, { workflow: 'reference' })
  assert.deepEqual((session as typeof session & { promptOptions: unknown[] }).promptOptions, [
    { images }
  ])
})

test('extractAssistantText joins text parts and ignores thinking and tool calls', () => {
  assert.equal(
    extractAssistantText({
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'First. ' },
        { type: 'toolCall', name: 'bash' },
        { type: 'text', text: 'Second.' }
      ]
    }),
    'First. Second.'
  )
  assert.equal(extractAssistantText(undefined), '')
  assert.equal(extractAssistantText({ content: 'plain string' }), 'plain string')
  assert.equal(extractAssistantText({ content: [] }), '')
})

test('describeToolStart summarises the tool call for progress lines', () => {
  assert.equal(
    describeToolStart('wrapper_run', { id: 'nf-core/modules/fastqc' }),
    'wrapper_run nf-core/modules/fastqc'
  )
  assert.equal(describeToolStart('wrapper_search', { query: 'bam' }), 'wrapper_search bam')
  assert.equal(
    describeToolStart('bash', { command: 'nextflow run wrapper/main.nf' }),
    'bash nextflow run wrapper/main.nf'
  )
  assert.equal(describeToolStart('read', { path: '/a/b.nf' }), 'read /a/b.nf')
  assert.equal(describeToolStart('wrapper_status', { run_id: 'wrun_1' }), 'wrapper_status wrun_1')
  assert.equal(describeToolStart('wrapper_search', {}), 'wrapper_search')
  assert.ok(describeToolStart('bash', { command: 'x'.repeat(500) }).length <= 120)
})

test('the runner prompts a fresh session with the task and returns the last assistant text', async () => {
  const session = fakeSession()
  const result = await createAgentRunner({ agent: 'Wrapper', createSession: async () => session })({
    task: 'wrap seqkit stats'
  })
  assert.deepEqual(session.prompts, ['wrap seqkit stats'])
  assert.equal(result.text, 'Report body')
  assert.equal(session.disposed, 1)
})

test('the runner passes its agent run id into the specialist session for approval routing', async () => {
  const session = fakeSession()
  let createdFor: string | undefined
  await createAgentRunner({
    agent: 'Wrapper',
    createSession: async ({ runId }) => {
      createdFor = runId
      return session
    }
  })({ task: 'inspect remote file', runId: 'wrapper-run-1' })
  assert.equal(createdFor, 'wrapper-run-1')
})

test('the runner counts tool starts and reports them as progress', async () => {
  const session = fakeSession({
    onPrompt: (emit) => {
      emit({ type: 'message_update' })
      emit({ type: 'tool_execution_start', toolName: 'wrapper_search', args: { query: 'fastqc' } })
      emit({ type: 'tool_execution_end', toolName: 'wrapper_search' })
      emit({
        type: 'tool_execution_start',
        toolName: 'wrapper_run',
        args: { id: 'nf-core/modules/fastqc' }
      })
    }
  })
  const lines: string[] = []
  const result = await createAgentRunner({ agent: 'Wrapper', createSession: async () => session })({
    task: 'go',
    onProgress: (line) => lines.push(line)
  })
  assert.equal(result.toolCalls, 2)
  assert.deepEqual(lines, ['wrapper_search fastqc', 'wrapper_run nf-core/modules/fastqc'])
})

test('the runner emits structured tool step updates when requested', async () => {
  const session = fakeSession({
    onPrompt: (emit) => {
      emit({
        type: 'tool_execution_start',
        toolCallId: 'inner-1',
        toolName: 'wrapper_search',
        args: { query: 'fastqc' },
        createdAt: '2026-09-20T00:00:00.000Z'
      })
      emit({
        type: 'tool_execution_update',
        toolCallId: 'inner-1',
        toolName: 'wrapper_search',
        partialResult: { output: 'searching' }
      })
      emit({
        type: 'tool_execution_end',
        toolCallId: 'inner-1',
        toolName: 'wrapper_search',
        result: { output: 'found fastqc' },
        isError: false,
        createdAt: '2026-09-20T00:00:02.000Z'
      })
    }
  })
  const progress: string[] = []
  const steps: unknown[] = []

  const result = await createAgentRunner({ agent: 'Wrapper', createSession: async () => session })({
    task: 'go',
    onProgress: (line) => progress.push(line),
    onToolStep: (step) => steps.push(step)
  })

  assert.equal(result.toolCalls, 1)
  assert.deepEqual(progress, [])
  assert.deepEqual(steps, [
    {
      id: 'inner-1',
      toolName: 'wrapper_search',
      status: 'running',
      args: { query: 'fastqc' },
      createdAt: '2026-09-20T00:00:00.000Z'
    },
    {
      id: 'inner-1',
      toolName: 'wrapper_search',
      status: 'running',
      output: 'searching',
      createdAt: '2026-09-20T00:00:00.000Z'
    },
    {
      id: 'inner-1',
      toolName: 'wrapper_search',
      status: 'done',
      output: 'found fastqc',
      createdAt: '2026-09-20T00:00:00.000Z',
      completedAt: '2026-09-20T00:00:02.000Z'
    }
  ])
})

test('the runner surfaces a model error from the final assistant message and still disposes', async () => {
  const session = fakeSession({
    message: { stopReason: 'error', errorMessage: 'rate limited', content: [] }
  })
  await assert.rejects(
    createAgentRunner({ agent: 'Wrapper', createSession: async () => session })({ task: 'go' }),
    /rate limited/
  )
  assert.equal(session.disposed, 1)
})

test('the runner aborts the session and throws a cancellation error when the signal fires', async () => {
  const controller = new AbortController()
  const session = fakeSession({
    onPrompt: async () => {
      controller.abort()
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  })
  await assert.rejects(
    createAgentRunner({ agent: 'Wrapper', createSession: async () => session })({
      task: 'go',
      signal: controller.signal
    }),
    AgentCancelledError
  )
  assert.equal(session.aborted, 1)
  assert.equal(session.disposed, 1)
})

test('the runner does not start a session when the signal is already aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  let created = 0
  await assert.rejects(
    createAgentRunner({
      agent: 'Wrapper',
      createSession: async () => {
        created += 1
        return fakeSession()
      }
    })({ task: 'go', signal: controller.signal }),
    AgentCancelledError
  )
  assert.equal(created, 0)
})

test('the runner aborts and throws a timeout error when the run exceeds timeoutMs', async () => {
  const session = fakeSession({ onPrompt: () => new Promise((resolve) => setTimeout(resolve, 60)) })
  await assert.rejects(
    createAgentRunner({ agent: 'Wrapper', createSession: async () => session, timeoutMs: 10 })({
      task: 'go'
    }),
    AgentTimeoutError
  )
  assert.equal(session.aborted, 1)
  assert.equal(session.disposed, 1)
})
