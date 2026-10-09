import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { RemoteDoctorOptions } from '../src/shared/remoteDoctorTypes'
import { remoteDoctor } from '../src/main/agent/remote-doctor'
import { saveRemoteHostProfile } from '../src/main/agent/remote-hosts'
import { saveCapabilityProfile } from '../src/main/agent/workspace-host/capability-profile-store'
import { parseHostCapabilityProbe } from '../src/main/agent/workspace-host/probe'
import {
  RemoteSshConnectionError,
  sshConnectionDiagnosis,
  type SshConnectionIssueCode
} from '../src/main/agent/wrappers/remote-ssh-diagnostics'
import type {
  RemoteExecResult,
  RemoteSshSession
} from '../src/main/agent/wrappers/remote-ssh-session'

const OK: RemoteExecResult = { code: 0, stdout: '', stderr: '', signal: null }
const MISSING: RemoteExecResult = { ...OK, code: 1 }
const SFTP_READY = { sftpAvailable: () => true }

async function fixture<T>(
  run: (agentDir: string, hostProfileId: string) => Promise<T>
): Promise<T> {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-remote-doctor-'))
  try {
    const host = saveRemoteHostProfile({ label: 'Lab', hostAlias: 'lab-hpc' }, agentDir)
    return await run(agentDir, host.id)
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
}

function fakeSession(execute: (command: string) => Promise<RemoteExecResult> = async () => OK): {
  session: RemoteSshSession
  commands: string[]
  closed: () => boolean
} {
  const commands: string[] = []
  let didClose = false
  const forbidden = async (): Promise<never> => {
    throw new Error('remoteDoctor must not mutate or upload files')
  }
  return {
    session: {
      exec: async (command) => {
        commands.push(command)
        return execute(command)
      },
      readTextFile: forbidden,
      writeTextFile: forbidden,
      mkdirp: forbidden,
      exists: forbidden,
      uploadFile: forbidden,
      close: async () => {
        didClose = true
      }
    },
    commands,
    closed: () => didClose
  }
}

function status(report: Awaited<ReturnType<typeof remoteDoctor>>, id: string): string | undefined {
  return report.checks.find((check) => check.id === id)?.status
}

function capabilityProbeOutput(rows: Record<string, string> = {}): string {
  const values = {
    'platform.os': 'Linux',
    'platform.arch': 'x86_64',
    'libc.name': 'glibc',
    'libc.version': '2.17',
    'storage.home_writable': '1',
    'storage.home_executable': '1',
    'storage.available_kib': '1048576',
    'storage.shared': 'unknown',
    'probe.complete': '1',
    ...rows
  }
  return [
    'private motd for scientist@lab-hpc',
    '__PHI_CAPABILITY_PROBE_V1_BEGIN__',
    ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
    '__PHI_CAPABILITY_PROBE_V1_END__',
    '/home/scientist/private'
  ].join('\n')
}

test('remote doctor checks a saved host and candidate directory before any project exists', async () => {
  await fixture(async (agentDir, hostProfileId) => {
    const fake = fakeSession()
    const report = await remoteDoctor(
      hostProfileId,
      '/cluster/lab work',
      {
        scheduler: 'slurm',
        runtime: 'singularity'
      },
      {
        agentDir,
        ...SFTP_READY,
        connectImpl: async (config) => {
          assert.deepEqual(config, {
            host: 'lab-hpc',
            readyTimeoutMs: 15_000,
            execTimeoutMs: 31_000
          })
          return fake.session
        },
        now: () => new Date('2026-09-24T00:00:00.000Z')
      }
    )
    assert.equal(report.hostProfileId, hostProfileId)
    assert.equal(report.checkedAt, '2026-09-24T00:00:00.000Z')
    assert.equal(report.ok, true)
    for (const id of [
      'ssh',
      'sftp',
      'path',
      'path_read',
      'path_write',
      'shell',
      'nextflow',
      'java',
      'slurm_submit',
      'slurm_status',
      'slurm_detail',
      'slurm_cancel',
      'runtime'
    ]) {
      assert.equal(status(report, id), 'ok', id)
    }
    assert.ok(fake.commands.some((command) => command.includes("test -d '/cluster/lab work'")))
    assert.ok(
      fake.commands.every((command) => !/\b(mkdir|touch)\b|nextflow run|sbatch\s+--/.test(command))
    )
    assert.equal(fake.closed(), true)
  })
})

test('connection-only check succeeds without probing SFTP, shell or Wrapper tools', async () => {
  await fixture(async (agentDir, hostProfileId) => {
    const fake = fakeSession()
    const result = await remoteDoctor(
      hostProfileId,
      undefined,
      { scope: 'connection' },
      {
        agentDir,
        sftpAvailable: () => {
          throw new Error('SFTP must not be checked for SSH connectivity')
        },
        connectImpl: async () => fake.session
      }
    )
    assert.equal(result.ok, true)
    assert.deepEqual(
      result.checks.map((check) => check.id),
      ['ssh']
    )
    assert.deepEqual(fake.commands, [])
    assert.equal(fake.closed(), true)
  })
})

test('connection-only check returns the latest cached profile without probing again', async () => {
  await fixture(async (agentDir, hostProfileId) => {
    saveCapabilityProfile(
      { hostAlias: 'lab-hpc', projectRoot: '/cluster/project' },
      parseHostCapabilityProbe(capabilityProbeOutput({ 'tool.git.available': '1' })),
      agentDir
    )
    const fake = fakeSession()
    const result = await remoteDoctor(
      hostProfileId,
      undefined,
      { scope: 'connection' },
      { agentDir, connectImpl: async () => fake.session }
    )
    assert.equal(result.capabilityProfile?.platform.os, 'linux')
    assert.deepEqual(fake.commands, [])
    assert.equal(fake.closed(), true)
  })
})

test('remote doctor tests the same user, port and key used by project operations', async () => {
  await fixture(async (agentDir, hostProfileId) => {
    saveRemoteHostProfile(
      {
        id: hostProfileId,
        label: 'Lab',
        hostAlias: 'lab-hpc',
        user: 'scientist',
        port: 22022,
        identityFile: '/tmp/lab-key'
      },
      agentDir
    )
    await remoteDoctor(
      hostProfileId,
      undefined,
      { scope: 'workspace' },
      {
        agentDir,
        ...SFTP_READY,
        connectImpl: async (config) => {
          assert.deepEqual(config, {
            host: 'lab-hpc',
            user: 'scientist',
            port: 22022,
            identityFile: '/tmp/lab-key',
            readyTimeoutMs: 15_000,
            execTimeoutMs: 31_000
          })
          return fakeSession().session
        }
      }
    )
  })
})

test('workspace creation check stops after SSH, directory and shell checks', async () => {
  await fixture(async (agentDir, hostProfileId) => {
    const fake = fakeSession()
    const result = await remoteDoctor(
      hostProfileId,
      '/cluster/project',
      { scope: 'workspace' },
      {
        agentDir,
        ...SFTP_READY,
        connectImpl: async () => fake.session
      }
    )
    assert.equal(result.ok, true)
    assert.deepEqual(
      result.checks.map((check) => check.id),
      ['ssh', 'sftp', 'path', 'path_read', 'path_write', 'shell']
    )
    assert.equal(
      fake.commands.some((command) => /nextflow|sbatch|docker/.test(command)),
      false
    )
  })
})

test('workspace check probes once through stdin and returns only a sanitized capability profile', async () => {
  await fixture(async (agentDir, hostProfileId) => {
    const fake = fakeSession()
    const probeInputs: string[] = []
    fake.session.execWithInput = async (command, input) => {
      assert.equal(command, 'sh -s')
      if (input.includes('__PHI_RUNTIME_ROOT_CHECK_V1_BEGIN__')) return MISSING
      probeInputs.push(input)
      return {
        ...OK,
        stdout: capabilityProbeOutput({ 'tool.nextflow.available': '0' })
      }
    }
    const report = await remoteDoctor(
      hostProfileId,
      '/cluster/private/project',
      { scope: 'workspace' },
      { agentDir, ...SFTP_READY, connectImpl: async () => fake.session }
    )
    assert.equal(probeInputs.length, 1)
    assert.equal(report.capabilityProfile?.platform.libc?.version, '2.17')
    assert.equal(report.capabilityProfile?.toolchain.nextflow.state, 'unavailable')
    const serialized = JSON.stringify(report.capabilityProfile)
    assert.doesNotMatch(serialized, /scientist|lab-hpc|\/home\/|\/cluster\//)
  })
})

test('full doctor reuses capability tool results instead of probing the same commands twice', async () => {
  await fixture(async (agentDir, hostProfileId) => {
    const fake = fakeSession(async (command) =>
      /nextflow|'java'|sbatch|singularity|apptainer/.test(command) ? MISSING : OK
    )
    fake.session.execWithInput = async () => ({
      ...OK,
      stdout: capabilityProbeOutput({
        'tool.nextflow.available': '0',
        'tool.java.available': '1',
        'tool.java.version': 'openjdk 17.0.12',
        'tool.sbatch.available': '1',
        'tool.sbatch.version': 'slurm 23.11.4',
        'tool.container.singularity.available': '1',
        'tool.container.singularity.version': 'singularity-ce version 4.1.2'
      })
    })
    const report = await remoteDoctor(
      hostProfileId,
      '/cluster/project',
      { scope: 'full', scheduler: 'slurm', runtime: 'singularity' },
      { agentDir, ...SFTP_READY, connectImpl: async () => fake.session }
    )
    assert.equal(status(report, 'nextflow'), 'error')
    assert.equal(status(report, 'java'), 'ok')
    assert.equal(status(report, 'slurm_submit'), 'ok')
    assert.equal(status(report, 'runtime'), 'ok')
    assert.match(
      report.checks.find((check) => check.id === 'nextflow')?.suggestion ?? '',
      /module load.*phi-base/
    )
    assert.equal(
      fake.commands.some((command) => /nextflow|'java'|sbatch|singularity|apptainer/.test(command)),
      false
    )
  })
})

test('capability profiles cache by host alias and project root until manually refreshed', async () => {
  await fixture(async (agentDir, hostProfileId) => {
    let probes = 0
    const connectImpl = async (): Promise<RemoteSshSession> => {
      const fake = fakeSession()
      fake.session.execWithInput = async (_command, input) => {
        if (input.includes('__PHI_RUNTIME_ROOT_CHECK_V1_BEGIN__')) return MISSING
        probes += 1
        return { ...OK, stdout: capabilityProbeOutput() }
      }
      return fake.session
    }
    const check = (root: string, refreshCapabilities = false): Promise<unknown> =>
      remoteDoctor(
        hostProfileId,
        root,
        { scope: 'workspace', refreshCapabilities },
        { agentDir, ...SFTP_READY, connectImpl }
      )
    await check('/cluster/a')
    await check('/cluster/a')
    await check('/cluster/b')
    await check('/cluster/a', true)
    assert.equal(probes, 3)
  })
})

test('remote doctor refuses missing profiles without opening SSH', async () => {
  await fixture(async (agentDir) => {
    const report = await remoteDoctor(
      'missing-id',
      undefined,
      {},
      {
        agentDir,
        connectImpl: async () => {
          throw new Error('must not connect')
        }
      }
    )
    assert.equal(report.ok, false)
    assert.equal(status(report, 'ssh'), 'error')
  })
})

test('remote doctor reports missing local SFTP without attempting an upload', async () => {
  await fixture(async (agentDir, hostProfileId) => {
    const fake = fakeSession()
    const report = await remoteDoctor(
      hostProfileId,
      undefined,
      {},
      {
        agentDir,
        sftpAvailable: () => false,
        connectImpl: async () => fake.session
      }
    )
    assert.equal(status(report, 'ssh'), 'ok')
    assert.equal(status(report, 'sftp'), 'error')
    assert.equal(report.ok, false)
    assert.equal(fake.closed(), true)
  })
})

test('SSH program, host identity and noninteractive authentication failures are sanitized', async () => {
  await fixture(async (agentDir, hostProfileId) => {
    const codes: SshConnectionIssueCode[] = [
      'ssh_missing',
      'host_key_unknown',
      'host_key_changed',
      'authentication_failed'
    ]
    for (const code of codes) {
      const report = await remoteDoctor(
        hostProfileId,
        '/cluster',
        {},
        {
          agentDir,
          connectImpl: async () => {
            throw new RemoteSshConnectionError(sshConnectionDiagnosis(code))
          }
        }
      )
      assert.equal(report.ok, false)
      assert.deepEqual(
        report.checks.map((check) => check.id),
        ['ssh']
      )
      assert.equal(status(report, 'ssh'), 'error')
      assert.equal(JSON.stringify(report).includes('privateKey'), false)
    }
  })
})

test('invalid or inaccessible remote paths fail without creating anything', async () => {
  await fixture(async (agentDir, hostProfileId) => {
    const fake = fakeSession(async (command) =>
      command.startsWith('test -r') || command.startsWith('test -w') ? MISSING : OK
    )
    const deps = { agentDir, ...SFTP_READY, connectImpl: async () => fake.session }
    const relative = await remoteDoctor(hostProfileId, '../local', {}, deps)
    assert.equal(status(relative, 'path'), 'error')
    assert.equal(
      fake.commands.some((command) => command.includes('../local')),
      false
    )
    const absolute = await remoteDoctor(hostProfileId, '/cluster/private', {}, deps)
    assert.equal(status(absolute, 'path_read'), 'error')
    assert.equal(status(absolute, 'path_write'), 'error')
    assert.equal(absolute.ok, false)
  })
})

test('missing Nextflow and Slurm are errors, but compute-node-only runtime is a warning', async () => {
  await fixture(async (agentDir, hostProfileId) => {
    const fake = fakeSession(async (command) =>
      /nextflow|sbatch|squeue|scontrol|scancel|singularity|apptainer/.test(command) ? MISSING : OK
    )
    const report = await remoteDoctor(
      hostProfileId,
      undefined,
      {
        scheduler: 'slurm',
        runtime: 'singularity'
      },
      { agentDir, ...SFTP_READY, connectImpl: async () => fake.session }
    )
    assert.equal(status(report, 'nextflow'), 'error')
    assert.equal(status(report, 'slurm_submit'), 'error')
    assert.equal(status(report, 'runtime'), 'warning')
    assert.equal(report.ok, false)
  })
})

test('a runtime available only on compute nodes does not fail an otherwise usable host', async () => {
  await fixture(async (agentDir, hostProfileId) => {
    const fake = fakeSession(async (command) =>
      /singularity|apptainer/.test(command) ? MISSING : OK
    )
    const report = await remoteDoctor(
      hostProfileId,
      undefined,
      {
        scheduler: 'slurm',
        runtime: 'singularity'
      },
      { agentDir, ...SFTP_READY, connectImpl: async () => fake.session }
    )
    assert.equal(status(report, 'runtime'), 'warning')
    assert.equal(status(report, 'slurm_submit'), 'ok')
    assert.equal(report.ok, true)
  })
})

test('a missing runtime blocks direct host execution', async () => {
  await fixture(async (agentDir, hostProfileId) => {
    const fake = fakeSession(async (command) =>
      /singularity|apptainer/.test(command) ? MISSING : OK
    )
    const report = await remoteDoctor(
      hostProfileId,
      '/cluster',
      { scheduler: 'local', runtime: 'singularity' },
      { agentDir, ...SFTP_READY, connectImpl: async () => fake.session }
    )
    assert.equal(status(report, 'runtime'), 'error')
    assert.equal(report.ok, false)
  })
})

test('sbatch controller can submit when Nextflow and Java load only on compute nodes', async () => {
  await fixture(async (agentDir, hostProfileId) => {
    const fake = fakeSession(async (command) => (/nextflow|'java'/.test(command) ? MISSING : OK))
    const report = await remoteDoctor(
      hostProfileId,
      '/cluster',
      { scheduler: 'slurm', controller: 'sbatch', runtime: 'singularity' },
      {
        agentDir,
        ...SFTP_READY,
        connectImpl: async () => fake.session,
        deferToolChecksToLaunch: true
      }
    )
    assert.equal(status(report, 'nextflow'), 'warning')
    assert.equal(status(report, 'java'), 'warning')
    assert.equal(status(report, 'slurm_submit'), 'ok')
    assert.equal(report.ok, true)
    assert.equal(
      fake.commands.some((command) => command.includes('module load compute-only')),
      false
    )
  })
})

test('submission Doctor defers setup-dependent tools without executing setup commands', async () => {
  await fixture(async (agentDir, hostProfileId) => {
    const fake = fakeSession(async (command) => (command.includes('nextflow') ? MISSING : OK))
    const report = await remoteDoctor(
      hostProfileId,
      '/cluster',
      { scheduler: 'local', runtime: 'conda' },
      {
        agentDir,
        ...SFTP_READY,
        connectImpl: async () => fake.session,
        deferToolChecksToLaunch: true
      }
    )
    assert.equal(status(report, 'nextflow'), 'warning')
    assert.equal(report.ok, true)
    assert.equal(
      fake.commands.some((command) => command.includes('module load')),
      false
    )
  })
})

test('each remote check has a deadline and the connection closes after a stalled check', async () => {
  await fixture(async (agentDir, hostProfileId) => {
    const fake = fakeSession(async (command) =>
      command.includes("'java'") ? new Promise<RemoteExecResult>(() => undefined) : OK
    )
    const report = await remoteDoctor(
      hostProfileId,
      undefined,
      {},
      {
        agentDir,
        ...SFTP_READY,
        connectImpl: async () => fake.session,
        checkTimeoutMs: 15
      }
    )
    assert.equal(status(report, 'java'), 'error')
    assert.match(report.checks.find((check) => check.id === 'java')?.message ?? '', /超时/)
    assert.equal(fake.closed(), true)
  })
})

test('SSH connection setup itself has a deadline', async () => {
  await fixture(async (agentDir, hostProfileId) => {
    const report = await remoteDoctor(
      hostProfileId,
      undefined,
      {},
      {
        agentDir,
        connectTimeoutMs: 10,
        connectImpl: async () => new Promise<RemoteSshSession>(() => undefined)
      }
    )
    assert.equal(status(report, 'ssh'), 'error')
    assert.match(report.checks[0].message, /超时/)
  })
})

test('doctor ignores setup commands and checks the selected Docker or Conda runtime', async () => {
  await fixture(async (agentDir, hostProfileId) => {
    const fake = fakeSession()
    for (const runtime of ['docker', 'conda'] as const) {
      const untrustedOptions = {
        runtime,
        setupCommands: ['touch /tmp/phi-should-not-exist']
      } as unknown as RemoteDoctorOptions
      await remoteDoctor(hostProfileId, undefined, untrustedOptions, {
        agentDir,
        ...SFTP_READY,
        connectImpl: async () => fake.session
      })
      assert.ok(fake.commands.some((command) => command.includes(runtime)))
    }
    assert.equal(
      fake.commands.some((command) => command.includes('phi-should-not-exist')),
      false
    )
  })
})
