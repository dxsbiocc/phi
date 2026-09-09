import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  extractJupyterEndpoint,
  JupyterServerRegistry,
  type ManagedJupyterProcess
} from '../src/main/agent/analysis-jupyter-server'

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

test('extractJupyterEndpoint keeps token internal and returns a sanitized local URL', () => {
  const endpoint = extractJupyterEndpoint("http://127.0.0.1:8888/lab?token=secret-token&foo=bar'")

  assert.equal(endpoint?.url, 'http://127.0.0.1:8888/lab?foo=bar')
  assert.equal(endpoint?.token, 'secret-token')
})

test('JupyterServerRegistry starts only one server for the same project', () => {
  const processes: FakeJupyterProcess[] = []
  const project = projectDir()
  const registry = new JupyterServerRegistry({
    now: () => new Date('2026-09-09T00:00:00.000Z'),
    createProcess: () => {
      const process = new FakeJupyterProcess(1234)
      processes.push(process)
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
})

test('JupyterServerRegistry marks server ready from local Jupyter output without exposing tokens', () => {
  let process!: FakeJupyterProcess
  const project = projectDir()
  const registry = new JupyterServerRegistry({
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
  assert.doesNotMatch(JSON.stringify(status), /top-secret/)
  assert.doesNotMatch(JSON.stringify(status), /token=/)
})

test('JupyterServerRegistry stops a running project server', () => {
  let process!: FakeJupyterProcess
  const project = projectDir()
  const registry = new JupyterServerRegistry({
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

test('JupyterServerRegistry records process errors as public diagnostics', () => {
  let process!: FakeJupyterProcess
  const project = projectDir()
  const registry = new JupyterServerRegistry({
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
