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

test('isWrapperToolName recognizes wrapper_<id> execute tool names only', () => {
  assert.equal(isWrapperToolName('wrapper_phi_ngs_fastq_qc'), true)
  assert.equal(isWrapperToolName('bash'), false)
  assert.equal(isWrapperToolName('wrap_per'), false)
})

test('session history restores declared final files as a separate card', () => {
  const items = chatItemsFromSessionMessages([
    { source: 'phi', type: 'user_message', eventId: 'user-1', content: 'make a report' },
    {
      source: 'phi',
      type: 'files_presented',
      eventId: 'delivery-1',
      runId: 'run-1',
      files: [
        {
          path: '/project/report.pdf',
          displayPath: 'report.pdf',
          bytes: 123,
          description: 'Final report'
        }
      ]
    }
  ])
  assert.equal(items.length, 2)
  assert.deepEqual(items[1], {
    id: 'delivery-1',
    role: 'presented_files',
    runId: 'run-1',
    files: [
      {
        path: '/project/report.pdf',
        displayPath: 'report.pdf',
        bytes: 123,
        description: 'Final report'
      }
    ]
  })
})

test('session history restores a reviewed plan and the user decision', () => {
  const items = chatItemsFromSessionMessages([
    {
      source: 'phi',
      type: 'plan_review_submitted',
      eventId: 'plan-event',
      reviewId: 'review-1',
      runId: 'run-1',
      title: 'Analysis',
      content: '# Analysis',
      planFilePath: 'local://analysis-plan.md'
    },
    {
      source: 'phi',
      type: 'plan_review_decided',
      reviewId: 'review-1',
      decision: 'approve'
    }
  ])
  assert.equal(items.length, 1)
  assert.equal(items[0].role, 'plan_review')
  if (items[0].role === 'plan_review') assert.equal(items[0].status, 'approved')
})

test('isWrapperToolName excludes wrapper_search/wrapper_inspect — they never produce a planId, so routing them through WrapperPlanCard would strand the card on "正在加载计划…" forever', () => {
  assert.equal(isWrapperToolName('wrapper_search'), false)
  assert.equal(isWrapperToolName('wrapper_inspect'), false)
})

test('isWrapperToolName excludes wrapper_run — it executes directly and returns wrapper_run_result, never a planId', () => {
  assert.equal(isWrapperToolName('wrapper_run'), false)
})

test('the Wrapper agent (a delegation tool named after the agent) is not a wrapper_<id> plan tool', () => {
  assert.equal(isWrapperToolName('Wrapper'), false)
})

test('extractWrapperPlanId reads the P1.8 wrapper_* tool result convention', () => {
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
          index: 1,
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
      cellNumber: 2,
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

test('chatItemsFromSessionMessages restores structured agent executions from Phi timeline events', () => {
  const items = chatItemsFromSessionMessages([
    {
      source: 'phi',
      type: 'agent_execution_started',
      eventId: 'event-agent-start',
      runId: 'run-1',
      toolCallId: 'agent-1',
      agentName: 'Wrapper',
      task: 'run fastqc',
      args: { task: 'run fastqc', apiKey: '[redacted]' },
      createdAt: '2026-09-20T00:00:00.000Z'
    },
    {
      source: 'phi',
      type: 'agent_execution_step',
      eventId: 'event-step-start',
      runId: 'run-1',
      toolCallId: 'agent-1',
      agentName: 'Wrapper',
      step: {
        id: 'inner-1',
        toolName: 'wrapper_search',
        status: 'running',
        args: { query: 'fastqc' },
        createdAt: '2026-09-20T00:00:01.000Z'
      },
      createdAt: '2026-09-20T00:00:01.000Z'
    },
    {
      source: 'phi',
      type: 'agent_execution_step',
      eventId: 'event-step-end',
      runId: 'run-1',
      toolCallId: 'agent-1',
      agentName: 'Wrapper',
      step: {
        id: 'inner-1',
        toolName: 'wrapper_search',
        status: 'done',
        output: 'found fastqc',
        outputPath: '/tmp/out.txt',
        outputBytes: 120000,
        outputTruncated: true,
        outputArtifact: { kind: 'tool_output', path: '/tmp/out.txt', bytes: 120000 },
        completedAt: '2026-09-20T00:00:03.000Z'
      },
      createdAt: '2026-09-20T00:00:03.000Z'
    },
    {
      source: 'phi',
      type: 'agent_execution_completed',
      eventId: 'event-agent-end',
      runId: 'run-1',
      toolCallId: 'agent-1',
      agentName: 'Wrapper',
      finalReport: 'FastQC completed.',
      finalReportBytes: 17,
      toolCalls: 1,
      isError: false,
      createdAt: '2026-09-20T00:00:05.000Z'
    }
  ])

  assert.deepEqual(items, [
    {
      id: 'agent-1',
      role: 'agent_execution',
      runId: 'run-1',
      agentName: 'Wrapper',
      task: 'run fastqc',
      argsPreview: 'run fastqc',
      argsJson: '{\n  "task": "run fastqc",\n  "apiKey": "[redacted]"\n}',
      status: 'done',
      steps: [
        {
          id: 'inner-1',
          toolName: 'wrapper_search',
          argsPreview: 'fastqc',
          argsJson: '{\n  "query": "fastqc"\n}',
          output: 'found fastqc',
          status: 'done',
          createdAt: '2026-09-20T00:00:01.000Z',
          completedAt: '2026-09-20T00:00:03.000Z',
          durationMs: 2000,
          outputPath: '/tmp/out.txt',
          outputBytes: 120000,
          outputTruncated: true,
          outputArtifact: { kind: 'tool_output', path: '/tmp/out.txt', bytes: 120000 }
        }
      ],
      createdAt: '2026-09-20T00:00:00.000Z',
      completedAt: '2026-09-20T00:00:05.000Z',
      durationMs: 5000,
      finalReport: 'FastQC completed.',
      finalReportBytes: 17,
      toolCalls: 1
    }
  ])
})

test('chatItemsFromSessionMessages finalizes restored running tools on interrupted runs', () => {
  const items = chatItemsFromSessionMessages([
    {
      source: 'phi',
      type: 'run_started',
      eventId: 'event-start',
      runId: 'run-1',
      createdAt: '2026-09-10T00:00:00.000Z'
    },
    {
      source: 'phi',
      type: 'tool_call_started',
      eventId: 'event-tool',
      runId: 'run-1',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'long task' },
      createdAt: '2026-09-10T00:00:05.000Z'
    },
    {
      source: 'phi',
      type: 'run_interrupted',
      eventId: 'event-interrupted',
      runId: 'run-1',
      reason: 'app_restarted',
      createdAt: '2026-09-10T00:00:20.000Z'
    }
  ])

  assert.deepEqual(
    items.filter((item) => item.role === 'tool'),
    [
      {
        id: 'call-1',
        role: 'tool',
        runId: 'run-1',
        toolName: 'bash',
        argsPreview: 'long task',
        argsJson: '{\n  "command": "long task"\n}',
        output: '',
        status: 'error',
        createdAt: '2026-09-10T00:00:05.000Z',
        completedAt: '2026-09-10T00:00:20.000Z',
        durationMs: 15000
      }
    ]
  )
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
        cellNumber: 2,
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
    cellNumber: 2,
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
          cellNumber: 1,
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
    cellNumber: 1,
    cellId: 'cell-1',
    cellType: 'code',
    summary: 'Updated Cell 1'
  })
})

test('chatItemsFromSessionMessages restores todo details from Phi timeline events', () => {
  const items = chatItemsFromSessionMessages([
    {
      source: 'phi',
      type: 'tool_call_started',
      eventId: 'event-1',
      toolCallId: 'call-1',
      toolName: 'todo',
      args: { op: 'init', list: [{ phase: 'Foundation', items: ['Read the CSV'] }] },
      createdAt: '2026-09-10T00:00:00.000Z'
    },
    {
      source: 'phi',
      type: 'tool_call_completed',
      eventId: 'event-2',
      toolCallId: 'call-1',
      toolName: 'todo',
      output: 'Todo initialized',
      details: {
        op: 'init',
        storage: 'session',
        phases: [{ name: 'Foundation', tasks: [{ content: 'Read the CSV', status: 'pending' }] }]
      },
      isError: false,
      createdAt: '2026-09-10T00:00:01.000Z'
    }
  ])

  assert.equal(items.length, 1)
  assert.equal(items[0].role, 'tool')
  assert.deepEqual(items[0].todo, {
    op: 'init',
    phases: [{ name: 'Foundation', tasks: [{ content: 'Read the CSV', status: 'pending' }] }]
  })
})

test('chatItemsFromSessionMessages restores todo details from runtime tool results', () => {
  const items = chatItemsFromSessionMessages([
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'call-1',
          name: 'todo',
          arguments: { op: 'done', task: 'Read the CSV' }
        }
      ]
    },
    {
      role: 'toolResult',
      toolCallId: 'call-1',
      content: {
        content: [{ type: 'text', text: 'Marked done' }],
        details: {
          op: 'done',
          storage: 'session',
          phases: [
            { name: 'Foundation', tasks: [{ content: 'Read the CSV', status: 'completed' }] }
          ]
        }
      }
    }
  ])

  assert.equal(items.length, 1)
  assert.equal(items[0].role, 'tool')
  assert.deepEqual(items[0].todo, {
    op: 'done',
    phases: [{ name: 'Foundation', tasks: [{ content: 'Read the CSV', status: 'completed' }] }]
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

test('chatItemsFromSessionMessages restores a compact per-run file change summary', () => {
  const items = chatItemsFromSessionMessages([
    {
      source: 'phi',
      type: 'workspace_changes',
      eventId: 'changes-1',
      runId: 'run-1',
      files: [
        {
          path: '/project/result.txt',
          displayPath: 'result.txt',
          status: 'modified',
          added: 2,
          deleted: 1,
          diff: {
            sessionId: '11111111-1111-1111-1111-111111111111',
            id: 'a'.repeat(64),
            bytes: 32
          },
          content: 'must not enter the chat item'
        }
      ],
      totalChanged: 1,
      truncated: false
    }
  ])
  assert.deepEqual(items, [
    {
      id: 'changes-1',
      role: 'workspace_changes',
      runId: 'run-1',
      files: [
        {
          path: '/project/result.txt',
          displayPath: 'result.txt',
          status: 'modified',
          added: 2,
          deleted: 1,
          diff: {
            sessionId: '11111111-1111-1111-1111-111111111111',
            id: 'a'.repeat(64),
            bytes: 32
          }
        }
      ],
      totalChanged: 1,
      truncated: false
    }
  ])
})

test('chatItemsFromSessionMessages restores pasted image references without inlining image bytes', () => {
  const image = {
    sessionId: 'session-1',
    id: 'a'.repeat(64),
    mimeType: 'image/png'
  }
  const items = chatItemsFromSessionMessages([
    {
      source: 'phi',
      type: 'user_message',
      eventId: 'event-image',
      content: '',
      images: [{ ...image, data: 'do not inline' }]
    }
  ])
  assert.deepEqual(items, [{ id: 'event-image', role: 'user', content: '', images: [image] }])
})

test('image-only retry keeps the original user image when the live bubble used a temporary id', () => {
  const image = { sessionId: 'session-1', id: 'b'.repeat(64), mimeType: 'image/png' }
  const items = chatItemsFromSessionMessages([
    {
      source: 'phi',
      type: 'user_message',
      eventId: 'persisted-user',
      content: '',
      images: [image]
    },
    { source: 'phi', type: 'run_failed', eventId: 'failed', errorMessage: 'try again' },
    {
      source: 'phi',
      type: 'user_message_retry',
      eventId: 'retry',
      userMessageId: 'temporary-user',
      content: '',
      images: [image]
    }
  ])
  assert.deepEqual(items, [{ id: 'persisted-user', role: 'user', content: '', images: [image] }])
})

test('chatItemsFromSessionMessages clears failed output after a persisted retry marker', () => {
  const items = chatItemsFromSessionMessages([
    {
      source: 'phi',
      type: 'user_message',
      eventId: 'event-user',
      content: '帮我检索THRSP基因的信息'
    },
    {
      source: 'phi',
      type: 'run_failed',
      eventId: 'event-failed',
      runId: 'run-1',
      errorMessage: '账户余额不足'
    },
    {
      source: 'phi',
      type: 'user_message_retry',
      eventId: 'event-retry',
      runId: 'run-2',
      userMessageId: 'event-user',
      content: '帮我检索THRSP基因的信息'
    },
    {
      source: 'phi',
      type: 'run_started',
      eventId: 'event-run-started',
      runId: 'run-2',
      createdAt: '2026-09-18T00:00:00.000Z'
    }
  ])

  assert.deepEqual(
    items.map((item) => item.id),
    ['event-user', 'run-event-run-started']
  )
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

test('legacy runtime prompt suffix does not create a second user bubble or expose Phi instructions', () => {
  const userText = '你有哪些工具可以调用'
  const oldRuntimeText = `${userText}\n\n<phi_next_action_instruction>\n当这次回复有明确、有用的后续操作时，请在最终回复最后单独输出一行：\n推荐下一步：<一句中文操作>\n</phi_next_action_instruction>`
  const items = chatItemsFromSessionMessages([
    { role: 'user', content: [{ type: 'text', text: oldRuntimeText }] },
    {
      source: 'phi',
      preferPhiTimeline: true,
      type: 'user_message',
      eventId: 'event-user',
      content: userText
    },
    {
      source: 'phi',
      preferPhiTimeline: true,
      type: 'run_failed',
      eventId: 'event-failed',
      errorMessage: 'Provider 请求失败'
    }
  ])

  assert.deepEqual(items, [
    { id: 'event-user', role: 'user', content: userText },
    { id: 'event-failed', role: 'error', content: 'Provider 请求失败' }
  ])
  assert.deepEqual(
    chatItemsFromSessionMessages([
      { role: 'user', content: [{ type: 'text', text: oldRuntimeText }] }
    ]),
    [{ id: 'user-0', role: 'user', content: userText }]
  )
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
      action: 'remote',
      reason: 'threshold',
      tokensBefore: 24000,
      tokensAfter: 5000,
      shortSummary: 'Earlier work summarized.',
      summary: 'The complete summary remains available after reopening.'
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
  assert.deepEqual(items[0].contextCompaction, {
    action: 'remote',
    reason: 'threshold',
    tokensBefore: 24000,
    tokensAfter: 5000,
    shortSummary: 'Earlier work summarized.',
    summary: 'The complete summary remains available after reopening.'
  })
  assert.deepEqual(items[1], {
    id: 'event-compact-failed',
    role: 'error',
    content: '上下文压缩失败：provider rejected summary',
    contextCompaction: { action: 'unknown' }
  })
})

test('session history distinguishes automatic tool cleanup from image rescue', () => {
  const items = chatItemsFromSessionMessages([
    {
      source: 'phi',
      type: 'context_shaken',
      eventId: 'shake-1',
      runId: 'run-1',
      tokensAfter: 12000
    },
    {
      source: 'phi',
      type: 'context_maintenance_notice',
      eventId: 'rescue-1',
      runId: 'run-1',
      noticeText: 'dropped 2 attached images so maintenance could make progress'
    },
    {
      source: 'phi',
      type: 'context_maintenance_notice',
      eventId: 'rescue-error',
      noticeLevel: 'error',
      noticeText: 'provider rejected recovery'
    }
  ])

  assert.equal(items.length, 3)
  assert.match(items[0].content, /自动精简大型工具结果/)
  assert.doesNotMatch(items[0].content, /上下文已压缩/)
  assert.match(items[1].content, /移除了 2 张历史图片/)
  assert.equal(items[2].role, 'error')
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

const FINISHED_EVENT = {
  source: 'phi',
  type: 'wrapper_run_finished',
  eventId: 'event-wrapper-done',
  createdAt: '2026-09-20T10:03:00.000Z',
  wrapperRunId: 'wrun_abc',
  wrapperId: 'nf-core/modules/fastqc',
  state: 'completed',
  exitCode: 0,
  outDir: '/data/qc',
  elapsedSeconds: 125
}

test('chatItemsFromSessionMessages restores the notice for a finished background wrapper run', () => {
  const items = chatItemsFromSessionMessages([FINISHED_EVENT])
  assert.equal(items.length, 1)
  assert.equal(items[0].role, 'warning')
  assert.equal(items[0].id, 'event-wrapper-done')
  assert.deepEqual((items[0] as { backgroundJobNotice?: unknown }).backgroundJobNotice, {
    state: 'completed'
  })
  const content = (items[0] as { content: string }).content
  assert.match(content, /^Wrapper 运行已完成\n/)
  assert.match(content, /nf-core\/modules\/fastqc/)
  assert.match(content, /2 分 5 秒/)
  assert.match(content, /\/data\/qc/)
  assert.match(content, /wrun_abc/)
})

test('a failed background wrapper run is restored with its cause and a next step', () => {
  const items = chatItemsFromSessionMessages([
    { ...FINISHED_EVENT, state: 'failed', exitCode: 137 }
  ])
  const content = (items[0] as { content: string }).content
  assert.match(content, /^Wrapper 运行失败\n/)
  assert.match(content, /137/)
  assert.match(content, /让 Wrapper 查看/)
})

test('chatItemsFromSessionMessages restores the notice for a finished background agent run', () => {
  const items = chatItemsFromSessionMessages([
    {
      source: 'phi',
      type: 'agent_run_finished',
      eventId: 'event-agent-done',
      createdAt: '2026-09-20T10:03:00.000Z',
      agentRunId: 'run_2',
      agent: 'Database',
      state: 'error',
      task: 'look up TP53 in ClinVar',
      elapsedSeconds: 125,
      error: 'The Database agent failed: connector offline'
    }
  ])
  assert.equal(items.length, 1)
  assert.equal(items[0].role, 'warning')
  assert.equal(items[0].id, 'event-agent-done')
  assert.deepEqual((items[0] as { backgroundJobNotice?: unknown }).backgroundJobNotice, {
    state: 'failed'
  })
  const content = (items[0] as { content: string }).content
  assert.match(content, /^Database 后台任务失败\n/)
  assert.match(content, /TP53/)
  assert.match(content, /connector offline/)
  assert.match(content, /2 分 5 秒/)
  assert.match(content, /run_2/)
})

// ── restoring agent cards: background runs ───────────────────────────────

const RESTORED_AGENT_EVENTS = [
  {
    source: 'phi',
    type: 'agent_execution_started',
    eventId: 'e1',
    runId: 'run-1',
    toolCallId: 'call-1',
    agentName: 'Wrapper',
    task: 'align the reads',
    createdAt: '2026-09-20T10:00:00.000Z'
  },
  {
    source: 'phi',
    type: 'agent_execution_background',
    eventId: 'e2',
    runId: 'run-1',
    toolCallId: 'call-1',
    agentName: 'Wrapper',
    agentRunId: 'run_3',
    agentSessionId: 'runtime-9',
    createdAt: '2026-09-20T10:00:01.000Z'
  },
  {
    source: 'phi',
    type: 'run_completed',
    eventId: 'e3',
    runId: 'run-1',
    createdAt: '2026-09-20T10:00:05.000Z'
  }
]

test('a restored background card is still running after its chat run completed', () => {
  const items = chatItemsFromSessionMessages(RESTORED_AGENT_EVENTS)
  const card = items.find((item) => item.role === 'agent_execution') as unknown as Record<
    string,
    unknown
  >
  assert.equal(card.status, 'running')
  assert.equal(card.background, true)
  assert.equal(card.agentRunId, 'run_3')
  assert.equal(card.agentSessionId, 'runtime-9')
})

test('a restored background card gets its later steps and completion', () => {
  const items = chatItemsFromSessionMessages([
    ...RESTORED_AGENT_EVENTS,
    {
      source: 'phi',
      type: 'agent_execution_step',
      eventId: 'e4',
      toolCallId: 'call-1',
      agentName: 'Wrapper',
      agentRunId: 'run_3',
      step: { id: 's1', toolName: 'wrapper_run', status: 'done', output: 'ok' }
    },
    {
      source: 'phi',
      type: 'agent_execution_completed',
      eventId: 'e5',
      toolCallId: 'call-1',
      agentName: 'Wrapper',
      isError: false,
      finalReport: 'Aligned.',
      createdAt: '2026-09-20T10:03:00.000Z'
    }
  ])
  const card = items.find((item) => item.role === 'agent_execution') as unknown as {
    status: string
    steps: unknown[]
    finalReport?: string
  }
  assert.equal(card.status, 'done')
  assert.equal(card.steps.length, 1)
  assert.equal(card.finalReport, 'Aligned.')
})

test('a restored foreground card is still finished by its chat run', () => {
  const items = chatItemsFromSessionMessages([RESTORED_AGENT_EVENTS[0], RESTORED_AGENT_EVENTS[2]])
  const card = items.find((item) => item.role === 'agent_execution') as unknown as {
    status: string
  }
  assert.equal(card.status, 'done')
})

test('a restored cancelled background card is cancelled, not failed', () => {
  const items = chatItemsFromSessionMessages([
    ...RESTORED_AGENT_EVENTS,
    {
      source: 'phi',
      type: 'agent_execution_completed',
      eventId: 'e5',
      toolCallId: 'call-1',
      agentName: 'Wrapper',
      isError: false,
      cancelled: true,
      createdAt: '2026-09-20T10:03:00.000Z'
    }
  ])
  const card = items.find((item) => item.role === 'agent_execution') as unknown as {
    status: string
    cancelled?: boolean
    error?: string
  }
  assert.equal(card.status, 'done')
  assert.equal(card.cancelled, true)
  assert.equal(card.error, undefined)
})

test('a restored card keeps the user’s steering messages', () => {
  const items = chatItemsFromSessionMessages([
    ...RESTORED_AGENT_EVENTS,
    {
      source: 'phi',
      type: 'agent_execution_steered',
      eventId: 'e6',
      toolCallId: 'call-1',
      agentRunId: 'run_3',
      text: 'use hg38',
      createdAt: '2026-09-20T10:01:00.000Z'
    }
  ])
  const card = items.find((item) => item.role === 'agent_execution') as unknown as {
    steers?: Array<{ text: string; createdAt?: string }>
  }
  assert.deepEqual(card.steers, [{ text: 'use hg38', createdAt: '2026-09-20T10:01:00.000Z' }])
})
