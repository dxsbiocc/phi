import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { describe, it } from 'node:test'

import {
  HOST_CAPABILITY_PROBE_SCRIPT,
  parseHostCapabilityProbe,
  probeHostCapabilities
} from '../src/main/agent/workspace-host/probe'
import type { RemoteExecResult } from '../src/main/agent/wrappers/remote-ssh-session'
import { createLocalShellSession } from './helpers/localShellSession'

function execWithInput(command: string, input: string): Promise<RemoteExecResult> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('close', (code, signal) => resolve({ stdout, stderr, code, signal }))
    child.stdin.end(input)
  })
}

describe('workspace host capability probe', () => {
  it('reports glibc 2.17 while conservatively marking a missing Perl unavailable', () => {
    const profile = parseHostCapabilityProbe(`
login banner
__PHI_CAPABILITY_PROBE_V1_BEGIN__
platform.os=Linux
platform.arch=x86_64
libc.name=glibc
libc.version=2.17
prerequisite.perl.available=0
probe.complete=1
__PHI_CAPABILITY_PROBE_V1_END__
`)

    assert.deepEqual(profile.platform, {
      os: 'linux',
      arch: 'x86_64',
      libc: { name: 'glibc', version: '2.17' }
    })
    assert.deepEqual(profile.prerequisites.perl, {
      state: 'unavailable',
      reason: 'perl is not installed'
    })
    assert.deepEqual(profile.pty, { state: 'unavailable', reason: 'helper 未安装' })
  })

  it('reports a writable but noexec home directory from an actual execution probe', () => {
    const profile = parseHostCapabilityProbe(`
__PHI_CAPABILITY_PROBE_V1_BEGIN__
storage.home_writable=1
storage.home_executable=0
probe.complete=1
__PHI_CAPABILITY_PROBE_V1_END__
`)

    assert.deepEqual(profile.storage.homeWritable, { state: 'available' })
    assert.deepEqual(profile.storage.homeExecutable, {
      state: 'unavailable',
      reason: 'home directory blocks executable files'
    })
  })

  it('reports a read-only home without inferring noexec support', () => {
    const profile = parseHostCapabilityProbe(`
__PHI_CAPABILITY_PROBE_V1_BEGIN__
storage.home_writable=0
storage.home_executable=unknown
probe.complete=1
__PHI_CAPABILITY_PROBE_V1_END__
`)

    assert.deepEqual(profile.storage.homeWritable, {
      state: 'unavailable',
      reason: 'home directory is not writable'
    })
    assert.deepEqual(profile.storage.homeExecutable, {
      state: 'unavailable',
      reason: 'probe result is unavailable'
    })
  })

  it('marks Darwin and unsupported CPU architectures as helper-incompatible', () => {
    const darwin = parseHostCapabilityProbe(`
__PHI_CAPABILITY_PROBE_V1_BEGIN__
platform.os=Darwin
platform.arch=arm64
probe.complete=1
__PHI_CAPABILITY_PROBE_V1_END__
`)
    const unsupportedLinux = parseHostCapabilityProbe(`
__PHI_CAPABILITY_PROBE_V1_BEGIN__
platform.os=Linux
platform.arch=ppc64le
probe.complete=1
__PHI_CAPABILITY_PROBE_V1_END__
`)

    assert.deepEqual(darwin.helperCompatibility, {
      state: 'unavailable',
      reason: 'remote helper supports Linux only'
    })
    assert.deepEqual(unsupportedLinux.helperCompatibility, {
      state: 'unavailable',
      reason: 'unsupported remote helper architecture'
    })
  })

  it('ignores motd noise and reports only sanitized tool versions from the sentinel block', () => {
    const profile = parseHostCapabilityProbe(`
Welcome alice@example.invalid /Users/alice
platform.os=Darwin
__PHI_CAPABILITY_PROBE_V1_BEGIN__
platform.os=Linux
platform.arch=x86_64
tool.git.available=1
tool.git.version=git version 2.39.5 (Apple Git-154)
tool.nextflow.available=0
tool.container.available=1
tool.container.name=podman
tool.container.version=podman version 5.2.2 /Users/alice
probe.complete=1
__PHI_CAPABILITY_PROBE_V1_END__
Last login for alice on secret-host
`)

    assert.equal(profile.platform.os, 'linux')
    assert.deepEqual(profile.toolchain.git, { state: 'available', version: '2.39.5' })
    assert.deepEqual(profile.toolchain.nextflow, {
      state: 'unavailable',
      reason: 'nextflow is not installed'
    })
    assert.deepEqual(profile.toolchain.containerRuntime, {
      state: 'available',
      version: 'podman 5.2.2'
    })
    assert.doesNotMatch(JSON.stringify(profile), /alice|secret-host|\/Users\//)
  })

  it('keeps partial fields but marks truncated probe output degraded', () => {
    const profile = parseHostCapabilityProbe(`
motd before probe
__PHI_CAPABILITY_PROBE_V1_BEGIN__
platform.os=Linux
platform.arch=aarch64
tool.git.available=1
tool.git.version=git version 2.43.0
`)

    assert.equal(profile.platform.arch, 'aarch64')
    assert.deepEqual(profile.toolchain.git, { state: 'available', version: '2.43.0' })
    assert.deepEqual(profile.toolchain.java, {
      state: 'unavailable',
      reason: 'java availability could not be determined'
    })
    assert.deepEqual(profile.probe, {
      state: 'degraded',
      reason: 'probe output was incomplete'
    })
  })

  it('sends the POSIX probe over stdin instead of embedding it in the command line', async () => {
    const calls: Array<{ command: string; input: string }> = []
    const profile = await probeHostCapabilities(
      {
        async execWithInput(command, input) {
          calls.push({ command, input })
          return {
            stdout: `${
              '__PHI_CAPABILITY_PROBE_V1_BEGIN__\n' +
              'platform.os=Linux\nplatform.arch=x86_64\nprobe.complete=1\n' +
              '__PHI_CAPABILITY_PROBE_V1_END__\n'
            }`,
            stderr: '',
            code: 0,
            signal: null
          }
        }
      },
      { now: () => new Date('2026-10-09T00:00:00.000Z') }
    )

    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.command, 'sh -s')
    assert.equal(calls[0]?.input, HOST_CAPABILITY_PROBE_SCRIPT)
    assert.match(HOST_CAPABILITY_PROBE_SCRIPT, /^#!\/bin\/sh\n/)
    assert.equal(profile.probedAt, '2026-10-09T00:00:00.000Z')
  })

  it('reports musl, available space, and a shared filesystem without exposing its path', () => {
    const profile = parseHostCapabilityProbe(`
__PHI_CAPABILITY_PROBE_V1_BEGIN__
platform.os=Linux
platform.arch=aarch64
libc.name=musl
libc.version=1.2.5
storage.available_kib=1048576
storage.shared=1
probe.complete=1
__PHI_CAPABILITY_PROBE_V1_END__
`)

    assert.deepEqual(profile.platform.libc, { name: 'musl', version: '1.2.5' })
    assert.equal(profile.storage.availableSpaceKiB, 1_048_576)
    assert.deepEqual(profile.storage.sharedFileSystem, { state: 'available' })
  })

  it('treats output without a probe sentinel as wholly unavailable and redacted', () => {
    const profile = parseHostCapabilityProbe(
      'Welcome alice on secret-host; home=/Users/alice; platform.os=Linux'
    )

    assert.equal(profile.platform.os, 'unknown')
    assert.equal(profile.fs.state, 'unavailable')
    assert.equal(profile.exec.state, 'unavailable')
    assert.equal(profile.background.state, 'unavailable')
    assert.equal(profile.probe.state, 'unavailable')
    assert.doesNotMatch(JSON.stringify(profile), /alice|secret-host|\/Users\//)
  })

  it('keeps an installed tool degraded when its protected version check cannot run', () => {
    const profile = parseHostCapabilityProbe(`
__PHI_CAPABILITY_PROBE_V1_BEGIN__
tool.nextflow.available=1
tool.nextflow.version_unavailable=1
probe.complete=1
__PHI_CAPABILITY_PROBE_V1_END__
`)

    assert.deepEqual(profile.toolchain.nextflow, {
      state: 'degraded',
      reason: 'nextflow version check failed'
    })
  })

  it('returns a conservative redacted profile when the overall probe times out', async () => {
    const profile = await probeHostCapabilities(
      {
        execWithInput: () => new Promise(() => undefined)
      },
      { timeoutMs: 5 }
    )

    assert.deepEqual(profile.probe, {
      state: 'unavailable',
      reason: 'capability probe timed out'
    })
    assert.equal(profile.fs.state, 'unavailable')
    assert.equal(profile.exec.state, 'unavailable')
  })

  it('does not report a successful probe when the remote sh exits non-zero', async () => {
    const profile = await probeHostCapabilities({
      async execWithInput() {
        return {
          stdout:
            '__PHI_CAPABILITY_PROBE_V1_BEGIN__\n' +
            'platform.os=Linux\nplatform.arch=x86_64\nprobe.complete=1\n' +
            '__PHI_CAPABILITY_PROBE_V1_END__\n',
          stderr: 'remote detail /Users/alice@secret-host',
          code: 7,
          signal: null
        }
      }
    })

    assert.deepEqual(profile.probe, {
      state: 'unavailable',
      reason: 'capability probe exited unsuccessfully'
    })
    assert.doesNotMatch(JSON.stringify(profile), /alice|secret-host|\/Users\//)
  })

  it('reports every container runtime instead of collapsing to the first command found', () => {
    const profile = parseHostCapabilityProbe(`
__PHI_CAPABILITY_PROBE_V1_BEGIN__
tool.container.docker.available=1
tool.container.docker.version=Docker version 27.1.2
tool.container.singularity.available=1
tool.container.singularity.version=singularity-ce version 4.1.5
tool.container.apptainer.available=0
tool.container.podman.available=0
probe.complete=1
__PHI_CAPABILITY_PROBE_V1_END__
`)

    assert.deepEqual(profile.toolchain.containerRuntimes.docker, {
      state: 'available',
      version: '27.1.2'
    })
    assert.deepEqual(profile.toolchain.containerRuntimes.singularity, {
      state: 'available',
      version: '4.1.5'
    })
    assert.deepEqual(profile.toolchain.containerRuntimes.apptainer, {
      state: 'unavailable',
      reason: 'apptainer is not installed'
    })
  })

  it('runs the probe end to end through a local shell session', async () => {
    const session = createLocalShellSession()
    session.execWithInput = execWithInput

    const profile = await probeHostCapabilities(session, { timeoutMs: 30_000 })

    assert.equal(profile.probe.state, 'available')
    assert.notEqual(profile.platform.os, 'unknown')
    assert.notEqual(profile.platform.arch, 'unknown')
    assert.ok(
      profile.storage.homeWritable.state === 'available' ||
        profile.storage.homeWritable.reason === 'home directory is not writable'
    )
    assert.doesNotMatch(JSON.stringify(profile), new RegExp(process.env.USER ?? '___no_user___'))
  })

  it('redacts unexpected platform values even when they appear inside valid sentinels', () => {
    const profile = parseHostCapabilityProbe(`
__PHI_CAPABILITY_PROBE_V1_BEGIN__
platform.os=secret-host
platform.arch=alice@private
libc.name=/Users/alice
probe.complete=1
__PHI_CAPABILITY_PROBE_V1_END__
`)

    assert.deepEqual(profile.platform, {
      os: 'unknown',
      arch: 'unknown',
      libc: { name: 'unknown' }
    })
    assert.doesNotMatch(JSON.stringify(profile), /alice|secret-host|private|\/Users\//)
  })
})
