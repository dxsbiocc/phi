import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  isolatedHomeEnvironment,
  prepareIsolatedHome,
  sweepStaleIsolatedHomes
} from '../scripts/gui-e2e/profile'

function fixture(): { root: string; sourceHome: string; destinationHome: string } {
  const root = mkdtempSync(join(tmpdir(), 'phi-gui-profile-test-'))
  const sourceHome = join(root, 'source')
  const destinationHome = join(root, 'isolated')
  mkdirSync(join(sourceHome, '.phi', 'logs'), { recursive: true })
  mkdirSync(join(sourceHome, '.phi', 'sessions', 'session-1'), { recursive: true })
  mkdirSync(join(sourceHome, '.ssh', 'config.d'), { recursive: true })
  return { root, sourceHome, destinationHome }
}

test('prepareIsolatedHome copies the Phi profile without logs or symlinks', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.sourceHome, '.phi', 'settings.json'), '{"theme":"dark"}\n')
    writeFileSync(join(f.sourceHome, '.phi', 'logs', 'private.jsonl'), '{}\n')
    writeFileSync(join(f.sourceHome, '.phi', 'sessions', 'session-1', 'messages.jsonl'), '{}\n')
    symlinkSync(
      join(f.sourceHome, '.phi', 'settings.json'),
      join(f.sourceHome, '.phi', 'linked-settings.json')
    )

    const prepared = prepareIsolatedHome({
      sourceHome: f.sourceHome,
      destinationHome: f.destinationHome
    })

    assert.equal(
      readFileSync(join(prepared.agentDir, 'settings.json'), 'utf8'),
      '{"theme":"dark"}\n'
    )
    assert.equal(existsSync(join(prepared.agentDir, 'logs')), false)
    assert.equal(
      existsSync(join(prepared.agentDir, 'sessions', 'session-1', 'messages.jsonl')),
      true
    )
    assert.equal(existsSync(join(prepared.agentDir, 'linked-settings.json')), false)
    assert.equal(prepared.skippedSymlinks, 1)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('prepareIsolatedHome never deletes a pre-existing invalid destination', () => {
  const f = fixture()
  try {
    mkdirSync(f.destinationHome, { recursive: true })
    const sentinel = join(f.destinationHome, 'keep.txt')
    writeFileSync(sentinel, 'keep')

    assert.throws(
      () =>
        prepareIsolatedHome({
          sourceHome: f.sourceHome,
          destinationHome: f.destinationHome
        }),
      /must be empty/
    )
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('prepareIsolatedHome flattens SSH includes and copies referenced identities as mode 600', () => {
  const f = fixture()
  try {
    const localKey = join(f.sourceHome, '.ssh', 'id cluster')
    const includedKey = join(f.root, 'included-key')
    const profileKey = join(f.root, 'profile-key')
    writeFileSync(localKey, 'local-private-key')
    writeFileSync(includedKey, 'included-private-key')
    writeFileSync(profileKey, 'profile-private-key')
    writeFileSync(
      join(f.sourceHome, '.ssh', 'config'),
      ['Include config.d/*.conf', 'Host gpu', '  IdentityFile "~/.ssh/id cluster"', ''].join('\n')
    )
    writeFileSync(
      join(f.sourceHome, '.ssh', 'config.d', 'cluster.conf'),
      `Host yzhang-node3\n  IdentityFile ${includedKey}\n`
    )
    writeFileSync(
      join(f.sourceHome, '.phi', 'ssh-hosts.json'),
      `${JSON.stringify([{ id: 'profile-1', label: 'Profile', hostAlias: 'profile', identityFile: profileKey }])}\n`
    )

    const prepared = prepareIsolatedHome({
      sourceHome: f.sourceHome,
      destinationHome: f.destinationHome
    })
    const copiedConfig = readFileSync(join(prepared.homeDir, '.ssh', 'config'), 'utf8')
    const profiles = JSON.parse(
      readFileSync(join(prepared.agentDir, 'ssh-hosts.json'), 'utf8')
    ) as Array<{ identityFile: string }>

    assert.doesNotMatch(copiedConfig, /^\s*Include\b/im)
    assert.doesNotMatch(copiedConfig, new RegExp(f.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(copiedConfig, /Host yzhang-node3/)
    assert.match(copiedConfig, /IdentityFile "~\/\.ssh\/id cluster"/)
    assert.match(copiedConfig, /IdentityFile ~\/\.ssh\/identities\/[a-f0-9]{12}-included-key/)
    assert.equal(profiles[0].identityFile.match(/^~\/\.ssh\/identities\//) !== null, true)
    assert.equal(
      readFileSync(join(prepared.homeDir, '.ssh', 'id cluster'), 'utf8'),
      'local-private-key'
    )

    const imported = readFileSync(join(prepared.homeDir, profiles[0].identityFile.slice(2)), 'utf8')
    assert.equal(imported, 'profile-private-key')
    assert.equal(
      statSync(join(prepared.homeDir, profiles[0].identityFile.slice(2))).mode & 0o777,
      0o600
    )
    assert.equal(statSync(join(prepared.homeDir, '.ssh', 'config')).mode & 0o777, 0o600)
    assert.equal(prepared.copiedIdentityFiles, 3)
    assert.equal(prepared.missingIdentityFiles, 0)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('isolatedHomeEnvironment redirects both HOME and the Phi agent directory', () => {
  const env = isolatedHomeEnvironment('/tmp/isolated-home', { PATH: '/usr/bin', SECRET: 'kept' })
  assert.equal(env.HOME, '/tmp/isolated-home')
  assert.equal(env.USERPROFILE, '/tmp/isolated-home')
  assert.equal(env.PI_CODING_AGENT_DIR, '/tmp/isolated-home/.phi')
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.SECRET, 'kept')
})

test('sweepStaleIsolatedHomes removes only marked harness homes older than one hour', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-gui-profile-sweep-test-'))
  const staleHome = join(root, 'phi-gui-e2e-stale')
  const freshHome = join(root, 'phi-gui-e2e-fresh')
  const boundaryHome = join(root, 'phi-gui-e2e-one-hour-old')
  const unmarkedHome = join(root, 'phi-gui-e2e-unmarked')
  const unrelatedHome = join(root, 'other-stale-home')
  const symlinkTarget = join(root, 'outside-target')
  const symlinkHome = join(root, 'phi-gui-e2e-symlink')
  const now = new Date('2026-11-03T12:00:00.000Z')
  const stale = new Date(now.getTime() - 60 * 60 * 1_000 - 1)
  try {
    for (const home of [staleHome, freshHome, boundaryHome, unrelatedHome, symlinkTarget]) {
      mkdirSync(join(home, '.phi'), { recursive: true })
    }
    mkdirSync(unmarkedHome, { recursive: true })
    symlinkSync(symlinkTarget, symlinkHome)
    for (const home of [staleHome, unmarkedHome, unrelatedHome]) {
      utimesSync(home, stale, stale)
    }
    utimesSync(freshHome, now, now)
    const oneHourOld = new Date(now.getTime() - 60 * 60 * 1_000)
    utimesSync(boundaryHome, oneHourOld, oneHourOld)

    const removed = sweepStaleIsolatedHomes(root, now.getTime())

    assert.deepEqual(removed, [staleHome])
    assert.equal(existsSync(staleHome), false)
    assert.equal(existsSync(freshHome), true)
    assert.equal(existsSync(boundaryHome), true)
    assert.equal(existsSync(unmarkedHome), true)
    assert.equal(existsSync(unrelatedHome), true)
    assert.equal(existsSync(symlinkHome), true)
    assert.equal(existsSync(symlinkTarget), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
