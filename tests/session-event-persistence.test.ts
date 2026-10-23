import assert from 'node:assert/strict'
import test from 'node:test'

import type { PhiAgentEvent } from '../src/main/agent/engine/types'
import {
  persistSessionEvent,
  type SessionEventPersistenceDeps,
  type SessionEventPersistenceRun
} from '../src/main/agent/session/session-event-persistence'
import type {
  PersistedToolOutput,
  SessionEventInput,
  StoredSessionEvent
} from '../src/main/agent/session/session-store'

interface PersistenceHarness {
  appended: Array<{ sessionId: string; event: SessionEventInput }>
  deps: SessionEventPersistenceDeps
  persistedOutputs: Array<{
    sessionId: string
    input: { runId: string; toolCallId: string; output: string; inlineLimit?: number }
  }>
}

function phiEvent(value: Record<string, unknown>): PhiAgentEvent {
  return value as PhiAgentEvent
}

function run(overrides: Partial<SessionEventPersistenceRun> = {}): SessionEventPersistenceRun {
  return {
    phiSessionId: 'phi-1',
    runId: 'run-1',
    thinkingBlocks: new Map(),
    thinkingBlockStartedAtMs: new Map(),
    compactionReasons: new Map(),
    agentToolCallIds: new Set(),
    sdkToolCallIds: new Set(),
    browserSdkToolCallIds: new Set(),
    persistedToolCallIds: new Set(),
    pendingProviderToolCalls: new Map(),
    ...overrides
  }
}

function createdAtFromSummary(
  summary: Record<string, unknown>
): { createdAt: string } | Record<string, never> {
  if (typeof summary.createdAt !== 'string') return {}
  return Number.isFinite(Date.parse(summary.createdAt)) ? { createdAt: summary.createdAt } : {}
}

function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const record = message as { role?: string; content?: unknown }
  if (record.role !== 'assistant' || !Array.isArray(record.content)) return ''
  return record.content
    .map((part) =>
      part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? String((part as { text: string }).text)
        : ''
    )
    .join('')
}

function persistedOutput(input: { output: string }): PersistedToolOutput {
  if (input.output.length <= 8) {
    return { outputPreview: input.output, outputBytes: input.output.length, truncated: false }
  }
  return {
    outputPreview: `${input.output.slice(0, 8)}\n...saved`,
    outputPath: '/tool-outputs/output.txt',
    outputBytes: input.output.length,
    truncated: true,
    outputArtifact: {
      kind: 'tool_output',
      path: '/tool-outputs/output.txt',
      bytes: input.output.length
    }
  }
}

function harness(): PersistenceHarness {
  const appended: PersistenceHarness['appended'] = []
  const persistedOutputs: PersistenceHarness['persistedOutputs'] = []
  const appendSessionEvent = (sessionId: string, event: SessionEventInput): StoredSessionEvent => {
    appended.push({ sessionId, event })
    return {
      ...event,
      eventId: `event-${appended.length}`,
      sessionId,
      createdAt: typeof event.createdAt === 'string' ? event.createdAt : '2026-10-20T00:00:00.000Z'
    }
  }
  const persistSdkCompactionNotice: SessionEventPersistenceDeps['shared']['persistSdkCompactionNotice'] =
    (sessionId, runId, summary) => {
      if (summary.type !== 'notice' || summary.source !== 'compaction') return null
      const stored = appendSessionEvent(sessionId, {
        type: 'context_maintenance_notice',
        ...(runId ? { runId } : {}),
        noticeText: summary.message
      })
      return { source: 'phi', ...stored }
    }
  const persistSdkShakeEvent: SessionEventPersistenceDeps['shared']['persistSdkShakeEvent'] = (
    sessionId,
    runId,
    summary,
    reason
  ) => {
    if (summary.type !== 'auto_compaction_end' || summary.action !== 'shake') return null
    const stored = appendSessionEvent(sessionId, {
      type: 'context_shaken',
      ...(runId ? { runId } : {}),
      action: 'shake',
      ...(reason ? { reason } : {})
    })
    return { source: 'phi', ...stored }
  }
  return {
    appended,
    persistedOutputs,
    deps: {
      storage: {
        appendSessionEvent,
        persistToolOutput: (sessionId, input) => {
          persistedOutputs.push({ sessionId, input })
          return persistedOutput(input)
        },
        toolOutputInlineLimit: 20_000
      },
      shared: {
        createdAtFromSummary,
        extractAssistantText,
        persistSdkCompactionNotice,
        persistSdkShakeEvent,
        redactStructuredValue: (value) => value
      }
    }
  }
}

test('compaction events preserve notice priority, retry cleanup, reasons and persisted output', () => {
  const f = harness()
  const currentRun = run({ recordedFailureMessage: 'temporary failure' })
  const notice = persistSessionEvent(
    currentRun,
    phiEvent({ type: 'notice', source: 'compaction', message: 'maintenance' }),
    f.deps
  )
  assert.equal(notice.type, 'context_maintenance_notice')
  assert.equal(notice.runId, 'run-1')

  const retry = persistSessionEvent(
    currentRun,
    phiEvent({ type: 'auto_retry_end', success: true, attempt: 1 }),
    f.deps
  )
  assert.equal(currentRun.recordedFailureMessage, undefined)
  assert.deepEqual(retry, { type: 'auto_retry_end', success: true, attempt: 1, runId: 'run-1' })

  persistSessionEvent(
    currentRun,
    phiEvent({ type: 'auto_compaction_start', action: 'handoff', reason: 'threshold' }),
    f.deps
  )
  const completed = persistSessionEvent(
    currentRun,
    phiEvent({
      type: 'auto_compaction_end',
      action: 'handoff',
      aborted: false,
      willRetry: false,
      result: {
        shortSummary: 'Short',
        summary: 'Long',
        firstKeptEntryId: 'entry-1',
        tokensBefore: 120
      },
      tokensAfter: 40
    }),
    f.deps
  )
  assert.equal(completed.type, 'context_compacted')
  assert.deepEqual(f.appended.at(-1), {
    sessionId: 'phi-1',
    event: {
      type: 'context_compacted',
      runId: 'run-1',
      action: 'handoff',
      reason: 'threshold',
      shortSummary: 'Short',
      summary: 'Long',
      tokensBefore: 120,
      tokensAfter: 40
    }
  })
})

test('assistant message events persist thinking and text before forwarding the final message', () => {
  const f = harness()
  const currentRun = run({
    thinkingBlocks: new Map([[9, 'stale']]),
    thinkingBlockStartedAtMs: new Map([[9, 0]])
  })
  assert.deepEqual(
    persistSessionEvent(
      currentRun,
      phiEvent({ type: 'message_start', message: { role: 'assistant' } }),
      f.deps
    ),
    { type: 'message_start', message: { role: 'assistant' }, runId: 'run-1' }
  )
  persistSessionEvent(
    currentRun,
    phiEvent({
      type: 'message_update',
      createdAt: '2026-10-20T00:00:01.000Z',
      message: { role: 'assistant' },
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Inspect' }
    }),
    f.deps
  )
  const forwarded = persistSessionEvent(
    currentRun,
    phiEvent({
      type: 'message_end',
      createdAt: '2026-10-20T00:00:03.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Inspect' },
          { type: 'text', text: 'Done.' }
        ]
      }
    }),
    f.deps
  )
  assert.deepEqual(
    f.appended.map(({ event }) => event),
    [
      {
        type: 'assistant_thinking_completed',
        runId: 'run-1',
        content: 'Inspect',
        createdAt: '2026-10-20T00:00:03.000Z',
        durationMs: 2000
      },
      {
        type: 'assistant_message_finalized',
        runId: 'run-1',
        content: 'Done.',
        createdAt: '2026-10-20T00:00:03.000Z'
      }
    ]
  )
  assert.equal(forwarded.runId, 'run-1')
  assert.deepEqual(forwarded.message, {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'Inspect' },
      { type: 'text', text: 'Done.' }
    ]
  })
})

test('tool-result message_end reaches the provider tool family after the assistant family declines it', () => {
  const f = harness()
  const currentRun = run({
    pendingProviderToolCalls: new Map([
      ['provider-1', { toolName: 'web_fetch', args: { url: 'https://example.test' } }]
    ])
  })
  const forwarded = persistSessionEvent(
    currentRun,
    phiEvent({
      type: 'message_end',
      createdAt: '2026-10-20T00:00:04.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'provider-1',
        content: [{ type: 'text', text: 'Fetched' }],
        isError: false
      }
    }),
    f.deps
  )
  assert.deepEqual(
    f.appended.map(({ event }) => event.type),
    ['tool_call_started', 'tool_call_completed']
  )
  assert.deepEqual(f.persistedOutputs, [
    {
      sessionId: 'phi-1',
      input: {
        runId: 'run-1',
        toolCallId: 'provider-1',
        output: 'Fetched',
        inlineLimit: 20_000
      }
    }
  ])
  assert.equal(forwarded.type, 'provider_tool_call_completed')
  assert.equal(forwarded.toolCallId, 'provider-1')
  assert.deepEqual(forwarded.args, { url: 'https://example.test' })
})

test('tool execution starts persist ordinary tools and give delegation starts priority', () => {
  const f = harness()
  const currentRun = run()
  const ordinary = persistSessionEvent(
    currentRun,
    phiEvent({
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'bash',
      args: { command: 'pwd' }
    }),
    f.deps
  )
  const delegation = persistSessionEvent(
    currentRun,
    phiEvent({
      type: 'tool_execution_start',
      toolCallId: 'agent-1',
      toolName: 'Reviewer',
      args: { task: 'review it' }
    }),
    f.deps
  )
  assert.deepEqual(ordinary, {
    type: 'tool_execution_start',
    toolCallId: 'tool-1',
    toolName: 'bash',
    args: { command: 'pwd' },
    runId: 'run-1'
  })
  assert.equal(delegation.type, 'agent_execution_started')
  assert.deepEqual(
    f.appended.map(({ event }) => event.type),
    ['tool_call_started', 'agent_execution_started']
  )
  assert.equal(currentRun.sdkToolCallIds.has('agent-1'), true)
  assert.equal(currentRun.agentToolCallIds.has('agent-1'), true)
})

test('agent delegation updates persist their step output and forward the stored step event', () => {
  const f = harness()
  const currentRun = run({
    agentToolCallIds: new Set(['agent-1']),
    session: { runtimeSessionId: 'runtime-1' }
  })
  const forwarded = persistSessionEvent(
    currentRun,
    phiEvent({
      type: 'tool_execution_update',
      toolCallId: 'agent-1',
      toolName: 'Reviewer',
      partialResult: {
        details: {
          kind: 'agent_step',
          agent: 'Reviewer',
          agentRunId: 'agent-run-1',
          step: { id: 'step-1', toolName: 'read', status: 'done', output: 'checked' }
        }
      }
    }),
    f.deps
  )
  assert.equal(forwarded.type, 'agent_execution_step')
  assert.equal(forwarded.agentRunId, 'agent-run-1')
  assert.equal(forwarded.agentSessionId, 'runtime-1')
  assert.equal(f.appended.at(-1)?.event.type, 'agent_execution_step')
  assert.deepEqual(f.persistedOutputs[0]?.input, {
    runId: 'run-1',
    toolCallId: 'agent-1-step-1',
    output: 'checked',
    inlineLimit: 20_000
  })
})

test('delegation ends distinguish agent_started details from a completed foreground agent', () => {
  const f = harness()
  const currentRun = run({
    agentToolCallIds: new Set(['background-1', 'foreground-1']),
    session: { runtimeSessionId: 'runtime-1' }
  })
  const background = persistSessionEvent(
    currentRun,
    phiEvent({
      type: 'tool_execution_end',
      toolCallId: 'background-1',
      toolName: 'Reviewer',
      result: { details: { kind: 'agent_started', agent: 'Reviewer', runId: 'agent-run-1' } },
      isError: false
    }),
    f.deps
  )
  const completed = persistSessionEvent(
    currentRun,
    phiEvent({
      type: 'tool_execution_end',
      toolCallId: 'foreground-1',
      toolName: 'Reviewer',
      result: {
        content: [{ type: 'text', text: 'finished' }],
        details: { kind: 'agent_result', agent: 'Reviewer', toolCalls: 2 }
      },
      isError: false
    }),
    f.deps
  )
  assert.equal(background.type, 'agent_execution_background')
  assert.equal(background.agentRunId, 'agent-run-1')
  assert.equal(completed.type, 'agent_execution_completed')
  assert.deepEqual(
    f.appended.map(({ event }) => event.type),
    ['agent_execution_background', 'agent_execution_completed']
  )
  assert.equal(f.persistedOutputs.length, 1)
  assert.deepEqual([...currentRun.sdkToolCallIds], ['background-1', 'foreground-1'])
  assert.equal(currentRun.agentToolCallIds.size, 0)
})

test('ordinary tool ends persist notebook details and forward a bounded truncated result', () => {
  const f = harness()
  const currentRun = run()
  const forwarded = persistSessionEvent(
    currentRun,
    phiEvent({
      type: 'tool_execution_end',
      toolCallId: 'notebook-1',
      toolName: 'notebook_run_cell',
      result: {
        output: '1234567890',
        details: {
          kind: 'notebook_execution',
          path: '/project/analysis.ipynb',
          cell: { id: 'cell-1', index: 0, cell_type: 'code' },
          execution: { state: 'completed', executionCount: 3 }
        }
      },
      isError: false
    }),
    f.deps
  )
  assert.deepEqual(f.appended.at(-1)?.event.details, {
    kind: 'notebook_execution',
    path: '/project/analysis.ipynb',
    cellId: 'cell-1',
    cellNumber: 1,
    cellType: 'code',
    executionState: 'completed',
    executionCount: 3
  })
  assert.deepEqual(forwarded.result, {
    output: '12345678\n...saved',
    outputPath: '/tool-outputs/output.txt',
    outputBytes: 10,
    truncated: true,
    outputArtifact: {
      kind: 'tool_output',
      path: '/tool-outputs/output.txt',
      bytes: 10
    }
  })
  assert.equal(forwarded.runId, 'run-1')
})

test('the tool-end guard rejects non-string ids and withRunId only fills a missing run id', () => {
  const f = harness()
  const currentRun = run()
  const nonString = persistSessionEvent(
    currentRun,
    phiEvent({ type: 'tool_execution_end', toolCallId: 42, toolName: 'bash' }),
    f.deps
  )
  const existing = persistSessionEvent(
    currentRun,
    phiEvent({ type: 'custom_event', runId: 'external-run' }),
    f.deps
  )
  assert.deepEqual(nonString, {
    type: 'tool_execution_end',
    toolCallId: 42,
    toolName: 'bash',
    runId: 'run-1'
  })
  assert.deepEqual(existing, { type: 'custom_event', runId: 'external-run' })
  assert.deepEqual(f.appended, [])
  assert.deepEqual(f.persistedOutputs, [])
})
