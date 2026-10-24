import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { E5_PROJECT_ID, E5_REMOTE_ROOT, prepareE5Profile } from '../scripts/e5-smoke-profile'

test('E5 prepare copies only the target project and harmless model metadata', async () => {
  const source = mkdtempSync('/tmp/phi-e5-source-')
  const secret = 'SECRET-SENTINEL-DO-NOT-COPY'
  const target = {
    id: E5_PROJECT_ID,
    name: 'phi-test',
    location: {
      kind: 'ssh',
      hostProfileId: 'ssh-config:GPU',
      remoteRoot: E5_REMOTE_ROOT,
      canonicalRoot: E5_REMOTE_ROOT
    },
    privateNote: secret
  }
  writeFileSync(
    join(source, 'projects.json'),
    JSON.stringify([
      target,
      {
        id: 'other-project',
        name: secret,
        location: { kind: 'local' }
      }
    ])
  )
  writeFileSync(
    join(source, 'settings.json'),
    JSON.stringify({
      lastSelectedModel: { providerId: 'moonshot', modelId: 'kimi-k2.6' },
      apiKey: secret
    })
  )
  writeFileSync(join(source, 'auth.json'), secret)
  mkdirSync(join(source, '.ssh'))
  writeFileSync(
    join(source, '.ssh', 'config'),
    [
      'Host GPU',
      '  HostName gpu.example.test',
      '  User tester',
      '  Port 10000',
      `Host other`,
      `  HostName ${secret}`
    ].join('\n')
  )
  writeFileSync(join(source, '.ssh', 'known_hosts'), 'hashed host key fixture')
  writeFileSync(join(source, '.ssh', 'id_ed25519'), secret)
  let root: string | undefined
  try {
    const prepared = await prepareE5Profile(source, '/tmp', source)
    root = prepared.root
    assert.deepEqual(readdirSync(root).sort(), ['home', 'user-data'])
    assert.deepEqual(readdirSync(prepared.agentDir).sort(), [
      'onboarding.json',
      'projects.json',
      'settings.json'
    ])
    assert.deepEqual(readdirSync(join(prepared.homeDir, '.ssh')), ['config'])
    const sshConfig = readFileSync(join(prepared.homeDir, '.ssh', 'config'), 'utf8')
    assert.match(sshConfig, /HostName gpu\.example\.test/)
    assert.match(sshConfig, /StrictHostKeyChecking yes/)
    assert.match(sshConfig, /UpdateHostKeys no/)
    assert.equal(sshConfig.includes(secret), false)
    const files = readdirSync(prepared.agentDir).map((name) =>
      readFileSync(join(prepared.agentDir, name), 'utf8')
    )
    assert.equal(files.join('').includes(secret), false)
    const projects = JSON.parse(readFileSync(join(prepared.agentDir, 'projects.json'), 'utf8'))
    assert.equal(projects.length, 1)
    assert.equal(projects[0].id, E5_PROJECT_ID)
    assert.equal(projects[0].permissionMode, 'ask')
    assert.deepEqual(JSON.parse(readFileSync(join(prepared.agentDir, 'settings.json'), 'utf8')), {
      lastSelectedModel: { providerId: 'moonshot', modelId: 'kimi-k2.6' }
    })
    for (const path of [root, prepared.homeDir, prepared.agentDir, prepared.userDataDir])
      assert.equal(statSync(path).mode & 0o077, 0)
  } finally {
    if (root) rmSync(root, { recursive: true, force: true })
    rmSync(source, { recursive: true, force: true })
  }
})
