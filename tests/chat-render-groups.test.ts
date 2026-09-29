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

test('an active turn shows an earlier wrapper plan only once', () => {
  const groups = groupMessages(
    [
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
      },
      {
        id: 'tool-2',
        role: 'tool',
        toolName: 'read',
        argsPreview: '{}',
        argsJson: '{}',
        output: 'reading',
        status: 'running'
      }
    ],
    { activeRun: true }
  )

  assert.equal(groups.filter((group) => group.key === 'plan-1').length, 1)
})

test('chat render groups keep file changes visible after the processing fold', () => {
  const messages: ChatItem[] = [
    { id: 'user-1', role: 'user', content: 'edit result' },
    { id: 'run-start', role: 'run', event: 'started', createdAt: '2026-09-11T00:00:00.000Z' },
    {
      id: 'tool-1',
      role: 'tool',
      toolName: 'edit',
      argsPreview: '{}',
      argsJson: '{}',
      output: 'done',
      status: 'done'
    },
    { id: 'run-end', role: 'run', event: 'completed', createdAt: '2026-09-11T00:00:01.000Z' },
    {
      id: 'changes-1',
      role: 'workspace_changes',
      files: [
        {
          path: '/project/result.txt',
          displayPath: 'result.txt',
          status: 'modified',
          added: 1,
          deleted: 0
        }
      ],
      totalChanged: 1,
      truncated: false
    }
  ]
  const groups = groupMessages(messages)
  assert.equal(groups.at(-1)?.kind, 'single')
  assert.equal(groups.at(-1)?.key, 'changes-1')
})

test('chat render groups keep delivered files outside the processing fold', () => {
  const groups = groupMessages([
    { id: 'user-1', role: 'user', content: 'make a report' },
    {
      id: 'tool-1',
      role: 'tool',
      toolName: 'present_files',
      argsPreview: '',
      argsJson: '',
      output: 'done',
      status: 'done'
    },
    {
      id: 'delivery-1',
      role: 'presented_files',
      files: [{ path: '/project/report.pdf', displayPath: 'report.pdf', bytes: 123 }]
    },
    { id: 'assistant-1', role: 'assistant', content: 'Report ready.' }
  ])
  assert.equal(groups.find((group) => group.key === 'delivery-1')?.kind, 'single')
  assert.equal(groups.at(-1)?.key, 'delivery-1')
})

test('file deliveries remain at the turn tail when a later tool call follows their event', () => {
  const groups = groupMessages([
    { id: 'user-1', role: 'user', content: 'make a figure' },
    { id: 'assistant-summary', role: 'assistant', content: 'The figure is ready.' },
    {
      id: 'delivery-1',
      role: 'presented_files',
      files: [{ path: '/project/figure.png', displayPath: 'figure.png', bytes: 123 }]
    },
    {
      id: 'present-tool',
      role: 'tool',
      toolName: 'present_files',
      argsPreview: '',
      argsJson: '',
      output: 'done',
      status: 'done'
    },
    { id: 'assistant-final', role: 'assistant', content: 'Everything is done.' }
  ])

  assert.equal(groups.at(-2)?.key, 'assistant-final')
  assert.equal(groups.at(-1)?.key, 'delivery-1')
})

test('changed files remain visible at the turn tail when a later tool call follows their event', () => {
  const groups = groupMessages([
    { id: 'user-1', role: 'user', content: 'edit a file' },
    {
      id: 'changes-1',
      role: 'workspace_changes',
      files: [{ path: '/project/data.tsv', displayPath: 'data.tsv', status: 'modified' }],
      totalChanged: 1,
      truncated: false
    },
    {
      id: 'tool-1',
      role: 'tool',
      toolName: 'read',
      argsPreview: '',
      argsJson: '',
      output: 'done',
      status: 'done'
    },
    { id: 'assistant-final', role: 'assistant', content: 'Updated.' }
  ])

  assert.equal(groups.at(-1)?.key, 'changes-1')
})

test('chat render groups keep a reviewed plan outside the processing fold', () => {
  const groups = groupMessages([
    { id: 'user-1', role: 'user', content: 'plan first' },
    {
      id: 'tool-1',
      role: 'tool',
      toolName: 'write',
      argsPreview: '',
      argsJson: '',
      output: '',
      status: 'done'
    },
    {
      id: 'plan-1',
      role: 'plan_review',
      reviewId: 'review-1',
      title: 'Analysis',
      content: '# Analysis',
      planFilePath: 'local://analysis-plan.md',
      status: 'approved'
    }
  ])
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
