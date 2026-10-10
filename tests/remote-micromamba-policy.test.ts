import assert from 'node:assert/strict'
import { it } from 'node:test'

import {
  installRemoteMicromambaForHost,
  type RemoteMicromambaSettingsDependencies
} from '../src/main/agent/remote-micromamba-settings'
import type { EnsureRemoteMicromambaOptions } from '../src/main/agent/workspace-host/remote-micromamba'
import type { RemoteMicromambaDownloadCapability } from '../src/shared/remoteRuntimeRootTypes'

const ARTIFACT = {
  version: '2.9.0-0',
  platform: 'linux-x64' as const,
  localPath: '/private/cache/micromamba',
  sha256: 'a'.repeat(64),
  size: 18_292_808
}

interface PolicyState {
  desktopDownloads: number
  ensureInput?: EnsureRemoteMicromambaOptions
  downloadProfile?: RemoteMicromambaDownloadCapability
}

function dependencies(state: PolicyState): RemoteMicromambaSettingsDependencies {
  return {
    getHostProfile: () => ({ id: 'host-1', label: 'Cluster', hostAlias: 'cluster' }),
    connect: async () => ({ close: async () => undefined }) as never,
    probePlatform: async () => ({
      os: 'linux',
      arch: 'x86_64',
      libc: { name: 'glibc' as const }
    }),
    describeArtifact: () => ({
      ...ARTIFACT,
      url: 'https://micro.mamba.pm/api/micromamba/linux-64/2.9.0-0'
    }),
    getArtifact: async () => {
      state.desktopDownloads += 1
      return ARTIFACT
    },
    ensure: async (_session, input) => {
      state.ensureInput = input
      return {
        status: 'installed',
        version: ARTIFACT.version,
        platform: ARTIFACT.platform,
        durationMs: 25,
        warningCodes: [],
        message: 'micromamba 已安装并验证。',
        networkProbe: { status: 'reachable', tool: 'curl' },
        transferMethod: 'remote-direct'
      }
    },
    updateLatestProfile: () => undefined,
    updateLatestDownloadProfile: (_hostAlias, download) => {
      state.downloadProfile = download
    }
  }
}

it('does not eagerly download the desktop artifact before ensure chooses a strategy', async () => {
  const state: PolicyState = { desktopDownloads: 0 }
  const result = await installRemoteMicromambaForHost(
    'host-1',
    { runtimeRoot: '~/.phi/runtime' },
    dependencies(state)
  )

  assert.equal(result.transferMethod, 'remote-direct')
  assert.match(state.ensureInput?.artifact.url ?? '', /^https:\/\//)
  assert.equal(typeof state.ensureInput?.obtainLocalArtifact, 'function')
  assert.equal(state.desktopDownloads, 0)
  assert.deepEqual(state.downloadProfile, { status: 'reachable', tool: 'curl' })
})
