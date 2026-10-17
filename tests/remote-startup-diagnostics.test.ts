import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  RemoteStartupDiagnostics,
  type RemoteStartupDiagnostic
} from '../src/main/agent/engine/rpc/remote-startup-diagnostics'
import type { RemoteSshSession } from '../src/main/agent/wrappers/remote-ssh-session'

function session(): RemoteSshSession {
  return {
    async exec() {
      return { stdout: '', stderr: '', code: 0, signal: null }
    },
    async execBounded() {
      return {
        stdout: '',
        stderr: '',
        code: 0,
        signal: null,
        stdoutTruncated: false,
        stderrTruncated: false
      }
    },
    async readTextFile() {
      return ''
    },
    writeTextFile: () => Promise.resolve(),
    mkdirp: () => Promise.resolve(),
    async exists() {
      return true
    },
    uploadFile: () => Promise.resolve(),
    async openStdio() {
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      return {
        stdin,
        stdout,
        stderr,
        closed: Promise.resolve({ code: 0, signal: null }),
        close: () => Promise.resolve()
      }
    },
    close: () => Promise.resolve()
  }
}

test('remote startup diagnostics attribute command channels without retaining command data', async () => {
  let now = 0
  let report: RemoteStartupDiagnostic | undefined
  const diagnostics = new RemoteStartupDiagnostics({
    phiSessionId: 'phi-session',
    emit: (value) => {
      report = value
    },
    now: () => now
  })
  const remote = diagnostics.instrumentSession(session())

  await diagnostics.step('runtime_binary', async () => {
    now = 4
    await remote.exec('token=must-not-appear')
    now = 9
    await remote.execBounded!('secret command', { timeoutMs: 100, maxOutputBytes: 10 })
    now = 15
  })
  await diagnostics.step('rpc_stdio_open', async () => {
    now = 18
    await remote.openStdio!('private launch command')
    now = 21
  })
  diagnostics.finish('ready')

  assert.ok(report)
  assert.equal(report.status, 'ready')
  assert.equal(report.totalMs, 21)
  assert.deepEqual(report.steps, [
    {
      step: 'runtime_binary',
      durationMs: 15,
      remoteCommands: 2,
      channels: { exec: 1, execBounded: 1 }
    },
    {
      step: 'rpc_stdio_open',
      durationMs: 6,
      remoteCommands: 1,
      channels: { openStdio: 1 }
    }
  ])
  const serialized = JSON.stringify(report)
  assert.doesNotMatch(serialized, /must-not-appear|secret command|private launch command/)
})

test('remote startup diagnostics are idempotent and diagnostic sink failures cannot alter startup', () => {
  let emits = 0
  const diagnostics = new RemoteStartupDiagnostics({
    phiSessionId: 'phi-session',
    emit: () => {
      emits++
      throw new Error('diagnostic sink failed')
    },
    now: () => 5
  })
  assert.doesNotThrow(() => diagnostics.finish('failed'))
  assert.doesNotThrow(() => diagnostics.finish('ready'))
  assert.equal(emits, 1)
})
