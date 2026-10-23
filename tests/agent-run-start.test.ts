import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

import type { PhiAgentDefinition } from '../src/main/agent/agents/definition'
import { AgentRunRegistry, type AgentRunFn } from '../src/main/agent/agents/registry'
import {
  MAX_HOST_AGENT_TASK_BYTES,
  startSessionAgentRun
} from '../src/main/agent/engine/in-process/agent-run-start'
import { buildSessionAgentDelegationTools } from '../src/main/agent/engine/in-process/session-agent-tools'
import { sessions, type SessionEntry } from '../src/main/agent/engine/in-process/state'

const run: AgentRunFn = async () => ({ text: 'step complete', toolCalls: 0 })

function installSession(
  t: TestContext,
  sessionId: string,
  registry = new AgentRunRegistry(),
  runners: ReadonlyMap<string, AgentRunFn> = new Map([['PlanStep', run]])
): AgentRunRegistry {
  sessions.set(sessionId, { agentRuns: registry, agentRunners: runners } as SessionEntry)
  t.after(() => sessions.delete(sessionId))
  return registry
}

function definition(name: string, invocation?: 'host'): PhiAgentDefinition {
  return {
    name,
    description: `${name} description`,
    tools: ['read'],
    skills: [],
    ...(invocation ? { invocation } : {}),
    visibility: 'entry',
    warnings: [],
    systemPrompt: `${name} prompt`,
    source: 'phi',
    filePath: `/agents/${name}.md`
  }
}

test('agentRun.start defaults to PlanStep and launches a host background run', async (t) => {
  const registry = installSession(t, 'start-default')
  const result = startSessionAgentRun({ sessionId: 'start-default', task: '  do the step  ' })
  const snapshot = registry.get(result.runId)

  assert.equal(snapshot?.agent, 'PlanStep')
  assert.equal(snapshot?.task, 'do the step')
  assert.equal(snapshot?.background, true)
  assert.equal(snapshot?.origin, 'host')
  assert.equal((await registry.wait([result.runId], { timeoutMs: 1000 })).timedOut, false)
})

test('agentRun.start validates session, agent and bounded non-empty task', (t) => {
  installSession(t, 'start-validation')

  assert.throws(() => startSessionAgentRun({ task: 'x' }), /sessionId/)
  assert.throws(() => startSessionAgentRun({ sessionId: 'missing', task: 'x' }), /Unknown session/)
  assert.throws(
    () => startSessionAgentRun({ sessionId: 'start-validation', agent: '', task: 'x' }),
    /agent/
  )
  assert.throws(
    () => startSessionAgentRun({ sessionId: 'start-validation', agent: 'Other', task: 'x' }),
    /not available/
  )
  assert.throws(
    () => startSessionAgentRun({ sessionId: 'start-validation', task: '   ' }),
    /non-empty task/
  )
  assert.throws(
    () =>
      startSessionAgentRun({
        sessionId: 'start-validation',
        task: '界'.repeat(Math.floor(MAX_HOST_AGENT_TASK_BYTES / 3) + 1)
      }),
    /byte limit/
  )
})

test('agentRun.start remains available after the tool run allowance is exhausted', async (t) => {
  const registry = installSession(
    t,
    'start-limit',
    new AgentRunRegistry({ limits: { maxRuns: 1 } })
  )
  const tool = registry.launch({
    agent: 'Wrapper',
    task: 'tool run',
    runner: run,
    background: true
  })
  await tool.done

  const host = startSessionAgentRun({ sessionId: 'start-limit', task: 'plan step' })
  assert.equal((await registry.wait([host.runId], { timeoutMs: 1000 })).timedOut, false)
})

test('host-only agents create runners without delegation or run-management tools', () => {
  const registry = new AgentRunRegistry()
  const seen: string[] = []
  const runnerFor = (agent: PhiAgentDefinition): AgentRunFn => {
    seen.push(agent.name)
    return run
  }
  const hostOnly = buildSessionAgentDelegationTools({
    definitions: [definition('PlanStep', 'host')],
    runnerFor,
    registry,
    toolOptions: {}
  })
  assert.deepEqual(hostOnly, [])
  assert.deepEqual(seen, [])

  const mixed = buildSessionAgentDelegationTools({
    definitions: [definition('PlanStep', 'host'), definition('Wrapper')],
    runnerFor,
    registry,
    toolOptions: {}
  })
  assert.deepEqual(
    mixed.map((tool) => tool.name),
    ['Wrapper', 'agent_status', 'agent_wait', 'agent_steer', 'agent_stop']
  )
  assert.deepEqual(seen, ['Wrapper'])
})
