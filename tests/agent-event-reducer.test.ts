import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createAgentEventReducerState,
  reduceAgentEventState
} from '../src/renderer/src/lib/agentEventReducer'
import { INLINE_OUTPUT_PREVIEW_CHARS } from '../src/renderer/src/lib/toolOutputPresentation'
import type { AgentEventSummary } from '../src/renderer/src/types'

test('provider-managed tool result appears as a completed tool card', () => {
  const state = reduceAgentEventState(createAgentEventReducerState(), {
    source: 'phi',
    type: 'provider_tool_call_completed',
    toolCallId: 'provider-call-1',
    toolName: 'web_fetch',
    args: { url: 'https://example.com' },
    output: 'Fetched page',
    isError: false,
    runId: 'run-1'
  })
  assert.equal(state.messages.length, 1)
  assert.deepEqual(state.messages[0], {
    id: 'provider-call-1',
    role: 'tool',
    runId: 'run-1',
    toolName: 'web_fetch',
    argsPreview: 'https://example.com',
    argsJson: '{\n  "url": "https://example.com"\n}',
    output: 'Fetched page',
    status: 'done'
  })
})

test('hosted web calls stay between the streamed blocks that announced them', () => {
  let state = createAgentEventReducerState()
  state = reduceAgentEventState(state, { type: 'message_start', message: { role: 'assistant' } })
  state = reduceAgentEventState(state, {
    type: 'message_update',
    message: { role: 'assistant' },
    assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'before' }
  })
  state = reduceAgentEventState(state, {
    type: 'message_update',
    message: { role: 'assistant' },
    assistantMessageEvent: {
      type: 'toolcall_start',
      contentIndex: 1,
      partial: {
        content: [
          { type: 'thinking', thinking: 'before' },
          {
            type: 'toolCall',
            id: 'fetch-1',
            name: 'web_fetch',
            arguments: { url: 'https://pubmed.ncbi.nlm.nih.gov/?term=MID1IP1' }
          }
        ]
      }
    }
  })
  state = reduceAgentEventState(state, {
    type: 'message_update',
    message: { role: 'assistant' },
    assistantMessageEvent: { type: 'thinking_delta', contentIndex: 2, delta: 'after' }
  })
  state = reduceAgentEventState(state, {
    type: 'message_update',
    message: { role: 'assistant' },
    assistantMessageEvent: { type: 'text_delta', contentIndex: 3, delta: 'Answer' }
  })
  state = reduceAgentEventState(state, {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'before' },
        {
          type: 'toolCall',
          id: 'fetch-1',
          name: 'web_fetch',
          arguments: { url: 'https://pubmed.ncbi.nlm.nih.gov/?term=MID1IP1' }
        },
        { type: 'thinking', thinking: 'after' },
        { type: 'text', text: 'Answer' }
      ]
    }
  })
  assert.deepEqual(
    state.messages.map((item) => item.role),
    ['thinking', 'tool', 'thinking', 'assistant']
  )
  state = reduceAgentEventState(state, {
    type: 'provider_tool_call_completed',
    toolCallId: 'fetch-1',
    toolName: 'web_fetch',
    args: { url: 'https://pubmed.ncbi.nlm.nih.gov/?term=MID1IP1' },
    output: 'PubMed results'
  })
  assert.equal(state.messages.length, 4)
  assert.equal(state.messages[1].role === 'tool' && state.messages[1].output, 'PubMed results')
})

test('live run change summary appears once after its persisted event', () => {
  const event: AgentEventSummary = {
    source: 'phi',
    type: 'workspace_changes',
    eventId: 'changes-1',
    runId: 'run-1',
    files: [
      {
        path: '/project/result.txt',
        displayPath: 'result.txt',
        status: 'modified',
        added: 1,
        deleted: 0,
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
  const first = reduceAgentEventState(createAgentEventReducerState(), event)
  const replay = reduceAgentEventState(first, event)
  assert.equal(first.messages.length, 1)
  assert.deepEqual(replay.messages, first.messages)
  assert.equal(first.messages[0].role, 'workspace_changes')
})

test('live file delivery appears once when its persisted event is replayed', () => {
  const event: AgentEventSummary = {
    source: 'phi',
    type: 'files_presented',
    eventId: 'delivery-1',
    runId: 'run-1',
    files: [{ path: '/project/report.pdf', displayPath: 'report.pdf', bytes: 123 }]
  }
  const first = reduceAgentEventState(createAgentEventReducerState(), event)
  const replay = reduceAgentEventState(first, event)
  assert.deepEqual(replay.messages, first.messages)
  assert.deepEqual(first.messages[0], {
    id: 'delivery-1',
    role: 'presented_files',
    runId: 'run-1',
    files: [{ path: '/project/report.pdf', displayPath: 'report.pdf', bytes: 123 }]
  })
})

test('live plan review updates its card instead of adding another message', () => {
  const submitted = reduceAgentEventState(createAgentEventReducerState(), {
    source: 'phi',
    type: 'plan_review_submitted',
    eventId: 'plan-event',
    reviewId: 'review-1',
    title: 'Analysis',
    content: '# Analysis',
    planFilePath: 'local://analysis-plan.md'
  })
  const decided = reduceAgentEventState(submitted, {
    source: 'phi',
    type: 'plan_review_decided',
    reviewId: 'review-1',
    decision: 'revise',
    note: 'Add tests'
  })
  assert.equal(decided.messages.length, 1)
  assert.equal(decided.messages[0].role, 'plan_review')
  if (decided.messages[0].role === 'plan_review') {
    assert.equal(decided.messages[0].status, 'revise')
    assert.equal(decided.messages[0].note, 'Add tests')
  }
})

test('assistant text deltas survive StrictMode-style reducer replay', () => {
  const initial = createAgentEventReducerState([
    { id: 'user-1', role: 'user', content: 'stop check' }
  ])
  const event: AgentEventSummary = {
    type: 'message_update',
    message: { role: 'assistant' },
    assistantMessageEvent: {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'Streaming fixture stop check'
    }
  }

  const first = reduceAgentEventState(initial, event)
  const replay = reduceAgentEventState(initial, event)

  assert.deepEqual(replay, first)
  assert.deepEqual(replay.messages, [
    { id: 'user-1', role: 'user', content: 'stop check' },
    { id: 'assistant-0-0', role: 'assistant', content: 'Streaming fixture stop check' }
  ])
  assert.equal(initial.messages.length, 1)
  assert.equal(initial.textBlockIds.size, 0)
})

test('assistant deltas append to the same block without mutating prior stream maps', () => {
  const started = reduceAgentEventState(createAgentEventReducerState(), {
    type: 'message_start',
    message: { role: 'assistant' }
  })
  const first = reduceAgentEventState(started, {
    type: 'message_update',
    message: { role: 'assistant' },
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello' }
  })
  const second = reduceAgentEventState(first, {
    type: 'message_update',
    message: { role: 'assistant' },
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' world' }
  })

  assert.deepEqual(second.messages, [
    { id: 'assistant-0-0', role: 'assistant', content: 'Hello world' }
  ])
  assert.equal(started.textBlockIds.size, 0)
  assert.equal(first.textBlockIds.get(0), 'assistant-0-0')
})

test('assistant thinking deltas keep elapsed duration through message end', () => {
  const started = reduceAgentEventState(createAgentEventReducerState(), {
    type: 'message_start',
    message: { role: 'assistant' },
    createdAt: '2026-09-07T00:00:00.000Z'
  })
  const first = reduceAgentEventState(started, {
    type: 'message_update',
    message: { role: 'assistant' },
    createdAt: '2026-09-07T00:00:00.000Z',
    assistantMessageEvent: {
      type: 'thinking_delta',
      contentIndex: 0,
      delta: 'Inspect '
    }
  })
  const second = reduceAgentEventState(first, {
    type: 'message_update',
    message: { role: 'assistant' },
    createdAt: '2026-09-07T00:00:02.000Z',
    assistantMessageEvent: {
      type: 'thinking_delta',
      contentIndex: 0,
      delta: 'state.'
    }
  })
  const ended = reduceAgentEventState(second, {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Done.' }]
    },
    createdAt: '2026-09-07T00:00:04.000Z'
  })

  assert.deepEqual(ended.messages, [
    {
      id: 'thinking-0-0',
      role: 'thinking',
      content: 'Inspect state.',
      createdAt: '2026-09-07T00:00:00.000Z',
      completedAt: '2026-09-07T00:00:04.000Z',
      durationMs: 4000
    },
    {
      id: 'assistant-1-0',
      role: 'assistant',
      content: 'Done.',
      createdAt: '2026-09-07T00:00:04.000Z'
    }
  ])
})

test('assistant placeholder dot is removed when a message finishes', () => {
  const started = reduceAgentEventState(createAgentEventReducerState(), {
    type: 'message_start',
    message: { role: 'assistant' }
  })
  const updated = reduceAgentEventState(started, {
    type: 'message_update',
    message: { role: 'assistant' },
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '.' }
  })
  const ended = reduceAgentEventState(updated, {
    type: 'message_end',
    message: { role: 'assistant' }
  })

  assert.deepEqual(ended.messages, [])
})

test('assistant message errors become visible chat content', () => {
  const started = reduceAgentEventState(createAgentEventReducerState(), {
    type: 'message_start',
    message: { role: 'assistant' }
  })
  const ended = reduceAgentEventState(started, {
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: 'error',
      errorMessage: '404 Not found the model kimi-k2.5 or Permission denied'
    }
  })

  assert.deepEqual(ended.messages, [
    {
      id: 'error-0-0',
      role: 'error',
      content: '404 Not found the model kimi-k2.5 or Permission denied'
    }
  ])
})

test('project parallel warning becomes an informational chat item', () => {
  const state = reduceAgentEventState(createAgentEventReducerState(), {
    type: 'project_parallel_warning',
    activeCount: 2
  })

  assert.deepEqual(state.messages, [
    {
      id: 'warning-0-0',
      role: 'warning',
      content:
        '这个项目里还有 2 个会话正在运行或等待权限。当前会话会继续启动，切换会话不会打断后台进程。'
    }
  ])
})

test('model selection migration becomes a visible timeline item', () => {
  const state = reduceAgentEventState(createAgentEventReducerState(), {
    type: 'model_selection_migrated',
    eventId: 'event-migrated',
    fromProviderId: 'kimi-code',
    fromModelId: 'kimi-k2.5',
    toProviderId: 'kimi-code',
    toModelId: 'kimi-for-coding',
    toModelName: 'K2.7 Coding'
  })

  assert.deepEqual(state.messages, [
    {
      id: 'event-migrated',
      role: 'warning',
      content: 'kimi-code/kimi-k2.5 当前不可用，已切换到 kimi-code/kimi-for-coding。'
    }
  ])
})

test('run failure timeline events become visible chat content once', () => {
  const event = {
    type: 'run_failed',
    eventId: 'event-failed',
    runId: 'run-1',
    errorMessage: '404 Not found the model kimi-k2.5 or Permission denied'
  }
  const once = reduceAgentEventState(createAgentEventReducerState(), event)
  const twice = reduceAgentEventState(once, event)

  assert.deepEqual(twice.messages, [
    {
      id: 'event-failed',
      role: 'error',
      runId: 'run-1',
      content: '404 Not found the model kimi-k2.5 or Permission denied'
    }
  ])
})

test('assistant message error and run failure with the same content render one visible error', () => {
  const ended = reduceAgentEventState(createAgentEventReducerState(), {
    type: 'message_end',
    runId: 'run-1',
    message: {
      role: 'assistant',
      stopReason: 'error',
      errorMessage: '404 Not found the model kimi-k2.5 or Permission denied'
    },
    createdAt: '2026-09-07T00:00:10.000Z'
  })
  const failed = reduceAgentEventState(ended, {
    type: 'run_failed',
    eventId: 'event-failed',
    runId: 'run-1',
    errorMessage: '404 Not found the model kimi-k2.5 or Permission denied',
    createdAt: '2026-09-07T00:00:11.000Z'
  })

  assert.equal(failed.messages.filter((item) => item.role === 'error').length, 1)
  assert.deepEqual(
    failed.messages.filter((item) => item.role === 'error'),
    [
      {
        id: 'error-0-0',
        role: 'error',
        runId: 'run-1',
        content: '404 Not found the model kimi-k2.5 or Permission denied',
        createdAt: '2026-09-07T00:00:10.000Z'
      }
    ]
  )
  assert.deepEqual(
    failed.messages.filter((item) => item.role === 'run'),
    [
      {
        id: 'run-event-failed',
        role: 'run',
        event: 'failed',
        runId: 'run-1',
        createdAt: '2026-09-07T00:00:11.000Z'
      }
    ]
  )
})

test('equivalent run failures from different turns remain visible separately', () => {
  const first = reduceAgentEventState(createAgentEventReducerState(), {
    type: 'run_failed',
    eventId: 'event-failed-1',
    runId: 'run-1',
    errorMessage: '404 Not found the model kimi-k2.5 or Permission denied',
    createdAt: '2026-09-07T00:00:10.000Z'
  })
  const second = reduceAgentEventState(first, {
    type: 'run_failed',
    eventId: 'event-failed-2',
    runId: 'run-2',
    errorMessage: '404 Not found the model kimi-k2.5 or Permission denied',
    createdAt: '2026-09-07T00:01:10.000Z'
  })

  assert.deepEqual(
    second.messages.filter((item) => item.role === 'error'),
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

test('run lifecycle events become hidden timeline metadata for processing totals', () => {
  const started = reduceAgentEventState(createAgentEventReducerState(), {
    type: 'run_started',
    eventId: 'event-start',
    runId: 'run-1',
    createdAt: '2026-09-07T00:00:00.000Z'
  })
  const completed = reduceAgentEventState(started, {
    type: 'run_completed',
    eventId: 'event-end',
    runId: 'run-1',
    createdAt: '2026-09-07T00:00:12.000Z',
    durationMs: 12000
  })

  assert.deepEqual(completed.messages, [
    {
      id: 'run-event-start',
      role: 'run',
      event: 'started',
      runId: 'run-1',
      createdAt: '2026-09-07T00:00:00.000Z'
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

test('run interruption finalizes still-running tool items for that run', () => {
  const started = reduceAgentEventState(createAgentEventReducerState(), {
    type: 'run_started',
    eventId: 'event-start',
    runId: 'run-1',
    createdAt: '2026-09-07T00:00:00.000Z'
  })
  const toolStarted = reduceAgentEventState(started, {
    type: 'tool_execution_start',
    runId: 'run-1',
    toolCallId: 'tool-1',
    toolName: 'bash',
    args: { command: 'long task' },
    createdAt: '2026-09-07T00:00:05.000Z'
  })
  const interrupted = reduceAgentEventState(toolStarted, {
    type: 'run_interrupted',
    eventId: 'event-interrupted',
    runId: 'run-1',
    reason: 'app_restarted',
    createdAt: '2026-09-07T00:00:20.000Z',
    durationMs: 20000
  })

  assert.deepEqual(
    interrupted.messages.filter((item) => item.role === 'tool'),
    [
      {
        id: 'tool-1',
        role: 'tool',
        runId: 'run-1',
        toolName: 'bash',
        argsPreview: 'long task',
        argsJson: '{\n  "command": "long task"\n}',
        output: '',
        status: 'error',
        createdAt: '2026-09-07T00:00:05.000Z',
        completedAt: '2026-09-07T00:00:20.000Z',
        durationMs: 15000
      }
    ]
  )
})

test('auto compaction end becomes a visible timeline item', () => {
  const state = reduceAgentEventState(createAgentEventReducerState(), {
    type: 'auto_compaction_end',
    action: 'remote',
    aborted: false,
    willRetry: false
  })

  assert.deepEqual(state.messages, [
    {
      id: 'warning-0-0',
      role: 'warning',
      content: '上下文已压缩，较早内容已汇总给模型；聊天时间线会继续保留可见历史。'
    }
  ])
})

test('persisted compaction event shows the same details live and after replay', () => {
  const event: AgentEventSummary = {
    source: 'phi',
    type: 'context_compacted',
    eventId: 'compact-1',
    action: 'handoff',
    reason: 'threshold',
    tokensBefore: 24000,
    tokensAfter: 5000,
    summary: 'Complete summary',
    shortSummary: 'Short summary'
  }
  const first = reduceAgentEventState(createAgentEventReducerState(), event)
  const replay = reduceAgentEventState(first, event)

  assert.equal(first.messages.length, 1)
  assert.deepEqual(replay.messages, first.messages)
  assert.equal(first.messages[0].role, 'warning')
  if (first.messages[0].role === 'warning') {
    assert.deepEqual(first.messages[0].contextCompaction, {
      action: 'handoff',
      reason: 'threshold',
      tokensBefore: 24000,
      tokensAfter: 5000,
      summary: 'Complete summary',
      shortSummary: 'Short summary'
    })
  }
})

test('skipped auto compaction stays out of the timeline', () => {
  const state = reduceAgentEventState(createAgentEventReducerState(), {
    type: 'auto_compaction_end',
    action: 'remote',
    skipped: true,
    aborted: false,
    willRetry: false
  })

  assert.deepEqual(state.messages, [])
})

test('tool execution end keeps persisted output metadata in live timeline', () => {
  const started = reduceAgentEventState(createAgentEventReducerState(), {
    type: 'tool_execution_start',
    toolCallId: 'tool-1',
    toolName: 'bash',
    args: { command: 'npm test' }
  })
  const completed = reduceAgentEventState(started, {
    type: 'tool_execution_end',
    toolCallId: 'tool-1',
    toolName: 'bash',
    result: {
      output: 'preview',
      outputPath: '/tmp/phi/tool-outputs/tool-1.txt',
      outputBytes: 100000,
      truncated: true,
      outputArtifact: {
        kind: 'tool_output',
        path: '/tmp/phi/tool-outputs/tool-1.txt',
        bytes: 100000
      }
    }
  })

  assert.deepEqual(completed.messages, [
    {
      id: 'tool-1',
      role: 'tool',
      toolName: 'bash',
      argsPreview: 'npm test',
      argsJson: '{\n  "command": "npm test"\n}',
      output: 'preview',
      outputPath: '/tmp/phi/tool-outputs/tool-1.txt',
      outputBytes: 100000,
      outputTruncated: true,
      outputArtifact: {
        kind: 'tool_output',
        path: '/tmp/phi/tool-outputs/tool-1.txt',
        bytes: 100000
      },
      status: 'done'
    }
  ])
})

test('a todo tool call attaches its phases snapshot for the sticky todo panel', () => {
  const started = reduceAgentEventState(createAgentEventReducerState(), {
    type: 'tool_execution_start',
    toolCallId: 'tool-1',
    toolName: 'todo',
    args: { op: 'start', task: 'Fit the model' }
  })
  const completed = reduceAgentEventState(started, {
    type: 'tool_execution_end',
    toolCallId: 'tool-1',
    toolName: 'todo',
    result: {
      content: [{ type: 'text', text: 'Todo updated' }],
      details: {
        op: 'start',
        storage: 'session',
        phases: [
          {
            name: 'Foundation',
            tasks: [
              { content: 'Read the CSV', status: 'completed' },
              { content: 'Fit the model', status: 'in_progress' }
            ]
          }
        ]
      }
    }
  })

  assert.deepEqual(completed.messages, [
    {
      id: 'tool-1',
      role: 'tool',
      toolName: 'todo',
      argsPreview: 'start',
      argsJson: '{\n  "op": "start",\n  "task": "Fit the model"\n}',
      output: 'Todo updated',
      outputPath: undefined,
      outputBytes: undefined,
      outputTruncated: undefined,
      outputArtifact: undefined,
      todo: {
        op: 'start',
        phases: [
          {
            name: 'Foundation',
            tasks: [
              { content: 'Read the CSV', status: 'completed' },
              { content: 'Fit the model', status: 'in_progress' }
            ]
          }
        ]
      },
      status: 'done'
    }
  ])
})

test('a wrapper_* tool call renders as a wrapper_plan item, not a generic tool item', () => {
  const started = reduceAgentEventState(createAgentEventReducerState(), {
    type: 'tool_execution_start',
    toolCallId: 'call-1',
    toolName: 'wrapper_phi_ngs_fastq_qc',
    args: { reads: 'data/*_{R1,R2}.fastq.gz' }
  })

  assert.deepEqual(started.messages, [
    { id: 'call-1', role: 'wrapper_plan', toolName: 'wrapper_phi_ngs_fastq_qc', status: 'running' }
  ])

  const completed = reduceAgentEventState(started, {
    type: 'tool_execution_end',
    toolCallId: 'call-1',
    toolName: 'wrapper_phi_ngs_fastq_qc',
    result: {
      content: [{ type: 'text', text: 'Plan wplan_abc123 created.' }],
      details: { kind: 'wrapper_plan', planId: 'wplan_abc123' }
    }
  })

  assert.deepEqual(completed.messages, [
    {
      id: 'call-1',
      role: 'wrapper_plan',
      toolName: 'wrapper_phi_ngs_fastq_qc',
      planId: 'wplan_abc123',
      status: 'done'
    }
  ])
})

test('a failed wrapper_* tool call marks the wrapper_plan item as errored without a planId', () => {
  const started = reduceAgentEventState(createAgentEventReducerState(), {
    type: 'tool_execution_start',
    toolCallId: 'call-1',
    toolName: 'wrapper_phi_ngs_fastq_qc',
    args: {}
  })
  const failed = reduceAgentEventState(started, {
    type: 'tool_execution_end',
    toolCallId: 'call-1',
    toolName: 'wrapper_phi_ngs_fastq_qc',
    isError: true,
    result: { content: [{ type: 'text', text: '缺少必填输入: reads' }] }
  })

  assert.deepEqual(failed.messages, [
    { id: 'call-1', role: 'wrapper_plan', toolName: 'wrapper_phi_ngs_fastq_qc', status: 'error' }
  ])
})

test('tool execution update previews long partial output in live timeline', () => {
  const started = reduceAgentEventState(createAgentEventReducerState(), {
    type: 'tool_execution_start',
    toolCallId: 'tool-1',
    toolName: 'bash',
    args: { command: 'npm test' }
  })
  const updated = reduceAgentEventState(started, {
    type: 'tool_execution_update',
    toolCallId: 'tool-1',
    partialResult: {
      output: `${'a'.repeat(INLINE_OUTPUT_PREVIEW_CHARS + 20)}PARTIAL_TAIL`
    }
  })

  const [tool] = updated.messages
  assert.equal(tool.role, 'tool')
  assert.match(tool.output, /预览已截断/)
  assert.doesNotMatch(tool.output, /PARTIAL_TAIL/)
})

test('agent execution events build a structured agent card in the live timeline', () => {
  const started = reduceAgentEventState(createAgentEventReducerState(), {
    type: 'agent_execution_started',
    runId: 'run-1',
    toolCallId: 'agent-1',
    agentName: 'Wrapper',
    task: 'run fastqc',
    args: { task: 'run fastqc', token: '[redacted]' },
    createdAt: '2026-09-20T00:00:00.000Z'
  })
  const stepStarted = reduceAgentEventState(started, {
    type: 'agent_execution_step',
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
  })
  const stepDone = reduceAgentEventState(stepStarted, {
    type: 'agent_execution_step',
    runId: 'run-1',
    toolCallId: 'agent-1',
    agentName: 'Wrapper',
    step: {
      id: 'inner-1',
      toolName: 'wrapper_search',
      status: 'done',
      output: 'found fastqc',
      outputPath: '/tmp/phi/tool-outputs/agent-1-inner-1.txt',
      outputBytes: 120000,
      outputTruncated: true,
      outputArtifact: {
        kind: 'tool_output',
        path: '/tmp/phi/tool-outputs/agent-1-inner-1.txt',
        bytes: 120000
      },
      completedAt: '2026-09-20T00:00:03.000Z'
    },
    createdAt: '2026-09-20T00:00:03.000Z'
  })
  const completed = reduceAgentEventState(stepDone, {
    type: 'agent_execution_completed',
    runId: 'run-1',
    toolCallId: 'agent-1',
    agentName: 'Wrapper',
    finalReport: 'FastQC completed.',
    finalReportBytes: 17,
    toolCalls: 1,
    isError: false,
    createdAt: '2026-09-20T00:00:05.000Z'
  })

  assert.deepEqual(completed.messages, [
    {
      id: 'agent-1',
      role: 'agent_execution',
      runId: 'run-1',
      agentName: 'Wrapper',
      task: 'run fastqc',
      argsPreview: 'run fastqc',
      argsJson: '{\n  "task": "run fastqc",\n  "token": "[redacted]"\n}',
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
          outputPath: '/tmp/phi/tool-outputs/agent-1-inner-1.txt',
          outputBytes: 120000,
          outputTruncated: true,
          outputArtifact: {
            kind: 'tool_output',
            path: '/tmp/phi/tool-outputs/agent-1-inner-1.txt',
            bytes: 120000
          }
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

test('a finished background wrapper run shows up live as a visible timeline notice', () => {
  const state = reduceAgentEventState(createAgentEventReducerState(), {
    type: 'wrapper_run_finished',
    eventId: 'event-wrapper-done',
    wrapperRunId: 'wrun_abc',
    wrapperId: 'nf-core/modules/fastqc',
    state: 'completed',
    exitCode: 0,
    outDir: '/data/qc',
    elapsedSeconds: 42
  })

  assert.equal(state.messages.length, 1)
  assert.equal(state.messages[0].role, 'warning')
  assert.deepEqual((state.messages[0] as { backgroundJobNotice?: unknown }).backgroundJobNotice, {
    state: 'completed'
  })
  assert.match((state.messages[0] as { content: string }).content, /^Wrapper 运行已完成/)
  assert.match((state.messages[0] as { content: string }).content, /wrun_abc/)
})

test('a finished background agent run shows up live as a visible timeline notice', () => {
  const state = reduceAgentEventState(createAgentEventReducerState(), {
    type: 'agent_run_finished',
    eventId: 'event-agent-done',
    agentRunId: 'run_1',
    agent: 'Wrapper',
    state: 'done',
    task: 'align the reads',
    elapsedSeconds: 60,
    report: 'Aligned.'
  })

  assert.equal(state.messages.length, 1)
  assert.equal(state.messages[0].role, 'warning')
  const content = (state.messages[0] as { content: string }).content
  assert.match(content, /^Wrapper 后台任务已完成/)
  assert.match(content, /align the reads/)
  assert.match(content, /run_1/)
  assert.doesNotMatch(content, /Aligned\./, 'the report is for the agent, not the notice')
})

// ── agent cards: run refs, background runs ───────────────────────────────

function reduceAll(
  events: Array<Record<string, unknown>>
): ReturnType<typeof createAgentEventReducerState> {
  return events.reduce(
    (state, event) => reduceAgentEventState(state, event as never),
    createAgentEventReducerState()
  )
}

const agentCard = (
  state: ReturnType<typeof createAgentEventReducerState>
): Record<string, unknown> =>
  state.messages.find((item) => item.role === 'agent_execution') as unknown as Record<
    string,
    unknown
  >

const STARTED = {
  type: 'agent_execution_started',
  runId: 'run-1',
  toolCallId: 'call-1',
  agentName: 'Wrapper',
  task: 'align the reads',
  createdAt: '2026-09-20T10:00:00.000Z'
}

test('agent steps tell the card which agent run and session it can steer', () => {
  const state = reduceAll([
    STARTED,
    {
      type: 'agent_execution_step',
      runId: 'run-1',
      toolCallId: 'call-1',
      agentName: 'Wrapper',
      agentRunId: 'run_3',
      agentSessionId: 'runtime-9',
      step: { id: 's1', toolName: 'read', status: 'running' }
    }
  ])
  const card = agentCard(state)
  assert.equal(card.agentRunId, 'run_3')
  assert.equal(card.agentSessionId, 'runtime-9')
  assert.equal(card.background, undefined)
  assert.equal(card.status, 'running')
})

test('a background agent card keeps running when the chat run that started it completes', () => {
  const state = reduceAll([
    STARTED,
    {
      type: 'agent_execution_background',
      runId: 'run-1',
      toolCallId: 'call-1',
      agentName: 'Wrapper',
      agentRunId: 'run_3',
      agentSessionId: 'runtime-9'
    },
    { type: 'run_completed', runId: 'run-1', createdAt: '2026-09-20T10:00:05.000Z' }
  ])
  const card = agentCard(state)
  assert.equal(card.background, true)
  assert.equal(card.agentRunId, 'run_3')
  assert.equal(card.status, 'running')
})

test('a foreground agent card is still finished when its chat run completes', () => {
  const state = reduceAll([
    STARTED,
    { type: 'run_completed', runId: 'run-1', createdAt: '2026-09-20T10:00:05.000Z' }
  ])
  assert.equal(agentCard(state).status, 'done')
})

test('a background card receives its later steps and its completion', () => {
  const state = reduceAll([
    STARTED,
    {
      type: 'agent_execution_background',
      runId: 'run-1',
      toolCallId: 'call-1',
      agentName: 'Wrapper',
      agentRunId: 'run_3',
      agentSessionId: 'runtime-9'
    },
    { type: 'run_completed', runId: 'run-1' },
    {
      type: 'agent_execution_step',
      toolCallId: 'call-1',
      agentName: 'Wrapper',
      agentRunId: 'run_3',
      agentSessionId: 'runtime-9',
      step: { id: 's1', toolName: 'wrapper_run', status: 'done', output: 'ok' }
    },
    {
      type: 'agent_execution_completed',
      toolCallId: 'call-1',
      agentName: 'Wrapper',
      agentRunId: 'run_3',
      isError: false,
      finalReport: 'Aligned.',
      toolCalls: 2,
      createdAt: '2026-09-20T10:03:00.000Z'
    }
  ])
  const card = agentCard(state) as {
    status: string
    steps: unknown[]
    finalReport?: string
    background?: boolean
  }
  assert.equal(card.status, 'done')
  assert.equal(card.steps.length, 1)
  assert.equal(card.finalReport, 'Aligned.')
  assert.equal(card.background, true)
})

test('a background card that ends in error shows the failure', () => {
  const state = reduceAll([
    STARTED,
    {
      type: 'agent_execution_background',
      toolCallId: 'call-1',
      agentName: 'Wrapper',
      agentRunId: 'run_3'
    },
    {
      type: 'agent_execution_completed',
      toolCallId: 'call-1',
      agentName: 'Wrapper',
      isError: true,
      error: 'The Wrapper agent failed: boom'
    }
  ])
  const card = agentCard(state) as { status: string; error?: string }
  assert.equal(card.status, 'error')
  assert.match(card.error ?? '', /boom/)
})

// ── agent cards: cancelled runs and the user's steering messages ─────────

test('a cancelled background card ends as cancelled, not as a failure', () => {
  const state = reduceAll([
    STARTED,
    {
      type: 'agent_execution_background',
      toolCallId: 'call-1',
      agentName: 'Wrapper',
      agentRunId: 'run_3'
    },
    {
      type: 'agent_execution_completed',
      toolCallId: 'call-1',
      agentName: 'Wrapper',
      isError: false,
      cancelled: true,
      createdAt: '2026-09-20T10:03:00.000Z'
    }
  ])
  const card = agentCard(state) as { status: string; cancelled?: boolean; error?: string }
  assert.equal(card.status, 'done')
  assert.equal(card.cancelled, true)
  assert.equal(card.error, undefined)
})

test('the user’s steering messages are kept on the card in order', () => {
  const state = reduceAll([
    STARTED,
    {
      type: 'agent_execution_background',
      toolCallId: 'call-1',
      agentName: 'Wrapper',
      agentRunId: 'run_3'
    },
    {
      type: 'agent_execution_steered',
      toolCallId: 'call-1',
      agentRunId: 'run_3',
      text: 'use hg38',
      createdAt: '2026-09-20T10:01:00.000Z'
    },
    {
      type: 'agent_execution_steered',
      toolCallId: 'call-1',
      agentRunId: 'run_3',
      text: 'skip QC',
      createdAt: '2026-09-20T10:02:00.000Z'
    }
  ])
  const card = agentCard(state) as {
    steers?: Array<{ text: string; createdAt?: string }>
    status: string
  }
  assert.deepEqual(card.steers, [
    { text: 'use hg38', createdAt: '2026-09-20T10:01:00.000Z' },
    { text: 'skip QC', createdAt: '2026-09-20T10:02:00.000Z' }
  ])
  assert.equal(card.status, 'running')
})

test('a steering message without text is ignored', () => {
  const state = reduceAll([
    STARTED,
    { type: 'agent_execution_steered', toolCallId: 'call-1', agentRunId: 'run_3', text: '  ' }
  ])
  assert.equal((agentCard(state) as { steers?: unknown }).steers, undefined)
})

test('live file delivery keeps artifact metadata', () => {
  const event: AgentEventSummary = {
    source: 'phi',
    type: 'files_presented',
    eventId: 'delivery-artifact',
    runId: 'run-1',
    files: [
      {
        path: '/project/figures/plot.png',
        displayPath: 'figures/plot.png',
        bytes: 12,
        artifact: { kind: 'figure', title: 'Volcano plot', envId: 'env-1' }
      }
    ]
  }
  const first = reduceAgentEventState(createAgentEventReducerState(), event)
  assert.equal(first.messages[0]?.role, 'presented_files')
  if (first.messages[0]?.role === 'presented_files') {
    assert.deepEqual(first.messages[0].files[0]?.artifact, {
      kind: 'figure',
      title: 'Volcano plot',
      envId: 'env-1'
    })
  }
})
