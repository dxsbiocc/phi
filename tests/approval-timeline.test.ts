import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import assert from 'node:assert/strict'
import test from 'node:test'
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  createAgentEventReducerState,
  reduceAgentEventState
} from '../src/renderer/src/lib/agentEventReducer'
import { chatItemsFromSessionMessages } from '../src/renderer/src/lib/chatItems'
import { ChatBubble } from '../src/renderer/src/components/chat/ChatBubble'
import ToolApprovalDialog from '../src/renderer/src/components/ToolApprovalDialog'
import { approvalItemFromEvent } from '../src/renderer/src/features/chat/lib/approvalTimeline'
import type { AgentEventSummary, ChatMessage } from '../src/renderer/src/types'

const summary = "python - <<'PY'\n" + 'print("a long command")\n'.repeat(100) + 'PY'
const requested: AgentEventSummary = {
  source: 'phi',
  type: 'approval_requested',
  eventId: 'requested-1',
  phiSessionId: 'session-1',
  runId: 'run-1',
  approvalId: 'approval-1',
  toolCallId: 'tool-1',
  toolName: 'bash',
  summary,
  createdAt: '2026-10-15T01:00:00Z'
}

function terminal(status: 'approved' | 'denied' | 'cancelled'): AgentEventSummary {
  return {
    ...requested,
    type: `approval_${status}`,
    eventId: `terminal-${status}`,
    toolName: undefined,
    summary: undefined,
    createdAt: '2026-10-15T01:00:10Z'
  }
}

function live(events: AgentEventSummary[]): ChatMessage[] {
  return events.reduce(reduceAgentEventState, createAgentEventReducerState())
    .messages as ChatMessage[]
}

// Keep the existing Chinese behavior assertions explicit; English switching has dedicated coverage.
setUiLanguage('zh-CN')

test('live and restored approval requests update one collapsed record for every terminal state', () => {
  for (const status of ['approved', 'denied', 'cancelled'] as const) {
    const events = [requested, terminal(status), terminal(status), requested]
    const restored = chatItemsFromSessionMessages(events) as ChatMessage[]
    const streamed = live(events)
    assert.deepEqual(streamed, restored)
    assert.equal(streamed.length, 1)
    assert.equal(streamed[0].id, requested.eventId)
    assert.equal(streamed[0].approval?.status, status)
    assert.equal(streamed[0].approval?.summary, summary)
    assert.equal(streamed[0].approval?.toolName, 'bash')
    assert.equal(streamed[0].createdAt, requested.createdAt)
    assert.equal(streamed[0].completedAt, terminal(status).createdAt)
    assert.doesNotMatch(streamed[0].content, /等待批准|a long command/)
  }
})

test('a terminal event arriving first retains its decision when the request arrives later', () => {
  const events = [terminal('approved'), requested, requested]
  for (const items of [live(events), chatItemsFromSessionMessages(events) as ChatMessage[]]) {
    assert.equal(items.length, 1)
    assert.equal(items[0].approval?.status, 'approved')
    assert.equal(items[0].approval?.summary, summary)
    assert.equal(items[0].createdAt, requested.createdAt)
  }
})

test('approval identity does not reconcile a conflicting session, run or tool call', () => {
  for (const identity of [
    { phiSessionId: 'other-session' },
    { runId: 'other-run' },
    { toolCallId: 'other-tool' }
  ]) {
    const events = [requested, { ...terminal('approved'), ...identity }]
    for (const items of [live(events), chatItemsFromSessionMessages(events) as ChatMessage[]]) {
      assert.equal(items.length, 2)
      assert.equal(items[0].approval?.status, 'pending')
      assert.equal(items[1].approval?.status, 'approved')
    }
  }
})

test('legacy terminal events without identity cannot resolve an unrelated pending request', () => {
  const anonymous = {
    ...requested,
    eventId: 'legacy-request',
    approvalId: undefined,
    toolCallId: undefined
  }
  const events = [anonymous, { type: 'approval_denied', source: 'phi', eventId: 'legacy-denial' }]
  for (const items of [live(events), chatItemsFromSessionMessages(events) as ChatMessage[]]) {
    assert.equal(items.length, 2)
    assert.equal(items[0].approval?.status, 'pending')
    assert.equal(items[1].content, '权限请求已拒绝。')
  }
})

test('legacy records reconcile only with the same run and tool-call identity', () => {
  const events = [requested, terminal('cancelled')].map((event) => ({
    ...event,
    approvalId: undefined
  }))
  for (const items of [live(events), chatItemsFromSessionMessages(events) as ChatMessage[]]) {
    assert.equal(items.length, 1)
    assert.equal(items[0].approval?.status, 'cancelled')
  }
})

test('a terminal without run identity never resolves one of several conflicting requests', () => {
  const events = [
    requested,
    { ...requested, eventId: 'requested-2', runId: 'run-2', toolCallId: 'tool-2' },
    { ...terminal('approved'), runId: undefined, toolCallId: undefined }
  ]
  for (const items of [live(events), chatItemsFromSessionMessages(events) as ChatMessage[]]) {
    assert.equal(items.length, 3)
    assert.deepEqual(
      items.slice(0, 2).map((item) => item.approval?.status),
      ['pending', 'pending']
    )
  }
  assert.equal(approvalItemFromEvent({ type: 'toString' }), null)
})

test('decided approval timeline stays collapsed while the pending approval shows full details and actions', () => {
  const message = live([requested, terminal('approved')])[0]
  const markup = renderToStaticMarkup(
    createElement(ChatBubble, {
      message,
      onGoSettings: () => undefined,
      onOpenBackgroundJobs: () => undefined
    })
  )
  assert.match(markup, /已批准/)
  assert.match(markup, /bash/)
  assert.match(markup, /aria-expanded="false"/)
  assert.doesNotMatch(markup, /a long command/)
  const approval = renderToStaticMarkup(
    createElement(ToolApprovalDialog, {
      request: { requestId: 'approval-1', toolName: 'bash', summary },
      onRespond: () => undefined,
      onOpenSession: () => undefined
    })
  )
  assert.match(approval, />批准</)
  assert.match(approval, />拒绝</)
  assert.match(approval, /a long command/)
})

test('pending approval retains the exact approve, refuse and open-session actions', () => {
  const actions: Array<string | boolean> = []
  let tree: ReactNode
  renderToStaticMarkup(
    createElement(function InspectApproval() {
      tree = ToolApprovalDialog({
        request: {
          requestId: 'approval-1',
          toolName: 'bash',
          summary,
          sessionPath: '/sessions/one'
        },
        onRespond: (id, approved) => actions.push(id, approved),
        onOpenSession: (path) => actions.push(path)
      })
      return null
    })
  )
  const find = (
    node: ReactNode,
    text: string
  ): ReactElement<{ onClick: () => void }> | undefined => {
    if (!isValidElement<{ children?: ReactNode; onClick: () => void }>(node)) return undefined
    if (node.props.children === text) return node
    for (const child of Children.toArray(node.props.children)) {
      const match = find(child, text)
      if (match) return match
    }
    return undefined
  }
  for (const label of ['批准', '拒绝', '打开会话']) {
    const button = find(tree, label)
    assert.ok(button, label)
    button.props.onClick()
  }
  assert.deepEqual(actions, ['approval-1', true, 'approval-1', false, '/sessions/one'])
})
