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
  const launcher = async (): Promise<unknown> => ({
    client,
    greeting: { kernelInstanceId: 'kernel-1' },
    close: async () => undefined
  })
  const host = new KernelExecutionHost('host-key', factory as never, launcher as never)
  return { host, client, reopened, projected, emit: (event: unknown) => onEvent(event) }
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

test('any other subscribe failure still fails the connection', async () => {
  const failure = new KernelClientError({ code: 'INVALID_PARAMS', message: 'bad' })
  const { host } = fixture(() => Promise.reject(failure))

  await assert.rejects(host.client({} as never, new AbortController().signal), /bad/)
})
