import assert from 'node:assert/strict'
import test from 'node:test'

import { KernelClientError } from '../src/main/agent/engine/kernel-client'
import { KernelExecutionHost } from '../src/main/agent/engine/kernel-execution-host'

type EventListener = (event: unknown) => void

type Fixture = {
  host: KernelExecutionHost
  client: unknown
  reopened: unknown[]
  projected: unknown[]
  launchSignals: AbortSignal[]
  emit: EventListener
}

function fixture(subscribe: (afterSeq: number) => Promise<unknown>): Fixture {
  const reopened: unknown[] = []
  const projected: unknown[] = []
  let onEvent: EventListener = () => undefined
  const client = {
    subscribe,
    onEvent: (listener: EventListener) => {
      onEvent = listener
      return () => undefined
    },
    onClose: () => () => undefined
  }
  const factory = {
    configureClient: () => () => undefined,
    hostCapabilityNames: () => [],
    assertConnectionIdentity: () => undefined,
    bindHostHandler: () => () => undefined,
    hasLiveSessions: () => true,
    interruptHost: () => undefined,
    projectEvent: (_host: unknown, event: unknown) => projected.push(event),
    reopenHostSessions: async (_host: unknown, target: unknown) => {
      reopened.push(target)
    }
  }
  const launchSignals: AbortSignal[] = []
  const launcher = async (
    _params: unknown,
    _context: unknown,
    signal: AbortSignal
  ): Promise<unknown> => {
    launchSignals.push(signal)
    return { client, greeting: { kernelInstanceId: 'kernel-1' }, close: async () => undefined }
  }
  const host = new KernelExecutionHost('host-key', factory as never, launcher as never)
  return {
    host,
    client,
    reopened,
    projected,
    launchSignals,
    emit: (event: unknown) => onEvent(event)
  }
}

const gap = (): KernelClientError =>
  new KernelClientError({
    code: 'REPLAY_GAP',
    message: 'Requested events are no longer available.',
    detail: { oldestSeq: 94 }
  })

test('attaching to a live kernel whose early events were evicted still connects', async () => {
  const { host, client, reopened, projected, emit } = fixture(() => Promise.reject(gap()))

  const connected = await host.client({} as never, new AbortController().signal)

  assert.equal(connected, client)
  assert.deepEqual(reopened, [client], 'sessions are rebuilt from their snapshots')
  emit({ kind: 'event', seq: 1200, type: 'run.started' })
  assert.equal(projected.length, 1, 'live events keep flowing after the gap')
})

test('ending the session that opened the connection leaves the shared connection alive', async () => {
  const { host, launchSignals } = fixture(() => Promise.resolve(undefined))
  const opener = new AbortController()

  await host.client({} as never, opener.signal)
  opener.abort(new Error('mode switched'))

  assert.equal(launchSignals.length, 1)
  assert.equal(launchSignals[0].aborted, false, 'model tunnels stay open for later sessions')
  await host.close()
  assert.equal(launchSignals[0].aborted, true, 'closing the host releases them')
})

test('a cancelled caller stops waiting without cancelling the shared launch', async () => {
  const { host, launchSignals } = fixture(() => Promise.resolve(undefined))
  const caller = new AbortController()
  caller.abort(new Error('gone'))

  await assert.rejects(host.client({} as never, caller.signal), /gone/)
  assert.equal(launchSignals.length, 0)
})

test('any other subscribe failure still fails the connection', async () => {
  const failure = new KernelClientError({ code: 'INVALID_PARAMS', message: 'bad' })
  const { host } = fixture(() => Promise.reject(failure))

  await assert.rejects(host.client({} as never, new AbortController().signal), /bad/)
})
