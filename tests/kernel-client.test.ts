import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { KernelProtocolCore, type FrameTransport } from '../src/kernel/protocol'
import {
  KernelClientError,
  KernelProtocolClient,
  launchLocalKernel,
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

test(
  'local launcher negotiates a source kernel before returning it',
  { timeout: 15_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'phi-local-kernel-source-'))
    const kernel = await launchLocalKernel({
      sourceMode: true,
      agentDir: root,
      cwd: resolve('.')
    })
    try {
      assert.equal(kernel.client.controllerGeneration, kernel.greeting.controllerGeneration)
      assert.ok(kernel.greeting.capabilities.includes('session.create'))
      assert.ok(kernel.process.pid)
    } finally {
      try {
        const outcome = await kernel.close()
        assert.equal(outcome.action, 'stdin-eof')
        assert.equal(outcome.code, 0)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  }
)

test(
  'local launcher executes a compiled path, keeps diagnostics off stdout, and kills within budget',
  { timeout: 10_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'phi-local-kernel-compiled-'))
    const executable = join(root, 'fake-compiled-kernel')
    const previousSecret = process.env.PHI_LOCAL_LAUNCH_SECRET
    process.env.PHI_LOCAL_LAUNCH_SECRET = 'must-not-reach-explicit-env'
    t.after(() => {
      if (previousSecret === undefined) delete process.env.PHI_LOCAL_LAUNCH_SECRET
      else process.env.PHI_LOCAL_LAUNCH_SECRET = previousSecret
    })
    writeFileSync(
      executable,
      `#!/usr/bin/env bun
import { createInterface } from 'node:readline'

process.stderr.write('compiled kernel diagnostic\\n')
const lines = createInterface({ input: process.stdin })
lines.once('line', (line) => {
  const request = JSON.parse(line)
  process.stdout.write(JSON.stringify({
    kind: 'response',
    id: request.id,
    ok: true,
    result: {
      protocol: { major: 1, minor: 0 },
      kernel: { version: process.env.PHI_LOCAL_LAUNCH_SECRET ?? 'compiled-test', ompVersion: 'compiled-test' },
      kernelInstanceId: 'compiled-test-kernel',
      controllerGeneration: 1,
      capabilities: ['session.create'],
      lastSeq: 0
    }
  }) + '\\n')
  process.on('SIGTERM', () => undefined)
  setInterval(() => undefined, 60_000)
})
`,
      { mode: 0o700 }
    )
    const diagnostics: string[] = []
    let confirmDiagnostic!: () => void
    const diagnosticReceived = new Promise<void>((resolveDiagnostic) => {
      confirmDiagnostic = resolveDiagnostic
    })
    const kernel = await launchLocalKernel({
      executable,
      agentDir: root,
      env: { PATH: process.env.PATH },
      onDiagnostic: (text) => {
        diagnostics.push(text)
        confirmDiagnostic()
      }
    })

    try {
      await diagnosticReceived
      assert.equal(kernel.greeting.kernel.version, 'compiled-test')
      assert.equal(kernel.client.controllerGeneration, 1)
      assert.equal(diagnostics.join(''), 'compiled kernel diagnostic\n')

      const startedAt = Date.now()
      const outcome = await kernel.close()
      assert.equal(outcome.action, 'sigkill')
      assert.equal(outcome.signal, 'SIGKILL')
      assert.ok(Date.now() - startedAt < 2_500)
      assert.deepEqual(await kernel.close(), outcome)
    } finally {
      if (kernel.process.exitCode === null && kernel.process.signalCode === null) {
        kernel.process.kill('SIGKILL')
      }
      rmSync(root, { recursive: true, force: true })
    }
  }
)
