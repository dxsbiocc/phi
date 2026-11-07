import assert from 'node:assert/strict'
import test from 'node:test'

import type { PhiAgentDefinition } from '../src/main/agent/agents/definition'
import { AgentRunRegistry } from '../src/main/agent/agents/registry'
import { buildAgentTool } from '../src/main/agent/agents/tool'
import type { PhiToolContext, PhiToolResult } from '../src/main/agent/engine/types'

const WRAPPER: PhiAgentDefinition = {
  name: 'Wrapper',
  description: 'Runs and creates Nextflow wrappers.',
  delegation: 'Delegate workflow execution with exact paths and user constraints.',
  tools: ['read'],
  skills: [],
  systemPrompt: 'You are Wrapper.',
  source: 'phi',
  filePath: '/agents/Wrapper.md',
  visibility: 'entry',
  warnings: []
}
const context: PhiToolContext = { cwd: '/project', recentUserImages: () => [] }

test('a delegation chosen by the main agent starts without a routing assessment or veto', async () => {
  const registry = new AgentRunRegistry()
  const updates: PhiToolResult[] = []
  let receivedTask: string | undefined
  const tool = buildAgentTool(
    WRAPPER,
    async ({ task }) => {
      receivedTask = task
      return { text: 'Complete', toolCalls: 1 }
    },
    registry
  )

  const result = await tool.execute(
    'call',
    { task: 'Run only the selected wrapper.' },
    (update) => updates.push(update),
    context
  )

  assert.equal(result.isError, undefined)
  assert.equal(receivedTask, 'Run only the selected wrapper.')
  assert.equal(registry.list()[0]?.state, 'done')
  assert.equal(
    updates.some((update) => JSON.stringify(update.details).includes('decision')),
    false
  )
})

test('an already-cancelled delegation never starts a background run', async () => {
  const controller = new AbortController()
  controller.abort()
  const registry = new AgentRunRegistry()
  let starts = 0
  const tool = buildAgentTool(
    WRAPPER,
    async () => {
      starts += 1
      return { text: 'Complete', toolCalls: 0 }
    },
    registry
  )

  const result = await tool.execute(
    'cancelled',
    { task: 'Run workflow', background: true },
    undefined,
    context,
    controller.signal
  )

  assert.equal(result.isError, true)
  assert.match(JSON.stringify(result.content), /cancelled/i)
  assert.equal(starts, 0)
  assert.deepEqual(registry.list(), [])
})
