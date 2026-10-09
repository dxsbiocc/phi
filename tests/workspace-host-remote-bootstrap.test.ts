import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  readCapabilityProfile,
  saveCapabilityProfile
} from '../src/main/agent/workspace-host/capability-profile-store'
import { parseHostCapabilityProbe } from '../src/main/agent/workspace-host/probe'
import type { ProbedHostCapabilityProfile } from '../src/main/agent/workspace-host/probe-parse'
import { RemoteWorkspaceHostRegistry } from '../src/main/agent/workspace-host/remote-registry'
import type { SshHostConfig } from '../src/main/agent/workspace-host/ssh-host-context'
import type { WorkspaceHost } from '../src/main/agent/workspace-host/types'
import { createLocalShellSession } from './helpers/localShellSession'

const PROFILE_KEY = { hostAlias: 'cluster-a', projectRoot: '/remote/project' }

function profileOutput(complete: boolean): string {
  return `
__PHI_CAPABILITY_PROBE_V1_BEGIN__
platform.os=Linux
platform.arch=x86_64
storage.home_writable=1
storage.home_executable=1
probe.complete=${complete ? '1' : '0'}
${complete ? '__PHI_CAPABILITY_PROBE_V1_END__' : ''}
`
}

function profile(complete: boolean): ProbedHostCapabilityProfile {
  return parseHostCapabilityProbe(profileOutput(complete))
}

async function helperResourceRoot(root: string): Promise<string> {
  const resourceRoot = join(root, 'resources')
  await mkdir(resourceRoot)
  await writeFile(
    join(resourceRoot, 'manifest.json'),
    `${JSON.stringify({
      version: '0.1.0',
      platforms: {
        'linux-amd64': { path: '0.1.0/linux-amd64/phi-helper', sha256: 'a'.repeat(64) }
      }
    })}\n`
  )
  return resourceRoot
}

async function registryConfig(
  cached?: ProbedHostCapabilityProfile
): Promise<{ config: SshHostConfig; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'phi-remote-bootstrap-registry-'))
  const agentDir = join(root, 'agent')
  const resourceRoot = await helperResourceRoot(root)
  if (cached) saveCapabilityProfile(PROFILE_KEY, cached, agentDir)
  let config: SshHostConfig | undefined
  const registry = new RemoteWorkspaceHostRegistry({
    agentDir,
    helperResourceRoot: resourceRoot,
    helperDevelopmentRoot: join(root, 'development'),
    resolveBinding: (request) => ({
      sessionId: request.sessionId,
      projectId: request.projectId,
      hostAlias: PROFILE_KEY.hostAlias,
      remoteRoot: PROFILE_KEY.projectRoot,
      canonicalRoot: PROFILE_KEY.projectRoot,
      cacheKey: 'cluster-a:/remote/project',
      config: {
        remoteRoot: PROFILE_KEY.projectRoot,
        canonicalRoot: PROFILE_KEY.projectRoot,
        connect: async () => {
          throw new Error('must remain lazy')
        }
      }
    }),
    createHost: (value) => {
      config = value
      return {
        fs: {} as WorkspaceHost['fs'],
        exec: {} as WorkspaceHost['exec'],
        capabilities: () => value.capabilityProfile ?? profile(true)
      }
    }
  })
  await registry.connect({ sessionId: 'session-a', projectId: 'project-a' })
  assert.ok(config)
  return { config, root }
}

test('an uncached registry entry defers probing to first host use', async () => {
  const { config, root } = await registryConfig()
  try {
    assert.deepEqual(config.helperBootstrap?.profileKey, PROFILE_KEY)
    assert.equal(config.helper, undefined)
    assert.equal(config.capabilityProfile, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a partial cached profile is displayed but reprobed on first host use', async () => {
  const cached = profile(false)
  const { config, root } = await registryConfig(cached)
  try {
    assert.equal(cached.probe.state, 'degraded')
    assert.deepEqual(config.helperBootstrap?.profileKey, PROFILE_KEY)
    assert.equal(config.capabilityProfile?.probe?.state, 'degraded')
    assert.equal(config.helper, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an available cached profile keeps the existing helper path', async () => {
  const { config, root } = await registryConfig(profile(true))
  try {
    assert.equal(config.helper?.profile.probe.state, 'available')
    assert.equal(config.helper?.artifact.version, '0.1.0')
    assert.equal(config.helperBootstrap, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a partial cached profile is completed on the next connection before pure SSH runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phi-remote-bootstrap-complete-'))
  const workspace = join(root, 'workspace')
  const agentDir = join(root, 'agent')
  let probes = 0
  try {
    await mkdir(workspace)
    const canonicalRoot = await realpath(workspace)
    saveCapabilityProfile(PROFILE_KEY, profile(false), agentDir)
    const registry = new RemoteWorkspaceHostRegistry({
      agentDir,
      helperResourceRoot: join(root, 'missing-resources'),
      helperDevelopmentRoot: join(root, 'missing-development'),
      resolveBinding: (request) => ({
        sessionId: request.sessionId,
        projectId: request.projectId,
        hostAlias: PROFILE_KEY.hostAlias,
        remoteRoot: PROFILE_KEY.projectRoot,
        canonicalRoot,
        cacheKey: 'cluster-a:/remote/project',
        config: {
          remoteRoot: workspace,
          canonicalRoot,
          connect: async () => {
            const session = createLocalShellSession(canonicalRoot)
            session.execWithInput = async () => {
              probes += 1
              return { stdout: profileOutput(true), stderr: '', code: 0, signal: null }
            }
            return session
          }
        }
      })
    })
    const session = await registry.connect({ sessionId: 'session-a', projectId: 'project-a' })
    assert.equal(await session.exists(canonicalRoot), true)
    assert.equal(probes, 1)
    assert.equal(readCapabilityProfile(PROFILE_KEY, { agentDir })?.probe.state, 'available')
    await session.close()
    await registry.releaseAll()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
