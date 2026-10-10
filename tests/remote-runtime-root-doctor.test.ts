import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { remoteDoctor } from '../src/main/agent/remote-doctor'
import { saveRemoteHostProfile } from '../src/main/agent/remote-hosts'
import { DEFAULT_REMOTE_RUNTIME_ROOT } from '../src/main/agent/remote-runtime-root'
import { saveHostRuntimeRoot } from '../src/main/agent/remote-runtime-root-store'
import {
  capabilityProfileStorePath,
  readCapabilityProfile,
  updateLatestCapabilityProfileMicromambaForHost
} from '../src/main/agent/workspace-host/capability-profile-store'
import type { RemoteExecResult } from '../src/main/agent/wrappers/remote-ssh-session'
import { createLocalShellSession } from './helpers/localShellSession'

function executeWithInput(command: string, input: string): Promise<RemoteExecResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('close', (code, signal) => resolve({ stdout, stderr, code, signal }))
    child.stdin.end(input)
  })
}

test('remote doctor checks and stores a redacted project runtime-root summary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-runtime-doctor-'))
  const agentDir = join(root, '.phi')
  const runtimeRoot = join(root, 'managed-runtime')
  const host = saveRemoteHostProfile({ label: 'Local shell', hostAlias: 'local-shell' }, agentDir)
  const session = createLocalShellSession()
  session.execWithInput = (command, input) => executeWithInput(command, input)

  try {
    const report = await remoteDoctor(
      host.id,
      root,
      {
        scope: 'workspace',
        refreshCapabilities: true,
        runtimeRootOverride: { source: 'project', configured: runtimeRoot }
      },
      {
        agentDir,
        sftpAvailable: () => true,
        connectImpl: async () => session,
        micromambaProfile: async (_session, configuredRoot) => {
          assert.equal(configuredRoot, runtimeRoot)
          return { status: 'not-installed' }
        },
        now: () => new Date('2026-10-09T05:00:00.000Z')
      }
    )

    assert.equal(report.runtimeRootCheck?.expandedPath, join(realpathSync(root), 'managed-runtime'))
    assert.equal(report.runtimeRootCheck?.exists, false)
    assert.equal(report.capabilityProfile?.runtimeRoot?.source, 'project')
    assert.equal(report.capabilityProfile?.runtimeRoot?.hasHardError, false)
    assert.deepEqual(report.capabilityProfile?.runtimeRoot?.micromamba, {
      status: 'not-installed'
    })
    assert.equal(
      readCapabilityProfile({ hostAlias: host.hostAlias, projectRoot: root }, { agentDir })
        ?.runtimeRoot?.source,
      'project'
    )
    const persisted = readFileSync(capabilityProfileStorePath(agentDir), 'utf8')
    assert.doesNotMatch(
      persisted,
      new RegExp(realpathSync(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    )
    assert.doesNotMatch(persisted, /local-shell/)

    const statuses = [
      { status: 'installed' as const, version: '2.9.0-0' },
      { status: 'outdated' as const, version: '2.8.0' }
    ]
    for (const status of statuses) {
      updateLatestCapabilityProfileMicromambaForHost(host.hostAlias, status, agentDir)
      const followupSession = createLocalShellSession()
      followupSession.execWithInput = (command, input) => executeWithInput(command, input)
      const followup = await remoteDoctor(
        host.id,
        root,
        {
          scope: 'workspace',
          runtimeRootOverride: { source: 'project', configured: runtimeRoot }
        },
        {
          agentDir,
          sftpAvailable: () => true,
          connectImpl: async () => followupSession,
          now: () => new Date('2026-10-09T05:05:00.000Z')
        }
      )
      assert.deepEqual(followup.capabilityProfile?.runtimeRoot?.micromamba, status)
      assert.deepEqual(
        readCapabilityProfile({ hostAlias: host.hostAlias, projectRoot: root }, { agentDir })
          ?.runtimeRoot?.micromamba,
        status
      )
    }
  } finally {
    await session.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('remote doctor uses and archives the host runtime root when the project override is omitted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-runtime-doctor-host-'))
  const agentDir = join(root, '.phi')
  const runtimeRoot = join(root, 'host-runtime')
  const host = saveRemoteHostProfile({ label: 'Local shell', hostAlias: 'local-shell' }, agentDir)
  saveHostRuntimeRoot(host.id, runtimeRoot, agentDir)
  const session = createLocalShellSession()
  session.execWithInput = (command, input) => executeWithInput(command, input)

  try {
    const report = await remoteDoctor(
      host.id,
      root,
      { scope: 'workspace', refreshCapabilities: true },
      {
        agentDir,
        sftpAvailable: () => true,
        connectImpl: async () => session,
        now: () => new Date('2026-10-09T05:00:00.000Z')
      }
    )

    assert.equal(report.runtimeRootCheck?.expandedPath, join(realpathSync(root), 'host-runtime'))
    assert.equal(report.capabilityProfile?.runtimeRoot?.source, 'host')
    assert.equal(
      readCapabilityProfile({ hostAlias: host.hostAlias, projectRoot: root }, { agentDir })
        ?.runtimeRoot?.source,
      'host'
    )
  } finally {
    await session.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('remote doctor uses and archives the default runtime root when overrides are omitted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-runtime-doctor-default-'))
  const agentDir = join(root, '.phi')
  const host = saveRemoteHostProfile({ label: 'Local shell', hostAlias: 'local-shell' }, agentDir)
  const session = createLocalShellSession()
  session.execWithInput = (command, input) => executeWithInput(command, input)

  try {
    const report = await remoteDoctor(
      host.id,
      root,
      { scope: 'workspace', refreshCapabilities: true },
      {
        agentDir,
        sftpAvailable: () => true,
        connectImpl: async () => session,
        now: () => new Date('2026-10-09T05:00:00.000Z')
      }
    )

    assert.equal(report.runtimeRootCheck?.configured, DEFAULT_REMOTE_RUNTIME_ROOT)
    assert.equal(report.capabilityProfile?.runtimeRoot?.source, 'default')
    assert.equal(
      readCapabilityProfile({ hostAlias: host.hostAlias, projectRoot: root }, { agentDir })
        ?.runtimeRoot?.source,
      'default'
    )
  } finally {
    await session.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('remote doctor falls back from a cleared project runtime root to host and default roots', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-runtime-doctor-cleared-'))
  const agentDir = join(root, '.phi')
  const host = saveRemoteHostProfile({ label: 'Local shell', hostAlias: 'local-shell' }, agentDir)
  saveHostRuntimeRoot(host.id, join(root, 'host-runtime'), agentDir)
  const sessions = [createLocalShellSession(), createLocalShellSession(), createLocalShellSession()]
  for (const session of sessions) {
    session.execWithInput = (command, input) => executeWithInput(command, input)
  }
  const dependencies = {
    agentDir,
    sftpAvailable: () => true,
    now: () => new Date('2026-10-09T05:00:00.000Z')
  }

  try {
    const projectReport = await remoteDoctor(
      host.id,
      root,
      {
        scope: 'workspace',
        refreshCapabilities: true,
        runtimeRootOverride: { source: 'project', configured: join(root, 'project-runtime') }
      },
      { ...dependencies, connectImpl: async () => sessions[0] }
    )
    assert.equal(projectReport.capabilityProfile?.runtimeRoot?.source, 'project')

    const hostReport = await remoteDoctor(
      host.id,
      root,
      { scope: 'workspace', refreshCapabilities: true },
      { ...dependencies, connectImpl: async () => sessions[1] }
    )
    assert.equal(hostReport.capabilityProfile?.runtimeRoot?.source, 'host')

    saveHostRuntimeRoot(host.id, null, agentDir)
    const defaultReport = await remoteDoctor(
      host.id,
      root,
      { scope: 'workspace', refreshCapabilities: true },
      { ...dependencies, connectImpl: async () => sessions[2] }
    )
    assert.equal(defaultReport.capabilityProfile?.runtimeRoot?.source, 'default')
    assert.equal(
      readCapabilityProfile({ hostAlias: host.hostAlias, projectRoot: root }, { agentDir })
        ?.runtimeRoot?.source,
      'default'
    )
  } finally {
    await Promise.all(sessions.map((session) => session.close()))
    rmSync(root, { recursive: true, force: true })
  }
})
