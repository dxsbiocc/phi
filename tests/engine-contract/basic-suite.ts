import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  PhiAgentEvent,
  WorkerCreateSessionResult,
  WorkerSessionState
} from '../../src/main/agent/engine/types'
import type { RpcSessionCreateParams } from '../../src/main/agent/engine/rpc/rpc-session-backend'
import type { startLoopbackModel } from './loopback-model'

export interface BasicEngineFixture {
  sessions: {
    create(params: RpcSessionCreateParams): Promise<WorkerCreateSessionResult>
    prompt(params: { sessionId: string; text: string }): Promise<WorkerSessionState>
    abort(params: { sessionId: string }): Promise<WorkerSessionState>
    dispose(params: { sessionId: string }): Promise<unknown>
    has(sessionId: string): boolean
  }
  onSessionEvent(sessionId: string, listener: (event: PhiAgentEvent) => void): () => void
  params(sessionId: string): RpcSessionCreateParams
  provider: Awaited<ReturnType<typeof startLoopbackModel>>
  close(): Promise<void>
}

export function messageText(value: unknown): string {
  assert.ok(value && typeof value === 'object')
  const content = (value as { content?: unknown }).content
  if (typeof content === 'string') return content
  assert.ok(Array.isArray(content))
  return content
    .filter((item) => item?.type === 'text')
    .map((item) => item.text)
    .join('')
}

export async function eventually(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** The same behavior runs through both real engines, without SDK imports or fake sessions. */
export function basicEngineContract(
  name: string,
  factory: () => Promise<BasicEngineFixture>
): void {
  const contract = (title: string, run: (fixture: BasicEngineFixture) => Promise<void>): void => {
    test(`${name}: ${title}`, { timeout: 30000 }, async (t) => {
      const fixture = await factory()
      t.after(() => fixture.close())
      try {
        await run(fixture)
      } finally {
        await fixture.close()
      }
    })
  }

  contract('creates, streams text and returns authoritative history', async (f) => {
    const events: PhiAgentEvent[] = []
    f.onSessionEvent('basic', (event) => events.push(event))
    assert.equal(f.sessions.has('basic'), false)
    const created = await f.sessions.create(f.params('basic'))
    assert.equal(created.sessionId, 'basic')
    assert.equal(created.state.cwd, f.params('basic').cwd)
    assert.deepEqual(created.state.messages, [])
    assert.equal(f.sessions.has('basic'), true)
    f.provider.enqueue({ text: 'Streaming evidence.' })
    const first = await f.sessions.prompt({ sessionId: 'basic', text: 'First prompt evidence.' })
    assert.equal(messageText(first.messages?.at(-1)), 'Streaming evidence.')
    const types = events.map((event) => event.type)
    assert.ok(types.indexOf('agent_start') >= 0)
    assert.ok(types.indexOf('message_update') > types.indexOf('agent_start'))
    assert.ok(types.lastIndexOf('agent_end') > types.indexOf('message_update'))
    const deltas = events.filter(
      (event) =>
        event.type === 'message_update' &&
        (event.assistantMessageEvent as { type?: string })?.type === 'text_delta'
    )
    assert.ok(deltas.length >= 2, 'Actual SDK must emit separate text deltas')
    assert.equal(first.model?.provider, 'phi-contract')
    f.provider.enqueue({ text: 'Second answer.' })
    const second = await f.sessions.prompt({ sessionId: 'basic', text: 'Second prompt.' })
    assert.ok(second.messages?.some((message) => messageText(message) === 'First prompt evidence.'))
    assert.ok(second.messages?.some((message) => messageText(message) === 'Streaming evidence.'))
    assert.equal(messageText(second.messages?.at(-1)), 'Second answer.')
    assert.ok(
      f.provider.requests[1].messages.some((message) => message.content === 'Streaming evidence.')
    )
  })

  contract('aborts streaming, settles history and reuses the same session', async (f) => {
    const events: PhiAgentEvent[] = []
    f.onSessionEvent('basic', (event) => events.push(event))
    await f.sessions.create(f.params('basic'))
    f.provider.enqueue({ text: 'Partial response.', hold: true })
    const prompt = f.sessions.prompt({ sessionId: 'basic', text: 'Run until interrupted.' })
    void prompt.catch(() => undefined)
    await eventually(
      () => events.some((event) => event.type === 'message_update'),
      'streamed response'
    )
    const aborted = await f.sessions.abort({ sessionId: 'basic' })
    await prompt
    assert.ok(
      aborted.messages?.some(
        (message) =>
          message !== null &&
          typeof message === 'object' &&
          (message as { stopReason?: string }).stopReason === 'aborted'
      )
    )
    assert.equal(f.sessions.has('basic'), true)
    f.provider.enqueue({ text: 'After abort works.' })
    const resumed = await f.sessions.prompt({ sessionId: 'basic', text: 'Continue.' })
    assert.equal(messageText(resumed.messages?.at(-1)), 'After abort works.')
    assert.ok(
      resumed.messages?.some((message) => messageText(message) === 'Run until interrupted.')
    )
  })

  contract('isolates two live sessions and disposing one preserves the other', async (f) => {
    const aEvents: PhiAgentEvent[] = []
    const bEvents: PhiAgentEvent[] = []
    f.onSessionEvent('a', (event) => aEvents.push(event))
    f.onSessionEvent('b', (event) => bEvents.push(event))
    await f.sessions.create(f.params('a'))
    await f.sessions.create(f.params('b'))
    f.provider.enqueue({ text: 'Only session A.', hold: true })
    const held = f.sessions.prompt({ sessionId: 'a', text: 'Private question A.' })
    void held.catch(() => undefined)
    await eventually(
      () => aEvents.some((event) => event.type === 'message_update'),
      'session A stream'
    )
    f.provider.enqueue({ text: 'Only session B.' })
    const b = await f.sessions.prompt({ sessionId: 'b', text: 'Private question B.' })
    assert.equal(messageText(b.messages?.at(-1)), 'Only session B.')
    assert.ok(!b.messages?.some((message) => messageText(message).includes('session A')))
    assert.ok(
      !f.provider.requests[1].messages.some((message) =>
        String(message.content).includes('question A')
      )
    )
    assert.ok(!JSON.stringify(bEvents).includes('Only session A.'))
    assert.ok(!JSON.stringify(aEvents).includes('Only session B.'))
    await f.sessions.abort({ sessionId: 'a' })
    await held
    await f.sessions.dispose({ sessionId: 'a' })
    assert.equal(f.sessions.has('a'), false)
    assert.equal(f.sessions.has('b'), true)
    await assert.rejects(f.sessions.prompt({ sessionId: 'a', text: 'Disposed session.' }))
    f.provider.enqueue({ text: 'Session B survives.' })
    const remaining = await f.sessions.prompt({ sessionId: 'b', text: 'Continue B.' })
    assert.equal(messageText(remaining.messages?.at(-1)), 'Session B survives.')
    await f.sessions.dispose({ sessionId: 'b' })
    assert.equal(f.sessions.has('b'), false)
  })
}
