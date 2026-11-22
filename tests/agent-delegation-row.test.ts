import assert from 'node:assert/strict'
import test from 'node:test'
import { chatItemsFromSessionMessages } from '../src/renderer/src/lib/chatItems'
import {
  createAgentEventReducerState,
  reduceAgentEventState
} from '../src/renderer/src/lib/agentEventReducer'
import type { AgentEventSummary, ChatItem } from '../src/renderer/src/types'

const runId = 'parent-run'
const createdAt = '2026-11-19T12:52:37.336Z'
const completedAt = '2026-11-19T12:52:52.620Z'
const previewAt = '2026-11-19T12:52:37.331Z'
const args = { task: 'Check sample pairing' }
const agentName = 'DifferentialExpression'
const child = { runId, toolCallId: 'child-first', agentName }
const start = { ...child, type: 'agent_execution_started', args, task: args.task, createdAt }
const end = {
  ...child,
  type: 'agent_execution_completed',
  createdAt: completedAt,
  finalReport: 'Checked.'
}
const other = { runId, toolCallId: 'child-second', agentName }

function assertTwoDelegations(items: ChatItem[]): void {
  const rows = items.filter((item) => item.role === 'agent_execution' || item.role === 'tool')
  assert.deepEqual(
    rows.map((item) => [item.id, item.role, item.status]),
    [
      [child.toolCallId, 'agent_execution', 'done'],
      [other.toolCallId, 'agent_execution', 'running'],
      ['ordinary', 'tool', 'running']
    ]
  )
  const first = rows[0]
  assert.equal(first.role, 'agent_execution')
  assert.equal(first.task, args.task)
  assert.equal(first.durationMs, 15284)
  assert.equal(first.finalReport, 'Checked.')
}

test('live partial tool calls become one specialist row that stops before the parent finishes', () => {
  const preview: AgentEventSummary = {
    type: 'message_update',
    runId,
    createdAt: previewAt,
    message: { role: 'assistant' },
    assistantMessageEvent: {
      type: 'toolcall_start',
      partial: {
        content: [{ type: 'toolCall', id: child.toolCallId, name: agentName, arguments: {} }]
      }
    }
  }
  const events: AgentEventSummary[] = [
    preview,
    start,
    { ...start, ...other },
    { type: 'tool_execution_start', toolCallId: 'ordinary', toolName: 'read', runId },
    end
  ]
  const state = events.reduce(reduceAgentEventState, createAgentEventReducerState())
  assertTwoDelegations(state.messages)
})

test('journal replay coalesces generic and specialist starts for the same call', () => {
  const events = [
    { ...child, type: 'tool_call_started', toolName: agentName, args, createdAt: previewAt },
    start,
    { ...start, ...other },
    { type: 'tool_call_started', toolCallId: 'ordinary', toolName: 'read', runId },
    end
  ]
  assertTwoDelegations(chatItemsFromSessionMessages(events.map((e) => ({ ...e, source: 'phi' }))))
})

test('a generic preview is replaced in place when streaming later identifies a delegation', () => {
  const preview: AgentEventSummary = {
    type: 'message_update',
    message: { role: 'assistant' },
    assistantMessageEvent: {
      type: 'toolcall_start',
      partial: { content: [{ type: 'toolCall', id: child.toolCallId, arguments: {} }] }
    },
    createdAt: previewAt
  }
  const initial = reduceAgentEventState(createAgentEventReducerState(), preview)
  assert.equal(initial.messages[0].role, 'tool')
  const events: AgentEventSummary[] = [
    {
      type: 'tool_execution_start',
      toolName: agentName,
      runId,
      toolCallId: child.toolCallId,
      args,
      createdAt
    },
    start,
    { ...end, isError: true, error: 'Invalid input' },
    {
      ...child,
      type: 'agent_execution_step',
      step: { id: 'late', toolName: 'read', status: 'error' }
    }
  ]
  const { messages } = events.reduce(reduceAgentEventState, initial)
  assert.equal(messages.length, 1)
  const [item] = messages
  assert.equal(item.role, 'agent_execution')
  assert.equal(item.status, 'error')
  assert.equal(item.durationMs, 15284)
})

test('mixed runtime and Phi history and late duplicate starts retain the finished agent card', () => {
  const runtime = {
    role: 'assistant',
    content: [{ type: 'toolCall', id: child.toolCallId, name: agentName, arguments: args }]
  }
  const history = [start, end, { ...child, type: 'tool_call_started', toolName: agentName, args }]
  const items = chatItemsFromSessionMessages([
    runtime,
    ...history.map((e) => ({ source: 'phi', ...e }))
  ])
  assert.equal(items.length, 1)
  const [item] = items
  assert.equal(item.role, 'agent_execution')
  assert.equal(item.status, 'done')
  assert.equal(item.durationMs, 15284)
})
