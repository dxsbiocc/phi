import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildPhiMainSystemPrompt,
  filterPersonaContextFile
} from '../src/main/agent/main-system-prompt'
import {
  evaluateSpecialistFallback,
  type SpecialistToolCall
} from '../src/main/agent/agents/fallback-policy'
import { parseAgentReport } from '../src/main/agent/agents/report'
import { AgentRunRegistry } from '../src/main/agent/agents/registry'
import type { PhiAgentDefinition } from '../src/main/agent/agents/definition'

const DATABASE: PhiAgentDefinition = {
  name: 'Database',
  description: 'Retrieves biological database records.',
  tools: ['db_query'],
  skills: [],
  delegationMode: 'required-first',
  fallback: {
    afterFailures: 1,
    tools: ['bash', 'eval', 'web_search'],
    match: ['rest.uniprot.org', 'eutils.ncbi.nlm.nih.gov']
  },
  systemPrompt: 'You are Database.',
  source: 'phi',
  filePath: '/agents/Database.md'
}

test('Phi owns the main system identity while retaining OMP runtime instructions', () => {
  const defaults = [
    [
      '<system-conventions>runtime</system-conventions>',
      '§ Role',
      'Helpful, trusted assistant for load-bearing changes in Oh My Pi coding harness.',
      '§ Runtime',
      'Keep this operational tool contract.'
    ].join('\n')
  ]
  const prompt = buildPhiMainSystemPrompt(defaults, {
    personaMarkdown: '# 助手人设\n\n名字叫星河，回答简洁。'
  })
  const rendered = prompt.join('\n\n')

  assert.match(rendered, /You are the assistant running in Phi/i)
  assert.match(rendered, /scientific research assistant/i)
  assert.match(rendered, /名字叫星河/)
  assert.match(rendered, /Keep this operational tool contract/)
  assert.doesNotMatch(rendered, /assistant for load-bearing changes in Oh My Pi/i)
  assert.ok(rendered.indexOf('Phi') < rendered.indexOf('名字叫星河'))
})

test('the Phi-managed persona file is removed from generic context after explicit injection', () => {
  const result = filterPersonaContextFile(
    {
      agentsFiles: [
        { path: '/home/user/.phi/AGENTS.md', content: 'persona' },
        { path: '/project/AGENTS.md', content: 'project rules' }
      ]
    },
    '/home/user/.phi/AGENTS.md'
  )
  assert.deepEqual(result.agentsFiles, [{ path: '/project/AGENTS.md', content: 'project rules' }])
})

test('required-first blocks a matching generic tool until the specialist has failed', async () => {
  const registry = new AgentRunRegistry()
  const call: SpecialistToolCall = {
    toolName: 'bash',
    input: { command: 'curl https://rest.uniprot.org/uniprotkb/Q92748.json' }
  }

  const before = evaluateSpecialistFallback(call, [DATABASE], registry)
  assert.equal(before.allowed, false)
  assert.equal(before.agent, 'Database')
  assert.match(before.reason ?? '', /Database/)

  await registry.launch({
    agent: 'Database',
    task: 'retrieve Q92748',
    background: false,
    runner: async () => {
      throw new Error('connector unavailable')
    }
  }).done

  const after = evaluateSpecialistFallback(call, [DATABASE], registry)
  assert.equal(after.allowed, true)
  assert.equal(after.agent, 'Database')
})

test('successful specialist work does not unlock fallback, and unrelated shell work is unaffected', async () => {
  const registry = new AgentRunRegistry()
  await registry.launch({
    agent: 'Database',
    task: 'retrieve Q92748',
    background: false,
    runner: async () => ({ text: 'record found', toolCalls: 1 })
  }).done

  assert.equal(
    evaluateSpecialistFallback(
      {
        toolName: 'bash',
        input: { command: 'curl https://rest.uniprot.org/uniprotkb/Q92748.json' }
      },
      [DATABASE],
      registry
    ).allowed,
    false
  )
  assert.deepEqual(
    evaluateSpecialistFallback(
      { toolName: 'bash', input: { command: 'git status --short' } },
      [DATABASE],
      registry
    ),
    { allowed: true }
  )
})

test('a structured blocked report unlocks the declared fallback route', async () => {
  const registry = new AgentRunRegistry()
  await registry.launch({
    agent: 'Database',
    task: 'retrieve Q92748',
    background: false,
    runner: async () => ({
      text: `<phi_agent_result>{"status":"blocked","missingInputs":[],"fallbackReason":"connector does not expose this endpoint"}</phi_agent_result>\nThe connector cannot serve this record.`,
      toolCalls: 1
    })
  }).done

  const decision = evaluateSpecialistFallback(
    {
      toolName: 'eval',
      input: { code: "fetch('https://rest.uniprot.org/uniprotkb/Q92748.json')" }
    },
    [DATABASE],
    registry
  )
  assert.equal(decision.allowed, true)
  assert.equal(decision.agent, 'Database')
})

test('a structured not-found report hands the exhausted database route back to the main agent', async () => {
  const registry = new AgentRunRegistry()
  const run = await registry.launch({
    agent: 'Database',
    task: 'find an experimental structure',
    background: false,
    runner: async () => ({
      text: `<phi_agent_result>{"status":"not_found","missingInputs":[],"fallbackReason":"no matching record in installed connectors"}</phi_agent_result>\nNo matching database record was found.`,
      toolCalls: 2
    })
  }).done

  assert.equal(run.reportStatus, 'not_found')
  const decision = evaluateSpecialistFallback(
    {
      toolName: 'bash',
      input: { command: 'curl https://rest.uniprot.org/uniprotkb/search' }
    },
    [DATABASE],
    registry
  )
  assert.equal(decision.allowed, true)
})

test('structured specialist reports preserve prose and expose blocked state', () => {
  const parsed = parseAgentReport(`
<phi_agent_result>{"status":"blocked","missingInputs":["NCBI API key"],"fallbackReason":"rate limited","nextAgent":null}</phi_agent_result>

NCBI refused the request after the connector retry policy was exhausted.
`)
  assert.equal(parsed.status, 'blocked')
  assert.equal(parsed.structured, true)
  assert.deepEqual(parsed.missingInputs, ['NCBI API key'])
  assert.equal(parsed.fallbackReason, 'rate limited')
  assert.match(parsed.text, /connector retry policy/)
  assert.doesNotMatch(parsed.text, /phi_agent_result/)
})

test('legacy specialist prose remains a completed report for compatibility', () => {
  assert.deepEqual(parseAgentReport('  Retrieved Q92748.  '), {
    status: 'completed',
    text: 'Retrieved Q92748.',
    missingInputs: [],
    structured: false
  })
})
