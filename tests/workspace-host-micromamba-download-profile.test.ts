import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  capabilityProfileStorePath,
  readLatestCapabilityProfileForHost,
  saveCapabilityProfile,
  updateLatestCapabilityProfileMicromambaDownloadForHost
} from '../src/main/agent/workspace-host/capability-profile-store'
import { parseHostCapabilityProbe } from '../src/main/agent/workspace-host/probe'
import { runtimeRootProfileWithMicromamba } from '../src/main/agent/workspace-host/remote-micromamba-profile'
import { runtimeRootCapabilityProfile } from '../src/main/agent/workspace-host/runtime-root-profile'
import type { RemoteRuntimeRootCheckResult } from '../src/shared/remoteRuntimeRootTypes'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'phi-micromamba-profile-'))
  temporaryDirectories.push(path)
  return path
}

function runtimeCheck(): RemoteRuntimeRootCheckResult {
  return {
    configured: '/data/private-user/runtime',
    checkedAt: '2026-10-10T00:00:00.000Z',
    status: 'checked',
    expandedPath: '/data/private-user/runtime',
    exists: true,
    nearestExistingAncestor: '/data/private-user/runtime',
    ancestorWritable: true,
    ownedByCurrentUser: true,
    groupOrOtherWritable: false,
    hasSymlink: false,
    fsType: 'ext4',
    availableKiB: 20_000_000,
    diskUsePercent: 20,
    inodeUsePercent: 10,
    executable: true,
    sharedFilesystem: false,
    computeNodeVisibility: 'unknown',
    hardErrors: [],
    warnings: []
  }
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('remote micromamba download capability profile', () => {
  it('persists only the redacted source host, connectivity state, and selected tool', () => {
    const agentDir = temporaryDirectory()
    const hostAlias = 'private-user@cluster.example.edu'
    const profile = parseHostCapabilityProbe(`
__PHI_CAPABILITY_PROBE_V1_BEGIN__
platform.os=Linux
platform.arch=x86_64
probe.complete=1
__PHI_CAPABILITY_PROBE_V1_END__
`)
    saveCapabilityProfile(
      { hostAlias, projectRoot: '/srv/private-user/project' },
      {
        ...profile,
        runtimeRoot: runtimeRootCapabilityProfile('host', runtimeCheck())
      },
      agentDir
    )

    assert.equal(
      updateLatestCapabilityProfileMicromambaDownloadForHost(
        hostAlias,
        { status: 'reachable', tool: 'curl', host: 'gh-proxy.com' },
        agentDir
      ),
      true
    )
    assert.deepEqual(
      readLatestCapabilityProfileForHost(hostAlias, { agentDir })?.runtimeRoot?.micromamba
        ?.download,
      { status: 'reachable', tool: 'curl', host: 'gh-proxy.com' }
    )
    const persisted = readFileSync(capabilityProfileStorePath(agentDir), 'utf8')
    assert.match(persisted, /gh-proxy\.com/)
    assert.doesNotMatch(persisted, /private-user|cluster\.example\.edu|\/srv\/|\/data\//)
  })
})

it('preserves the download capability when connection status is refreshed', async () => {
  const profile = await runtimeRootProfileWithMicromamba({
    session: {} as never,
    configuredRoot: '/runtime',
    source: 'host',
    platform: { os: 'linux', arch: 'x86_64', libc: { name: 'glibc' } },
    check: runtimeCheck(),
    previous: {
      status: 'not-installed',
      download: { status: 'unreachable' }
    },
    resolve: async () => ({ status: 'installed', version: '2.9.0-0' })
  })

  assert.deepEqual(profile.micromamba, {
    status: 'installed',
    version: '2.9.0-0',
    download: { status: 'unreachable' }
  })
})
