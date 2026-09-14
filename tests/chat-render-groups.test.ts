import assert from 'node:assert/strict'
import test from 'node:test'
import {
  groupMessages,
  processingStatusText,
  type ProcessingItem
} from '../src/renderer/src/lib/chatRenderGroups'
import type { ChatItem } from '../src/renderer/src/types'

test('chat render groups leave wrapper plans as persistent artifacts', () => {
  const messages: ChatItem[] = [
    { id: 'user-1', role: 'user', content: 'run wrapper' },
    {
      id: 'tool-1',
      role: 'tool',
      toolName: 'wrapper.fastq_qc',
      argsPreview: '{}',
      argsJson: '{}',
      output: 'planning',
      status: 'done'
    },
    {
      id: 'plan-1',
      role: 'wrapper_plan',
      toolName: 'wrapper.fastq_qc',
      planId: 'plan-1',
      status: 'done'
    }
  ]

  const groups = groupMessages(messages)

  assert.equal(groups.at(-1)?.kind, 'single')
  assert.equal(groups.at(-1)?.key, 'plan-1')
})

test('chat render groups keep streaming assistant text inside active processing turns', () => {
  const messages: ChatItem[] = [
    { id: 'user-1', role: 'user', content: 'do it' },
    { id: 'run-1', role: 'run', event: 'started', createdAt: '2026-09-11T00:00:00.000Z' },
    {
      id: 'tool-1',
      role: 'tool',
      toolName: 'bash',
      argsPreview: '{}',
      argsJson: '{}',
      output: 'working',
      status: 'running'
    },
    { id: 'assistant-1', role: 'assistant', content: 'still streaming' }
  ]

  const processing = groupMessages(messages, { activeRun: true }).find(
    (group) => group.kind === 'processing-group'
  )

  assert.equal(processing?.kind, 'processing-group')
  assert.deepEqual(
    processing?.items.map((item) => item.id),
    ['tool-1', 'assistant-1']
  )
})

test('chat render groups keep active processing key stable as stream items arrive', () => {
  const pending = groupMessages(
    [
      { id: 'user-1', role: 'user', content: 'do it' },
      {
        id: 'run-start-1',
        role: 'run',
        event: 'started',
        runId: 'run-1',
        createdAt: '2026-09-11T00:00:00.000Z'
      }
    ],
    { activeRun: true }
  ).find((group) => group.kind === 'processing-group')

  const streaming = groupMessages(
    [
      { id: 'user-1', role: 'user', content: 'do it' },
      {
        id: 'run-start-1',
        role: 'run',
        event: 'started',
        runId: 'run-1',
        createdAt: '2026-09-11T00:00:00.000Z'
      },
      {
        id: 'thinking-1',
        role: 'thinking',
        content: 'checking',
        createdAt: '2026-09-11T00:00:02.000Z'
      }
    ],
    { activeRun: true }
  ).find((group) => group.kind === 'processing-group')

  assert.equal(pending?.kind, 'processing-group')
  assert.equal(streaming?.kind, 'processing-group')
  assert.equal(pending?.key, 'processing-run-1')
  assert.equal(streaming?.key, pending?.key)
})

test('processing status text uses stored terminal duration before timestamps', () => {
  const items: ProcessingItem[] = [
    {
      id: 'tool-1',
      role: 'tool',
      toolName: 'bash',
      argsPreview: '{}',
      argsJson: '{}',
      output: 'done',
      status: 'done',
      durationMs: 90_000
    }
  ]

  assert.equal(
    processingStatusText({
      items,
      isActive: false,
      nowMs: Date.parse('2026-09-11T00:02:00.000Z'),
      fallbackStartedAtMs: Date.parse('2026-09-11T00:00:00.000Z'),
      durationMs: 90_000
    }),
    '已完成，总共用时 1 分钟 30 秒'
  )
})
