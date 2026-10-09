import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { saveCapabilityProfile } from '../src/main/agent/workspace-host/capability-profile-store'
import { parseHostCapabilityProbe } from '../src/main/agent/workspace-host/probe'
import { RemoteWorkspaceHostRegistry } from '../src/main/agent/workspace-host/remote-registry'
import type { SshHostConfig } from '../src/main/agent/workspace-host/ssh-host-context'
import type { WorkspaceHost } from '../src/main/agent/workspace-host/types'

test('remote workspace host registry keeps one host per Phi session until release', async () => {
  let hostsCreated = 0
  const host = {
    fs: {} as WorkspaceHost['fs'],
    exec: {} as WorkspaceHost['exec'],
    capabilities() {
      throw new Error('not used')
    }
  } satisfies WorkspaceHost
  const registry = new RemoteWorkspaceHostRegistry({
    resolveBinding: (request) => ({
      sessionId: request.sessionId,
      projectId: request.projectId,
      hostAlias: 'cluster-a',
      remoteRoot: '/remote/project',
      canonicalRoot: '/canonical/project',
      cacheKey: 'host-a:/canonical/project',
      config: {
        remoteRoot: '/remote/project',
        canonicalRoot: '/canonical/project',
        connect: async () => {
          throw new Error('not used')
        }
      }
    }),
    createHost: () => {
      hostsCreated += 1
      return host
    }
  })

  await registry.connect({ sessionId: 'session-a', projectId: 'project-a' })
  await registry.connect({ sessionId: 'session-a', projectId: 'project-a' })
  assert.equal(hostsCreated, 1)

  registry.releaseSession('session-a')
  await registry.connect({ sessionId: 'session-a', projectId: 'project-a' })
  assert.equal(hostsCreated, 2)
})

test('remote workspace host registry releases a host after its connection fails', async () => {
  let hostsCreated = 0
  const registry = new RemoteWorkspaceHostRegistry({
    resolveBinding: (request) => ({
      sessionId: request.sessionId,
      projectId: request.projectId,
      hostAlias: 'cluster-a',
      remoteRoot: '/remote/project',
      canonicalRoot: '/canonical/project',
      cacheKey: 'host-a:/canonical/project',
      config: {
        remoteRoot: '/remote/project',
        canonicalRoot: '/canonical/project',
        connect: async () => {
          throw new Error('not used')
        }
      }
    }),
    createHost: () => {
      hostsCreated += 1
      return {
        fs: {} as WorkspaceHost['fs'],
        exec: {
          async run() {
            throw new Error('SSH connection lost')
          },
          async spawnBackground() {
            throw new Error('not used')
          }
        },
        capabilities() {
          throw new Error('not used')
        }
      }
    }
  })

  const first = await registry.connect({ sessionId: 'session-a', projectId: 'project-a' })
  await assert.rejects(first.exec('true'), /connection lost/)
  await registry.connect({ sessionId: 'session-a', projectId: 'project-a' })

  assert.equal(hostsCreated, 2)
})

test('remote workspace host registry closes cached helper transports on release', async () => {
  let closes = 0
  const host = {
    fs: {} as WorkspaceHost['fs'],
    exec: {} as WorkspaceHost['exec'],
    capabilities() {
      throw new Error('not used')
    },
    async close() {
      closes += 1
    }
  } satisfies WorkspaceHost
  const registry = new RemoteWorkspaceHostRegistry({
    resolveBinding: (request) => ({
      sessionId: request.sessionId,
      projectId: request.projectId,
      hostAlias: 'cluster-a',
      remoteRoot: '/remote/project',
      canonicalRoot: '/canonical/project',
      cacheKey: 'host-a:/canonical/project',
      config: {
        remoteRoot: '/remote/project',
        canonicalRoot: '/canonical/project',
        connect: async () => {
          throw new Error('not used')
        }
      }
    }),
    createHost: () => host
  })

  await registry.connect({ sessionId: 'session-a', projectId: 'project-a' })
  await registry.releaseAll()

  assert.equal(closes, 1)
})

test('remote workspace registry carries platform data across helper version invalidation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-helper-registry-'))
  const agentDir = join(root, 'agent')
  const resourceRoot = join(root, 'resources')
  const profileKey = { hostAlias: 'cluster-a', projectRoot: '/remote/project' }
  let captured: SshHostConfig | undefined
  try {
    mkdirSync(resourceRoot)
    writeFileSync(
      join(resourceRoot, 'manifest.json'),
      `${JSON.stringify({ version: '0.2.0', platforms: {} })}\n`
    )
    const detected = parseHostCapabilityProbe(`
__PHI_CAPABILITY_PROBE_V1_BEGIN__
platform.os=Darwin
platform.arch=arm64
probe.complete=1
__PHI_CAPABILITY_PROBE_V1_END__
`)
    saveCapabilityProfile(profileKey, { ...detected, helperVersion: '0.1.0' }, agentDir)
    const registry = new RemoteWorkspaceHostRegistry({
      agentDir,
      helperResourceRoot: resourceRoot,
      resolveBinding: (request) => ({
        sessionId: request.sessionId,
        projectId: request.projectId,
        hostAlias: profileKey.hostAlias,
        remoteRoot: profileKey.projectRoot,
        canonicalRoot: profileKey.projectRoot,
        cacheKey: 'cluster-a:/remote/project',
        config: {
          remoteRoot: profileKey.projectRoot,
          canonicalRoot: profileKey.projectRoot,
          connect: async () => {
            throw new Error('not used')
          }
        }
      }),
      createHost: (config) => {
        captured = config
        return {
          fs: {} as WorkspaceHost['fs'],
          exec: {} as WorkspaceHost['exec'],
          capabilities: () => detected
        }
      }
    })

    await registry.connect({ sessionId: 'session-a', projectId: 'project-a' })

    assert.equal(captured?.helper?.artifact.version, '0.2.0')
    assert.equal(captured?.helper?.profile.helperVersion, undefined)
    assert.equal(captured?.helper?.profile.platform.os, 'darwin')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('remote workspace registry keeps a current degraded helper on pure SSH', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-helper-registry-degraded-'))
  const agentDir = join(root, 'agent')
  const resourceRoot = join(root, 'resources')
  const profileKey = { hostAlias: 'cluster-a', projectRoot: '/remote/project' }
  let captured: SshHostConfig | undefined
  try {
    mkdirSync(resourceRoot)
    writeFileSync(
      join(resourceRoot, 'manifest.json'),
      `${JSON.stringify({ version: '0.2.0', platforms: {} })}\n`
    )
    const detected = parseHostCapabilityProbe(`
__PHI_CAPABILITY_PROBE_V1_BEGIN__
platform.os=Darwin
platform.arch=arm64
probe.complete=1
__PHI_CAPABILITY_PROBE_V1_END__
`)
    saveCapabilityProfile(
      profileKey,
      {
        ...detected,
        helperVersion: '0.2.0',
        helperStatus: {
          state: 'degraded',
          reason: 'helper unavailable',
          version: '0.2.0',
          affectedCapabilities: ['fs', 'exec', 'background']
        }
      },
      agentDir
    )
    const registry = new RemoteWorkspaceHostRegistry({
      agentDir,
      helperResourceRoot: resourceRoot,
      resolveBinding: (request) => ({
        sessionId: request.sessionId,
        projectId: request.projectId,
        hostAlias: profileKey.hostAlias,
        remoteRoot: profileKey.projectRoot,
        canonicalRoot: profileKey.projectRoot,
        cacheKey: 'cluster-a:/remote/project',
        config: {
          remoteRoot: profileKey.projectRoot,
          canonicalRoot: profileKey.projectRoot,
          connect: async () => {
            throw new Error('not used')
          }
        }
      }),
      createHost: (config) => {
        captured = config
        return {
          fs: {} as WorkspaceHost['fs'],
          exec: {} as WorkspaceHost['exec'],
          capabilities: () => detected
        }
      }
    })

    await registry.connect({ sessionId: 'session-a', projectId: 'project-a' })

    assert.equal(captured?.helper, undefined)
    assert.equal(captured?.capabilityProfile?.helperStatus?.state, 'degraded')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
