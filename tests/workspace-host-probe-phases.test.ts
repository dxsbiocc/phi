import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'

import {
  HOST_CAPABILITY_FAST_PROBE_SCRIPT,
  HOST_CAPABILITY_SLOW_PROBE_SCRIPT,
  parseHostCapabilityProbe,
  probeHostCapabilities
} from '../src/main/agent/workspace-host/probe'
import type { RemoteExecResult } from '../src/main/agent/wrappers/remote-ssh-session'

function runShell(command: string): Promise<RemoteExecResult> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('close', (code, signal) => resolve({ stdout, stderr, code, signal }))
  })
}

const FAST_PROFILE_OUTPUT = `
noise before the probe
__PHI_CAPABILITY_PROBE_V2_FAST_BEGIN__
platform.os=Linux
platform.arch=x86_64
libc.name=glibc
libc.version=2.17
storage.home_writable=1
storage.home_executable=1
storage.available_kib=1048576
probe.fast_complete=1
__PHI_CAPABILITY_PROBE_V2_FAST_END__
`

test('keeps completed tools and marks only unfinished slow detections unknown', () => {
  const profile = parseHostCapabilityProbe(`
__PHI_CAPABILITY_PROBE_V2_FAST_BEGIN__
platform.os=Linux
platform.arch=x86_64
storage.home_writable=1
probe.fast_complete=1
__PHI_CAPABILITY_PROBE_V2_FAST_END__
login-shell noise
__PHI_CAPABILITY_PROBE_V2_SLOW_BEGIN__
tool.git.available=1
tool.git.version=2.43.0
`)

  assert.deepEqual(profile.toolchain.git, { state: 'available', version: '2.43.0' })
  assert.deepEqual(profile.toolchain.java, {
    state: 'degraded',
    reason: 'java detection was incomplete'
  })
  assert.deepEqual(profile.probe, {
    state: 'degraded',
    reason: 'slow capability detection was incomplete'
  })
})

test('sends successful split probes as two independent POSIX shell inputs', async () => {
  const calls: Array<{ command: string; input: string }> = []
  const outputs = [
    '__PHI_CAPABILITY_PROBE_V2_FAST_BEGIN__\n' +
      'platform.os=Linux\nplatform.arch=x86_64\nprobe.fast_complete=1\n' +
      '__PHI_CAPABILITY_PROBE_V2_FAST_END__\n',
    '__PHI_CAPABILITY_PROBE_V2_SLOW_BEGIN__\n' +
      'tool.git.available=1\ntool.git.version=2.43.0\nprobe.slow_complete=1\n' +
      '__PHI_CAPABILITY_PROBE_V2_SLOW_END__\n'
  ]
  const profile = await probeHostCapabilities({
    async execWithInput(command, input) {
      calls.push({ command, input })
      return { stdout: outputs[calls.length - 1] ?? '', stderr: '', code: 0, signal: null }
    }
  })

  assert.deepEqual(calls, [
    { command: 'sh -s', input: HOST_CAPABILITY_FAST_PROBE_SCRIPT },
    { command: 'sh -s', input: HOST_CAPABILITY_SLOW_PROBE_SCRIPT }
  ])
  assert.deepEqual(profile.toolchain.git, { state: 'available', version: '2.43.0' })
  assert.deepEqual(profile.probe, { state: 'available' })
})

test('ignores slow-phase rows outside sentinels and reports the phase incomplete', async () => {
  let calls = 0
  const profile = await probeHostCapabilities({
    async execWithInput() {
      calls += 1
      return {
        stdout:
          calls === 1
            ? '__PHI_CAPABILITY_PROBE_V2_FAST_BEGIN__\n' +
              'platform.os=Linux\nplatform.arch=x86_64\nprobe.fast_complete=1\n' +
              '__PHI_CAPABILITY_PROBE_V2_FAST_END__\n'
            : 'login noise\ntool.git.available=0\nsecret-host noise\n',
        stderr: '',
        code: 0,
        signal: null
      }
    }
  })

  assert.deepEqual(profile.toolchain.git, {
    state: 'degraded',
    reason: 'git detection was incomplete'
  })
  assert.deepEqual(profile.probe, {
    state: 'degraded',
    reason: 'slow capability detection was incomplete'
  })
  assert.doesNotMatch(JSON.stringify(profile), /secret-host/)
})

test('does not start slow detection after an incomplete fast probe', async () => {
  let calls = 0
  const profile = await probeHostCapabilities({
    async execWithInput() {
      calls += 1
      return {
        stdout:
          '__PHI_CAPABILITY_PROBE_V2_FAST_BEGIN__\n' +
          'platform.os=Linux\nplatform.arch=x86_64\nstorage.home_writable=1\n',
        stderr: '',
        code: 0,
        signal: null
      }
    }
  })

  assert.equal(calls, 1)
  assert.equal(profile.platform.os, 'linux')
  assert.deepEqual(profile.storage.homeWritable, { state: 'available' })
  assert.deepEqual(profile.probe, {
    state: 'unavailable',
    reason: 'fast capability detection was incomplete'
  })
})

test('keeps explicit unknown and version timeout results degraded instead of missing', () => {
  const profile = parseHostCapabilityProbe(`
__PHI_CAPABILITY_PROBE_V2_FAST_BEGIN__
platform.os=Linux
platform.arch=x86_64
probe.fast_complete=1
__PHI_CAPABILITY_PROBE_V2_FAST_END__
__PHI_CAPABILITY_PROBE_V2_SLOW_BEGIN__
tool.git.available=unknown
tool.container.docker.available=unknown
tool.container.singularity.available=unknown
tool.container.apptainer.available=unknown
tool.container.podman.available=unknown
tool.module.available=unknown
tool.module.version_timeout=1
probe.slow_complete=1
__PHI_CAPABILITY_PROBE_V2_SLOW_END__
`)

  assert.deepEqual(profile.toolchain.git, {
    state: 'degraded',
    reason: 'git availability could not be determined'
  })
  assert.deepEqual(profile.toolchain.module, {
    state: 'degraded',
    reason: 'module version check timed out'
  })
  assert.equal(profile.toolchain.containerRuntime.state, 'degraded')
  assert.doesNotMatch(profile.toolchain.containerRuntime.reason ?? '', /not installed/)
})

test('preserves the fast probe when a fake slow shell exceeds the timeout', async () => {
  let calls = 0
  let slowExecution: Promise<RemoteExecResult> | undefined
  const profile = await probeHostCapabilities(
    {
      execWithInput() {
        calls += 1
        if (calls === 1) {
          return Promise.resolve({
            stdout: FAST_PROFILE_OUTPUT,
            stderr: '',
            code: 0,
            signal: null
          })
        }
        slowExecution = runShell('sleep 0.05')
        return slowExecution
      }
    },
    { timeoutMs: 5 }
  )

  assert.equal(calls, 2)
  assert.deepEqual(profile.platform, {
    os: 'linux',
    arch: 'x86_64',
    libc: { name: 'glibc', version: '2.17' }
  })
  assert.deepEqual(profile.storage.homeWritable, { state: 'available' })
  assert.deepEqual(profile.storage.homeExecutable, { state: 'available' })
  assert.equal(profile.storage.availableSpaceKiB, 1_048_576)
  assert.deepEqual(profile.toolchain.git, {
    state: 'degraded',
    reason: 'git detection timed out'
  })
  assert.deepEqual(profile.probe, {
    state: 'degraded',
    reason: 'slow capability detection timed out'
  })
  await slowExecution
})
