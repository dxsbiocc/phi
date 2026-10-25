import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { KernelProtocolCore, type FrameTransport } from '../src/kernel/protocol'
import {
  KernelClientError,
  KernelProtocolClient,
  spawnKernelStdio,
  type KernelClientTransport
} from '../src/main/agent/engine/kernel-client'

class PairedTransport implements FrameTransport, KernelClientTransport {
  peer?: PairedTransport
  private readonly lineListeners = new Set<(line: string) => void>()
  private readonly closeListeners = new Set<() => void>()

  send(line: string): void {
    const peer = this.peer
    if (!peer) throw new Error('Transport is not paired')
    queueMicrotask(() => {
      for (const listener of peer.lineListeners) listener(line)
    })
  }

  onLine(callback: (line: string) => void): void {
    this.lineListeners.add(callback)
  }

  onClose(callback: () => void): void {
    this.closeListeners.add(callback)
  }

  close(): void {
    for (const listener of this.closeListeners) listener()
    for (const listener of this.peer?.closeListeners ?? []) listener()
  }
}

function pair(): [PairedTransport, PairedTransport] {
  const client = new PairedTransport()
  const server = new PairedTransport()
  client.peer = server
  server.peer = client
  return [client, server]
}

test('kernel client negotiates, correlates requests, events, and contextual host replies', async () => {
  const [clientTransport, serverTransport] = pair()
  const core: KernelProtocolCore = new KernelProtocolCore({
    kernelVersion: 'test',
    ompVersion: 'test',
    handlers: {
      async 'session.snapshot'(_params, _context, request) {
        const host = await core.requestHost(
          'desktop.snapshot',
          { requested: true },
          { sessionId: request.sessionId, agentRunId: 'run-1' }
        )
        return {
          sessionId: request.sessionId ?? 'missing',
          messages: [host],
          cwd: '/tmp/client-test'
        }
      }
    }
  })
  core.attachTransport(serverTransport, { trusted: true })
  const client = new KernelProtocolClient(clientTransport)
  const events: string[] = []
  client.onEvent((event) => events.push(event.type))
  client.registerHostHandler('desktop.snapshot', (params, context) => {
    assert.deepEqual(params, { requested: true })
    assert.deepEqual(context, { sessionId: 'session-1', agentRunId: 'run-1' })
    return { fromHost: true }
  })

  const greeting = await client.hello({ hostCapabilities: ['desktop.snapshot'] })
  assert.equal(client.controllerGeneration, greeting.controllerGeneration)
  const snapshot = await client.request('session.snapshot', {}, { sessionId: 'session-1' })
  assert.deepEqual(snapshot, {
    sessionId: 'session-1',
    messages: [{ fromHost: true }],
    cwd: '/tmp/client-test'
  })
  core.emitEvent('session.event', { type: 'agent_start' }, { sessionId: 'session-1' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['session.event'])
  await client.close()
})

test('kernel client maps protocol failures to typed errors', async () => {
  const [clientTransport, serverTransport] = pair()
  const core = new KernelProtocolCore({ kernelVersion: 'test', ompVersion: 'test' })
  core.attachTransport(serverTransport, { trusted: true })
  const client = new KernelProtocolClient(clientTransport)
  await client.hello()

  await assert.rejects(
    client.request('session.snapshot', {}, { sessionId: 'missing' }),
    (error: unknown) => {
      assert.ok(error instanceof KernelClientError)
      assert.equal(error.code, 'CAPABILITY_UNAVAILABLE')
      return true
    }
  )
  await client.close()
})

test(
  'stdio adapter spawns the kernel and reserves stderr for diagnostics',
  { timeout: 15_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'phi-kernel-client-'))
    const diagnostics: string[] = []
    const kernel = spawnKernelStdio({
      cwd: resolve('.'),
      env: { ...process.env, PI_CODING_AGENT_DIR: root },
      onDiagnostic: (text) => diagnostics.push(text)
    })
    try {
      const greeting = await kernel.client.hello()
      assert.ok(greeting.capabilities.includes('session.create'))
      assert.equal(kernel.client.controllerGeneration, 1)
      assert.ok(diagnostics.every((line) => !line.includes('"kind":"response"')))
    } finally {
      await kernel.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
)
