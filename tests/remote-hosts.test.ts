import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  deleteRemoteHostProfile,
  getRemoteHostProfile,
  listAvailableRemoteHostProfiles,
  listRemoteHostProfiles,
  saveRemoteHostProfile,
  sshConfigHostProfileId
} from '../src/main/agent/remote-hosts'

test('Phi-owned SSH host profiles store aliases without keys or passwords', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-host-profiles-'))
  try {
    const first = saveRemoteHostProfile({ label: ' Lab HPC ', hostAlias: 'lab-hpc' }, root)
    assert.deepEqual(listRemoteHostProfiles(root), [
      { id: first.id, label: 'Lab HPC', hostAlias: 'lab-hpc' }
    ])
    assert.equal(getRemoteHostProfile(first.id, root)?.hostAlias, 'lab-hpc')
    const updated = saveRemoteHostProfile({ ...first, hostAlias: 'lab-hpc-new' }, root)
    assert.equal(updated.id, first.id)
    assert.equal(listRemoteHostProfiles(root).length, 1)
    const configured = saveRemoteHostProfile(
      {
        ...updated,
        user: 'scientist',
        port: 22022,
        identityFile: '/tmp/lab-key'
      },
      root
    )
    assert.equal(getRemoteHostProfile(configured.id, root)?.user, 'scientist')
    assert.equal(getRemoteHostProfile(configured.id, root)?.port, 22022)
    assert.equal(getRemoteHostProfile(configured.id, root)?.identityFile, '/tmp/lab-key')
    assert.throws(
      () => saveRemoteHostProfile({ label: 'Bad port', hostAlias: 'other', port: 70000 }, root),
      /端口/
    )
    assert.throws(
      () =>
        saveRemoteHostProfile(
          { label: 'Bad key', hostAlias: 'other', identityFile: 'relative/key' },
          root
        ),
      /绝对路径/
    )
    assert.throws(
      () => saveRemoteHostProfile({ label: 'Duplicate', hostAlias: 'lab-hpc-new' }, root),
      /已存在/
    )
    assert.throws(() =>
      saveRemoteHostProfile({ label: 'Invalid', hostAlias: '-oProxyCommand=evil' }, root)
    )
    assert.throws(
      () => saveRemoteHostProfile({ id: 'missing', label: 'Missing', hostAlias: 'other' }, root),
      /不存在/
    )
    deleteRemoteHostProfile(first.id, root)
    assert.deepEqual(listRemoteHostProfiles(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('OpenSSH config hosts are selectable without copying them into Phi', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-host-profiles-'))
  try {
    const configPath = join(root, 'config')
    writeFileSync(configPath, 'Host lab-hpc\n  HostName compute.example.invalid\n')
    const id = sshConfigHostProfileId('lab-hpc')
    assert.deepEqual(listAvailableRemoteHostProfiles(root, configPath), [
      { id, label: 'lab-hpc', hostAlias: 'lab-hpc', source: 'ssh-config' }
    ])
    assert.deepEqual(getRemoteHostProfile(id, root, configPath), {
      id,
      label: 'lab-hpc',
      hostAlias: 'lab-hpc',
      source: 'ssh-config'
    })
    assert.equal(existsSync(join(root, 'ssh-hosts.json')), false)
    assert.throws(
      () => saveRemoteHostProfile({ label: 'Duplicate', hostAlias: 'lab-hpc' }, root, configPath),
      /可直接使用/
    )

    const overridden = saveRemoteHostProfile(
      { id, label: 'Lab', hostAlias: 'lab-hpc', identityFile: '/tmp/lab-key' },
      root,
      configPath
    )
    assert.equal(overridden.source, 'ssh-config')
    assert.equal(getRemoteHostProfile(id, root, configPath)?.identityFile, '/tmp/lab-key')
    assert.equal(listAvailableRemoteHostProfiles(root, configPath)[0].label, 'Lab')
    writeFileSync(configPath, '')
    assert.equal(getRemoteHostProfile(id, root, configPath), undefined)
    assert.deepEqual(listAvailableRemoteHostProfiles(root, configPath), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('host profile listing strips unexpected credential fields from stored data', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-host-profiles-'))
  try {
    writeFileSync(
      join(root, 'ssh-hosts.json'),
      JSON.stringify([
        { id: 'host-1', label: 'Lab', hostAlias: 'lab-hpc', user: 'scientist', password: 'secret' }
      ])
    )
    assert.deepEqual(listRemoteHostProfiles(root), [
      { id: 'host-1', label: 'Lab', hostAlias: 'lab-hpc', user: 'scientist' }
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
