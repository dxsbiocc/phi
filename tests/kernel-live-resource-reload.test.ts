import assert from 'node:assert/strict'
import test from 'node:test'

import { createLiveResourcePromptExtension } from '../src/main/agent/engine/in-process/live-resource-prompt'
import { reloadResources } from '../src/main/agent/engine/in-process/resources'
import { sessions } from '../src/main/agent/engine/in-process/state'

test('session-scoped resource reload updates the live loader before returning its snapshot', async () => {
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
  sessions.set(sessionId, {
    agentDir: '/agent',
    resourceLoader: loader as never,
    resourceSnapshot: {
      personaMarkdown: 'old persona',
      contextFiles: [{ path: '/project/AGENTS.md', content: 'old rules' }]
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
      contextFiles: [{ path: '/project/AGENTS.md', content: 'new rules' }]
    })
    assert.deepEqual(calls, ['reload', 'refreshSkills'])
    assert.deepEqual(sessions.get(sessionId)?.resourceSnapshot, {
      personaMarkdown: 'new persona',
      contextFiles: [{ path: '/project/AGENTS.md', content: 'new rules' }]
    })
    assert.deepEqual((snapshot as { agentsFiles: unknown }).agentsFiles, {
      agentsFiles: [{ path: '/project/AGENTS.md', content: 'updated rules' }]
    })
  } finally {
    sessions.delete(sessionId)
  }
})

test('live resource prompt rebuild reads the latest loader snapshot on each turn', async () => {
  let beforeStart: ((event: { systemPrompt: string[] }) => unknown) | undefined
  const files = { agentsFiles: [{ path: '/project/AGENTS.md', content: 'first rules' }] }
  const skills = { skills: [{ name: 'first-skill' }], diagnostics: [] }
  const snapshot = { personaMarkdown: 'first persona', skills: [...skills.skills] }
  const loader = {
    getSkills: () => skills,
    getAgentsFiles: () => files,
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => []
  }
  createLiveResourcePromptExtension({
    snapshot,
    loader: () => loader as never
  })({
    on(event, handler) {
      if (event === 'before_agent_start') beforeStart = handler as typeof beforeStart
    },
    getActiveTools: () => ['read']
  } as never)
  assert.ok(beforeStart)

  const first = beforeStart({ systemPrompt: ['base prompt', 'CURRENT_MEMORY_BLOCK'] }) as {
    systemPrompt: string[]
  }
  files.agentsFiles = [{ path: '/project/AGENTS.md', content: 'second rules' }]
  skills.skills = [{ name: 'second-skill' }]
  snapshot.skills = [...skills.skills]
  snapshot.personaMarkdown = 'second persona'
  const second = beforeStart({
    systemPrompt: [...first.systemPrompt, 'CURRENT_POLICY_BLOCK']
  }) as { systemPrompt: string[] }

  assert.match(JSON.stringify(first), /first persona/)
  assert.match(JSON.stringify(second), /second persona/)
  assert.match(JSON.stringify(second), /second rules/)
  assert.match(JSON.stringify(second), /second-skill/)
  assert.match(JSON.stringify(second), /CURRENT_MEMORY_BLOCK/)
  assert.match(JSON.stringify(second), /CURRENT_POLICY_BLOCK/)
  assert.doesNotMatch(JSON.stringify(second), /first persona|first rules|first-skill/)
  assert.equal(
    second.systemPrompt.filter((block) => block.startsWith('<phi_live_resource_snapshot>')).length,
    1
  )
})
