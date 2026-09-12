import assert from 'node:assert/strict'
import test from 'node:test'
import {
  chatItemsFromSessionMessages,
  extractNotebookToolSummary,
  extractToolText,
  extractWrapperPlanId,
  isNotebookToolName,
  isWrapperToolName
} from '../src/renderer/src/lib/chatItems'

test('isWrapperToolName recognizes wrapper.<id> execute tool names only', () => {
  assert.equal(isWrapperToolName('wrapper.phi_ngs_fastq_qc'), true)
  assert.equal(isWrapperToolName('bash'), false)
  assert.equal(isWrapperToolName('wrap.per'), false)
})

test('isWrapperToolName excludes wrapper.search/wrapper.inspect — they never produce a planId, so routing them through WrapperPlanCard would strand the card on "正在加载计划…" forever', () => {
  assert.equal(isWrapperToolName('wrapper.search'), false)
  assert.equal(isWrapperToolName('wrapper.inspect'), false)
})

test('extractWrapperPlanId reads the P1.8 wrapper.* tool result convention', () => {
  assert.equal(
    extractWrapperPlanId({
      content: [{ type: 'text', text: 'Plan created' }],
      details: { kind: 'wrapper_plan', planId: 'wplan_abc123' }
    }),
    'wplan_abc123'
  )
})

test('extractWrapperPlanId ignores results that are not the wrapper_plan shape', () => {
  assert.equal(extractWrapperPlanId(undefined), undefined)
  assert.equal(extractWrapperPlanId({ content: [] }), undefined)
  assert.equal(
    extractWrapperPlanId({ details: { kind: 'something_else', planId: 'x' } }),
    undefined
  )
  assert.equal(extractWrapperPlanId({ details: { kind: 'wrapper_plan' } }), undefined)
})

test('isNotebookToolName recognizes notebook.* tools only', () => {
  assert.equal(isNotebookToolName('notebook.run_cell'), true)
  assert.equal(isNotebookToolName('notebook.save'), true)
  assert.equal(isNotebookToolName('jupyter.run_cell'), false)
  assert.equal(isNotebookToolName('bash'), false)
})

test('extractNotebookToolSummary keeps notebook tool receipts compact', () => {
  assert.deepEqual(
    extractNotebookToolSummary({
      content: [{ type: 'text', text: 'Ran Cell 2' }],
      details: {
        kind: 'notebook_cell_executed',
        path: '/workspace/eda.ipynb',
        relativePath: 'eda.ipynb',
        summary: 'Ran Cell 2',
        cell: {
          id: 'cell-2',
          cellType: 'code',
          source: 'large source should not be copied'
        },
        execution: {
          state: 'idle',
          executionCount: 4,
          outputs: [{ text: 'large output should not be copied' }]
        },
        document: { cells: new Array(100).fill({}) }
      }
    }),
    {
      kind: 'notebook_cell_executed',
      path: '/workspace/eda.ipynb',
      relativePath: 'eda.ipynb',
      cellId: 'cell-2',
      cellType: 'code',
      executionState: 'idle',
      executionCount: 4,
      summary: 'Ran Cell 2'
    }
  )
})

test('extractToolText returns strings unchanged', () => {
  assert.equal(extractToolText('plain output'), 'plain output')
})

test('extractToolText reads output and text properties from objects', () => {
  assert.equal(extractToolText({ output: 'stdout text' }), 'stdout text')
  assert.equal(extractToolText({ text: 'result text' }), 'result text')
})

test('extractToolText joins text from top-level content arrays', () => {
  assert.equal(
    extractToolText([
      { type: 'text', text: 'first line\n' },
      { type: 'image', data: 'ignored' },
      { text: 'second line' }
    ]),
    'first line\nsecond line'
  )
})

test('extractToolText joins text from object content arrays', () => {
  assert.equal(
    extractToolText({
      content: [
        { type: 'text', text: 'restored ' },
        { type: 'input_text', text: 'tool output' },
        { type: 'image', data: 'ignored' }
      ]
    }),
    'restored tool output'
  )
})

test('extractToolText handles non-text inputs without throwing', () => {
  assert.equal(extractToolText(null), '')
  assert.equal(extractToolText(undefined), '')
  assert.equal(extractToolText(42), '42')
  assert.equal(extractToolText([{ type: 'image', data: 'ignored' }]), '')
  assert.equal(extractToolText({ content: [{ type: 'image', data: 'ignored' }] }), '')
  assert.equal(
    extractToolText({ content: [{ type: 'image', data: 'ignored' }], output: 'fallback' }),
    'fallback'
  )
})

test('chatItemsFromSessionMessages restores tool result content arrays as plain output', () => {
  const items = chatItemsFromSessionMessages([
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'call-1',
          name: 'shell',
          arguments: { command: 'pwd' }
        }
      ]
    },
    {
      role: 'toolResult',
      toolCallId: 'call-1',
      content: [{ type: 'text', text: '/tmp/project\n' }]
    }
  ])

  assert.equal(items.length, 1)
  assert.equal(items[0].role, 'tool')
  assert.equal(items[0].output, '/tmp/project\n')
})

test('chatItemsFromSessionMessages restores Phi tool and approval timeline events', () => {
  const items = chatItemsFromSessionMessages([
    {
      source: 'phi',
      type: 'tool_call_started',
      eventId: 'event-1',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'npm test' }
    },
    {
      source: 'phi',
      type: 'tool_call_completed',
      eventId: 'event-2',
      toolCallId: 'call-1',
      toolName: 'bash',
      output: 'preview',
      outputPath: '/tmp/out.txt',
      outputBytes: 120000,
      outputTruncated: true,
      outputArtifact: { kind: 'tool_output', path: '/tmp/out.txt', bytes: 120000 },
      isError: false
    },
    {
      source: 'phi',
      type: 'approval_denied',
      eventId: 'event-3'
    }
  ])

  assert.deepEqual(items, [
    {
      id: 'call-1',
      role: 'tool',
      toolName: 'bash',
      argsPreview: 'npm test',
      argsJson: '{\n  "command": "npm test"\n}',
      output: 'preview',
      outputPath: '/tmp/out.txt',
      outputBytes: 120000,
      outputTruncated: true,
      outputArtifact: { kind: 'tool_output', path: '/tmp/out.txt', bytes: 120000 },
      status: 'done'
    },
    { id: 'event-3', role: 'error', content: '权限请求已拒绝。' }
  ])
})

test('chatItemsFromSessionMessages restores notebook details from Phi timeline events', () => {
  const items = chatItemsFromSessionMessages([
    {
      source: 'phi',
      type: 'tool_call_started',
      eventId: 'event-1',
      toolCallId: 'call-1',
      toolName: 'notebook.run_cell',
      args: { path: 'eda.ipynb', cellId: 'cell-2' },
      createdAt: '2026-09-10T00:00:00.000Z'
    },
    {
      source: 'phi',
      type: 'tool_call_completed',
      eventId: 'event-2',
      toolCallId: 'call-1',
      toolName: 'notebook.run_cell',
      output: 'Ran Cell 2',
      details: {
        kind: 'notebook_cell_executed',
        relativePath: 'eda.ipynb',
        cellId: 'cell-2',
        cellType: 'code',
        executionState: 'idle',
        executionCount: 7,
        summary: 'Ran Cell 2'
      },
      isError: false,
      createdAt: '2026-09-10T00:00:01.000Z'
    }
  ])

  assert.equal(items.length, 1)
  assert.equal(items[0].role, 'tool')
  assert.deepEqual(items[0].notebook, {
    kind: 'notebook_cell_executed',
    relativePath: 'eda.ipynb',
    cellId: 'cell-2',
    cellType: 'code',
    executionState: 'idle',
    executionCount: 7,
    summary: 'Ran Cell 2'
  })
})

test('chatItemsFromSessionMessages restores notebook details from runtime tool results', () => {
  const items = chatItemsFromSessionMessages([
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'call-1',
          name: 'notebook.update_cell',
          arguments: { path: 'eda.ipynb', cellId: 'cell-1', source: 'df.head()' }
        }
      ]
    },
    {
      role: 'toolResult',
      toolCallId: 'call-1',
      content: {
        content: [{ type: 'text', text: 'Updated Cell 1' }],
        details: {
          kind: 'notebook_cell_updated',
          relativePath: 'eda.ipynb',
          cellId: 'cell-1',
          cellType: 'code',
          summary: 'Updated Cell 1'
        }
      }
    }
  ])

  assert.equal(items.length, 1)
  assert.equal(items[0].role, 'tool')
  assert.deepEqual(items[0].notebook, {
    kind: 'notebook_cell_updated',
    relativePath: 'eda.ipynb',
    cellId: 'cell-1',
    cellType: 'code',
    summary: 'Updated Cell 1'
  })
})

test('chatItemsFromSessionMessages restores run failure details', () => {
  const items = chatItemsFromSessionMessages([
    {
      source: 'phi',
      type: 'run_failed',
      eventId: 'event-failed',
      errorMessage:
        '401 Invalid Authentication\nInvalid Authentication (type=invalid_authentication_error)'
    }
  ])

  assert.deepEqual(items, [
    {
      id: 'event-failed',
      role: 'error',
      content:
        '401 Invalid Authentication\nInvalid Authentication (type=invalid_authentication_error)'
    }
  ])
})

test('chatItemsFromSessionMessages deduplicates equivalent run failure errors', () => {
  const items = chatItemsFromSessionMessages([
    {
      source: 'phi',
      type: 'run_failed',
      eventId: 'event-failed-1',
      runId: 'run-1',
      errorMessage: '404 Not found the model kimi-k2.5 or Permission denied',
      createdAt: '2026-09-07T00:00:10.000Z'
    },
    {
      source: 'phi',
      type: 'run_failed',
      eventId: 'event-failed-2',
      runId: 'run-1',
      errorMessage: '404 Not found the model kimi-k2.5 or Permission denied',
      createdAt: '2026-09-07T00:00:11.000Z'
    }
  ])

  assert.equal(items.filter((item) => item.role === 'error').length, 1)
  assert.deepEqual(
    items.filter((item) => item.role === 'error'),
    [
      {
        id: 'event-failed-1',
        role: 'error',
        runId: 'run-1',
        content: '404 Not found the model kimi-k2.5 or Permission denied',
        createdAt: '2026-09-07T00:00:10.000Z'
      }
    ]
  )
  assert.equal(items.filter((item) => item.role === 'run').length, 2)
})

test('chatItemsFromSessionMessages keeps equivalent errors from different runs', () => {
  const items = chatItemsFromSessionMessages([
    {
      source: 'phi',
      type: 'run_failed',
      eventId: 'event-failed-1',
      runId: 'run-1',
      errorMessage: '404 Not found the model kimi-k2.5 or Permission denied',
      createdAt: '2026-09-07T00:00:10.000Z'
    },
    {
      source: 'phi',
      type: 'run_failed',
      eventId: 'event-failed-2',
      runId: 'run-2',
      errorMessage: '404 Not found the model kimi-k2.5 or Permission denied',
      createdAt: '2026-09-07T00:01:10.000Z'
    }
  ])

  assert.deepEqual(
    items.filter((item) => item.role === 'error'),
    [
      {
        id: 'event-failed-1',
        role: 'error',
        runId: 'run-1',
        content: '404 Not found the model kimi-k2.5 or Permission denied',
        createdAt: '2026-09-07T00:00:10.000Z'
      },
      {
        id: 'event-failed-2',
        role: 'error',
        runId: 'run-2',
        content: '404 Not found the model kimi-k2.5 or Permission denied',
        createdAt: '2026-09-07T00:01:10.000Z'
      }
    ]
  )
})

test('chatItemsFromSessionMessages falls back for run failures without details', () => {
  const items = chatItemsFromSessionMessages([
    {
      source: 'phi',
      type: 'run_failed',
      eventId: 'event-failed'
    }
  ])

  assert.deepEqual(items, [{ id: 'event-failed', role: 'error', content: '运行失败。' }])
})

test('chatItemsFromSessionMessages restores Phi text timeline and skips duplicate runtime messages', () => {
  const items = chatItemsFromSessionMessages([
    { role: 'user', content: [{ type: 'text', text: 'phi user' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'phi assistant' }] },
    {
      source: 'phi',
      preferPhiTimeline: true,
      type: 'user_message',
      eventId: 'event-user',
      content: 'phi user'
    },
    {
      source: 'phi',
      preferPhiTimeline: true,
      type: 'assistant_message_finalized',
      eventId: 'event-assistant',
      content: 'phi assistant'
    }
  ])

  assert.deepEqual(items, [
    { id: 'event-user', role: 'user', content: 'phi user' },
    { id: 'event-assistant', role: 'assistant', content: 'phi assistant' }
  ])
})

test('chatItemsFromSessionMessages skips assistant placeholder dots', () => {
  const items = chatItemsFromSessionMessages([
    { role: 'assistant', content: [{ type: 'text', text: '.' }] },
    {
      source: 'phi',
      preferPhiTimeline: true,
      type: 'assistant_message_finalized',
      eventId: 'event-placeholder',
      content: '.'
    },
    {
      source: 'phi',
      preferPhiTimeline: true,
      type: 'assistant_message_finalized',
      eventId: 'event-answer',
      content: '正常回复。'
    }
  ])

  assert.deepEqual(items, [{ id: 'event-answer', role: 'assistant', content: '正常回复。' }])
})

test('chatItemsFromSessionMessages keeps runtime history that is missing from Phi timeline', () => {
  const items = chatItemsFromSessionMessages([
    { role: 'user', content: [{ type: 'text', text: 'older user question' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'older assistant answer' }] },
    { role: 'user', content: [{ type: 'text', text: 'phi user' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'phi assistant' }] },
    {
      source: 'phi',
      preferPhiTimeline: true,
      type: 'user_message',
      eventId: 'event-user',
      content: 'phi user'
    },
    {
      source: 'phi',
      preferPhiTimeline: true,
      type: 'assistant_message_finalized',
      eventId: 'event-assistant',
      content: 'phi assistant'
    }
  ])

  assert.deepEqual(items, [
    { id: 'user-0', role: 'user', content: 'older user question' },
    { id: 'assistant-1', role: 'assistant', content: 'older assistant answer' },
    { id: 'event-user', role: 'user', content: 'phi user' },
    { id: 'event-assistant', role: 'assistant', content: 'phi assistant' }
  ])
})

test('chatItemsFromSessionMessages skips the runtime suffix covered by the Phi timeline', () => {
  const items = chatItemsFromSessionMessages([
    { role: 'user', content: [{ type: 'text', text: 'older user question' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'older assistant answer' }] },
    { role: 'user', content: [{ type: 'text', text: 'current question' }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'runtime thinking that should not render first' },
        {
          type: 'toolCall',
          id: 'call-runtime',
          name: 'bash',
          arguments: { command: 'date' }
        },
        { type: 'text', text: 'current answer' }
      ]
    },
    {
      role: 'toolResult',
      toolCallId: 'call-runtime',
      content: [{ type: 'text', text: 'runtime output' }]
    },
    {
      source: 'phi',
      preferPhiTimeline: true,
      type: 'user_message',
      eventId: 'event-user',
      runId: 'run-current',
      content: 'current question'
    },
    {
      source: 'phi',
      preferPhiTimeline: true,
      type: 'assistant_thinking_completed',
      eventId: 'event-thinking',
      runId: 'run-current',
      content: 'persisted thinking',
      durationMs: 3000
    },
    {
      source: 'phi',
      preferPhiTimeline: true,
      type: 'assistant_message_finalized',
      eventId: 'event-assistant',
      runId: 'run-current',
      content: 'current answer'
    }
  ])

  assert.deepEqual(items, [
    { id: 'user-0', role: 'user', content: 'older user question' },
    { id: 'assistant-1', role: 'assistant', content: 'older assistant answer' },
    { id: 'event-user', role: 'user', content: 'current question' },
    {
      id: 'event-thinking',
      role: 'thinking',
      content: 'persisted thinking',
      durationMs: 3000
    },
    { id: 'event-assistant', role: 'assistant', content: 'current answer' }
  ])
})

test('chatItemsFromSessionMessages restores Phi thinking timeline events', () => {
  const items = chatItemsFromSessionMessages([
    {
      source: 'phi',
      preferPhiTimeline: true,
      type: 'assistant_thinking_completed',
      eventId: 'event-thinking',
      content: 'Inspect project state first.',
      durationMs: 4000
    },
    {
      source: 'phi',
      preferPhiTimeline: true,
      type: 'assistant_message_finalized',
      eventId: 'event-assistant',
      content: 'Done.'
    }
  ])

  assert.deepEqual(items, [
    {
      id: 'event-thinking',
      role: 'thinking',
      content: 'Inspect project state first.',
      durationMs: 4000
    },
    { id: 'event-assistant', role: 'assistant', content: 'Done.' }
  ])
})

test('chatItemsFromSessionMessages restores Phi run lifecycle timestamps as hidden metadata', () => {
  const items = chatItemsFromSessionMessages([
    {
      source: 'phi',
      preferPhiTimeline: true,
      type: 'run_started',
      eventId: 'event-start',
      runId: 'run-1',
      createdAt: '2026-09-07T00:00:00.000Z'
    },
    {
      source: 'phi',
      preferPhiTimeline: true,
      type: 'assistant_message_finalized',
      eventId: 'event-assistant',
      runId: 'run-1',
      content: 'Done.',
      createdAt: '2026-09-07T00:00:10.000Z'
    },
    {
      source: 'phi',
      preferPhiTimeline: true,
      type: 'run_completed',
      eventId: 'event-end',
      runId: 'run-1',
      createdAt: '2026-09-07T00:00:12.000Z',
      durationMs: 12000
    }
  ])

  assert.deepEqual(items, [
    {
      id: 'run-event-start',
      role: 'run',
      event: 'started',
      runId: 'run-1',
      createdAt: '2026-09-07T00:00:00.000Z'
    },
    {
      id: 'event-assistant',
      role: 'assistant',
      content: 'Done.',
      createdAt: '2026-09-07T00:00:10.000Z'
    },
    {
      id: 'run-event-end',
      role: 'run',
      event: 'completed',
      runId: 'run-1',
      createdAt: '2026-09-07T00:00:12.000Z',
      durationMs: 12000
    }
  ])
})

test('chatItemsFromSessionMessages restores context compaction notices', () => {
  const items = chatItemsFromSessionMessages([
    {
      source: 'phi',
      type: 'context_compacted',
      eventId: 'event-compact',
      shortSummary: 'Earlier work summarized.'
    },
    {
      source: 'phi',
      type: 'context_compaction_failed',
      eventId: 'event-compact-failed',
      errorMessage: 'provider rejected summary'
    }
  ])

  assert.equal(items[0].role, 'warning')
  assert.match(items[0].content, /上下文已压缩/)
  assert.match(items[0].content, /Earlier work summarized/)
  assert.deepEqual(items[1], {
    id: 'event-compact-failed',
    role: 'error',
    content: '上下文压缩失败：provider rejected summary'
  })
})

test('chatItemsFromSessionMessages restores model selection migration notices', () => {
  const items = chatItemsFromSessionMessages([
    {
      source: 'phi',
      type: 'model_selection_migrated',
      eventId: 'event-model-migrated',
      fromProviderId: 'kimi-code',
      fromModelId: 'kimi-k2.5',
      toProviderId: 'kimi-code',
      toModelId: 'kimi-for-coding',
      toModelName: 'K2.7 Coding'
    }
  ])

  assert.deepEqual(items, [
    {
      id: 'event-model-migrated',
      role: 'warning',
      content: 'kimi-code/kimi-k2.5 当前不可用，已切换到 kimi-code/kimi-for-coding。'
    }
  ])
})
