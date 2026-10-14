import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  RpcPromptError,
  RpcSessionBackend
} from '../../src/main/agent/engine/rpc/rpc-session-backend'
import {
  basicEngineContract,
  eventually,
  messageText,
  type BasicEngineFixture
} from './basic-suite'
import { createInProcessFixture } from './in-process-factory'
import { createRpcFixture } from './rpc-factory'

async function createBasicInProcessFixture(): Promise<BasicEngineFixture> {
  const fixture = await createInProcessFixture()
  return {
    provider: fixture.provider,
    params: (sessionId) => ({
      sessionId,
      cwd: fixture.cwd,
      agentDir: fixture.agentDir,
      model: fixture.model
    }),
    onSessionEvent: (id, listener) => fixture.engine.events.onSessionEvent(id, listener),
    sessions: {
      create: (params) =>
        fixture.engine.sessions.create({
          ...params,
          sessionManager: { kind: 'memory', cwd: fixture.cwd },
          resourceOptions: {
            noExtensions: true,
            noSkills: true,
            noContextFiles: true,
            noPromptTemplates: true,
            noThemes: true
          },
          noTools: 'all',
          enableToolApproval: false,
          autoCompaction: { enabled: false }
        }),
      prompt: (params) => fixture.engine.sessions.prompt(params),
      abort: (params) => fixture.engine.sessions.abort(params),
      dispose: (params) => fixture.engine.sessions.dispose(params),
      has: (id) => fixture.engine.sessions.has(id)
    },
    close: () => fixture.close()
  }
}

basicEngineContract('InProcessEngine basic', createBasicInProcessFixture)
basicEngineContract('RpcSessionBackend basic', createRpcFixture)

test('RPC prompt failures preserve retry and provider metadata after refreshing history', async (t) => {
  const details = {
    message: 'Synthetic provider unavailable',
    retryable: true,
    provider: 'phi-contract',
    model: 'contract-model',
    httpStatus: 503
  }
  const backend = new RpcSessionBackend(() => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let complete!: (value: { code: number | null; signal: string | null }) => void
    const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      complete = resolve
    })
    const output = (value: unknown): void => {
      stdout.write(JSON.stringify(value) + '\n')
    }
    stdin.on('data', (bytes: Buffer) => {
      const command = JSON.parse(bytes.toString('utf8')) as { type: string; id: string }
      const data =
        command.type === 'negotiate_protocol'
          ? { protocolVersion: 2 }
          : command.type === 'get_state'
            ? { thinkingLevel: 'off' }
            : command.type === 'get_messages'
              ? {
                  messages: [
                    {
                      role: 'assistant',
                      content: [{ type: 'text', text: 'Partial error evidence.' }],
                      stopReason: 'error'
                    }
                  ]
                }
              : { agentInvoked: true }
      output({ type: 'response', id: command.id, command: command.type, success: true, data })
      if (command.type === 'prompt') {
        output({
          type: 'prompt_result',
          id: command.id,
          agentInvoked: true,
          status: 'error',
          sessionSettled: true,
          error: details
        })
      }
    })
    queueMicrotask(() =>
      output({
        type: 'ready',
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
        maxFrameBytes: 1024 * 1024,
        maxReassembledFrameBytes: 64 * 1024 * 1024
      })
    )
    return {
      stdin,
      stdout,
      stderr,
      closed,
      async close() {
        complete({ code: 0, signal: null })
        stdin.end()
        stdout.end()
        stderr.end()
      }
    }
  })
  t.after(() => backend.dispose({ sessionId: 'error' }))
  const states: unknown[] = []
  backend.onSessionState('error', (state) => states.push(state))
  await backend.create({
    sessionId: 'error',
    cwd: '/synthetic/project',
    agentDir: '/synthetic/agent'
  })
  await assert.rejects(
    backend.prompt({ sessionId: 'error', text: 'Synthetic failure.' }),
    (error) => {
      assert.ok(error instanceof RpcPromptError)
      assert.deepEqual(error.cause, details)
      assert.deepEqual(error.result.error, details)
      return true
    }
  )
  assert.equal(states.length, 2, 'Failure still publishes refreshed authoritative history')
})

test(
  'RPC running observer can immediately stop the submitted turn',
  { timeout: 30000 },
  async (t) => {
    const fixture = await createRpcFixture()
    t.after(() => fixture.close())
    await fixture.sessions.create(fixture.params('status-abort'))
    let aborted: Promise<unknown> | undefined
    fixture.backend.onSessionStatus('status-abort', (status) => {
      if (status.phase === 'running' && !aborted) {
        aborted = fixture.sessions.abort({ sessionId: 'status-abort' })
        void aborted.catch(() => undefined)
      }
    })
    fixture.provider.enqueue({ text: 'Until stopped.', hold: true })
    let promptSettled = false
    const prompt = fixture.sessions.prompt({ sessionId: 'status-abort', text: 'Stop on running.' })
    void prompt.then(
      () => {
        promptSettled = true
      },
      () => {
        promptSettled = true
      }
    )
    await eventually(() => aborted !== undefined, 'status-driven abort')
    await aborted
    // Stopping before the provider starts can legitimately produce no assistant message.
    assert.equal(
      promptSettled,
      true,
      'Abort must not acknowledge while the submitted turn still runs'
    )
    await prompt
  }
)

test(
  'RPC running observer cannot reenter prompt before the turn lock is recorded',
  { timeout: 30000 },
  async (t) => {
    const fixture = await createRpcFixture()
    t.after(() => fixture.close())
    await fixture.sessions.create(fixture.params('reentrant'))
    let reentrant: Promise<unknown> | undefined
    let attempted = false
    fixture.backend.onSessionStatus('reentrant', (status) => {
      if (status.phase === 'running' && !attempted) {
        attempted = true
        reentrant = fixture.sessions.prompt({ sessionId: 'reentrant', text: 'Illegal reentry.' })
        void reentrant.catch(() => undefined)
      }
    })
    fixture.provider.enqueue({ text: 'Only the primary turn.' })
    const prompt = fixture.sessions.prompt({ sessionId: 'reentrant', text: 'Primary turn.' })
    void prompt.catch(() => undefined)
    await eventually(() => reentrant !== undefined, 'observer reentry')
    await assert.rejects(reentrant!, /already running/)
    const state = await prompt
    assert.equal(messageText(state.messages?.at(-1)), 'Only the primary turn.')
    assert.equal(fixture.provider.requests.length, 1)
  }
)

test(
  'RPC ready observer can submit the next turn after completion',
  { timeout: 30000 },
  async (t) => {
    const fixture = await createRpcFixture()
    t.after(() => fixture.close())
    let readyCount = 0
    let nextTurn: ReturnType<typeof fixture.sessions.prompt> | undefined
    fixture.backend.onSessionStatus('ready-next', (status) => {
      if (status.phase !== 'ready') return
      if (++readyCount === 2) {
        nextTurn = fixture.sessions.prompt({ sessionId: 'ready-next', text: 'Observer next turn.' })
        void nextTurn.catch(() => undefined)
      }
    })
    await fixture.sessions.create(fixture.params('ready-next'))
    fixture.provider.enqueue({ text: 'Primary completed.' }, { text: 'Observer next completed.' })
    const first = await fixture.sessions.prompt({ sessionId: 'ready-next', text: 'Primary turn.' })
    assert.equal(messageText(first.messages?.at(-1)), 'Primary completed.')
    assert.ok(nextTurn)
    const second = await nextTurn
    assert.equal(messageText(second.messages?.at(-1)), 'Observer next completed.')
    assert.equal(fixture.provider.requests.length, 2)
  }
)

test(
  'RPC official v2 chunks preserve a >1 MiB multibyte assistant stream and history',
  { timeout: 30000 },
  async (t) => {
    const fixture = await createRpcFixture()
    t.after(() => fixture.close())
    const expected = Array.from(
      { length: 16000 },
      (_, index) => `边界🙂 ${index}: ${createHash('sha256').update(String(index)).digest('hex')}\n`
    ).join('')
    assert.ok(Buffer.byteLength(expected, 'utf8') > 1024 * 1024)
    const deltas: string[] = []
    fixture.onSessionEvent('large', (event) => {
      if (event.type !== 'message_update') return
      const update = event.assistantMessageEvent as { type?: string; delta?: unknown }
      if (update?.type === 'text_delta' && typeof update.delta === 'string')
        deltas.push(update.delta)
    })
    await fixture.sessions.create(fixture.params('large'))
    fixture.provider.enqueue({ text: expected, textChunkChars: 4096 })
    const state = await fixture.sessions.prompt({
      sessionId: 'large',
      text: 'Emit the large fixture.'
    })
    assert.equal(deltas.join(''), expected)
    assert.equal(messageText(state.messages?.at(-1)), expected)
  }
)

test(
  'RPC rejected model setup releases the session and permits an explicit retry',
  { timeout: 30000 },
  async (t) => {
    const fixture = await createRpcFixture()
    t.after(() => fixture.close())
    const params = fixture.params('setup')
    await assert.rejects(
      fixture.sessions.create({
        ...params,
        model: {
          provider: 'phi-contract',
          id: 'missing-contract-model',
          name: 'Missing',
          reasoning: false
        }
      }),
      /Model not found/
    )
    assert.equal(fixture.sessions.has('setup'), false)
    assert.equal(fixture.provider.requests.length, 0)
    await fixture.sessions.create(params)
    fixture.provider.enqueue({ text: 'Explicit model retry works.' })
    const state = await fixture.sessions.prompt({ sessionId: 'setup', text: 'Retry.' })
    assert.equal(messageText(state.messages?.at(-1)), 'Explicit model retry works.')
  }
)

test('RPC isolates failing event, state and status observers', { timeout: 30000 }, async (t) => {
  const fixture = await createRpcFixture()
  t.after(() => fixture.close())
  const events: string[] = []
  const states: unknown[] = []
  const statuses: string[] = []
  const asyncObservers = new Set<string>()
  const fail = (): never => {
    throw new Error('Fixture observer failed')
  }
  const failAsync = (kind: string) => async (): Promise<never> => {
    asyncObservers.add(kind)
    throw new Error(`Fixture async ${kind} observer failed`)
  }
  fixture.onSessionEvent('observers', fail)
  fixture.onSessionEvent('observers', failAsync('event'))
  fixture.onSessionEvent('observers', (event) => events.push(event.type))
  fixture.backend.onSessionState('observers', fail)
  fixture.backend.onSessionState('observers', failAsync('state'))
  fixture.backend.onSessionState('observers', (state) => states.push(state))
  fixture.backend.onSessionStatus('observers', fail)
  fixture.backend.onSessionStatus('observers', failAsync('status'))
  fixture.backend.onSessionStatus('observers', (status) => statuses.push(status.phase))
  await fixture.sessions.create(fixture.params('observers'))
  fixture.provider.enqueue({ text: 'Observers cannot break this turn.' })
  const state = await fixture.sessions.prompt({ sessionId: 'observers', text: 'Proceed.' })
  assert.equal(messageText(state.messages?.at(-1)), 'Observers cannot break this turn.')
  assert.ok(events.includes('agent_end'))
  assert.equal(states.length, 2)
  assert.deepEqual(statuses, ['ready', 'running', 'ready'])
  assert.deepEqual([...asyncObservers].sort(), ['event', 'state', 'status'])
})

test(
  'RPC disconnect marks the session interrupted and never replays its prompt',
  { timeout: 30000 },
  async (t) => {
    const fixture = await createRpcFixture()
    t.after(() => fixture.close())
    const events: string[] = []
    const statuses: string[] = []
    fixture.backend.onSessionStatus('broken', (status) => statuses.push(status.phase))
    fixture.onSessionEvent('broken', (event) => events.push(event.type))
    await fixture.sessions.create(fixture.params('broken'))
    fixture.provider.enqueue({ text: 'Before disconnect.', hold: true })
    const prompt = fixture.sessions.prompt({ sessionId: 'broken', text: 'Do not replay this.' })
    void prompt.catch(() => undefined)
    await eventually(() => events.includes('message_update'), 'first disconnected session delta')
    await fixture.kill('broken')
    await assert.rejects(prompt)
    await eventually(() => statuses.includes('interrupted'), 'interruption notification')
    await assert.rejects(
      fixture.sessions.prompt({ sessionId: 'broken', text: 'Unavailable.' }),
      /unavailable/
    )
    assert.equal(fixture.provider.requests.length, 1)
    await fixture.sessions.dispose({ sessionId: 'broken' })
    assert.equal(fixture.sessions.has('broken'), false)
    // Reconnection is explicit and starts fresh; no generation silently resends a turn.
    await fixture.sessions.create(fixture.params('broken'))
    assert.equal(fixture.provider.requests.length, 1)
    fixture.provider.enqueue({ text: 'Explicit new turn.' })
    const resumed = await fixture.sessions.prompt({ sessionId: 'broken', text: 'Fresh request.' })
    assert.equal(messageText(resumed.messages?.at(-1)), 'Explicit new turn.')
    assert.equal(fixture.provider.requests.length, 2)
  }
)

test(
  'RPC dispose cancels an active turn and emits no late session callbacks',
  { timeout: 30000 },
  async (t) => {
    const fixture = await createRpcFixture()
    t.after(() => fixture.close())
    const events: string[] = []
    const states: unknown[] = []
    fixture.onSessionEvent('disposed', (event) => events.push(event.type))
    fixture.backend.onSessionState('disposed', (state) => states.push(state))
    await fixture.sessions.create(fixture.params('disposed'))
    await assert.rejects(fixture.sessions.create(fixture.params('disposed')), /already exists/)
    fixture.provider.enqueue({ text: 'Before dispose.', hold: true })
    const prompt = fixture.sessions.prompt({ sessionId: 'disposed', text: 'Until disposed.' })
    void prompt.catch(() => undefined)
    await eventually(() => events.includes('message_update'), 'first disposed session delta')
    const before = { events: events.length, states: states.length }
    await fixture.sessions.dispose({ sessionId: 'disposed' })
    await assert.rejects(prompt)
    assert.equal(fixture.sessions.has('disposed'), false)
    assert.equal(events.length, before.events)
    assert.equal(states.length, before.states)
    await fixture.sessions.dispose({ sessionId: 'disposed' })
  }
)

test(
  'RPC closing generation cannot remove subscriptions of an explicit replacement',
  { timeout: 30000 },
  async (t) => {
    const fixture = await createRpcFixture()
    t.after(() => fixture.close())
    await fixture.sessions.create(fixture.params('replacement'))
    const closing = fixture.sessions.dispose({ sessionId: 'replacement' })
    const events: string[] = []
    fixture.onSessionEvent('replacement', (event) => events.push(event.type))
    await fixture.sessions.create(fixture.params('replacement'))
    await closing
    fixture.provider.enqueue({ text: 'Replacement subscriptions survive.' })
    const state = await fixture.sessions.prompt({
      sessionId: 'replacement',
      text: 'Explicit replacement.'
    })
    assert.equal(messageText(state.messages?.at(-1)), 'Replacement subscriptions survive.')
    assert.ok(events.includes('agent_end'))
  }
)

test('RPC same-tick external abort settles the submitted turn', { timeout: 30000 }, async (t) => {
  const fixture = await createRpcFixture()
  t.after(() => fixture.close())
  await fixture.sessions.create(fixture.params('immediate-abort'))
  fixture.provider.enqueue({ text: 'Only until stopped.', hold: true })
  const prompt = fixture.sessions.prompt({
    sessionId: 'immediate-abort',
    text: 'Stop immediately.'
  })
  let settled = false
  void prompt.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  await fixture.sessions.abort({ sessionId: 'immediate-abort' })
  assert.equal(settled, true)
  await prompt
})

test(
  'RPC immediate dispose prevents an old turn from notifying its replacement',
  { timeout: 30000 },
  async (t) => {
    const fixture = await createRpcFixture()
    t.after(() => fixture.close())
    const params = fixture.params('immediate-replacement')
    await fixture.sessions.create(params)
    const prompt = fixture.sessions.prompt({
      sessionId: params.sessionId,
      text: 'Disposed before running.'
    })
    void prompt.catch(() => undefined)
    const closing = fixture.sessions.dispose({ sessionId: params.sessionId })
    const statuses: string[] = []
    fixture.backend.onSessionStatus(params.sessionId, (status) => statuses.push(status.phase))
    await fixture.sessions.create(params)
    await closing
    await assert.rejects(prompt)
    assert.deepEqual(statuses, ['ready'])
  }
)

for (const phase of ['create', 'prompt'] as const) {
  test(
    `RPC ${phase} state observer cannot send old ready state to a replacement`,
    { timeout: 30000 },
    async (t) => {
      const fixture = await createRpcFixture()
      t.after(() => fixture.close())
      const params = fixture.params('state-replacement')
      if (phase === 'prompt') await fixture.sessions.create(params)
      const statuses: string[] = []
      let replaced = false
      let replacement: ReturnType<typeof fixture.sessions.create> | undefined
      let closing: Promise<unknown> | undefined
      fixture.backend.onSessionState(params.sessionId, () => {
        if (replaced) return
        replaced = true
        closing = fixture.sessions.dispose({ sessionId: params.sessionId })
        fixture.backend.onSessionStatus(params.sessionId, (status) => statuses.push(status.phase))
        replacement = fixture.sessions.create(params)
        void replacement.catch(() => undefined)
      })
      fixture.provider.enqueue({ text: 'Old generation finishes.' })
      const operation =
        phase === 'create'
          ? fixture.sessions.create(params)
          : fixture.sessions.prompt({ sessionId: params.sessionId, text: 'Old turn.' })
      await assert.rejects(operation, /disposed/)
      assert.ok(replacement)
      await replacement
      await closing
      assert.deepEqual(statuses, ['ready'])
      assert.equal(fixture.sessions.has(params.sessionId), true)
    }
  )
}
