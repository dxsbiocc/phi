import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { summarizeEvent } from '../src/main/agent/session/session-manager'

import {
  translateOmpEvent,
  phiEventFromWire,
  isPhiEventType,
  adaptOmpSessionEvents,
  isPhiMessageUpdateSummary
} from '../src/main/agent/engine/events'

type OmpEvent = Parameters<typeof translateOmpEvent>[0]
type OmpSession = Parameters<typeof translateOmpEvent>[1]

const assistant = {
  role: 'assistant',
  content: [{ type: 'text', text: 'hello' }],
  api: 'openai-completions',
  provider: 'openai',
  model: 'fixture',
  usage: {
    input: 3,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 5,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  },
  stopReason: 'stop',
  timestamp: 1
}

function session(tokens: unknown, leaf: unknown = undefined): OmpSession {
  return {
    getContextUsage: () => ({ tokens }),
    sessionManager: { getLeafEntry: () => leaf }
  } as unknown as OmpSession
}

function translate(event: unknown, source = session(42)): unknown {
  return translateOmpEvent(event as OmpEvent, source)
}

test('event translation preserves assistant stream variants and their metadata', () => {
  const streams = [
    { type: 'start', partial: assistant },
    ...['text_start', 'thinking_start', 'toolcall_start'].map((type) => ({
      type,
      contentIndex: 0,
      partial: assistant
    })),
    ...['text_delta', 'thinking_delta', 'toolcall_delta'].map((type) => ({
      type,
      contentIndex: 0,
      delta: 'hello',
      partial: assistant
    })),
    ...['text_end', 'thinking_end'].map((type) => ({
      type,
      contentIndex: 0,
      content: 'hello',
      partial: assistant
    })),
    {
      type: 'image_end',
      contentIndex: 0,
      content: { type: 'image', data: 'AA==', mimeType: 'image/png' },
      partial: assistant
    },
    {
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: { type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'a' } },
      partial: assistant
    },
    { type: 'done', reason: 'stop', message: assistant },
    { type: 'error', reason: 'aborted', error: { ...assistant, stopReason: 'aborted' } }
  ]
  for (const assistantMessageEvent of streams) {
    const event = {
      type: 'message_update',
      message: assistant,
      assistantMessageEvent,
      extension: { value: 1 }
    }
    assert.deepEqual(translate(event), event, assistantMessageEvent.type)
  }
})

test('event translation preserves lifecycle, tool fields, optional absence and order', () => {
  const events = [
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'message_start', message: { role: 'user', content: 'hello', timestamp: 1 } },
    { type: 'message_end', message: assistant },
    {
      type: 'tool_execution_start',
      toolCallId: 'call',
      toolName: 'read',
      args: { path: 'a' },
      intent: 'inspect',
      createdAt: 'time'
    },
    {
      type: 'tool_execution_update',
      toolCallId: 'call',
      toolName: 'read',
      args: { path: 'a' },
      partialResult: { content: [{ type: 'text', text: 'part' }], details: { progress: 1 } }
    },
    {
      type: 'tool_stream_update',
      toolCallId: 'call',
      toolName: 'read',
      update: { kind: 'progress' }
    },
    {
      type: 'tool_execution_end',
      toolCallId: 'call',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'result' }] }
    },
    {
      type: 'message_end',
      message: {
        role: 'toolResult',
        toolCallId: 'call',
        toolName: 'read',
        content: [],
        isError: false,
        timestamp: 2
      }
    },
    { type: 'message_end', message: { ...assistant, stopReason: 'aborted' } },
    { type: 'turn_end', message: assistant, toolResults: [] },
    { type: 'agent_end', messages: [assistant], isTerminal: false, telemetry: { extra: true } }
  ]
  assert.deepEqual(
    events.map((event) => translate(event)),
    events
  )
  assert.equal(Object.hasOwn(translate(events[7]) as object, 'isError'), false)
})

test('compaction adds valid tokens only for successful non-skipped operations', () => {
  const end = {
    type: 'auto_compaction_end',
    action: 'remote',
    result: undefined,
    aborted: false,
    willRetry: false
  }
  const leaf = { type: 'compaction', tokensAfter: 17 }
  assert.deepEqual(translate(end, session(42, leaf)), { ...end, tokensAfter: 17 })
  assert.deepEqual(translate({ ...end, action: 'shake' }, session(42, leaf)), {
    ...end,
    action: 'shake',
    tokensAfter: 42
  })
  for (const leaf of [
    undefined,
    { type: 'compaction', tokensAfter: -1 },
    { type: 'compaction', tokensAfter: NaN },
    { type: 'other', tokensAfter: 17 }
  ]) {
    assert.deepEqual(translate(end, session(42, leaf)), { ...end, tokensAfter: 42 })
  }
  for (const event of [
    { ...end, aborted: true },
    { ...end, skipped: true },
    { type: 'auto_compaction_start', action: 'remote', reason: 'threshold' }
  ]) {
    assert.deepEqual(translate(event, session(42, leaf)), event)
  }
  for (const tokens of [undefined, -1, NaN, Infinity, '42']) {
    assert.deepEqual(translate(end, session(tokens, undefined)), end)
  }
  assert.deepEqual(translate(end, session(0, { type: 'compaction', tokensAfter: 0 })), {
    ...end,
    tokensAfter: 0
  })
  const throwing = {
    getContextUsage: () => {
      throw new Error('no context')
    },
    sessionManager: {
      getLeafEntry: () => {
        throw new Error('no leaf')
      }
    }
  } as unknown as OmpSession
  assert.deepEqual(translate(end, throwing), end)
})

test('unknown event names and opaque extension messages survive translation', () => {
  for (const event of [
    { type: 'future_event', nested: { value: [1, null, 'x'] } },
    {
      type: 'message_end',
      message: {
        role: 'custom',
        customType: 'future',
        content: 'extension',
        display: false,
        details: { extra: true },
        timestamp: 1
      }
    },
    {
      type: 'message_update',
      message: assistant,
      assistantMessageEvent: { type: 'future_delta', delta: { text: 'future' }, extension: true }
    }
  ])
    assert.deepEqual(translate(event), event)
})

test('wire decoding preserves unknown fields and rejects invalid envelopes', () => {
  for (const value of [null, undefined, false, 1, [], {}, { type: 1 }]) {
    assert.equal(phiEventFromWire(value), undefined)
  }
  const source = { type: 'future_event', nested: { toolName: 'read' }, extra: [1, 2] }
  const event = phiEventFromWire(source)
  assert.deepEqual(event, source)
  assert.ok(event)
  assert.equal(isPhiEventType(event, 'tool_execution_start'), false)
})

test('known event guards validate enums, structured fields, and optional-field types', () => {
  const compaction = {
    type: 'auto_compaction_end',
    action: 'remote',
    result: undefined,
    aborted: false,
    willRetry: false
  }
  const result = { summary: 'summary', firstKeptEntryId: 'entry', tokensBefore: 20 }
  const valid = [
    compaction,
    { ...compaction, result },
    { type: 'auto_compaction_start', action: 'shake', reason: 'threshold' },
    {
      type: 'todo_reminder',
      todos: [{ content: 'work', status: 'blocked', blocker: 'input' }],
      attempt: 1,
      maxAttempts: 2
    },
    {
      type: 'thinking_level_changed',
      thinkingLevel: 'inherit',
      configured: 'auto',
      resolved: 'high'
    },
    { type: 'tool_execution_start', toolCallId: 'call', toolName: 'read', args: {} },
    // Historical runner sources can omit IDs and result; retain their fallback behavior.
    { type: 'tool_execution_end', toolName: 'read' },
    // Extra fields from a newer vendor must not invalidate a currently understood shape.
    { type: 'tool_execution_update', toolName: 'read', intent: { future: true }, isError: 'extra' }
  ]
  for (const value of valid) {
    const event = phiEventFromWire(value)
    assert.ok(event)
    assert.equal(
      isPhiEventType(event, value.type as Parameters<typeof isPhiEventType>[1]),
      true,
      JSON.stringify(value)
    )
  }
  const invalid = [
    { ...compaction, action: 'future' },
    { ...compaction, result: {} },
    { ...compaction, result: { ...result, tokensBefore: '20' } },
    { ...compaction, result: { ...result, preserveData: [] } },
    { ...compaction, result: { ...result, shortSummary: 7 } },
    { ...compaction, aborted: 'false' },
    { ...compaction, willRetry: 1 },
    { ...compaction, skipped: 'yes' },
    { ...compaction, errorMessage: [] },
    { ...compaction, tokensAfter: '1' },
    { type: 'auto_compaction_start', action: 'remote', reason: 'future' },
    { type: 'todo_reminder', todos: [{}], attempt: 1, maxAttempts: 2 },
    {
      type: 'todo_reminder',
      todos: [{ content: 'work', status: 'future' }],
      attempt: 1,
      maxAttempts: 2
    },
    { type: 'thinking_level_changed', thinkingLevel: 'future' },
    { type: 'thinking_level_changed', thinkingLevel: 'high', configured: 'future' },
    { type: 'thinking_level_changed', thinkingLevel: 'high', resolved: 'off' },
    { type: 'tool_execution_start', toolCallId: 7 },
    { type: 'tool_execution_end', toolName: 'read', isError: 'false' },
    { type: 'message_end', message: null },
    { type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 1 } },
    { type: 'turn_end', message: { role: 'assistant' }, toolResults: [{}] }
  ]
  for (const value of invalid) {
    const event = phiEventFromWire(value)
    assert.deepEqual(event, value, 'diagnostic information must survive')
    assert.ok(event)
    assert.equal(
      isPhiEventType(event, value.type as Parameters<typeof isPhiEventType>[1]),
      false,
      JSON.stringify(value)
    )
  }
})

test('specialist subscription adapts the production session while retaining properties, receivers, and unsubscribe', () => {
  let listener: ((event: OmpEvent) => void) | undefined
  const original = {
    ...session(42, { type: 'compaction', tokensAfter: 17 }),
    marker: 'preserved',
    calls: 0,
    subscribe(callback: (event: OmpEvent) => void) {
      assert.equal(this, original)
      listener = callback
      return () => {
        listener = undefined
      }
    },
    async prompt() {
      this.calls += 1
      return this.marker === 'preserved'
    }
  }
  const adapted = adaptOmpSessionEvents(original as unknown as OmpSession)
  assert.equal(adapted, original)
  const events: unknown[] = []
  const stop = adapted.subscribe((event) => events.push(event))
  listener?.({
    type: 'auto_compaction_end',
    action: 'remote',
    result: undefined,
    aborted: false,
    willRetry: false
  } as OmpEvent)
  assert.deepEqual(events, [
    {
      type: 'auto_compaction_end',
      action: 'remote',
      result: undefined,
      aborted: false,
      willRetry: false,
      tokensAfter: 17
    }
  ])
  stop()
  assert.equal(listener, undefined)
  assert.equal(original.marker, 'preserved')
  return original.prompt().then((result) => {
    assert.equal(result, true)
    assert.equal(original.calls, 1)
  })
})

test('no-tools event summaries preserve text and thinking streaming through the production index consumer', () => {
  // Load the actual pure function without starting Electron or reproducing its logic.
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  const declaration = parsed.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'assistantTextFromEventSummary'
  )
  assert.ok(declaration)
  const compiled = ts.transpileModule(declaration.getText(parsed), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText
  const consume = new Function(
    'isPhiEventType',
    'isPhiMessageUpdateSummary',
    'extractMessageText',
    `${compiled}; return assistantTextFromEventSummary`
  )(isPhiEventType, isPhiMessageUpdateSummary, (value: unknown) =>
    typeof value === 'string' ? value : ''
  ) as (summary: ReturnType<typeof summarizeEvent>, text: string) => string
  let text = ''
  for (const type of ['text_delta', 'thinking_delta']) {
    const event = {
      type: 'message_update',
      assistantMessageEvent: { type, delta: 'stream', contentIndex: 0 },
      omitted: true
    }
    const summary = summarizeEvent(event)
    assert.equal(Object.hasOwn(summary, 'message'), false)
    assert.equal(Object.hasOwn(summary, 'omitted'), false)
    assert.equal(isPhiMessageUpdateSummary(summary), true)
    text = consume(summary, text)
  }
  assert.equal(text, 'streamstream')
})

test('new cache warming and queue events preserve payloads and validate Phi fields', () => {
  const valid = [
    { type: 'cache_warming_start', phase: 'streaming', provider: 'contract', model: 'model' },
    {
      type: 'cache_warming_end',
      phase: 'idle',
      provider: 'contract',
      model: 'model',
      outcome: 'hit',
      usage: { input: 1 },
      warmingStopReason: 'stopped'
    },
    { type: 'queue_update', steering: ['one'], followUp: ['two'], liveSteered: 1 }
  ] as const
  for (const event of valid) {
    assert.deepEqual(translate(event), event)
    const decoded = phiEventFromWire(event)!
    assert.equal(isPhiEventType(decoded, event.type), true)
    if (isPhiEventType(decoded, 'cache_warming_start')) assert.equal(decoded.phase, 'streaming')
    if (isPhiEventType(decoded, 'cache_warming_end')) assert.equal(decoded.outcome, 'hit')
  }
  for (const event of [
    { ...valid[0], phase: 'future' },
    { ...valid[1], outcome: undefined },
    { ...valid[2], steering: [1] },
    { ...valid[2], liveSteered: -1 }
  ]) {
    const decoded = phiEventFromWire(event)!
    assert.deepEqual(decoded, event)
    assert.equal(isPhiEventType(decoded, event.type), false)
  }
})
