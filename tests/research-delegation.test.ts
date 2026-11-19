import assert from 'node:assert/strict'
import test from 'node:test'
import type { PhiAgentDefinition } from '../src/main/agent/agents/definition'
import { buildAgentLeaderPrompt } from '../src/main/agent/agents/leader-prompt'
import { AgentRunRegistry } from '../src/main/agent/agents/registry'
import { buildAgentTool } from '../src/main/agent/agents/tool'
import { createPhiToolContext } from '../src/main/agent/engine/tool-adapter'
import type { PhiToolContext } from '../src/main/agent/engine/types'

const specialist: PhiAgentDefinition = {
  name: 'Statistics',
  description: 'Perform the requested statistical analysis.',
  skills: [],
  tools: [],
  visibility: 'entry',
  warnings: [],
  systemPrompt: 'Run the requested analysis.',
  source: 'phi',
  filePath: 'agents/Statistics.md'
}

function conversation(
  ...messages: Array<{
    role: string
    content: unknown
    synthetic?: boolean
    attribution?: 'agent' | 'user'
  }>
): PhiToolContext {
  const branch = messages.map((message) => ({ type: 'message', message }))
  return createPhiToolContext('/research', {
    sessionManager: { getBranch: () => branch }
  })
}

const question = '治疗后哪些基因达到了预设的差异阈值？'
const task = '统计结果表中满足既定阈值的基因数。'
const marker = 'DEG_INTERMEDIATE_TABLE_AND_LOG_DO_NOT_FORWARD'
const research = {
  subquestion: task,
  answer: '3 个基因可评估，0 个达到阈值。',
  interpretation: '这是预设条件下的筛选结果。',
  rationale: '依赖非空候选集的 ORA 可以结束。',
  evidence: ['results/de.tsv']
}

test('delegation preserves the original user question across later turns and excludes child intermediates', async () => {
  const context = conversation(
    { role: 'user', content: [{ type: 'text', text: question }] },
    { role: 'assistant', content: 'Which samples should I use?' },
    { role: 'user', content: '只用配对样本。' }
  )
  const registry = new AgentRunRegistry()
  const tool = buildAgentTool(
    specialist,
    async (request) => {
      assert.ok(request.task.includes(question))
      assert.ok(request.task.includes(task))
      request.onProgress?.(marker)
      request.onToolStep?.({ id: 's1', toolName: 'read', status: 'done', output: marker })
      return {
        text: `<phi_agent_result>${JSON.stringify({ status: 'completed', research })}</phi_agent_result>\n${marker}`,
        toolCalls: 1
      }
    },
    registry
  )
  const updates: unknown[] = []
  const result = await tool.execute(
    'question-1',
    { task, research_question: question },
    (update) => updates.push(update),
    context
  )
  assert.equal(result.isError, undefined)
  assert.ok(JSON.stringify(result.content).includes(question))
  assert.ok(JSON.stringify(result.content).includes(research.answer))
  assert.ok(JSON.stringify(result.content).includes('results/de.tsv'))
  assert.ok(!JSON.stringify([updates, result]).includes(marker))
})

test('a research delegation cannot substitute a specialist suggestion or a system wake-up for a user request', async () => {
  const context = conversation(
    { role: 'user', content: question },
    { role: 'assistant', content: 'Run a new pathway analysis.' },
    {
      role: 'user',
      content: '<phi_research_plan_paused>Approve the new analysis.</phi_research_plan_paused>'
    },
    { role: 'user', content: 'Synthetic progress result', synthetic: true },
    { role: 'user', content: 'An agent suggested this', attribution: 'agent' },
    {
      role: 'user',
      content:
        '<phi_agent_run_finished>Automatically tighten the threshold.</phi_agent_run_finished>'
    }
  )
  const registry = new AgentRunRegistry()
  const tool = buildAgentTool(specialist, async () => ({ text: '', toolCalls: 0 }), registry)
  for (const invalidQuestion of [
    'Run a new pathway analysis.',
    'Automatically tighten the threshold.',
    'Approve the new analysis.',
    'Synthetic progress result',
    'An agent suggested this',
    ' ',
    5
  ]) {
    const result = await tool.execute(
      'invalid',
      { task, research_question: invalidQuestion },
      undefined,
      context
    )
    assert.equal(result.isError, true)
  }
  assert.equal(registry.list().length, 0)
})

test('the scientific leader checks coverage and authorization before delivery, continuation or clarification', () => {
  const prompt = buildAgentLeaderPrompt([specialist])
  assert.match(prompt, /original user question and current clarifications/)
  assert.match(prompt, /deliver the supported answer/)
  assert.match(prompt, /continue an already approved, applicable step/)
  assert.match(prompt, /ask_user_question with concrete choices/)
})
