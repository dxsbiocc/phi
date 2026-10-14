import assert from 'node:assert/strict'
import { appendFileSync, readFileSync } from 'node:fs'
import test from 'node:test'
import {
  createCursorStreamRecoveryExtension,
  type CursorRecoveryAgent
} from '../src/main/agent/engine/phi-extension/extensions/cursor-stream-recovery'
import { createInProcessFixture } from './engine-contract/in-process-factory'
import { startLoopbackCursor } from './helpers/loopbackCursor'

type Handler = (event: Record<string, unknown>) => unknown

function recovery(): { start: () => void; stop: Handler; end: Handler } {
  const handlers = new Map<string, Handler>()
  const agent: CursorRecoveryAgent = {}
  createCursorStreamRecoveryExtension(() => agent)({
    on: (name: string, handler: Handler) => handlers.set(name, handler)
  } as never)
  handlers.get('before_agent_start')?.({})
  return {
    start: () => handlers.get('before_agent_start')?.({}),
    stop: (event) => handlers.get('session_stop')?.(event),
    end: (event) => agent.transformAssistantMessage?.(event.message as never)
  }
}

function interrupted(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const message = {
    role: 'assistant',
    api: 'cursor-agent',
    provider: 'cursor',
    stopReason: 'error',
    errorMessage: 'Cursor stream ended before turnEnded',
    content: [{ type: 'text', text: 'Already completed work.' }],
    ...overrides
  }
  return {
    messages: [message],
    last_assistant_message: message,
    stop_hook_active: false,
    signal: new AbortController().signal
  }
}

test('a truncated Cursor answer continues from retained output once instead of replaying the prompt', () => {
  const policy = recovery()
  const event = interrupted()
  const original = structuredClone(event.messages)
  const result = policy.stop(event) as
    { continue?: boolean; additionalContext?: string } | undefined
  assert.equal(result?.continue, true)
  assert.match(result?.additionalContext ?? '', /already|completed|resume/i)
  assert.deepEqual(event.messages, original)
  assert.equal(policy.stop(event), undefined, 'repeated truncation must remain a real failure')
  policy.start()
  assert.equal((policy.stop(event) as { continue?: boolean })?.continue, true)
})

test('Cursor tool interruptions use the native preserved-tool recovery path once', async () => {
  const event = interrupted({
    content: [{ type: 'toolCall', id: 'call-1', name: 'write', arguments: {} }]
  })
  const policy = recovery()
  assert.equal(policy.stop(event), undefined, 'tool turns must use native pairing checks')
  const message = event.last_assistant_message as { errorMessage: string }
  await policy.end({ message })
  assert.equal(
    message.errorMessage,
    'stream closed before a terminal response event: Cursor stream ended before turnEnded'
  )
  const next = interrupted({
    content: [{ type: 'toolCall', id: 'call-2', name: 'write', arguments: {} }]
  })
  await policy.end({ message: next.last_assistant_message })
  assert.equal(
    (next.last_assistant_message as typeof message).errorMessage,
    'Cursor stream ended before turnEnded'
  )
})

for (const overrides of [
  { stopReason: 'aborted' },
  { api: 'openai-completions' },
  { errorMessage: '401 unauthorized' },
  { stopReason: 'stop', errorMessage: undefined }
]) {
  test(`recovery ignores unrelated or stopped turns: ${JSON.stringify(overrides)}`, () => {
    assert.equal(recovery().stop(interrupted(overrides)), undefined)
  })
}

test('user cancellation and an existing stop-hook continuation suppress Cursor recovery', () => {
  const cancelled = interrupted()
  cancelled.signal = AbortSignal.abort()
  assert.equal(recovery().stop(cancelled), undefined)
  const continuing = interrupted()
  continuing.stop_hook_active = true
  assert.equal(recovery().stop(continuing), undefined)
})

test('the real Cursor provider resumes a missing turnEnded stream through the Phi worker', async () => {
  const fixture = await createInProcessFixture({
    providerFactory: startLoopbackCursor,
    api: 'cursor-agent'
  })
  try {
    await fixture.engine.sessions.create({
      sessionId: 'cursor-recovery',
      cwd: fixture.cwd,
      agentDir: fixture.agentDir,
      sessionManager: { kind: 'memory', cwd: fixture.cwd },
      model: fixture.model,
      resourceOptions: {
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true
      },
      enableToolApproval: false,
      autoCompaction: { enabled: false }
    })
    fixture.provider.enqueue(
      { text: 'Already completed work.', hold: true },
      { text: 'Remaining answer.' }
    )
    const state = await fixture.engine.sessions.prompt({
      sessionId: 'cursor-recovery',
      text: 'Finish the task.'
    })
    assert.equal(fixture.provider.requests.length, 2, JSON.stringify(state.messages))
    const messages = state.messages as Array<{
      role: string
      content: unknown
      stopReason?: string
    }>
    assert.equal(messages.at(-1)?.stopReason, 'stop')
    assert.equal(JSON.stringify(messages).split('Already completed work.').length - 1, 1)
    assert.match(JSON.stringify(messages), /Remaining answer/)
  } finally {
    await fixture.close()
  }
})

test('a second truncated Cursor response settles as failure instead of looping', async () => {
  const fixture = await createInProcessFixture({
    providerFactory: startLoopbackCursor,
    api: 'cursor-agent'
  })
  try {
    await fixture.engine.sessions.create({
      sessionId: 'cursor-repeated',
      cwd: fixture.cwd,
      agentDir: fixture.agentDir,
      sessionManager: { kind: 'memory', cwd: fixture.cwd },
      model: fixture.model,
      resourceOptions: {
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true
      },
      enableToolApproval: false,
      autoCompaction: { enabled: false }
    })
    fixture.provider.enqueue(
      { text: 'First partial.', hold: true },
      { text: 'Second partial.', hold: true }
    )
    const state = await fixture.engine.sessions.prompt({
      sessionId: 'cursor-repeated',
      text: 'Finish the task.'
    })
    assert.equal(fixture.provider.requests.length, 2)
    const messages = state.messages as Array<{ stopReason?: string; errorMessage?: string }>
    assert.equal(messages.at(-1)?.stopReason, 'error')
    assert.equal(messages.at(-1)?.errorMessage, 'Cursor stream ended before turnEnded')
  } finally {
    await fixture.close()
  }
})

test('a real Cursor tool turn retains its completed result when the stream is resumed', async () => {
  const fixture = await createInProcessFixture({
    providerFactory: startLoopbackCursor,
    api: 'cursor-agent'
  })
  try {
    await fixture.engine.sessions.create({
      sessionId: 'cursor-tool',
      cwd: fixture.cwd,
      agentDir: fixture.agentDir,
      sessionManager: { kind: 'memory', cwd: fixture.cwd },
      model: fixture.model,
      resourceOptions: {
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true
      },
      enableToolApproval: false,
      autoCompaction: { enabled: false }
    })
    fixture.provider.enqueue(
      { text: 'Checking state.', tool: { name: 'todo', args: {}, id: 'todo-1' }, hold: true },
      { text: 'State checked.' }
    )
    const state = await fixture.engine.sessions.prompt({
      sessionId: 'cursor-tool',
      text: 'Check current state.'
    })
    assert.equal(fixture.provider.requests.length, 2, JSON.stringify(state.messages))
    const messages = state.messages as Array<{
      role: string
      toolCallId?: string
      stopReason?: string
    }>
    assert.equal(messages.at(-1)?.stopReason, 'stop')
    assert.equal(
      messages.filter((item) => item.role === 'toolResult' && item.toolCallId === 'todo-1').length,
      1
    )
  } finally {
    await fixture.close()
  }
})

test('Cursor recovery remains active after restoring compacted history', async () => {
  const fixture = await createInProcessFixture({
    providerFactory: startLoopbackCursor,
    api: 'cursor-agent'
  })
  const options = {
    cwd: fixture.cwd,
    agentDir: fixture.agentDir,
    model: fixture.model,
    resourceOptions: {
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true
    },
    enableToolApproval: false,
    autoCompaction: { enabled: false }
  }
  try {
    await fixture.engine.sessions.create({
      ...options,
      sessionId: 'before-compact',
      sessionManager: { kind: 'persistent', cwd: fixture.cwd }
    })
    fixture.provider.enqueue({ text: 'Earlier work.' })
    const previous = await fixture.engine.sessions.prompt({
      sessionId: 'before-compact',
      text: 'Remember earlier work.'
    })
    assert.ok(previous.sessionFile)
    await fixture.engine.stop()
    const entries = readFileSync(previous.sessionFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const kept = entries.findLast((entry) => entry.type === 'message')
    assert.ok(kept?.id)
    appendFileSync(
      previous.sessionFile,
      JSON.stringify({
        type: 'compaction',
        id: 'fixture-compact',
        parentId: entries.at(-1).id,
        timestamp: new Date().toISOString(),
        firstKeptEntryId: kept.id,
        tokensBefore: 24000,
        tokensAfter: 500,
        method: 'soft',
        summary: 'Earlier context summary.'
      }) + '\n'
    )
    const restored = await fixture.engine.sessions.create({
      ...options,
      sessionId: 'after-compact',
      sessionManager: { kind: 'open', cwd: fixture.cwd, path: previous.sessionFile }
    })
    assert.match(JSON.stringify(restored.state.messages), /Earlier context summary/)
    fixture.provider.enqueue(
      { text: 'Partial after compaction.', hold: true },
      { text: 'Recovered after compaction.' }
    )
    const state = await fixture.engine.sessions.prompt({
      sessionId: 'after-compact',
      text: 'Finish the task.'
    })
    assert.equal(fixture.provider.requests.length, 3)
    assert.equal((state.messages?.at(-1) as { stopReason?: string }).stopReason, 'stop')
    assert.match(JSON.stringify(state.messages), /Recovered after compaction/)
  } finally {
    await fixture.close()
  }
})
