import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
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
  assert.deepEqual(launches, [{ port: PHI_JUPYTER_PORT }])
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
  assert.deepEqual(probedUrls, [`http://127.0.0.1:${PHI_JUPYTER_PORT}/`])
})

test('JupyterServerRegistry marks server ready from local Jupyter output without exposing tokens', () => {
  let process!: FakeJupyterProcess
  const project = projectDir()
  const registry = new JupyterServerRegistry({
    readyProbeAttempts: 0,
    createProcess: () => {
      process = new FakeJupyterProcess(5678)
      return process
    }
  })

  registry.start(project)
  process.stderr.write('    http://localhost:8899/tree?token=top-secret\n')
  const status = registry.status(project)

  assert.equal(status.state, 'ready')
  assert.equal(status.hasEndpoint, true)
  assert.equal(status.pid, 5678)
  assert.equal(status.port, 8899)
  assert.doesNotMatch(JSON.stringify(status), /top-secret/)
  assert.doesNotMatch(JSON.stringify(status), /token=/)
})

test('JupyterServerRegistry marks server ready even when the URL banner is split across stdout chunks', () => {
  let process!: FakeJupyterProcess
  const project = projectDir()
  const registry = new JupyterServerRegistry({
    readyProbeAttempts: 0,
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
  const status = registry.status(project)

  assert.equal(status.state, 'ready')
  assert.equal(status.hasEndpoint, true)
  assert.equal(status.port, 8899)
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
  assert.equal(status.exitedAt, '2026-09-09T00:03:00.000Z')
})
