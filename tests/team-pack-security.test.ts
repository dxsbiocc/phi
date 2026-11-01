import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Encrypter, generateHybridIdentity, identityToRecipient } from 'age-encryption'

import { createDeterministicTarGz } from '../src/main/agent/packages/archive'
import { TeamPackError, type TeamPackErrorCode } from '../src/main/agent/team-pack/errors'
import { jsonBytes, sha256 } from '../src/main/agent/team-pack/format'
import {
  createMemberKeys,
  createTeamKeys,
  type MemberKeys,
  type TeamKeys
} from '../src/main/agent/team-pack/keys'
import { publishTeamRelease } from '../src/main/agent/team-pack/publish'
import { pullTeamRelease } from '../src/main/agent/team-pack/pull'
import { signTeamFile } from '../src/main/agent/team-pack/signing'
import { DirectoryTeamPackStore, HttpTeamPackStore } from '../src/main/agent/team-pack/store'
import { digest, readJson, TEAM_ID, writeSkillRegistry } from './team-pack-fixtures'

const roots: string[] = []

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

test('tampered metadata, payload, and team key fail without changing local state', async (t) => {
  const fixture = await publishedFixture('tamper')
  const attacks: Array<{
    name: string
    code: TeamPackErrorCode
    mutate(storeDir: string): void
  }> = [
    {
      name: 'latest.json',
      code: 'BAD_SIGNATURE',
      mutate(storeDir) {
        const latest = readJson(join(storeDir, 'latest.json'))
        latest.createdAt = '2026-10-25T00:00:00.000Z'
        writeFileSync(join(storeDir, 'latest.json'), jsonBytes(latest))
      }
    },
    {
      name: 'manifest.json',
      code: 'HASH_MISMATCH',
      mutate(storeDir) {
        const path = join(storeDir, 'releases/1/manifest.json')
        const manifest = readJson(path)
        manifest.createdAt = '2026-10-25T00:00:00.000Z'
        writeFileSync(path, jsonBytes(manifest))
      }
    },
    {
      name: 'payload.age',
      code: 'HASH_MISMATCH',
      mutate(storeDir) {
        const path = join(storeDir, 'releases/1/payload.age')
        const payload = readFileSync(path)
        payload[payload.length - 1] ^= 1
        writeFileSync(path, payload)
      }
    },
    {
      name: 'team.json public key',
      code: 'UNTRUSTED_TEAM_KEY',
      mutate(storeDir) {
        const teamFile = readJson(join(storeDir, 'team.json'))
        teamFile.publicKey = createTeamKeys({ teamId: 'other-team', name: 'Other' }).publicKey
        writeFileSync(join(storeDir, 'team.json'), jsonBytes(teamFile))
      }
    }
  ]

  for (const attack of attacks) {
    await t.test(attack.name, async () => {
      const storeDir = join(fixture.root, `store-${attack.name.replaceAll(/[^a-z]/gi, '-')}`)
      cpSync(fixture.storeDir, storeDir, { recursive: true })
      attack.mutate(storeDir)
      const stateDir = join(fixture.root, `state-${attack.name.replaceAll(/[^a-z]/gi, '-')}`)
      await expectCode(
        pullTeamRelease({
          store: new DirectoryTeamPackStore(storeDir),
          teamKeyId: fixture.team.keyId,
          identity: fixture.member.identity,
          stateDir
        }),
        attack.code
      )
      assert.equal(existsSync(stateDir), false)
    })
  }
})

test('a genuinely signed old latest pointer is rejected as rollback', async () => {
  const fixture = await publishedFixture('rollback')
  const store = new DirectoryTeamPackStore(fixture.storeDir)
  const oldLatest = readFileSync(join(fixture.storeDir, 'latest.json'))
  const oldSignature = readFileSync(join(fixture.storeDir, 'latest.sig.json'))
  const stateDir = join(fixture.root, 'state')
  await pullTeamRelease({
    store,
    teamKeyId: fixture.team.keyId,
    identity: fixture.member.identity,
    stateDir
  })

  writeSkillRegistry(fixture.registryDir, '2.0.0')
  await publishTeamRelease({
    storeDir: fixture.storeDir,
    team: fixture.team,
    members: [fixture.member.recipient],
    registryDir: fixture.registryDir,
    createdAt: '2026-10-24T02:00:00.000Z'
  })
  await pullTeamRelease({
    store,
    teamKeyId: fixture.team.keyId,
    identity: fixture.member.identity,
    stateDir
  })
  const stateBefore = readFileSync(join(stateDir, TEAM_ID, 'state.json'))
  writeFileSync(join(fixture.storeDir, 'latest.json'), oldLatest)
  writeFileSync(join(fixture.storeDir, 'latest.sig.json'), oldSignature)

  await expectCode(
    pullTeamRelease({
      store,
      teamKeyId: fixture.team.keyId,
      identity: fixture.member.identity,
      stateDir
    }),
    'ROLLBACK'
  )
  assert.deepEqual(readFileSync(join(stateDir, TEAM_ID, 'state.json')), stateBefore)
})

test('moving ciphertext across versions or teams is rejected', async (t) => {
  await t.test('cross-version ciphertext', async () => {
    const fixture = await publishedFixture('cross-version')
    const v1Payload = readFileSync(join(fixture.storeDir, 'releases/1/payload.age'))
    writeSkillRegistry(fixture.registryDir, '2.0.0')
    await publishTeamRelease({
      storeDir: fixture.storeDir,
      team: fixture.team,
      members: [fixture.member.recipient],
      registryDir: fixture.registryDir,
      createdAt: '2026-10-24T02:00:00.000Z'
    })
    rewriteSignedPayload(fixture.storeDir, fixture.team, 2, v1Payload)
    await expectCode(
      pullTeamRelease({
        store: new DirectoryTeamPackStore(fixture.storeDir),
        teamKeyId: fixture.team.keyId,
        identity: fixture.member.identity,
        stateDir: join(fixture.root, 'state')
      }),
      'INNER_MISMATCH'
    )
  })

  await t.test('cross-team signed pointer', async () => {
    const first = await publishedFixture('cross-team-a', TEAM_ID)
    const second = await publishedFixture('cross-team-b', 'bravo-team')
    cpSync(join(second.storeDir, 'releases'), join(first.storeDir, 'releases'), {
      recursive: true,
      force: true
    })
    cpSync(join(second.storeDir, 'latest.json'), join(first.storeDir, 'latest.json'), {
      force: true
    })
    cpSync(join(second.storeDir, 'latest.sig.json'), join(first.storeDir, 'latest.sig.json'), {
      force: true
    })
    await expectCode(
      pullTeamRelease({
        store: new DirectoryTeamPackStore(first.storeDir),
        teamKeyId: first.team.keyId,
        identity: first.member.identity,
        stateDir: join(first.root, 'state')
      }),
      'BAD_SIGNATURE'
    )
  })
})

test('store and decrypted tar traversal are rejected', async () => {
  const fixture = await publishedFixture('traversal')
  const store = new DirectoryTeamPackStore(fixture.storeDir)
  await expectCode(store.read('../team.json', 1_024), 'INVALID_FORMAT')

  const archive = createDeterministicTarGz([
    { path: 'inner.json', data: jsonBytes({ version: 1, teamId: TEAM_ID, release: 1 }) },
    { path: 'registry/index.json', data: jsonBytes(emptyRegistry()) },
    { path: 'registry/../escape.txt', data: Buffer.from('escape') }
  ])
  const encrypter = new Encrypter()
  encrypter.addRecipient(fixture.member.recipient)
  const payload = Buffer.from(await encrypter.encrypt(archive))
  rewriteSignedPayload(fixture.storeDir, fixture.team, 1, payload)
  const stateDir = join(fixture.root, 'state')
  await expectCode(
    pullTeamRelease({
      store,
      teamKeyId: fixture.team.keyId,
      identity: fixture.member.identity,
      stateDir
    }),
    'INVALID_FORMAT'
  )
  assert.equal(existsSync(stateDir), false)
})

test('a pull that crashed before recording its state is repeated', async () => {
  const fixture = await publishedFixture('crash-recovery')
  const stateDir = join(fixture.root, 'state')
  const leftover = join(stateDir, TEAM_ID, '1', 'registry')
  mkdirSync(leftover, { recursive: true })
  writeFileSync(join(leftover, 'partial'), 'left by a crash')

  const result = await pullTeamRelease({
    store: new DirectoryTeamPackStore(fixture.storeDir),
    teamKeyId: fixture.team.keyId,
    identity: fixture.member.identity,
    stateDir
  })

  assert.equal(result.status, 'updated')
  assert.equal(existsSync(join(result.registryDir, 'partial')), false)
  assert.equal(existsSync(join(result.registryDir, 'index.json')), true)
})

test('HTTP store refuses cross-origin redirects', async (t) => {
  const destination = createServer((_request, response) => response.end('secret'))
  await new Promise<void>((resolve) => destination.listen(0, '127.0.0.1', resolve))
  t.after(() => destination.close())
  const destinationAddress = destination.address()
  assert.ok(destinationAddress && typeof destinationAddress === 'object')
  const source = createServer((_request, response) => {
    response.writeHead(302, {
      location: `http://127.0.0.1:${destinationAddress.port}/team.json`
    })
    response.end()
  })
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve))
  t.after(() => source.close())
  const sourceAddress = source.address()
  assert.ok(sourceAddress && typeof sourceAddress === 'object')
  const store = new HttpTeamPackStore(`http://127.0.0.1:${sourceAddress.port}/`)
  await expectCode(store.read('team.json', 1_024), 'STORE_UNAVAILABLE')
})

test('local state binds a team id to one trusted public key and manifest', async () => {
  const first = await publishedFixture('state-key-a', TEAM_ID)
  const stateDir = join(first.root, 'shared-state')
  await pullTeamRelease({
    store: new DirectoryTeamPackStore(first.storeDir),
    teamKeyId: first.team.keyId,
    identity: first.member.identity,
    stateDir
  })

  const second = await publishedFixture('state-key-b', TEAM_ID)
  await expectCode(
    pullTeamRelease({
      store: new DirectoryTeamPackStore(second.storeDir),
      teamKeyId: second.team.keyId,
      identity: second.member.identity,
      stateDir
    }),
    'UNTRUSTED_TEAM_KEY'
  )

  const latest = readJson(join(first.storeDir, 'latest.json'))
  latest.manifestSha256 = '0'.repeat(64)
  const bytes = jsonBytes(latest)
  writeFileSync(join(first.storeDir, 'latest.json'), bytes)
  writeFileSync(join(first.storeDir, 'latest.sig.json'), signTeamFile(bytes, first.team.privateKey))
  await expectCode(
    pullTeamRelease({
      store: new DirectoryTeamPackStore(first.storeDir),
      teamKeyId: first.team.keyId,
      identity: first.member.identity,
      stateDir
    }),
    'ROLLBACK'
  )
})

test('publisher and puller reject managed subdirectories that are symlinks', async () => {
  const fixture = await publishedFixture('symlink-state')
  const stateDir = join(fixture.root, 'state')
  const outsideState = join(fixture.root, 'outside-state')
  mkdirSync(stateDir)
  mkdirSync(outsideState)
  symlinkSync(outsideState, join(stateDir, TEAM_ID), 'dir')
  await expectCode(
    pullTeamRelease({
      store: new DirectoryTeamPackStore(fixture.storeDir),
      teamKeyId: fixture.team.keyId,
      identity: fixture.member.identity,
      stateDir
    }),
    'INVALID_FORMAT'
  )
  assert.equal(existsSync(join(outsideState, '1')), false)

  const publishRoot = sandbox('symlink-publish')
  const storeDir = join(publishRoot, 'store')
  const outsideReleases = join(publishRoot, 'outside-releases')
  const registryDir = join(publishRoot, 'registry')
  mkdirSync(storeDir)
  mkdirSync(outsideReleases)
  symlinkSync(outsideReleases, join(storeDir, 'releases'), 'dir')
  writeSkillRegistry(registryDir, '1.0.0')
  await expectCode(
    publishTeamRelease({
      storeDir,
      team: fixture.team,
      members: [fixture.member.recipient],
      registryDir
    }),
    'INVALID_FORMAT'
  )
  assert.deepEqual(readFileNames(outsideReleases), [])
})

test('only native age X25519 identities and recipients are accepted', async () => {
  const fixture = await publishedFixture('x25519-only')
  const hybridIdentity = await generateHybridIdentity()
  const hybridRecipient = await identityToRecipient(hybridIdentity)
  await expectCode(
    publishTeamRelease({
      storeDir: join(fixture.root, 'hybrid-store'),
      team: fixture.team,
      members: [hybridRecipient],
      registryDir: fixture.registryDir
    }),
    'INVALID_FORMAT'
  )
  await expectCode(
    pullTeamRelease({
      store: new DirectoryTeamPackStore(fixture.storeDir),
      teamKeyId: fixture.team.keyId,
      identity: hybridIdentity,
      stateDir: join(fixture.root, 'hybrid-state')
    }),
    'INVALID_FORMAT'
  )
})

interface PublishedFixture {
  root: string
  registryDir: string
  storeDir: string
  team: TeamKeys
  member: MemberKeys
}

async function publishedFixture(label: string, teamId = TEAM_ID): Promise<PublishedFixture> {
  const root = sandbox(label)
  const registryDir = join(root, 'registry')
  const storeDir = join(root, 'store')
  const team = createTeamKeys({ teamId, name: `${teamId} name` })
  const member = await createMemberKeys()
  writeSkillRegistry(registryDir, '1.0.0')
  await publishTeamRelease({
    storeDir,
    team,
    members: [member.recipient],
    registryDir,
    createdAt: '2026-10-24T01:00:00.000Z'
  })
  return { root, registryDir, storeDir, team, member }
}

function rewriteSignedPayload(
  storeDir: string,
  team: TeamKeys,
  release: number,
  payload: Buffer
): void {
  const releaseDir = join(storeDir, 'releases', String(release))
  const manifest = readJson(join(releaseDir, 'manifest.json'))
  manifest.payloadSha256 = digest(payload)
  manifest.payloadBytes = payload.length
  const manifestBytes = jsonBytes(manifest)
  writeFileSync(join(releaseDir, 'payload.age'), payload)
  writeFileSync(join(releaseDir, 'manifest.json'), manifestBytes)
  writeFileSync(join(releaseDir, 'manifest.sig.json'), signTeamFile(manifestBytes, team.privateKey))

  const latest = readJson(join(storeDir, 'latest.json'))
  latest.manifestSha256 = sha256(manifestBytes)
  const latestBytes = jsonBytes(latest)
  writeFileSync(join(storeDir, 'latest.sig.json'), signTeamFile(latestBytes, team.privateKey))
  writeFileSync(join(storeDir, 'latest.json'), latestBytes)
}

function emptyRegistry(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    generatedAt: '2026-10-24T00:00:00.000Z',
    packages: []
  }
}

function sandbox(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `phi-team-pack-${label}-`))
  roots.push(root)
  mkdirSync(root, { recursive: true })
  return root
}

function readFileNames(path: string): string[] {
  return readdirSync(path).sort()
}

async function expectCode(
  promise: Promise<unknown>,
  code: TeamPackErrorCode
): Promise<TeamPackError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof TeamPackError)
    assert.equal(error.code, code)
    return error
  }
  assert.fail(`expected ${code}`)
}
