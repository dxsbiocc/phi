import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  capabilityProfileStorePath,
  invalidateCapabilityProfile,
  readLatestCapabilityProfileForHost,
  readCapabilityProfile,
  refreshCapabilityProfile,
  saveCapabilityProfile
} from '../src/main/agent/workspace-host/capability-profile-store'
import { parseHostCapabilityProbe } from '../src/main/agent/workspace-host/probe'

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
