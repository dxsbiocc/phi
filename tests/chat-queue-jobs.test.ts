import assert from 'node:assert/strict'
import test from 'node:test'
import type { AssistantInboxEntry } from '../src/main/session-runtime/assistant-inbox'
import { projectChatQueueJobs } from '../src/main/session-runtime/chat-queue-jobs'

function entry(
  id: string,
  status: AssistantInboxEntry['status'],
  projectId = 'project'
): AssistantInboxEntry {
  return {
    id,
    requestId: id,
    scope: { conversationId: 'session', projectId },
    order: 0,
    status,
    text: 'Preview\napi_key=fixture-secret {"api_key":"fixture-key","password":"fixture pass"}',
    attachments: [{ mimeType: 'image/png', bytes: 4, digest: 'a'.repeat(64) }],
    ...(status === 'failed' ? { settledAt: Date.parse('2026-11-19T06:00:00Z') } : {}),
    ...(status === 'queued' ? { submittedAt: Date.parse('2026-11-19T05:00:00Z') } : {})
  }
}

test('projects the four queue statuses with bounded display data for the current owner only', () => {
  const calls: string[] = []
  const rows = projectChatQueueJobs(
    [
      entry('queued', 'queued'),
      entry('running', 'running'),
      entry('failed', 'failed'),
      entry('interrupted', 'interrupted'),
      entry('cancelled', 'cancelled'),
      entry('finished', 'succeeded'),
      entry('rebound', 'failed', 'other-project'),
      {
        ...entry('removed', 'interrupted'),
        scope: { conversationId: 'removed', projectId: 'project' }
      }
    ],
    (sessionId) => {
      calls.push(sessionId)
      return sessionId === 'session'
        ? { projectId: 'project', title: 'Original chat', createdAt: '2026-11-18T06:00:00Z' }
        : null
    }
  )
  assert.deepEqual(calls, ['session', 'removed'])
  assert.deepEqual(
    rows.map((row) => row.id),
    ['queued', 'running', 'failed', 'interrupted']
  )
  const [first, , failed] = rows
  assert.deepEqual(first, {
    id: 'queued',
    sessionId: 'session',
    sessionPath: 'phi-session:session',
    title: 'Original chat',
    preview: 'Preview api_key=[redacted] {"api_key":"[redacted]","password":"[redacted]"}',
    imageCount: 1,
    status: 'queued',
    timestamp: '2026-11-19T05:00:00.000Z'
  })
  assert.equal(failed.timestamp, '2026-11-19T06:00:00.000Z')
  assert.doesNotMatch(
    JSON.stringify(rows),
    /fixture-secret|fixture-key|fixture pass|digest|requestId/
  )
})
