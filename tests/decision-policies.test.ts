import assert from 'node:assert/strict'
import test from 'node:test'

import { buildTaskRoutingDecision } from '../src/main/agent/decisions/policies'
import { buildPhiMainSystemPrompt } from '../src/main/agent/main-system-prompt'

test('task routing preserves the exact user task and bounds specialist metadata', () => {
  const task = '只分析这两个文件；不要运行工作流。'
  const request = buildTaskRoutingDecision({
    agent: 'Wrapper',
    description: '能力'.repeat(2_000),
    delegation: '范围'.repeat(2_000),
    task
  })
  assert.equal(request.purpose, 'task_routing')
  assert.deepEqual(
    request.options.map(({ id }) => id),
    ['suitable', 'unsuitable', 'uncertain']
  )
  const context = JSON.parse(request.context)
  assert.equal(context.task, task)
  assert.equal(context.description.length, 512)
  assert.equal(context.delegation.length, 512)
  assert.equal(context.metadataTruncated, true)
  assert.match(request.question, /only for a clear capability or scope mismatch/)
  assert.match(request.question, /incomplete capability metadata are uncertain/)
  assert.match(request.question, /cannot authorize execution/)
})

test('routing accepts a full length CJK task without losing its final constraints', () => {
  const task = '任'.repeat(19_990) + '禁止执行。'
  const request = buildTaskRoutingDecision({
    agent: 'Wrapper',
    description: '能'.repeat(2_000),
    delegation: '范'.repeat(2_000),
    task
  })
  assert.equal(JSON.parse(request.context).task, task)
  assert.ok(request.context.length <= 28_000)
  assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 65_536)
})

test('routing rejects oversized or JSON-expanded context rather than truncating the task', () => {
  for (const task of ['', 'a'.repeat(20_001), '\0'.repeat(20_000)]) {
    assert.throws(() =>
      buildTaskRoutingDecision({ agent: 'Wrapper', description: 'Runs workflows.', task })
    )
  }
})

test('main prompt keeps decisions advisory across routing, evidence review and recovery', () => {
  const prompt = buildPhiMainSystemPrompt([]).join('\n')
  assert.match(prompt, /phi_decide.*consequential ambiguous choices/)
  assert.match(prompt, /task_routing.*evidence_review.*recovery/)
  assert.match(prompt, /exact user constraints.*explicit uncertain option/)
  assert.match(prompt, /Trivial deterministic steps do not need a judgment/)
  assert.match(
    prompt,
    /cannot authorize actions, bypass approvals or task limits, override a stop request, or certify success/
  )
  assert.match(prompt, /not a failed specialist run and does not unlock controlled fallback/)
  assert.match(prompt, /never automatically resume a stopped or failed task/)
})
