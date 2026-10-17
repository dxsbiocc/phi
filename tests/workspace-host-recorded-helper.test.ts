import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { remoteHelperReadyMarkerIdentity } from '../src/main/agent/remote-helper-marker'
import { saveCapabilityProfile } from '../src/main/agent/workspace-host/capability-profile-store'
import { parseHostCapabilityProbe } from '../src/main/agent/workspace-host/probe'
import {
  FAST_PROBE_END_SENTINEL,
  FAST_PROBE_START_SENTINEL
} from '../src/main/agent/workspace-host/probe-script'
import { SshHost } from '../src/main/agent/workspace-host/ssh-host'

const VERSION = '9.9.9'
const profileKey = { hostAlias: 'recorded-host', projectRoot: '/srv/runtime' }
const probe = parseHostCapabilityProbe(
  `${FAST_PROBE_START_SENTINEL}\nplatform.os=Linux\nplatform.arch=x86_64\nprobe.fast_complete=1\n${FAST_PROBE_END_SENTINEL}`
)

let scratch = ''
let sha256 = ''

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'phi-recorded-helper-'))
  const binary = Buffer.from('#!/bin/sh\nexit 0\n')
  sha256 = createHash('sha256').update(binary).digest('hex')
  await mkdir(join(scratch, 'resources', VERSION, 'linux-amd64'), { recursive: true })
  await writeFile(join(scratch, 'resources', VERSION, 'linux-amd64', 'phi-helper'), binary)
  await writeFile(
    join(scratch, 'resources', 'manifest.json'),
    JSON.stringify({
      version: VERSION,
      platforms: { 'linux-amd64': { path: `${VERSION}/linux-amd64/phi-helper`, sha256 } }
    })
  )
})

after(() => rm(scratch, { recursive: true, force: true }))

function record(name: string, identity: { version: string; sha256: string }): string {
  const agentDir = join(scratch, name)
  saveCapabilityProfile(
    profileKey,
    {
      ...probe,
      helperVersion: identity.version,
      helperReadyMarker: remoteHelperReadyMarkerIdentity(identity),
      helperManagedRoot: '/home/u/.phi/remote',
      helperDirectory: `/home/u/.phi/remote/${identity.version}`
    },
    agentDir
  )
  return agentDir
}

function host(agentDir: string): { host: SshHost; connections: () => number } {
  let connections = 0
  return {
    host: new SshHost({
      remoteRoot: '/srv/runtime',
      canonicalRoot: '/srv/runtime',
      platform: { os: 'linux', arch: 'x86_64' },
      connect: async () => {
        connections += 1
        throw new Error('no SSH in this test')
      },
      helperBootstrap: {
        profileKey,
        agentDir,
        resourceRoot: join(scratch, 'resources'),
        developmentRoot: join(scratch, 'no-development-root'),
        onDemand: true
      }
    }),
    connections: () => connections
  }
}

test('a recorded installation of the current helper is returned without touching the host', async () => {
  const { host: ssh, connections } = host(record('current', { version: VERSION, sha256 }))
  const installation = await ssh.ensureManagedRemoteHelper()
  assert.equal(installation?.remotePath, `/home/u/.phi/remote/${VERSION}/phi-helper`)
  assert.equal(installation?.markerIdentity.sha256, sha256)
  assert.equal(connections(), 0)
  await ssh.close()
})

test('a record of another helper version or hash is never used', async () => {
  for (const [name, identity] of [
    ['old-version', { version: '1.0.0', sha256 }],
    ['other-hash', { version: VERSION, sha256: 'f'.repeat(64) }]
  ] as const) {
    const { host: ssh, connections } = host(record(name, identity))
    assert.equal(await ssh.ensureManagedRemoteHelper(), undefined)
    assert.ok(connections() > 0, `${name} must fall through to the full probe/install path`)
    await ssh.close()
  }
})

test('without any record the full probe/install path runs', async () => {
  const { host: ssh, connections } = host(join(scratch, 'empty'))
  assert.equal(await ssh.ensureManagedRemoteHelper(), undefined)
  assert.ok(connections() > 0)
  await ssh.close()
})

test('force repair bypasses the recorded installation', async () => {
  const { host: ssh, connections } = host(record('forced', { version: VERSION, sha256 }))
  assert.ok(await ssh.ensureManagedRemoteHelper())
  assert.equal(connections(), 0)
  assert.equal(await ssh.ensureManagedRemoteHelper({ force: true }), undefined)
  assert.ok(connections() > 0, 'a repair must probe and install, not trust the record')
  await ssh.close()
})
