import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { RemoteDoctorOptions } from '../src/shared/remoteDoctorTypes'
import { remoteDoctor } from '../src/main/agent/remote-doctor'
import { saveRemoteHostProfile } from '../src/main/agent/remote-hosts'
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
            execTimeoutMs: 5_000
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
            execTimeoutMs: 5_000
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
