import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { afterEach } from 'node:test'

import {
  capabilityProfileStorePath,
  capabilityProfileCacheKey,
  readCapabilityProfile,
  saveCapabilityProfile,
  updateLatestCapabilityProfileMicromambaForHost
} from '../src/main/agent/workspace-host/capability-profile-store'
import { parseHostCapabilityProbe } from '../src/main/agent/workspace-host/probe'
import { remoteMicromambaCapabilityProfile } from '../src/main/agent/workspace-host/runtime-root-profile'
import type { RemoteRuntimeRootCapabilityProfile } from '../src/shared/remoteRuntimeRootTypes'

const temporaryDirectories: string[] = []

function makeTempDir(): string {
  const path = mkdtempSync(join(tmpdir(), 'phi-micromamba-profile-'))
  temporaryDirectories.push(path)
  return path
}

function profile(): ReturnType<typeof parseHostCapabilityProbe> {
  return parseHostCapabilityProbe(`
__PHI_CAPABILITY_PROBE_V1_BEGIN__
platform.os=Linux
platform.arch=x86_64
probe.complete=1
__PHI_CAPABILITY_PROBE_V1_END__
`)
}

const runtimeRoot: RemoteRuntimeRootCapabilityProfile = {
  source: 'default',
  checkedAt: '2026-10-10T00:00:00.000Z',
  status: 'checked',
  hasHardError: false,
  warningCodes: [],
  checks: {
    pathResolution: 'ok',
    creation: 'ok',
    ownership: 'ok',
    permissions: 'ok',
    filesystem: 'ok',
    space: 'ok',
    executable: 'ok',
    sharedFilesystem: 'ok'
  }
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

test('records a runnable expected micromamba version as installed', () => {
  assert.deepEqual(
    remoteMicromambaCapabilityProfile({
      checked: true,
      installedVersion: '2.9.0',
      expectedVersion: '2.9.0',
      runnable: true
    }),
    { status: 'installed', version: '2.9.0' }
  )
})

test('records a checked runtime without micromamba as not installed', () => {
  assert.deepEqual(
    remoteMicromambaCapabilityProfile({
      checked: true,
      installedVersion: null,
      expectedVersion: '2.9.0',
      runnable: false
    }),
    { status: 'not-installed' }
  )
})

test('records a runtime that has not been inspected as unchecked', () => {
  assert.deepEqual(
    remoteMicromambaCapabilityProfile({
      checked: false,
      installedVersion: null,
      expectedVersion: '2.9.0',
      runnable: false
    }),
    { status: 'unchecked' }
  )
})

test('records an installed micromamba that cannot run as unusable', () => {
  assert.deepEqual(
    remoteMicromambaCapabilityProfile({
      checked: true,
      installedVersion: '2.9.0',
      expectedVersion: '2.9.0',
      runnable: false
    }),
    { status: 'unusable', version: '2.9.0' }
  )
})

test('marks a runnable older micromamba version as outdated', () => {
  assert.deepEqual(
    remoteMicromambaCapabilityProfile({
      checked: true,
      installedVersion: '2.8.0',
      expectedVersion: '2.9.0',
      runnable: true
    }),
    { status: 'outdated', version: '2.8.0' }
  )
})

test('loads a legacy runtime-root profile without micromamba status as unchecked', () => {
  const agentDir = makeTempDir()
  const key = { hostAlias: 'cluster', projectRoot: '/work/project' }
  saveCapabilityProfile(key, { ...profile(), runtimeRoot }, agentDir)
  const path = capabilityProfileStorePath(agentDir)
  const document = JSON.parse(readFileSync(path, 'utf8')) as {
    entries: Record<string, { runtimeRoot: Record<string, unknown> }>
  }
  delete document.entries[capabilityProfileCacheKey(key)].runtimeRoot.micromamba
  writeFileSync(path, `${JSON.stringify(document)}\n`)

  assert.deepEqual(readCapabilityProfile(key, { agentDir })?.runtimeRoot?.micromamba, {
    status: 'unchecked'
  })
})

test('ignores one malformed runtime-root entry without losing healthy profiles', () => {
  const agentDir = makeTempDir()
  const damaged = { hostAlias: 'cluster-a', projectRoot: '/work/damaged' }
  const healthy = { hostAlias: 'cluster-b', projectRoot: '/work/healthy' }
  saveCapabilityProfile(damaged, { ...profile(), runtimeRoot }, agentDir)
  saveCapabilityProfile(healthy, { ...profile(), runtimeRoot }, agentDir)
  const path = capabilityProfileStorePath(agentDir)
  const document = JSON.parse(readFileSync(path, 'utf8')) as {
    entries: Record<string, { runtimeRoot: unknown }>
  }
  document.entries[capabilityProfileCacheKey(damaged)].runtimeRoot = { source: 'default' }
  writeFileSync(path, `${JSON.stringify(document)}\n`)

  assert.equal(readCapabilityProfile(damaged, { agentDir }), undefined)
  assert.equal(readCapabilityProfile(healthy, { agentDir })?.platform.os, 'linux')
})

test('persists only redacted micromamba capability fields', () => {
  const agentDir = makeTempDir()
  const key = { hostAlias: 'private-cluster', projectRoot: '/work/private-project' }
  const taintedRuntimeRoot = {
    ...runtimeRoot,
    installationPath: '/home/private-user/.phi/runtime/bin/micromamba-2.9.0',
    username: 'private-user',
    hostname: 'private-cluster.example',
    micromamba: {
      status: 'installed' as const,
      version: '2.9.0',
      localPath: '/Users/private-user/cache/micromamba'
    }
  }
  saveCapabilityProfile(key, { ...profile(), runtimeRoot: taintedRuntimeRoot }, agentDir)

  assert.deepEqual(readCapabilityProfile(key, { agentDir })?.runtimeRoot?.micromamba, {
    status: 'installed',
    version: '2.9.0'
  })
  const persisted = readFileSync(capabilityProfileStorePath(agentDir), 'utf8')
  assert.doesNotMatch(persisted, /private-user|private-cluster|private-project|\/home\/|\/Users\//)
})

test('updates micromamba status only on the latest existing profile for a host', () => {
  const agentDir = makeTempDir()
  const first = { hostAlias: 'cluster', projectRoot: '/work/first' }
  const latest = { hostAlias: 'cluster', projectRoot: '/work/latest' }
  saveCapabilityProfile(first, { ...profile(), runtimeRoot }, agentDir)
  saveCapabilityProfile(latest, { ...profile(), runtimeRoot }, agentDir)

  const updated = updateLatestCapabilityProfileMicromambaForHost(
    'cluster',
    { status: 'installed', version: '2.9.0' },
    agentDir
  )

  assert.equal(updated, true)
  assert.equal(
    readCapabilityProfile(first, { agentDir })?.runtimeRoot?.micromamba?.status,
    'unchecked'
  )
  assert.deepEqual(readCapabilityProfile(latest, { agentDir })?.runtimeRoot?.micromamba, {
    status: 'installed',
    version: '2.9.0'
  })
})

test('invalidates a cached installed status when the expected micromamba version changes', () => {
  const agentDir = makeTempDir()
  const key = { hostAlias: 'cluster', projectRoot: '/work/project' }
  saveCapabilityProfile(
    key,
    {
      ...profile(),
      runtimeRoot: { ...runtimeRoot, micromamba: { status: 'installed', version: '2.8.0' } }
    },
    agentDir
  )

  assert.equal(
    readCapabilityProfile(key, { agentDir })?.runtimeRoot?.micromamba?.status,
    'installed'
  )
  assert.deepEqual(
    readCapabilityProfile(key, { agentDir, expectedMicromambaVersion: '2.9.0' })?.runtimeRoot
      ?.micromamba,
    { status: 'outdated', version: '2.8.0' }
  )
})
