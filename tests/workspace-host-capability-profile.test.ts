import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  capabilityProfileStorePath,
  capabilityProfileCacheKey,
  invalidateCapabilityProfile,
  invalidateCapabilityProfilesForHost,
  readLatestCapabilityProfileForHost,
  readCapabilityProfile,
  refreshCapabilityProfile,
  saveCapabilityProfile
} from '../src/main/agent/workspace-host/capability-profile-store'
import { installRemoteHelper } from '../src/main/agent/workspace-host/helper-installer'
import { parseHostCapabilityProbe } from '../src/main/agent/workspace-host/probe'
import { runtimeRootCapabilityProfile } from '../src/main/agent/workspace-host/runtime-root-profile'
import type { RemoteSshSession } from '../src/main/agent/wrappers/remote-ssh-session'
import type { RemoteRuntimeRootCheckResult } from '../src/shared/remoteRuntimeRootTypes'

const temporaryDirectories: string[] = []

function makeTempDir(): string {
  const path = mkdtempSync(join(tmpdir(), 'phi-capability-profile-'))
  temporaryDirectories.push(path)
  return path
}

function profile(os: string, arch: string): ReturnType<typeof parseHostCapabilityProbe> {
  return parseHostCapabilityProbe(`
__PHI_CAPABILITY_PROBE_V1_BEGIN__
platform.os=${os}
platform.arch=${arch}
probe.complete=1
__PHI_CAPABILITY_PROBE_V1_END__
`)
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('workspace host capability profile cache', () => {
  it('keys profiles by host alias and project root without persisting either in cleartext', () => {
    const agentDir = makeTempDir()
    const first = { hostAlias: 'private-cluster', projectRoot: '/srv/secret/project-a' }
    const second = { hostAlias: 'private-cluster', projectRoot: '/srv/secret/project-b' }

    saveCapabilityProfile(first, profile('Linux', 'x86_64'), agentDir)
    saveCapabilityProfile(second, profile('Darwin', 'arm64'), agentDir)

    assert.equal(readCapabilityProfile(first, { agentDir })?.platform.os, 'linux')
    assert.equal(readCapabilityProfile(second, { agentDir })?.platform.os, 'darwin')
    assert.equal(
      readLatestCapabilityProfileForHost(first.hostAlias, { agentDir })?.platform.os,
      'darwin'
    )
    const persisted = readFileSync(capabilityProfileStorePath(agentDir), 'utf8')
    assert.doesNotMatch(persisted, /private-cluster|\/srv\/secret|project-[ab]/)
    assert.equal(statSync(capabilityProfileStorePath(agentDir)).mode & 0o777, 0o600)
  })

  it('persists only a redacted runtime-root summary in the capability profile', () => {
    const agentDir = makeTempDir()
    const key = { hostAlias: 'private-cluster', projectRoot: '/srv/private/project' }
    const runtimeCheck: RemoteRuntimeRootCheckResult = {
      configured: '/data/private-user/phi-runtime',
      checkedAt: '2026-10-09T04:00:00.000Z',
      status: 'checked',
      expandedPath: '/data/private-user/phi-runtime',
      exists: false,
      nearestExistingAncestor: '/data/private-user',
      ancestorWritable: true,
      ownedByCurrentUser: false,
      groupOrOtherWritable: true,
      hasSymlink: false,
      fsType: 'nfs4',
      availableKiB: 20 * 1024 * 1024,
      diskUsePercent: 73,
      inodeUsePercent: 12,
      executable: true,
      sharedFilesystem: true,
      computeNodeVisibility: 'unknown',
      hardErrors: [],
      warnings: [
        {
          code: 'shared-filesystem-info',
          message: '检测到共享文件系统',
          consequence: '计算节点可见性仍未知'
        }
      ]
    }

    saveCapabilityProfile(
      key,
      {
        ...profile('Linux', 'x86_64'),
        runtimeRoot: runtimeRootCapabilityProfile('project', runtimeCheck)
      },
      agentDir
    )

    const saved = readCapabilityProfile(key, { agentDir })
    assert.equal(saved?.runtimeRoot?.source, 'project')
    assert.deepEqual(saved?.runtimeRoot?.micromamba, { status: 'unchecked' })
    assert.deepEqual(saved?.runtimeRoot?.warningCodes, ['shared-filesystem-info'])
    assert.equal(saved?.runtimeRoot?.checks.ownership, 'warning')
    const persisted = readFileSync(capabilityProfileStorePath(agentDir), 'utf8')
    assert.doesNotMatch(persisted, /private-cluster|private-user|\/srv\/private|\/data\//)
  })

  it('invalidates entries when the profile or helper version changes and on request', () => {
    const agentDir = makeTempDir()
    const key = { hostAlias: 'cluster', projectRoot: '/work/project' }
    const cached = { ...profile('Linux', 'x86_64'), helperVersion: 'helper-1' }

    saveCapabilityProfile(key, cached, agentDir)

    assert.ok(readCapabilityProfile(key, { agentDir, expectedHelperVersion: 'helper-1' }))
    assert.equal(
      readCapabilityProfile(key, { agentDir, expectedHelperVersion: 'helper-2' }),
      undefined
    )
    assert.equal(readCapabilityProfile(key, { agentDir, expectedProfileVersion: 2 }), undefined)
    invalidateCapabilityProfile(key, agentDir)
    assert.equal(readCapabilityProfile(key, { agentDir }), undefined)
  })

  it('invalidates every project profile when a host-level runtime override changes', () => {
    const agentDir = makeTempDir()
    const first = { hostAlias: 'cluster-a', projectRoot: '/work/first' }
    const second = { hostAlias: 'cluster-a', projectRoot: '/work/second' }
    const other = { hostAlias: 'cluster-b', projectRoot: '/work/other' }
    saveCapabilityProfile(first, profile('Linux', 'x86_64'), agentDir)
    saveCapabilityProfile(second, profile('Linux', 'x86_64'), agentDir)
    saveCapabilityProfile(other, profile('Linux', 'x86_64'), agentDir)

    invalidateCapabilityProfilesForHost('cluster-a', agentDir)

    assert.equal(readCapabilityProfile(first, { agentDir }), undefined)
    assert.equal(readCapabilityProfile(second, { agentDir }), undefined)
    assert.ok(readCapabilityProfile(other, { agentDir }))
  })

  it('conservatively clears a legacy store whose host index cannot identify every project', () => {
    const agentDir = makeTempDir()
    const first = { hostAlias: 'cluster-a', projectRoot: '/work/first' }
    const second = { hostAlias: 'cluster-a', projectRoot: '/work/second' }
    const other = { hostAlias: 'cluster-b', projectRoot: '/work/other' }
    saveCapabilityProfile(first, profile('Linux', 'x86_64'), agentDir)
    saveCapabilityProfile(second, profile('Linux', 'x86_64'), agentDir)
    saveCapabilityProfile(other, profile('Linux', 'x86_64'), agentDir)
    const path = capabilityProfileStorePath(agentDir)
    const legacy = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    delete legacy.cacheKeysByHost
    delete legacy.hostIndexComplete
    writeFileSync(path, `${JSON.stringify(legacy)}\n`)

    invalidateCapabilityProfilesForHost('cluster-a', agentDir)

    assert.equal(readCapabilityProfile(first, { agentDir }), undefined)
    assert.equal(readCapabilityProfile(second, { agentDir }), undefined)
    assert.equal(readCapabilityProfile(other, { agentDir }), undefined)
  })

  it('ignores an incomplete legacy profile so the next connection probes again', () => {
    const agentDir = makeTempDir()
    const key = { hostAlias: 'cluster', projectRoot: '/work/project' }
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(
      capabilityProfileStorePath(agentDir),
      `${JSON.stringify({
        version: 1,
        entries: { [capabilityProfileCacheKey(key)]: profile('unknown', 'unknown') },
        latestByHost: {}
      })}\n`
    )

    assert.equal(readCapabilityProfile(key, { agentDir }), undefined)
  })

  it('does not persist a profile when fast capability detection failed', () => {
    const agentDir = makeTempDir()
    const key = { hostAlias: 'cluster', projectRoot: '/work/project' }
    const detected = profile('Linux', 'x86_64')

    saveCapabilityProfile(
      key,
      { ...detected, probe: { state: 'unavailable', reason: 'fast detection failed' } },
      agentDir
    )

    assert.equal(readCapabilityProfile(key, { agentDir }), undefined)
  })

  it('degrades an unknown platform accurately without caching it', async () => {
    const agentDir = makeTempDir()
    const key = { hostAlias: 'cluster', projectRoot: '/work/project' }
    const unexpected = async (): Promise<never> => {
      throw new Error('an unknown platform must not touch the remote session')
    }
    const session: RemoteSshSession = {
      exec: unexpected,
      readTextFile: unexpected,
      writeTextFile: unexpected,
      mkdirp: unexpected,
      exists: unexpected,
      uploadFile: unexpected,
      close: async () => undefined
    }
    const result = await installRemoteHelper({
      session,
      profile: profile('unknown', 'unknown'),
      profileKey: key,
      artifact: { version: '0.1.0', localPath: '/unused', sha256: 'a'.repeat(64) },
      agentDir
    })

    assert.match(result.reason, /platform.*unknown/i)
    assert.match(result.reason, /retry.*next connection/i)
    assert.equal(readCapabilityProfile(key, { agentDir }), undefined)
  })

  it('forwards independent fast and slow timeouts when refreshing a profile', async () => {
    const agentDir = makeTempDir()
    let calls = 0
    const refreshed = await refreshCapabilityProfile(
      {
        async execWithInput() {
          calls += 1
          if (calls === 1) {
            return {
              stdout:
                '__PHI_CAPABILITY_PROBE_V2_FAST_BEGIN__\n' +
                'platform.os=Linux\nplatform.arch=x86_64\nprobe.fast_complete=1\n' +
                '__PHI_CAPABILITY_PROBE_V2_FAST_END__\n',
              stderr: '',
              code: 0,
              signal: null
            }
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 20))
          return {
            stdout:
              '__PHI_CAPABILITY_PROBE_V2_SLOW_BEGIN__\n' +
              'probe.slow_complete=1\n' +
              '__PHI_CAPABILITY_PROBE_V2_SLOW_END__\n',
            stderr: '',
            code: 0,
            signal: null
          }
        }
      },
      { hostAlias: 'cluster', projectRoot: '/work/project' },
      { agentDir, timeoutMs: 5, fastTimeoutMs: 50, slowTimeoutMs: 50 }
    )

    assert.equal(calls, 2)
    assert.deepEqual(refreshed.probe, { state: 'available' })
  })

  it('manually re-detects and atomically replaces the selected profile', async () => {
    const agentDir = makeTempDir()
    const key = { hostAlias: 'cluster', projectRoot: '/work/project' }
    saveCapabilityProfile(key, profile('Linux', 'x86_64'), agentDir)

    const refreshed = await refreshCapabilityProfile(
      {
        async execWithInput() {
          return {
            stdout:
              '__PHI_CAPABILITY_PROBE_V1_BEGIN__\n' +
              'platform.os=Darwin\nplatform.arch=arm64\nprobe.complete=1\n' +
              '__PHI_CAPABILITY_PROBE_V1_END__\n',
            stderr: '',
            code: 0,
            signal: null
          }
        }
      },
      key,
      { agentDir }
    )

    assert.equal(refreshed.platform.os, 'darwin')
    assert.equal(readCapabilityProfile(key, { agentDir })?.platform.os, 'darwin')
  })
})
