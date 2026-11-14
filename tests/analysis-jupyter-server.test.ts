import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  extractJupyterEndpoint,
  jupyterPortForProject,
  jupyterServerArgs,
  JupyterServerRegistry,
  PHI_JUPYTER_PORT,
  type JupyterServerLaunch,
  type ManagedJupyterProcess
} from '../src/main/agent/notebook/analysis-jupyter-server'
import { LocalJupyterRuntimeBackend } from '../src/main/agent/notebook/jupyter-runtime-backend'

class FakeJupyterProcess extends EventEmitter implements ManagedJupyterProcess {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false

  constructor(readonly pid: number) {
    super()
  }

  kill(): boolean {
    this.killed = true
    this.emit('exit', 0, null)
    return true
  }

  emitError(error: Error): void {
    this.emit('error', error)
  }
}

function projectDir(): string {
  return mkdtempSync(join(tmpdir(), 'phi-jupyter-project-'))
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for readiness condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createTcpServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close((error) => {
        if (error) reject(error)
        else resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })
  })
}

test('extractJupyterEndpoint keeps token internal and returns a sanitized local URL', () => {
  const endpoint = extractJupyterEndpoint("http://127.0.0.1:8888/lab?token=secret-token&foo=bar'")

  assert.equal(endpoint?.url, 'http://127.0.0.1:8888/lab?foo=bar')
  assert.equal(endpoint?.token, 'secret-token')
  assert.equal(endpoint?.port, 8888)
})

test('JupyterServerRegistry uses one fixed Phi port for every project', () => {
  const project = projectDir()
  const otherProject = projectDir()
  const registry = new JupyterServerRegistry()
  const status = registry.status(project)
  const otherStatus = registry.status(otherProject)
  const projectCwd = status.projectCwd

  assert.equal(status.port, PHI_JUPYTER_PORT)
  assert.equal(otherStatus.port, PHI_JUPYTER_PORT)
  assert.equal(jupyterPortForProject(projectCwd), PHI_JUPYTER_PORT)
  assert.equal(status.port, otherStatus.port)
  assert.equal(status.state, 'stopped')
})

test('JupyterServerRegistry reports a non-directory project path in English', () => {
  const path = join(projectDir(), 'not-a-directory')
  writeFileSync(path, '')
  const registry = new JupyterServerRegistry()

  assert.throws(() => registry.status(path), /Project path is not a directory/)
})

test('jupyterServerArgs pins localhost, project port, and disables port retries', () => {
  assert.deepEqual(jupyterServerArgs({ port: 31888 }), [
    'server',
    '--no-browser',
    '--ServerApp.ip=127.0.0.1',
    '--ServerApp.port=31888',
    '--ServerApp.port_retries=0',
    '--ServerApp.open_browser=False',
    '--ServerApp.token=',
    '--ServerApp.password=',
    '--ServerApp.allow_remote_access=False'
  ])
})

test('JupyterServerRegistry starts only one server for the same project', () => {
  const processes: FakeJupyterProcess[] = []
  const launches: JupyterServerLaunch[] = []
  const project = projectDir()
  const registry = new JupyterServerRegistry({
    readyProbeAttempts: 0,
    now: () => new Date('2026-09-09T00:00:00.000Z'),
    createProcess: (_cwd, launch) => {
      const process = new FakeJupyterProcess(1234)
      processes.push(process)
      launches.push(launch)
      return process
    }
  })

  const first = registry.start(project)
  const second = registry.start(project)

  assert.equal(processes.length, 1)
  assert.equal(first.state, 'starting')
  assert.equal(second.state, 'starting')
  assert.equal(first.pid, 1234)
  assert.equal(first.hasEndpoint, false)
  assert.equal(first.port, PHI_JUPYTER_PORT)
  assert.equal(first.message, 'Starting Jupyter Server')
  assert.equal(first.messageCode, 'starting')
  assert.deepEqual(launches, [{ port: PHI_JUPYTER_PORT }])
})

test('LocalJupyterRuntimeBackend preserves stable message metadata', async () => {
  const project = projectDir()
  const registry = new JupyterServerRegistry({
    readyProbeAttempts: 0,
    createProcess: () => new FakeJupyterProcess(1235)
  })
  const backend = new LocalJupyterRuntimeBackend(registry)

  await backend.start(project)
  const status = backend.status(project)

  assert.equal(status.message, 'Starting Jupyter Server')
  assert.equal(status.messageCode, 'starting')
})

test('JupyterServerRegistry marks server ready from localhost health probe', async () => {
  const probedUrls: string[] = []
  const project = projectDir()
  const registry = new JupyterServerRegistry({
    readyProbeAttempts: 1,
    readyProbeIntervalMs: 0,
    readyProbe: async (url) => {
      probedUrls.push(url)
      return true
    },
    createProcess: () => new FakeJupyterProcess(9012)
  })

  registry.start(project)
  await tick()
  const status = registry.status(project)

  assert.equal(status.state, 'ready')
  assert.equal(status.hasEndpoint, true)
  assert.equal(status.port, PHI_JUPYTER_PORT)
  assert.equal(status.message, 'Jupyter Server is ready')
  assert.equal(status.messageCode, 'ready')
  assert.deepEqual(probedUrls, [`http://127.0.0.1:${PHI_JUPYTER_PORT}/`])
})

test('JupyterServerRegistry marks server ready from local Jupyter output only after the health probe succeeds', async () => {
  let process!: FakeJupyterProcess
  let probeCalls = 0
  const project = projectDir()
  const registry = new JupyterServerRegistry({
    port: 8899,
    readyProbeAttempts: 1,
    readyProbeIntervalMs: 0,
    readyProbe: async () => {
      probeCalls += 1
      return true
    },
    createProcess: () => {
      process = new FakeJupyterProcess(5678)
      return process
    }
  })

  registry.start(project)
  process.stderr.write('    http://localhost:8899/tree?token=top-secret\n')
  assert.equal(registry.status(project).state, 'starting')
  assert.equal(registry.connection(project), null)

  await waitFor(() => registry.status(project).state === 'ready')
  const status = registry.status(project)
  const connection = registry.connection(project)

  assert.equal(status.state, 'ready')
  assert.equal(status.hasEndpoint, true)
  assert.equal(status.pid, 5678)
  assert.equal(status.port, 8899)
  assert.equal(probeCalls, 1)
  assert.equal(connection?.url, 'http://127.0.0.1:8899/tree')
  assert.equal(connection?.token, 'top-secret')
  assert.ok(connection?.runtimeId)
  assert.doesNotMatch(JSON.stringify(status), /top-secret/)
  assert.doesNotMatch(JSON.stringify(status), /token=/)
})

test('JupyterServerRegistry ignores unrelated hosts and ports and keeps banner metadata only as a candidate', async () => {
  let process!: FakeJupyterProcess
  let resolveProbe!: (ready: boolean) => void
  let probeCalls = 0
  const probeGate = new Promise<boolean>((resolve) => {
    resolveProbe = resolve
  })
  const project = projectDir()
  const registry = new JupyterServerRegistry({
    readyProbeAttempts: 2,
    readyProbeIntervalMs: 0,
    readyProbe: async () => {
      probeCalls += 1
      return probeGate
    },
    createProcess: () => (process = new FakeJupyterProcess(5680))
  })

  registry.start(project)
  process.stderr.write('extension endpoint http://localhost:9000/docs\n')
  assert.equal(registry.status(project).state, 'starting')
  assert.equal(registry.connection(project), null)
  process.stderr.write(`http://evil.example:${PHI_JUPYTER_PORT}/tree?token=evil\n`)
  assert.equal(registry.connection(project), null)
  process.stderr.write(`http://localhost:${PHI_JUPYTER_PORT}/tree?token=split-`)
  assert.equal(registry.connection(project), null)
  process.stderr.write('token\n')
  assert.equal(registry.status(project).state, 'starting')
  assert.equal(registry.connection(project), null)

  resolveProbe(true)
  await waitFor(() => registry.status(project).state === 'ready')
  const connection = registry.connection(project)
  assert.equal(connection?.url, `http://127.0.0.1:${PHI_JUPYTER_PORT}/tree`)
  assert.equal(connection?.token, 'split-token')
  assert.equal(probeCalls, 1)
})

test('JupyterServerRegistry recognizes a split URL banner but does not become ready before the probe', async () => {
  let process!: FakeJupyterProcess
  let resolveProbe!: (ready: boolean) => void
  const probeGate = new Promise<boolean>((resolve) => {
    resolveProbe = resolve
  })
  const project = projectDir()
  const registry = new JupyterServerRegistry({
    port: 8899,
    readyProbeAttempts: 1,
    readyProbeIntervalMs: 0,
    readyProbe: async () => probeGate,
    createProcess: () => {
      process = new FakeJupyterProcess(5679)
      return process
    }
  })

  registry.start(project)
  // A pipe can flush a single line across multiple 'data' events; the ready
  // banner must still be recognized once the halves arrive, even when the
  // split falls before the port is fully written out.
  process.stderr.write('    http://local')
  assert.equal(registry.status(project).state, 'starting')
  process.stderr.write('host:8899/tree?token=top-secret\n')
  assert.equal(registry.status(project).state, 'starting')
  assert.equal(registry.connection(project), null)

  resolveProbe(true)
  await waitFor(() => registry.status(project).state === 'ready')
  const status = registry.status(project)

  assert.equal(status.state, 'ready')
  assert.equal(status.hasEndpoint, true)
  assert.equal(status.port, 8899)
})

test('JupyterServerRegistry retries a false health probe before marking the banner candidate ready', async () => {
  let process!: FakeJupyterProcess
  const pendingProbes: Array<(ready: boolean) => void> = []
  let probeCalls = 0
  const project = projectDir()
  const registry = new JupyterServerRegistry({
    readyProbeAttempts: 3,
    readyProbeIntervalMs: 0,
    readyProbe: () =>
      new Promise((resolve) => {
        probeCalls += 1
        pendingProbes.push(resolve)
      }),
    createProcess: () => (process = new FakeJupyterProcess(5681))
  })

  registry.start(project)
  process.stderr.write(`http://127.0.0.1:${PHI_JUPYTER_PORT}/lab?token=probe-token\n`)
  await waitFor(() => pendingProbes.length === 1)
  assert.equal(registry.status(project).state, 'starting')
  assert.equal(registry.connection(project), null)

  const firstProbe = pendingProbes.shift()
  assert.ok(firstProbe)
  firstProbe(false)
  await waitFor(() => pendingProbes.length === 1)
  assert.equal(registry.status(project).state, 'starting')
  assert.equal(registry.connection(project), null)

  const secondProbe = pendingProbes.shift()
  assert.ok(secondProbe)
  secondProbe(true)
  await waitFor(() => registry.status(project).state === 'ready')
  const connection = registry.connection(project)
  assert.equal(connection?.url, `http://127.0.0.1:${PHI_JUPYTER_PORT}/lab`)
  assert.equal(connection?.token, 'probe-token')
  assert.equal(probeCalls, 2)
})

test('JupyterServerRegistry starts a bounded probe round when a valid banner arrives after probe exhaustion', async () => {
  let process!: FakeJupyterProcess
  const pendingProbes: Array<(ready: boolean) => void> = []
  let probeCalls = 0
  const project = projectDir()
  const registry = new JupyterServerRegistry({
    readyProbeAttempts: 1,
    readyProbeIntervalMs: 0,
    readyProbe: () =>
      new Promise((resolve) => {
        probeCalls += 1
        pendingProbes.push(resolve)
      }),
    createProcess: () => (process = new FakeJupyterProcess(5685))
  })

  registry.start(project)
  await waitFor(() => pendingProbes.length === 1)
  const exhaustedProbe = pendingProbes.shift()
  assert.ok(exhaustedProbe)
  exhaustedProbe(false)
  await tick()
  assert.equal(pendingProbes.length, 0)
  assert.equal(probeCalls, 1)
  assert.equal(registry.status(project).state, 'starting')
  assert.equal(registry.connection(project), null)

  process.stderr.write(`http://127.0.0.1:${PHI_JUPYTER_PORT}/lab?token=late-banner-token\n`)
  await waitFor(() => pendingProbes.length === 1)
  assert.equal(probeCalls, 2)

  const lateProbe = pendingProbes.shift()
  assert.ok(lateProbe)
  lateProbe(true)
  await waitFor(() => registry.status(project).state === 'ready')
  const connection = registry.connection(project)
  assert.equal(connection?.url, `http://127.0.0.1:${PHI_JUPYTER_PORT}/lab`)
  assert.equal(connection?.token, 'late-banner-token')
})

test('JupyterServerRegistry does not lose a repeated banner arriving while the final probe is pending', async () => {
  let process!: FakeJupyterProcess
  const pendingProbes: Array<(ready: boolean) => void> = []
  let probeCalls = 0
  const project = projectDir()
  const registry = new JupyterServerRegistry({
    readyProbeAttempts: 1,
    readyProbeIntervalMs: 0,
    readyProbe: () =>
      new Promise((resolve) => {
        probeCalls += 1
        pendingProbes.push(resolve)
      }),
    createProcess: () => (process = new FakeJupyterProcess(5686))
  })

  registry.start(project)
  await waitFor(() => pendingProbes.length === 1)
  process.stderr.write(`http://127.0.0.1:${PHI_JUPYTER_PORT}/lab?token=last-probe-token\n`)
  process.stderr.write(`http://127.0.0.1:${PHI_JUPYTER_PORT}/lab?token=last-probe-token\n`)
  assert.equal(probeCalls, 1)

  const finalProbe = pendingProbes.shift()
  assert.ok(finalProbe)
  finalProbe(false)
  await waitFor(() => pendingProbes.length === 1)
  assert.equal(probeCalls, 2)

  const followUpProbe = pendingProbes.shift()
  assert.ok(followUpProbe)
  followUpProbe(true)
  await waitFor(() => registry.status(project).state === 'ready')
  assert.equal(registry.connection(project)?.token, 'last-probe-token')
})

test('JupyterServerRegistry ignores a late successful probe after stop', async () => {
  let process!: FakeJupyterProcess
  let resolveProbe!: (ready: boolean) => void
  let probeCalls = 0
  const probeGate = new Promise<boolean>((resolve) => {
    resolveProbe = resolve
  })
  const project = projectDir()
  const registry = new JupyterServerRegistry({
    readyProbeAttempts: 3,
    readyProbeIntervalMs: 0,
    readyProbe: async () => {
      probeCalls += 1
      return probeGate
    },
    createProcess: () => (process = new FakeJupyterProcess(5682))
  })

  registry.start(project)
  process.stderr.write(`http://127.0.0.1:${PHI_JUPYTER_PORT}/lab?token=late-token\n`)
  await waitFor(() => probeCalls === 1)
  registry.stop(project)
  assert.equal(registry.status(project).state, 'stopped')

  resolveProbe(true)
  await tick()
  assert.equal(registry.status(project).state, 'stopped')
  assert.equal(registry.status(project).hasEndpoint, false)
  assert.equal(registry.connection(project), null)
})

test('JupyterServerRegistry does not revive an abnormally exited process from a late ready probe', async () => {
  let process!: FakeJupyterProcess
  let resolveReady!: (ready: boolean) => void
  let resolveIdentity!: (isJupyter: boolean) => void
  let readyCalls = 0
  const readyGate = new Promise<boolean>((resolve) => {
    resolveReady = resolve
  })
  const identityGate = new Promise<boolean>((resolve) => {
    resolveIdentity = resolve
  })
  const project = projectDir()
  const registry = new JupyterServerRegistry({
    readyProbeAttempts: 3,
    readyProbeIntervalMs: 0,
    readyProbe: async () => {
      readyCalls += 1
      return readyGate
    },
    identityProbe: async () => identityGate,
    createProcess: () => (process = new FakeJupyterProcess(5683))
  })

  registry.start(project)
  process.stderr.write(`http://127.0.0.1:${PHI_JUPYTER_PORT}/lab?token=late-token\n`)
  await waitFor(() => readyCalls === 1)
  process.emit('exit', 1, null)
  resolveReady(true)
  await tick()

  assert.notEqual(registry.status(project).state, 'ready')
  assert.equal(registry.connection(project), null)

  resolveIdentity(false)
  await waitFor(() => registry.status(project).state === 'error')
  assert.equal(registry.connection(project), null)
})

test('JupyterServerRegistry waits for a late real loopback HTTP health check after a banner', async (t) => {
  const port = await freeLoopbackPort()
  let process!: FakeJupyterProcess
  const project = projectDir()
  const registry = new JupyterServerRegistry({
    port,
    readyProbeAttempts: 1_000,
    readyProbeIntervalMs: 5,
    createProcess: () => (process = new FakeJupyterProcess(5684))
  })
  const httpServer = createHttpServer((request, response) => {
    if (request.url === '/api/status') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ started: new Date().toISOString() }))
      return
    }
    response.writeHead(404)
    response.end()
  })

  try {
    registry.start(project)
    process.stderr.write(`http://127.0.0.1:${port}/lab?token=real-token\n`)
    assert.equal(registry.status(project).state, 'starting')
    assert.equal(registry.connection(project), null)

    const listenError = await new Promise<Error | null>((resolve) => {
      httpServer.once('error', resolve)
      httpServer.listen(port, '127.0.0.1', () => resolve(null))
    })
    if (listenError) {
      const code = (listenError as NodeJS.ErrnoException).code
      if (code === 'EACCES' || code === 'EPERM') {
        t.skip(`loopback listen not permitted: ${listenError.message}`)
        return
      }
      throw listenError
    }

    await waitFor(() => registry.status(project).state === 'ready')
    const connection = registry.connection(project)
    assert.equal(connection?.url, `http://127.0.0.1:${port}/lab`)
    assert.equal(connection?.token, 'real-token')
  } finally {
    if (httpServer.listening) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    }
    registry.disposeAll()
  }
})

test('JupyterServerRegistry stops a running project server', () => {
  let process!: FakeJupyterProcess
  const project = projectDir()
  const registry = new JupyterServerRegistry({
    readyProbeAttempts: 0,
    now: () => new Date('2026-09-09T00:02:00.000Z'),
    createProcess: () => {
      process = new FakeJupyterProcess(42)
      return process
    }
  })

  registry.start(project)
  const status = registry.stop(project)

  assert.equal(process.killed, true)
  assert.equal(status.state, 'stopped')
  assert.equal(status.exitedAt, '2026-09-09T00:02:00.000Z')
  assert.equal(status.message, 'Jupyter Server stopped')
  assert.equal(status.messageCode, 'stopped')
  assert.deepEqual(registry.activeStatuses(), [])
})

test('JupyterServerRegistry lists active servers without starting or stopping them', () => {
  const project = projectDir()
  const registry = new JupyterServerRegistry({
    readyProbeAttempts: 0,
    createProcess: () => new FakeJupyterProcess(43)
  })

  assert.deepEqual(registry.activeStatuses(), [])
  registry.start(project)
  assert.deepEqual(
    registry.activeStatuses().map((server) => server.projectCwd),
    [registry.status(project).projectCwd]
  )
  assert.equal(registry.activeStatuses()[0]?.state, 'starting')
})

test('JupyterServerRegistry adopts an already-running Jupyter Server instead of failing when the port is taken', async () => {
  let process!: FakeJupyterProcess
  const project = projectDir()
  const identityProbeUrls: string[] = []
  const registry = new JupyterServerRegistry({
    readyProbeAttempts: 0,
    identityProbe: async (url) => {
      identityProbeUrls.push(url)
      return true
    },
    createProcess: () => {
      process = new FakeJupyterProcess(99)
      return process
    }
  })

  registry.start(project)
  // Simulate the spawn dying immediately because our fixed port is already
  // held by a Jupyter Server left running from a previous Phi session
  // (spawned processes are unref()'d and can outlive an app restart/crash).
  process.emit('exit', 1, null)
  await tick()
  const status = registry.status(project)

  assert.equal(status.state, 'ready')
  assert.equal(status.hasEndpoint, true)
  assert.equal(status.messageCode, 'ready')
  assert.deepEqual(identityProbeUrls, [`http://127.0.0.1:${PHI_JUPYTER_PORT}/`])
})

test('JupyterServerRegistry still reports an error when the taken port is not a Jupyter Server', async () => {
  let process!: FakeJupyterProcess
  const project = projectDir()
  const registry = new JupyterServerRegistry({
    readyProbeAttempts: 0,
    now: () => new Date('2026-09-09T00:04:00.000Z'),
    identityProbe: async () => false,
    createProcess: () => {
      process = new FakeJupyterProcess(100)
      return process
    }
  })

  registry.start(project)
  process.emit('exit', 1, null)
  await tick()
  const status = registry.status(project)

  assert.equal(status.state, 'error')
  assert.equal(status.hasEndpoint, false)
  assert.equal(status.exitedAt, '2026-09-09T00:04:00.000Z')
  assert.equal(status.message, 'Jupyter Server exited abnormally (1)')
  assert.equal(status.messageCode, 'abnormal_exit')
  assert.deepEqual(status.messageParams, { exitCode: 1 })
})

test('JupyterServerRegistry identifies a non-Jupyter port conflict with stable parameters', async () => {
  let process!: FakeJupyterProcess
  const project = projectDir()
  const registry = new JupyterServerRegistry({
    readyProbeAttempts: 0,
    identityProbe: async () => false,
    createProcess: () => {
      process = new FakeJupyterProcess(101)
      return process
    }
  })

  registry.start(project)
  process.stderr.write(`Port ${PHI_JUPYTER_PORT} already in use\n`)
  process.emit('exit', 1, null)
  await tick()
  const status = registry.status(project)

  assert.equal(status.messageCode, 'port_in_use')
  assert.deepEqual(status.messageParams, { port: PHI_JUPYTER_PORT })
  assert.equal(
    status.message,
    `Port ${PHI_JUPYTER_PORT} is occupied by another process that is not a usable Jupyter Server`
  )
})

test('JupyterServerRegistry marks a clean process exit with a stable code', () => {
  let process!: FakeJupyterProcess
  const project = projectDir()
  const registry = new JupyterServerRegistry({
    readyProbeAttempts: 0,
    createProcess: () => {
      process = new FakeJupyterProcess(102)
      return process
    }
  })

  registry.start(project)
  process.emit('exit', 0, null)
  const status = registry.status(project)

  assert.equal(status.state, 'exited')
  assert.equal(status.message, 'Jupyter Server exited')
  assert.equal(status.messageCode, 'exited')
})

test('JupyterServerRegistry records process errors as public diagnostics', () => {
  let process!: FakeJupyterProcess
  const project = projectDir()
  const registry = new JupyterServerRegistry({
    readyProbeAttempts: 0,
    now: () => new Date('2026-09-09T00:03:00.000Z'),
    createProcess: () => {
      process = new FakeJupyterProcess(43)
      return process
    }
  })

  registry.start(project)
  process.emitError(new Error('ENOENT jupyter'))
  const status = registry.status(project)

  assert.equal(status.state, 'error')
  assert.equal(status.message, 'ENOENT jupyter')
  assert.equal(status.messageCode, undefined)
  assert.equal(status.exitedAt, '2026-09-09T00:03:00.000Z')
})
