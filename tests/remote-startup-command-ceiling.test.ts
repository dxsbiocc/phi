import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'

import type { RemoteStartupDiagnostic } from '../src/main/agent/engine/rpc/remote-startup-diagnostics'

const DIAGNOSTIC_PREFIX = 'REMOTE_STARTUP_DIAGNOSTIC '

test(
  'prepared unchanged host starts remote RPC with at most three remote commands',
  { timeout: 120_000 },
  async (t) => {
    const child = spawn(
      'node',
      ['--import', './scripts/test-loader.mjs', './tests/helpers/runRemoteStartupMeasurement.ts'],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    const abort = (): void => {
      child.kill()
    }
    t.signal.addEventListener('abort', abort, { once: true })
    if (t.signal.aborted) abort()

    try {
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', resolve)
      })
      assert.equal(exit, 0, stdout + stderr)
      const line = stdout.split('\n').find((candidate) => candidate.startsWith(DIAGNOSTIC_PREFIX))
      assert.ok(line, stdout + stderr)
      const report = JSON.parse(line.slice(DIAGNOSTIC_PREFIX.length)) as RemoteStartupDiagnostic
      assert.equal(report.status, 'ready')

      const ompChannel = report.steps.find((step) => step.step === 'rpc_stdio_open')
      assert.equal(ompChannel?.channels.openStdio, 1)
      const transaction = report.steps.find((step) => step.step === 'rpc_startup_transaction')
      assert.equal(transaction?.remoteCommands, 1)
      assert.equal(transaction?.channels.openStdio, 1)
      assert.equal(
        report.steps.some((step) => step.step === 'project_plugin_guard'),
        false
      )
      // The measurement drives the real openRemoteRuntimeWorkspace and the real SshHost helper
      // bootstrap, so these steps must really have run (not been injected) and stayed cheap.
      for (const [name, commands] of [
        ['platform_probe', 1],
        ['runtime_root', 1]
      ] as const) {
        const step = report.steps.find((candidate) => candidate.step === name)
        assert.ok(step, `${name} did not run: the measurement is not on the real path`)
        assert.equal(step.remoteCommands, commands, `${name} issued extra remote commands`)
      }
      const helperStep = report.steps.find((step) => step.step === 'remote_helper')
      assert.ok(helperStep, 'remote_helper did not run: the measurement is not on the real path')
      assert.equal(
        helperStep.remoteCommands,
        0,
        'remote_helper probed or installed on a prepared host'
      )
      for (const name of ['runtime_binary', 'extension_deployment']) {
        const install = report.steps.find((step) => step.step === name)
        if (install) assert.equal(install.remoteCommands, 0, `${name} ran on a prepared host`)
      }
      const observedRemoteCommands = report.steps
        .filter((step) => step.step !== 'rpc_stdio_open')
        .reduce((total, step) => total + step.remoteCommands, 0)

      assert.ok(
        observedRemoteCommands <= 3,
        `expected at most 3 remote commands excluding the OMP stdio channel and reverse tunnel, observed ${observedRemoteCommands}`
      )
    } finally {
      t.signal.removeEventListener('abort', abort)
      child.kill()
    }
  }
)
