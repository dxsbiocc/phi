import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createAgentEventReducerState,
  reduceAgentEventState
} from '../src/renderer/src/lib/agentEventReducer'
import { INLINE_OUTPUT_PREVIEW_CHARS } from '../src/renderer/src/lib/toolOutputPresentation'
import type { AgentEventSummary } from '../src/renderer/src/types'

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
