import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { discoverPhiAgents } from '../src/main/agent/agents/discovery'
import {
  isPhiAgentDefinition,
  isValidPhiAgentName,
  normalizeToolName,
  parsePhiAgent,
  toPhiAgentName,
  type PhiAgentDefinition
} from '../src/main/agent/agents/definition'
import { buildAgentLeaderPrompt } from '../src/main/agent/agents/leader-prompt'
import {
  AgentCancelledError,
  AgentTimeoutError,
  createAgentRunner,
  describeToolStart,
  extractAssistantText,
  type AgentSessionLike
} from '../src/main/agent/agents/runner'
import { buildScopedPhiToolMap, resolveAgentTools } from '../src/main/agent/agents/tool-resolution'
import { buildAgentTool, type AgentRunner } from '../src/main/agent/agents/tool'

const REPO_AGENTS_DIR = join(import.meta.dirname, '..', 'resources', 'agents')
const REPO_SKILLS_DIR = join(import.meta.dirname, '..', 'resources', 'skills')

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
    filePath: '/x/Alpha.md'
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
    filePath: '/x'
  }
  assert.equal(isPhiAgentDefinition(good), true)
  assert.equal(isPhiAgentDefinition({ ...good, tools: 'read' }), false)
  assert.equal(isPhiAgentDefinition({ ...good, name: 'alpha' }), false)
  assert.equal(isPhiAgentDefinition(null), false)
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
      homeDir: join(root, 'home')
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

    const { agents } = discoverPhiAgents({ cwd, agentDir: join(home, '.phi'), homeDir: home })
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
      homeDir: home
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
      homeDir: home
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
      homeDir: join(root, 'home')
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
      homeDir: join(root, 'nope3')
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

test('the bundled Database agent owns the biological database tools', () => {
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
  for (const tool of [
    'read',
    'glob',
    'grep',
    'bash',
    'write',
    'edit',
    'db_search',
    'db_domain',
    'db_docs_search',
    'db_query'
  ]) {
    assert.ok(database.tools.includes(tool), `Database should have ${tool}`)
  }
  assert.deepEqual(database.skills, ['create-database-connector'])
  assert.equal(existsSync(join(REPO_SKILLS_DIR, 'create-database-connector', 'SKILL.md')), true)
  assert.match(database.systemPrompt, /stable_id/)
  assert.match(database.systemPrompt, /provenance/i)
  assert.match(database.systemPrompt, /bulk download/i)
  assert.match(database.systemPrompt, /skill:\/\/create-database-connector/)
  assert.ok(database.delegation && database.delegation.length > 0)
  for (const toolName of ['db_search', 'db_domain', 'db_docs_search', 'db_query']) {
    assert.doesNotMatch(database.delegation ?? '', new RegExp(`\\b${toolName}\\b`))
  }
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
  assert.match(prompt, /- Wrapper: /)
  assert.match(prompt, /self-contained/i)
  assert.match(prompt, /absolute/i)
  assert.match(prompt, /cannot (see|ask)/i)
  assert.match(prompt, /nextflow/i)
  assert.match(prompt, /do not/i)
  // The leader never learns the specialist's own tool functions.
  for (const name of [
    'wrapper_search',
    'wrapper_inspect',
    'wrapper_run',
    'db_search',
    'db_domain',
    'db_docs_search',
    'db_query'
  ]) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(prompt), `leader prompt must not mention ${name}`)
  }
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
  filePath: '/x/Wrapper.md'
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
  assert.deepEqual(result.details, { kind: 'agent_result', agent: 'Wrapper', toolCalls: 3 })
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
  const state = { prompts: [] as string[], aborted: 0, disposed: 0 }
  return Object.assign(state, {
    subscribe(listener: Listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async prompt(text: string) {
      state.prompts.push(text)
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
