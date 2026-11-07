import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test, { type TestContext } from 'node:test'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'

const BUN_CHILD_TEST_ENV = 'PHI_KERNEL_LIVE_RESOURCE_BUN_TEST'
const bunRuntime = 'Bun' in globalThis
const selectedBunTest = bunRuntime ? process.env[BUN_CHILD_TEST_ENV] : undefined

function it(name: string, body: (context: TestContext) => void | Promise<void>): void {
  if (bunRuntime) {
    if (!selectedBunTest || selectedBunTest === name) test(name, body)
    return
  }
  test(name, () => {
    execFileSync(
      resolveBunExecutable(),
      ['test', '--timeout', '60000', fileURLToPath(import.meta.url), '--test-name-pattern', name],
      {
        cwd: resolve('.'),
        env: { ...process.env, [BUN_CHILD_TEST_ENV]: name },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
  })
}

const promptModule = bunRuntime
  ? await import('../src/main/agent/engine/in-process/live-resource-prompt')
  : undefined
const resourcesModule = bunRuntime
  ? await import('../src/main/agent/engine/in-process/resources')
  : undefined
const stateModule = bunRuntime
  ? await import('../src/main/agent/engine/in-process/state')
  : undefined
const sessionCreationModule = bunRuntime
  ? await import('../src/main/agent/engine/in-process/session-creation')
  : undefined
const { createLiveResourcePromptExtension } =
  promptModule ?? ({} as typeof import('../src/main/agent/engine/in-process/live-resource-prompt'))
const { reloadResources } =
  resourcesModule ?? ({} as typeof import('../src/main/agent/engine/in-process/resources'))
const { sessions } =
  stateModule ?? ({} as typeof import('../src/main/agent/engine/in-process/state'))
const { scheduleMcpToolRefresh } =
  sessionCreationModule ??
  ({} as typeof import('../src/main/agent/engine/in-process/session-creation'))

it('session-scoped resource reload updates the live loader before returning its snapshot', async () => {
  const sessionId = 'kernel-resource-session'
  const calls: string[] = []
  const loader = {
    reload: async () => {
      calls.push('reload')
    },
    getExtensions: () => [],
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => [],
    getThemes: () => [],
    getAgentsFiles: () => ({
      agentsFiles: [{ path: '/project/AGENTS.md', content: 'updated rules' }]
    }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => []
  }
  const addedAgent = {
    name: 'Added',
    description: 'Added after session creation.',
    tools: [],
    skills: [],
    invocation: 'host' as const,
    visibility: 'entry' as const,
    warnings: [],
    systemPrompt: 'Act as the added specialist.',
    source: 'phi' as const,
    filePath: '/agent/agents/Added.md'
  }
  let reloadAgentCalls = 0
  sessions.set(sessionId, {
    agentDir: '/agent',
    resourceLoader: loader as never,
    resourceSnapshot: {
      personaMarkdown: 'old persona',
      contextFiles: [{ path: '/project/AGENTS.md', content: 'old rules' }]
    },
    reloadAgents: async () => {
      reloadAgentCalls += 1
      return reloadAgentCalls === 1
        ? { applied: true, added: ['Added'] }
        : {
            applied: false,
            reason: 'requires_session_refresh' as const,
            changed: ['Added']
          }
    },
    result: {
      session: {
        sessionManager: { getCwd: () => '/project' },
        refreshSkills: async () => {
          calls.push('refreshSkills')
        }
      }
    } as never
  })

  try {
    const snapshot = await reloadResources({
      sessionId,
      cwd: '/ignored',
      personaMarkdown: 'new persona',
      contextFiles: [{ path: '/project/AGENTS.md', content: 'new rules' }],
      phiAgents: [addedAgent]
    })
    assert.deepEqual(calls, ['reload', 'refreshSkills'])
    assert.deepEqual(sessions.get(sessionId)?.resourceSnapshot, {
      personaMarkdown: 'new persona',
      contextFiles: [{ path: '/project/AGENTS.md', content: 'new rules' }]
    })
    assert.deepEqual((snapshot as { agentsFiles: unknown }).agentsFiles, {
      agentsFiles: [{ path: '/project/AGENTS.md', content: 'updated rules' }]
    })
    assert.deepEqual((snapshot as { agents?: unknown }).agents, {
      applied: true,
      added: ['Added']
    })
    const refreshed = await reloadResources({
      sessionId,
      cwd: '/ignored',
      phiAgents: [{ ...addedAgent, description: 'Updated definition.' }]
    })
    assert.deepEqual((refreshed as { agents?: unknown }).agents, {
      applied: false,
      reason: 'requires_session_refresh',
      changed: ['Added']
    })
  } finally {
    sessions.delete(sessionId)
  }
})

it('live resource prompt rebuild reads the latest loader snapshot on each turn', async () => {
  let beforeStart: ((event: { systemPrompt: string[] }) => unknown) | undefined
  const files = { agentsFiles: [{ path: '/project/AGENTS.md', content: 'first rules' }] }
  const skills = { skills: [{ name: 'first-skill' }], diagnostics: [] }
  const phiAgents = [
    {
      name: 'Wrapper',
      description: 'Wrapper specialist.',
      tools: ['read'],
      skills: [],
      visibility: 'entry' as const,
      warnings: [],
      systemPrompt: 'Run Wrapper.',
      source: 'phi' as const,
      filePath: '/agents/Wrapper.md'
    }
  ]
  const snapshot = {
    personaMarkdown: 'first persona',
    skills: [...skills.skills],
    phiAgents
  }
  const loader = {
    getSkills: () => skills,
    getAgentsFiles: () => files,
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => []
  }
  createLiveResourcePromptExtension({
    snapshot,
    loader: () => loader as never,
    includeSkills: true
  })({
    on(event, handler) {
      if (event === 'before_agent_start') beforeStart = handler as typeof beforeStart
    }
  } as never)
  assert.ok(beforeStart)

  const first = beforeStart({ systemPrompt: ['base prompt', 'CURRENT_MEMORY_BLOCK'] }) as {
    systemPrompt: string[]
  }
  files.agentsFiles = [{ path: '/project/AGENTS.md', content: 'second rules' }]
  skills.skills = [{ name: 'second-skill' }]
  snapshot.skills = [...skills.skills]
  snapshot.personaMarkdown = 'second persona'
  phiAgents.push({
    ...phiAgents[0],
    name: 'General',
    description: 'General remote work.',
    systemPrompt: 'Run General.',
    filePath: '/agents/General.md'
  })
  const second = beforeStart({
    systemPrompt: [...first.systemPrompt, 'CURRENT_POLICY_BLOCK']
  }) as { systemPrompt: string[] }

  assert.match(JSON.stringify(first), /first persona/)
  assert.match(JSON.stringify(second), /second persona/)
  assert.match(JSON.stringify(second), /second rules/)
  assert.match(JSON.stringify(second), /second-skill/)
  assert.match(JSON.stringify(second), /Available agents:[\s\S]*General/)
  assert.match(JSON.stringify(second), /CURRENT_MEMORY_BLOCK/)
  assert.match(JSON.stringify(second), /CURRENT_POLICY_BLOCK/)
  assert.doesNotMatch(JSON.stringify(second), /first persona|first rules|first-skill/)
  assert.equal(
    second.systemPrompt.filter((block) => block.startsWith('<phi_live_resource_snapshot>')).length,
    1
  )
  assert.equal(JSON.stringify(second).match(/<phi_agents>/gu)?.length, 1)
})

it('live resource prompt keeps two session snapshots isolated without runtime actions', () => {
  const handlers: Array<(event: { systemPrompt: string[] }) => unknown> = []
  for (const marker of ['A_RESOURCE_ONLY', 'B_RESOURCE_ONLY']) {
    createLiveResourcePromptExtension({
      snapshot: { personaMarkdown: '', skills: [] },
      loader: () =>
        ({
          getAgentsFiles: () => ({
            agentsFiles: [{ path: `/project/${marker}/AGENTS.md`, content: marker }]
          })
        }) as never,
      includeSkills: true
    })({
      on(event, handler) {
        if (event === 'before_agent_start') handlers.push(handler as (typeof handlers)[number])
      }
    } as never)
  }

  const first = JSON.stringify(handlers[0]({ systemPrompt: ['base'] }))
  const second = JSON.stringify(handlers[1]({ systemPrompt: ['base'] }))
  assert.match(first, /A_RESOURCE_ONLY/)
  assert.doesNotMatch(first, /B_RESOURCE_ONLY/)
  assert.match(second, /B_RESOURCE_ONLY/)
  assert.doesNotMatch(second, /A_RESOURCE_ONLY/)
})

it('live MCP refresh is registered as pending before the next prompt', async () => {
  let finish!: () => void
  const refresh = new Promise<void>((resolve) => {
    finish = resolve
  })
  let registered: Promise<void> | undefined
  const returned = scheduleMcpToolRefresh(
    {
      refreshMCPTools: () => refresh,
      setPendingMCPDiscovery: (pending) => {
        registered = pending
      }
    } as never,
    []
  )

  assert.equal(returned, refresh)
  assert.equal(registered, refresh)
  let settled = false
  void returned.then(() => {
    settled = true
  })
  await Promise.resolve()
  assert.equal(settled, false)
  finish()
  await returned
  assert.equal(settled, true)
})
