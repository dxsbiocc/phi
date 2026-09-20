import assert from 'node:assert/strict'
import test from 'node:test'

import {
  agentRunControlTarget,
  agentRunStatusText,
  isAgentRunGoneError
} from '../src/renderer/src/lib/agentExecutionControl'
import type { AgentExecutionItem } from '../src/renderer/src/lib/agentExecutionTypes'

const card = (overrides: Partial<AgentExecutionItem> = {}): AgentExecutionItem => ({
  id: 'call-1',
  role: 'agent_execution',
  agentName: 'Wrapper',
  task: 'align',
  argsPreview: '',
  argsJson: '',
  status: 'running',
  steps: [],
  agentRunId: 'run_3',
  agentSessionId: 'runtime-9',
  ...overrides
})

test('a running card that knows its run and session can be steered and stopped', () => {
  assert.deepEqual(agentRunControlTarget(card()), {
    agentRunId: 'run_3',
    agentSessionId: 'runtime-9'
  })
})

test('a card that has ended, or that does not know its run, offers no controls', () => {
  assert.equal(agentRunControlTarget(card({ status: 'done' })), null)
  assert.equal(agentRunControlTarget(card({ status: 'error' })), null)
  assert.equal(agentRunControlTarget(card({ agentRunId: undefined })), null)
  assert.equal(agentRunControlTarget(card({ agentSessionId: undefined })), null)
})

test('a card whose run has been lost offers no controls', () => {
  assert.equal(agentRunControlTarget(card(), { lost: true }), null)
})

test('the worker’s "gone" answers are recognised, other failures are not', () => {
  assert.equal(isAgentRunGoneError(new Error('Run run_3 is no longer running.')), true)
  assert.equal(isAgentRunGoneError(new Error('Unknown run: run_3')), true)
  assert.equal(isAgentRunGoneError(new Error('Run run_3 (Wrapper) has already finished.')), true)
  assert.equal(
    isAgentRunGoneError(
      new Error("Error invoking remote method 'agent:steerRun': Error: Unknown run: run_3")
    ),
    true
  )
  assert.equal(isAgentRunGoneError(new Error('消息过长')), false)
  assert.equal(isAgentRunGoneError('nope'), false)
})

test('the status line says a background run is running in the background', () => {
  assert.equal(agentRunStatusText(card()), '运行中')
  assert.equal(agentRunStatusText(card({ background: true })), '后台运行中')
  assert.equal(agentRunStatusText(card({ background: true, status: 'done' })), '完成')
  assert.equal(agentRunStatusText(card({ status: 'error' })), '失败')
  assert.equal(agentRunStatusText(card({ status: 'done', cancelled: true })), '已取消')
  assert.equal(agentRunStatusText(card(), { lost: true }), '已中断')
})
