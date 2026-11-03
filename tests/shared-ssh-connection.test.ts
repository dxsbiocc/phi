import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  RemoteConnectionConfig,
  RemoteSshSession,
  RemoteStdioProcess
} from '../src/main/agent/wrappers/remote-ssh-session'
import { connectSharedSshSession } from '../src/main/agent/wrappers/shared-ssh-connection'
import {
  setConnectionEventSink,
  type ConnectionEvent
} from '../src/main/agent/connection-events'

function fakeServer(host: string): {
  config: RemoteConnectionConfig
  connections: Array<{ alive: boolean; stdioClosed: number; closed: boolean }>
  connect: (config: RemoteConnectionConfig) => Promise<RemoteSshSession>
} {
  const connections: Array<{ alive: boolean; stdioClosed: number; closed: boolean }> = []
  return {
    config: { host, execTimeoutMs: 5_000 },
    connections,
    connect: async () => {
      const state = { alive: true, stdioClosed: 0, closed: false }
      connections.push(state)
      return {
        exec: async () => ({ code: 0, stdout: '', stderr: '' }),
        isAlive: async () => state.alive,
        openStdio: async () => {
          const closed = Promise.withResolvers<void>()
          return {
            closed: closed.promise,
            close: async () => {
              state.stdioClosed += 1
              closed.resolve()
            }
          } as unknown as RemoteStdioProcess
        },
        close: async () => {
          state.closed = true
        }
      } as unknown as RemoteSshSession
    }
  }
}

test('sessions on one server share a connection that outlives each of them', async () => {
  const server = fakeServer('share-a')
  const first = await connectSharedSshSession(server.config, server.connect)
  await first.close()
  const second = await connectSharedSshSession(
    { ...server.config, execTimeoutMs: 30_000, userInitiated: true },
    server.connect
  )
  assert.equal(server.connections.length, 1)
  assert.equal(server.connections[0].closed, false)
  await second.close()
})

test('a dead connection is replaced', async () => {
  const server = fakeServer('share-b')
  await (await connectSharedSshSession(server.config, server.connect)).close()
  server.connections[0].alive = false
  const next = await connectSharedSshSession(server.config, server.connect)
  assert.equal(server.connections.length, 2)
  assert.equal(server.connections[0].closed, true)
  await next.close()
})

test('closing a session ends only its own channels, and rejects later commands', async () => {
  const server = fakeServer('share-c')
  const first = await connectSharedSshSession(server.config, server.connect)
  const other = await connectSharedSshSession(server.config, server.connect)
  await first.openStdio!('serve')
  const kept = await other.openStdio!('serve')
  await first.close()
  assert.equal(server.connections[0].stdioClosed, 1)
  assert.equal(server.connections[0].closed, false)
  await assert.rejects(first.exec('true'), /SSH 连接已关闭/)
  assert.equal((await other.exec('true')).code, 0)
  await kept.close()
  await other.close()
})

test('stdio channels past the per-connection limit open another connection', async () => {
  const server = fakeServer('share-d')
  const session = await connectSharedSshSession(server.config, server.connect)
  for (let index = 0; index < 4; index += 1) await session.openStdio!('serve')
  assert.equal(server.connections.length, 2)
  await session.close()
  assert.equal(server.connections[0].stdioClosed, 3)
  assert.equal(server.connections[1].stdioClosed, 1)
})

test('the log shows each server connection opening once and why one was replaced', async () => {
  const events: ConnectionEvent[] = []
  setConnectionEventSink((event) => events.push(event))
  try {
    const gpu = fakeServer('log-gpu')
    const node3 = fakeServer('log-node3')
    await (await connectSharedSshSession(gpu.config, gpu.connect)).close()
    await (await connectSharedSshSession(node3.config, node3.connect)).close()
    await (await connectSharedSshSession(gpu.config, gpu.connect)).close()
    gpu.connections[0].alive = false
    await (await connectSharedSshSession(gpu.config, gpu.connect)).close()
    assert.deepEqual(
      events.map(({ change, target, reason }) => [change, target, reason]),
      [
        ['opened', 'log-gpu', undefined],
        ['opened', 'log-node3', undefined],
        ['closed', 'log-gpu', 'not_answering'],
        ['opened', 'log-gpu', undefined]
      ]
    )
  } finally {
    setConnectionEventSink(undefined)
  }
})
