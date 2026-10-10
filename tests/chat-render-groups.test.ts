import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activeProcessingGroupIndex,
  groupMessages,
  processingStatusText,
  type ProcessingItem
} from '../src/renderer/src/lib/chatRenderGroups'
import type { ChatItem } from '../src/renderer/src/types'

test('an error card does not make a still running turn look completed', () => {
  const groups = groupMessages(
    [
      { id: 'user-1', role: 'user', content: '测试连接' },
      { id: 'run-1', role: 'run', event: 'started', createdAt: '2026-09-29T00:00:00.000Z' },
      { id: 'error-1', role: 'error', content: 'Provider unavailable' }
    ],
    { activeRun: true }
  )

  assert.equal(groups.at(-1)?.key, 'error-1')
  assert.equal(groups[activeProcessingGroupIndex(groups, true)]?.kind, 'processing-group')
  assert.equal(activeProcessingGroupIndex(groups, false), -1)
})

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

test('chat render groups keep ui blocks inline outside the processing fold', () => {
  const groups = groupMessages(
    [
      { id: 'user-1', role: 'user', content: 'show QC' },
      {
        id: 'tool-1',
        role: 'tool',
        toolName: 'render_blocks',
        argsPreview: '',
        argsJson: '',
        output: 'done',
        status: 'done'
      },
      {
        id: 'ui-blocks-tool-1',
        role: 'ui_blocks',
        blocks: [{ type: 'metrics', items: [{ label: '样本数', value: 12 }] }]
      },
      { id: 'assistant-1', role: 'assistant', content: '质控完成。' }
    ],
    { activeRun: true }
  )

  const uiGroup = groups.find((group) => group.key === 'ui-blocks-tool-1')
  assert.equal(uiGroup?.kind, 'single')
  assert.equal(
    groups.some(
      (group) =>
        group.kind === 'processing-group' &&
        group.items.some((item) => item.id === 'ui-blocks-tool-1')
    ),
    false
  )
})

test('separate PNG and PDF delivery events in one turn share a single file card', () => {
  const messages: ChatItem[] = [
    { id: 'user-1', role: 'user', content: 'make a heatmap in PNG and PDF' },
    {
      id: 'delivery-png',
      role: 'presented_files',
      runId: 'run-1',
      files: [{ path: '/project/heatmap.png', displayPath: 'heatmap.png', bytes: 302_000 }]
    },
    {
      id: 'delivery-pdf',
      role: 'presented_files',
      runId: 'run-1',
      files: [{ path: '/project/heatmap.pdf', displayPath: 'heatmap.pdf', bytes: 8_800 }]
    },
    { id: 'assistant-final', role: 'assistant', content: 'The heatmap is ready.' }
  ]

  const tool: ChatItem = {
    id: 'present-tool',
    role: 'tool',
    toolName: 'present_files',
    argsPreview: '',
    argsJson: '',
    output: 'done',
    status: 'done'
  }
  for (const withTool of [false, true]) {
    for (const activeRun of [false, true]) {
      const groups = groupMessages(withTool ? [...messages, tool] : messages, { activeRun })
      const deliveries = groups.flatMap((group) =>
        group.kind === 'single' && group.item.role === 'presented_files' ? [group.item] : []
      )
      assert.equal(deliveries.length, 1)
      assert.deepEqual(
        deliveries[0].files.map((file) => file.displayPath),
        ['heatmap.png', 'heatmap.pdf']
      )
      assert.equal(groups.at(-1)?.key, 'delivery-png')
    }
  }
})

test('delivery grouping preserves turn and run boundaries, including legacy receipts', () => {
  const delivery = (id: string, runId?: string): ChatItem => ({
    id,
    role: 'presented_files',
    runId,
    files: [{ path: `/project/${id}.pdf`, displayPath: `${id}.pdf`, bytes: 123 }]
  })
  const groups = groupMessages([
    { id: 'user-1', role: 'user', content: 'first report' },
    delivery('legacy-1'),
    delivery('legacy-2'),
    { id: 'user-2', role: 'user', content: 'second report' },
    delivery('legacy-3'),
    delivery('delivery-1', 'run-1'),
    delivery('delivery-2', 'run-2')
  ])
  const deliveries = groups.flatMap((group) =>
    group.kind === 'single' && group.item.role === 'presented_files' ? [group.item] : []
  )

  assert.deepEqual(
    deliveries.map((item) => item.files.map((file) => file.displayPath)),
    [['legacy-1.pdf', 'legacy-2.pdf'], ['legacy-3.pdf'], ['delivery-1.pdf'], ['delivery-2.pdf']]
  )
})

test('repeated deliveries show the latest file metadata once without mutating history', () => {
  const messages: ChatItem[] = [
    {
      id: 'delivery-1',
      role: 'presented_files',
      runId: 'run-1',
      files: [{ path: '/project/report.pdf', displayPath: 'report.pdf', bytes: 100 }]
    },
    {
      id: 'changes-1',
      role: 'workspace_changes',
      files: [
        {
          path: '/project/report.pdf',
          displayPath: 'report.pdf',
          status: 'modified',
          added: 1,
          deleted: 0
        }
      ],
      totalChanged: 1,
      truncated: false
    },
    {
      id: 'delivery-2',
      role: 'presented_files',
      runId: 'run-1',
      files: [
        {
          path: '/project/report.pdf',
          displayPath: 'report.pdf',
          bytes: 200,
          description: 'Revised'
        },
        { path: '/project/report.png', displayPath: 'report.png', bytes: 300 }
      ]
    }
  ]
  const original = structuredClone(messages)
  const groups = groupMessages(messages)
  const delivery = groups[0]

  assert.deepEqual(
    groups.map((group) => group.key),
    ['delivery-1', 'changes-1']
  )
  assert.ok(delivery.kind === 'single' && delivery.item.role === 'presented_files')
  assert.deepEqual(delivery.item.files, [
    { path: '/project/report.pdf', displayPath: 'report.pdf', bytes: 200, description: 'Revised' },
    { path: '/project/report.png', displayPath: 'report.png', bytes: 300 }
  ])
  assert.deepEqual(messages, original)
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
