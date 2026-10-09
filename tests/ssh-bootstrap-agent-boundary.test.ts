import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { AgentRunRegistry } from '../src/main/agent/agents/registry'
import { buildAgentRunTools } from '../src/main/agent/agents/run-tools'

test('SSH password bootstrap is absent from the agent-visible tool registries', () => {
  const runToolNames = buildAgentRunTools(new AgentRunRegistry()).map((tool) => tool.name)
  const workerSource = readFileSync(
    new URL('../src/main/agent/omp/omp-sdk-worker.ts', import.meta.url),
    'utf8'
  )

  assert.deepEqual(runToolNames, ['agent_status', 'agent_wait', 'agent_steer', 'agent_stop'])
  assert.doesNotMatch(workerSource, /ssh[_-]?bootstrap|password[_-]?bootstrap/i)
})
