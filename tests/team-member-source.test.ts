import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { createMemberKeys, createTeamKeys } from '../src/main/agent/team-pack/keys'
import { publishTeamRelease } from '../src/main/agent/team-pack/publish'
import { pullTeamRelease } from '../src/main/agent/team-pack/pull'
import {
  TeamSourceScheduler,
  type TeamSourceSchedulerService
} from '../src/main/agent/team-pack/team-source-scheduler'
import {
  TeamSourceService,
  listTeamSources,
  teamSourceRegistryDir,
  teamSourcesPath,
  type TeamSource,
  type TeamSourceAuthStorage
} from '../src/main/agent/team-pack/team-source'
import { TEAM_ID, writeSkillRegistry } from './team-pack-fixtures'

const roots: string[] = []

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

test('adds a directory source only after validating team.json and persists strict source metadata', async () => {
  const root = sandbox('add')
  const agentDir = join(root, 'agent')
  const registryDir = join(root, 'registry')
  const storeDir = join(root, 'store')
  const team = createTeamKeys({ teamId: TEAM_ID, name: 'Alpha Team' })
  const member = await createMemberKeys()
  writeSkillRegistry(registryDir, '1.0.0')
  await publishTeamRelease({ storeDir, team, members: [member.recipient], registryDir })

  assert.deepEqual(listTeamSources(agentDir), [])
  assert.equal(existsSync(teamSourcesPath(agentDir)), false)
  const service = new TeamSourceService({
    agentDir,
    getMemberIdentity: async () => member.identity,
    createId: () => 'source-alpha',
    now: () => new Date('2026-11-04T01:02:03.000Z')
  })
  const preview = await service.previewSource({
    teamKeyId: team.keyId,
    location: { kind: 'directory', path: storeDir }
  })
  assert.deepEqual(preview, {
    teamId: TEAM_ID,
    teamName: 'Alpha Team',
    teamKeyId: team.keyId,
    location: { kind: 'directory', path: storeDir }
  })
  assert.equal(existsSync(teamSourcesPath(agentDir)), false)
  const source = await service.addSource({
    teamKeyId: team.keyId,
    location: { kind: 'directory', path: storeDir }
  })

  assert.deepEqual(source, {
    id: 'source-alpha',
    teamId: TEAM_ID,
    teamName: 'Alpha Team',
    teamKeyId: team.keyId,
    location: { kind: 'directory', path: storeDir },
    addedAt: '2026-11-04T01:02:03.000Z',
    status: {
      lastSuccessfulRelease: null,
      lastCheckedAt: null,
      lastErrorCode: null,
      withdrawnReleases: [],
      announcements: [],
      resources: {},
      credentialConflicts: [],
      skippedProviders: []
    }
  })
  assert.deepEqual(listTeamSources(agentDir), [source])
  assert.deepEqual(JSON.parse(readFileSync(teamSourcesPath(agentDir), 'utf8')), {
    version: 1,
    sources: [source],
    credentialOwners: []
  })
  assert.equal(statSync(teamSourcesPath(agentDir)).mode & 0o777, 0o600)

  const secondStoreDir = join(root, 'second-store')
  const secondTeam = createTeamKeys({ teamId: 'second-team', name: 'Second Team' })
  await publishTeamRelease({
    storeDir: secondStoreDir,
    team: secondTeam,
    members: [member.recipient],
    registryDir
  })
  await assert.rejects(
    service.addSource({
      teamKeyId: secondTeam.keyId,
      location: { kind: 'directory', path: secondStoreDir }
    }),
    /标识重复/
  )
  assert.equal(service.listSources().length, 1)
})

test('rejects a mismatched team fingerprint and plain HTTP without persisting a source', async () => {
  const root = sandbox('reject')
  const agentDir = join(root, 'agent')
  const registryDir = join(root, 'registry')
  const storeDir = join(root, 'store')
  const team = createTeamKeys({ teamId: TEAM_ID, name: 'Alpha Team' })
  const otherTeam = createTeamKeys({ teamId: 'other-team', name: 'Other Team' })
  const member = await createMemberKeys()
  writeSkillRegistry(registryDir, '1.0.0')
  await publishTeamRelease({ storeDir, team, members: [member.recipient], registryDir })
  const service = new TeamSourceService({
    agentDir,
    getMemberIdentity: async () => member.identity
  })

  await assert.rejects(
    service.addSource({
      teamKeyId: otherTeam.keyId,
      location: { kind: 'directory', path: storeDir }
    }),
    { code: 'UNTRUSTED_TEAM_KEY' }
  )
  await assert.rejects(
    service.addSource({
      teamKeyId: team.keyId,
      location: { kind: 'https', url: 'http://127.0.0.1:12345/team' }
    }),
    { code: 'INVALID_FORMAT' }
  )
  assert.deepEqual(listTeamSources(agentDir), [])
  assert.equal(existsSync(teamSourcesPath(agentDir)), false)
})

test('allows an explicitly enabled HTTP source for local tests', async (t) => {
  const root = sandbox('allow-http')
  const agentDir = join(root, 'agent')
  const registryDir = join(root, 'registry')
  const storeDir = join(root, 'store')
  const team = createTeamKeys({ teamId: TEAM_ID, name: 'Alpha Team' })
  const member = await createMemberKeys()
  writeSkillRegistry(registryDir, '1.0.0')
  await publishTeamRelease({ storeDir, team, members: [member.recipient], registryDir })
  const server = createServer((request, response) => {
    try {
      const relative = decodeURIComponent(
        new URL(request.url ?? '/', 'http://local').pathname
      ).slice(1)
      const data = readFileSync(join(storeDir, ...relative.split('/')))
      response.writeHead(200, { 'content-length': data.length })
      response.end(data)
    } catch {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const service = new TeamSourceService({
    agentDir,
    getMemberIdentity: async () => member.identity,
    allowHttp: true,
    createId: () => 'source-alpha'
  })
  const source = await service.addSource({
    teamKeyId: team.keyId,
    location: { kind: 'https', url: `http://127.0.0.1:${address.port}/` }
  })
  assert.equal(source.teamName, 'Alpha Team')
  assert.equal(source.location.kind, 'https')
  assert.equal(service.listSources().length, 1)
  assert.equal(listTeamSources(agentDir).length, 1)

  const productionService = new TeamSourceService({
    agentDir,
    getMemberIdentity: async () => member.identity,
    authStorage: new FakeAuthStorage()
  })
  await assert.rejects(productionService.pullSource(source.id), { code: 'INVALID_FORMAT' })
  assert.equal(productionService.listSources()[0]?.status.lastErrorCode, 'INVALID_FORMAT')
})

test('pulls releases, reconciles team model keys, records withdrawals, and preserves user credentials', async () => {
  const root = sandbox('pull')
  const agentDir = join(root, 'agent')
  const registryDir = join(root, 'registry')
  const storeDir = join(root, 'store')
  const team = createTeamKeys({ teamId: TEAM_ID, name: 'Alpha Team' })
  const member = await createMemberKeys()
  const auth = new FakeAuthStorage()
  await auth.credentials.upsert('anthropic', {
    type: 'api_key',
    key: 'user-owned-anthropic'
  })
  auth.configureExternal('google', 'environment')
  writeSkillRegistry(registryDir, '1.0.0')
  await publishTeamRelease({
    storeDir,
    team,
    members: [member.recipient],
    grants: [
      {
        recipient: member.recipient,
        models: [
          { providerId: 'openai', label: 'Team OpenAI', apiKey: 'team-openai-v1' },
          { providerId: 'anthropic', label: 'Team Claude', apiKey: 'team-anthropic' },
          { providerId: 'google', label: 'Team Gemini', apiKey: 'team-google' },
          { providerId: 'unknown-provider', label: 'Unknown', apiKey: 'team-unknown' }
        ]
      }
    ],
    registryDir
  })
  let clock = 0
  const service = new TeamSourceService({
    agentDir,
    getMemberIdentity: async () => member.identity,
    authStorage: auth,
    createId: () => 'source-alpha',
    now: () => new Date(Date.UTC(2026, 10, 4, 1, 0, clock++))
  })
  const added = await service.addSource({
    teamKeyId: team.keyId,
    location: { kind: 'directory', path: storeDir }
  })
  const first = await service.pullSource(added.id)

  assert.equal(first.status.lastSuccessfulRelease, 1)
  assert.equal(first.status.lastErrorCode, null)
  assert.deepEqual(first.status.credentialConflicts, ['anthropic', 'google'])
  assert.deepEqual(first.status.skippedProviders, ['unknown-provider'])
  assert.deepEqual(service.configuredProviders(TEAM_ID), ['openai'])
  assert.equal(auth.key('openai'), 'team-openai-v1')
  assert.equal(auth.key('anthropic'), 'user-owned-anthropic')
  assert.equal(auth.key('google'), undefined)
  assert.equal(existsSync(teamSourceRegistryDir(agentDir, first)!), true)

  writeSkillRegistry(registryDir, '2.0.0')
  await publishTeamRelease({
    storeDir,
    team,
    members: [member.recipient],
    grants: [
      {
        recipient: member.recipient,
        models: [{ providerId: 'openai', label: 'Team OpenAI', apiKey: 'team-openai-v2' }]
      }
    ],
    registryDir,
    withdrawReleases: [1]
  })
  const second = await service.pullSource(added.id)
  assert.equal(second.status.lastSuccessfulRelease, 2)
  assert.deepEqual(second.status.withdrawnReleases, [1])
  assert.deepEqual(second.status.credentialConflicts, [])
  assert.deepEqual(second.status.skippedProviders, [])
  assert.equal(auth.key('openai'), 'team-openai-v2')
  assert.equal(auth.credentials.list('openai').length, 1)
  assert.equal(auth.key('anthropic'), 'user-owned-anthropic')

  writeSkillRegistry(registryDir, '3.0.0')
  await publishTeamRelease({
    storeDir,
    team,
    members: [member.recipient],
    registryDir
  })
  const third = await service.pullSource(added.id)
  assert.equal(third.status.lastSuccessfulRelease, 3)
  assert.equal(auth.key('openai'), undefined)
  assert.deepEqual(service.configuredProviders(TEAM_ID), [])
  assert.equal(auth.key('anthropic'), 'user-owned-anthropic')
  assert.deepEqual(
    (
      JSON.parse(readFileSync(teamSourcesPath(agentDir), 'utf8')) as {
        credentialOwners: unknown[]
      }
    ).credentialOwners,
    []
  )
})

test('records NOT_A_MEMBER while retaining the previous successful registry', async () => {
  const root = sandbox('removed-member')
  const agentDir = join(root, 'agent')
  const registryDir = join(root, 'registry')
  const storeDir = join(root, 'store')
  const team = createTeamKeys({ teamId: TEAM_ID, name: 'Alpha Team' })
  const member = await createMemberKeys()
  const replacement = await createMemberKeys()
  writeSkillRegistry(registryDir, '1.0.0')
  await publishTeamRelease({ storeDir, team, members: [member.recipient], registryDir })
  const service = new TeamSourceService({
    agentDir,
    getMemberIdentity: async () => member.identity,
    authStorage: new FakeAuthStorage(),
    createId: () => 'source-alpha',
    now: () => new Date('2026-11-04T04:00:00.000Z')
  })
  const added = await service.addSource({
    teamKeyId: team.keyId,
    location: { kind: 'directory', path: storeDir }
  })
  const first = await service.pullSource(added.id)
  const firstRegistry = teamSourceRegistryDir(agentDir, first)
  assert.ok(firstRegistry)

  writeSkillRegistry(registryDir, '2.0.0')
  await publishTeamRelease({
    storeDir,
    team,
    members: [replacement.recipient],
    registryDir
  })
  await assert.rejects(service.pullSource(added.id), { code: 'NOT_A_MEMBER' })
  const failed = service.listSources()[0]!
  assert.equal(failed.status.lastSuccessfulRelease, 1)
  assert.equal(failed.status.lastErrorCode, 'NOT_A_MEMBER')
  assert.equal(teamSourceRegistryDir(agentDir, failed), firstRegistry)
  assert.equal(existsSync(firstRegistry), true)
})

test('records RELEASE_WITHDRAWN without replacing the last successful release', async () => {
  const root = sandbox('withdrawn-latest')
  const agentDir = join(root, 'agent')
  const registryDir = join(root, 'registry')
  const storeDir = join(root, 'store')
  const team = createTeamKeys({ teamId: TEAM_ID, name: 'Alpha Team' })
  const member = await createMemberKeys()
  writeSkillRegistry(registryDir, '1.0.0')
  await publishTeamRelease({ storeDir, team, members: [member.recipient], registryDir })
  const service = new TeamSourceService({
    agentDir,
    getMemberIdentity: async () => member.identity,
    authStorage: new FakeAuthStorage(),
    createId: () => 'source-alpha'
  })
  const added = await service.addSource({
    teamKeyId: team.keyId,
    location: { kind: 'directory', path: storeDir }
  })
  await service.pullSource(added.id)

  writeSkillRegistry(registryDir, '2.0.0')
  await publishTeamRelease({
    storeDir,
    team,
    members: [member.recipient],
    registryDir,
    withdrawReleases: [2]
  })
  await assert.rejects(service.pullSource(added.id), { code: 'RELEASE_WITHDRAWN' })
  const failed = service.listSources()[0]!
  assert.equal(failed.status.lastSuccessfulRelease, 1)
  assert.equal(failed.status.lastErrorCode, 'RELEASE_WITHDRAWN')
})

test('removes source state and only its unchanged team credential without uninstalling packages', async () => {
  const root = sandbox('remove')
  const agentDir = join(root, 'agent')
  const registryDir = join(root, 'registry')
  const storeDir = join(root, 'store')
  const team = createTeamKeys({ teamId: TEAM_ID, name: 'Alpha Team' })
  const member = await createMemberKeys()
  const auth = new FakeAuthStorage()
  writeSkillRegistry(registryDir, '1.0.0')
  await publishTeamRelease({
    storeDir,
    team,
    members: [member.recipient],
    grants: [
      {
        recipient: member.recipient,
        models: [{ providerId: 'openai', label: 'Team OpenAI', apiKey: 'team-openai' }]
      }
    ],
    registryDir
  })
  const service = new TeamSourceService({
    agentDir,
    getMemberIdentity: async () => member.identity,
    authStorage: auth,
    createId: () => 'source-alpha'
  })
  const added = await service.addSource({
    teamKeyId: team.keyId,
    location: { kind: 'directory', path: storeDir }
  })
  await service.pullSource(added.id)
  const installedMarker = join(agentDir, 'packages', 'skill', 'kept', '1.0.0', 'marker')
  mkdirSync(dirname(installedMarker), { recursive: true })
  writeFileSync(installedMarker, 'installed')
  assert.equal(auth.key('openai'), 'team-openai')

  assert.equal(await service.removeSource(added.id), true)
  assert.deepEqual(service.listSources(), [])
  assert.equal(auth.key('openai'), undefined)
  assert.equal(existsSync(join(agentDir, 'team-pack', 'state', TEAM_ID)), false)
  assert.equal(readFileSync(installedMarker, 'utf8'), 'installed')
  assert.equal(await service.removeSource(added.id), false)
})

test('does not rotate or delete a user key added beside an owned team provider', async () => {
  const root = sandbox('late-conflict')
  const agentDir = join(root, 'agent')
  const registryDir = join(root, 'registry')
  const storeDir = join(root, 'store')
  const team = createTeamKeys({ teamId: TEAM_ID, name: 'Alpha Team' })
  const member = await createMemberKeys()
  const auth = new FakeAuthStorage()
  writeSkillRegistry(registryDir, '1.0.0')
  await publishTeamRelease({
    storeDir,
    team,
    members: [member.recipient],
    grants: [
      {
        recipient: member.recipient,
        models: [{ providerId: 'openai', label: 'Team OpenAI', apiKey: 'team-openai-v1' }]
      }
    ],
    registryDir
  })
  const service = new TeamSourceService({
    agentDir,
    getMemberIdentity: async () => member.identity,
    authStorage: auth,
    createId: () => 'source-alpha'
  })
  const added = await service.addSource({
    teamKeyId: team.keyId,
    location: { kind: 'directory', path: storeDir }
  })
  await service.pullSource(added.id)
  await auth.credentials.upsert('openai', { type: 'api_key', key: 'user-openai' })

  writeSkillRegistry(registryDir, '2.0.0')
  await publishTeamRelease({
    storeDir,
    team,
    members: [member.recipient],
    grants: [
      {
        recipient: member.recipient,
        models: [{ providerId: 'openai', label: 'Team OpenAI', apiKey: 'team-openai-v2' }]
      }
    ],
    registryDir
  })
  const conflicted = await service.pullSource(added.id)
  assert.deepEqual(conflicted.status.credentialConflicts, ['openai'])
  assert.deepEqual(auth.keysFor('openai'), ['team-openai-v1', 'user-openai'])

  writeSkillRegistry(registryDir, '3.0.0')
  await publishTeamRelease({ storeDir, team, members: [member.recipient], registryDir })
  const removalConflict = await service.pullSource(added.id)
  assert.deepEqual(removalConflict.status.credentialConflicts, ['openai'])
  assert.deepEqual(auth.keysFor('openai'), ['team-openai-v1', 'user-openai'])
  assert.deepEqual(service.configuredProviders(TEAM_ID), [])
})

test('preserves a user replacement that reused the team credential id and records a conflict', async () => {
  const root = sandbox('same-id-replacement')
  const agentDir = join(root, 'agent')
  const registryDir = join(root, 'registry')
  const storeDir = join(root, 'store')
  const team = createTeamKeys({ teamId: TEAM_ID, name: 'Alpha Team' })
  const member = await createMemberKeys()
  const auth = new FakeAuthStorage()
  writeSkillRegistry(registryDir, '1.0.0')
  await publishTeamRelease({
    storeDir,
    team,
    members: [member.recipient],
    grants: [
      {
        recipient: member.recipient,
        models: [{ providerId: 'openai', label: 'Team OpenAI', apiKey: 'team-openai' }]
      }
    ],
    registryDir
  })
  const service = new TeamSourceService({
    agentDir,
    getMemberIdentity: async () => member.identity,
    authStorage: auth,
    createId: () => 'source-alpha'
  })
  const source = await service.addSource({
    teamKeyId: team.keyId,
    location: { kind: 'directory', path: storeDir }
  })
  await service.pullSource(source.id)
  const teamCredentialId = auth.credentials.list('openai')[0]?.id

  await auth.credentials.set('openai', { type: 'api_key', key: 'user-openai' })
  assert.equal(auth.credentials.list('openai')[0]?.id, teamCredentialId)
  writeSkillRegistry(registryDir, '2.0.0')
  await publishTeamRelease({ storeDir, team, members: [member.recipient], registryDir })
  const updated = await service.pullSource(source.id)

  assert.deepEqual(updated.status.credentialConflicts, ['openai'])
  assert.equal(auth.key('openai'), 'user-openai')
  assert.equal(auth.logoutCalls, 0)
  assert.deepEqual(service.configuredProviders(TEAM_ID), [])
})

test('does not rotate an owned team key while an external provider source is configured', async () => {
  const root = sandbox('external-source-conflict')
  const agentDir = join(root, 'agent')
  const registryDir = join(root, 'registry')
  const storeDir = join(root, 'store')
  const team = createTeamKeys({ teamId: TEAM_ID, name: 'Alpha Team' })
  const member = await createMemberKeys()
  const auth = new FakeAuthStorage()
  writeSkillRegistry(registryDir, '1.0.0')
  await publishTeamRelease({
    storeDir,
    team,
    members: [member.recipient],
    grants: [
      {
        recipient: member.recipient,
        models: [{ providerId: 'openai', label: 'Team OpenAI', apiKey: 'team-openai-v1' }]
      }
    ],
    registryDir
  })
  const service = new TeamSourceService({
    agentDir,
    getMemberIdentity: async () => member.identity,
    authStorage: auth,
    createId: () => 'source-alpha'
  })
  const source = await service.addSource({
    teamKeyId: team.keyId,
    location: { kind: 'directory', path: storeDir }
  })
  await service.pullSource(source.id)
  auth.configureExternal('openai', 'environment')

  writeSkillRegistry(registryDir, '2.0.0')
  await publishTeamRelease({
    storeDir,
    team,
    members: [member.recipient],
    grants: [
      {
        recipient: member.recipient,
        models: [{ providerId: 'openai', label: 'Team OpenAI', apiKey: 'team-openai-v2' }]
      }
    ],
    registryDir
  })
  const conflicted = await service.pullSource(source.id)

  assert.deepEqual(conflicted.status.credentialConflicts, ['openai'])
  assert.equal(auth.key('openai'), 'team-openai-v1')
  assert.deepEqual(service.configuredProviders(TEAM_ID), ['openai'])
})

test('deduplicates concurrent pulls of the same source', async () => {
  const root = sandbox('dedupe')
  const agentDir = join(root, 'agent')
  const registryDir = join(root, 'registry')
  const storeDir = join(root, 'store')
  const team = createTeamKeys({ teamId: TEAM_ID, name: 'Alpha Team' })
  const member = await createMemberKeys()
  writeSkillRegistry(registryDir, '1.0.0')
  await publishTeamRelease({ storeDir, team, members: [member.recipient], registryDir })
  const pending = deferred<{
    status: 'updated'
    teamId: string
    release: number
    registryDir: string
    withdrawnReleases: number[]
    models: []
    announcements: []
    resources: Record<string, never>
  }>()
  let calls = 0
  const service = new TeamSourceService({
    agentDir,
    getMemberIdentity: async () => member.identity,
    authStorage: new FakeAuthStorage(),
    createId: () => 'source-alpha',
    pullRelease: async () => {
      calls += 1
      return pending.promise
    }
  })
  const added = await service.addSource({
    teamKeyId: team.keyId,
    location: { kind: 'directory', path: storeDir }
  })
  const first = service.pullSource(added.id)
  const second = service.pullSource(added.id)
  assert.equal(first, second)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  pending.resolve({
    status: 'updated',
    teamId: TEAM_ID,
    release: 1,
    registryDir: join(root, 'synthetic-registry'),
    withdrawnReleases: [],
    models: [],
    announcements: [],
    resources: {}
  })
  await Promise.all([first, second])
  assert.equal(calls, 1)
})

test('source removal waits for an in-flight pull before deleting committed state', async () => {
  const root = sandbox('remove-race')
  const agentDir = join(root, 'agent')
  const registryDir = join(root, 'registry')
  const storeDir = join(root, 'store')
  const team = createTeamKeys({ teamId: TEAM_ID, name: 'Alpha Team' })
  const member = await createMemberKeys()
  writeSkillRegistry(registryDir, '1.0.0')
  await publishTeamRelease({ storeDir, team, members: [member.recipient], registryDir })
  const entered = deferred<void>()
  const release = deferred<void>()
  const service = new TeamSourceService({
    agentDir,
    getMemberIdentity: async () => member.identity,
    createId: () => 'source-alpha',
    pullRelease: async (options) => {
      entered.resolve(undefined)
      await release.promise
      return pullTeamRelease(options)
    }
  })
  const source = await service.addSource({
    teamKeyId: team.keyId,
    location: { kind: 'directory', path: storeDir }
  })

  const pull = service.pullSource(source.id)
  await entered.promise
  const removal = service.removeSource(source.id)
  await assert.rejects(service.pullSource(source.id), /正在删除/)
  release.resolve(undefined)
  await pull
  assert.equal(await removal, true)

  assert.deepEqual(service.listSources(), [])
  assert.equal(existsSync(join(agentDir, 'team-pack', 'state', TEAM_ID)), false)
})

test('service close drains an in-flight pull and rejects later mutations', async () => {
  const root = sandbox('close-race')
  const agentDir = join(root, 'agent')
  const registryDir = join(root, 'registry')
  const storeDir = join(root, 'store')
  const team = createTeamKeys({ teamId: TEAM_ID, name: 'Alpha Team' })
  const member = await createMemberKeys()
  writeSkillRegistry(registryDir, '1.0.0')
  await publishTeamRelease({ storeDir, team, members: [member.recipient], registryDir })
  const pending = deferred<{
    status: 'updated'
    teamId: string
    release: number
    registryDir: string
    withdrawnReleases: number[]
    models: []
    announcements: []
    resources: Record<string, never>
  }>()
  const service = new TeamSourceService({
    agentDir,
    getMemberIdentity: async () => member.identity,
    createId: () => 'source-alpha',
    pullRelease: async () => pending.promise
  })
  const source = await service.addSource({
    teamKeyId: team.keyId,
    location: { kind: 'directory', path: storeDir }
  })
  const pull = service.pullSource(source.id)
  let closed = false
  const close = service.close().then(() => {
    closed = true
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(closed, false)

  pending.resolve({
    status: 'updated',
    teamId: TEAM_ID,
    release: 1,
    registryDir: join(root, 'synthetic-registry'),
    withdrawnReleases: [],
    models: [],
    announcements: [],
    resources: {}
  })
  await pull
  await close
  assert.equal(closed, true)
  assert.throws(() => service.pullSource(source.id), /服务已关闭/)
  await assert.rejects(service.addSource({ teamKeyId: team.keyId, location: source.location }), {
    code: 'INVALID_FORMAT'
  })
})

test('service close drains an in-flight source addition before returning', async () => {
  const root = sandbox('close-add-race')
  const registryDir = join(root, 'registry')
  const storeDir = join(root, 'store')
  const team = createTeamKeys({ teamId: TEAM_ID, name: 'Alpha Team' })
  const member = await createMemberKeys()
  writeSkillRegistry(registryDir, '1.0.0')
  await publishTeamRelease({ storeDir, team, members: [member.recipient], registryDir })
  const teamFile = readFileSync(join(storeDir, 'team.json'))
  const entered = deferred<void>()
  const release = deferred<void>()
  const service = new TeamSourceService({
    agentDir: join(root, 'agent'),
    getMemberIdentity: async () => member.identity,
    allowHttp: true,
    createId: () => 'source-alpha',
    httpStoreOptions: {
      fetch: async () => {
        entered.resolve(undefined)
        await release.promise
        return new Response(teamFile, {
          headers: { 'content-length': String(teamFile.length) }
        })
      }
    }
  })

  const adding = service.addSource({
    teamKeyId: team.keyId,
    location: { kind: 'https', url: 'http://127.0.0.1:12345/' }
  })
  await entered.promise
  let closed = false
  const close = service.close().then(() => {
    closed = true
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(closed, false)

  release.resolve(undefined)
  const added = await adding
  await close
  assert.equal(closed, true)
  assert.deepEqual(service.listSources(), [added])
  await assert.rejects(service.addSource({ teamKeyId: team.keyId, location: added.location }), {
    code: 'INVALID_FORMAT'
  })
})

test('scheduler pulls immediately, prevents overlapping ticks, and writes nothing with no sources', async () => {
  const root = sandbox('scheduler')
  const emptyAgentDir = join(root, 'empty-agent')
  const emptyService = new TeamSourceService({
    agentDir: emptyAgentDir,
    getMemberIdentity: async () => assert.fail('empty scheduler must not request identity')
  })
  let emptyIntervals = 0
  const emptyScheduler = new TeamSourceScheduler({
    service: emptyService,
    setInterval: () => {
      emptyIntervals += 1
      return setInterval(() => undefined, 60_000)
    }
  })
  await emptyScheduler.start()
  assert.equal(emptyIntervals, 0)
  assert.equal(existsSync(teamSourcesPath(emptyAgentDir)), false)

  const releases: Array<() => void> = []
  let calls = 0
  let active = 0
  let maximumActive = 0
  let scheduledInterval = 0
  const fakeSource = sourceRecord()
  const service: TeamSourceSchedulerService = {
    listSources: () => [fakeSource],
    pullAllSources: async () => {
      calls += 1
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise<void>((resolve) => releases.push(resolve))
      active -= 1
      return []
    }
  }
  const scheduler = new TeamSourceScheduler({
    service,
    setInterval: (_callback, intervalMs) => {
      scheduledInterval = intervalMs
      return setInterval(() => undefined, 60_000)
    }
  })
  const started = scheduler.start()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  releases.shift()!()
  await started
  assert.equal(scheduledInterval, 6 * 60 * 60 * 1_000)

  const firstTick = scheduler.runNow()
  const secondTick = scheduler.runNow()
  assert.equal(firstTick, secondTick)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(calls, 2)
  assert.equal(maximumActive, 1)
  releases.shift()!()
  await Promise.all([firstTick, secondTick])
  scheduler.stop()
})

function sandbox(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `phi-team-source-${name}-`))
  roots.push(root)
  return root
}

function sourceRecord(): TeamSource {
  return {
    id: 'source-alpha',
    teamId: TEAM_ID,
    teamName: 'Alpha Team',
    teamKeyId: 'a'.repeat(16),
    location: { kind: 'directory' as const, path: '/tmp/team-source-fixture' },
    addedAt: '2026-11-04T00:00:00.000Z',
    status: {
      lastSuccessfulRelease: null,
      lastCheckedAt: null,
      lastErrorCode: null,
      withdrawnReleases: [],
      announcements: [],
      resources: {},
      credentialConflicts: [],
      skippedProviders: []
    }
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

class FakeAuthStorage implements TeamSourceAuthStorage {
  readonly #rows = new Map<
    string,
    Array<{ id: number; credential: { type: 'api_key'; key: string } }>
  >()
  #nextId = 1
  readonly #externalSources = new Map<
    string,
    'runtime' | 'environment' | 'models_json_key' | 'models_json_command'
  >()
  logoutCalls = 0

  readonly credentials = {
    list: (provider?: string) => {
      if (provider) {
        return (this.#rows.get(provider) ?? []).map((row) => ({ provider, ...row }))
      }
      return [...this.#rows].flatMap(([storedProvider, rows]) =>
        rows.map((row) => ({ provider: storedProvider, ...row }))
      )
    },
    upsert: async (provider: string, credential: { type: 'api_key'; key: string }) => {
      const rows = this.#rows.get(provider) ?? []
      const existing = rows.find((row) => row.credential.key === credential.key)
      const row = existing ?? { id: this.#nextId++, credential }
      this.#rows.set(provider, existing ? rows : [...rows, row])
      return (this.#rows.get(provider) ?? []).map((stored) => ({ provider, ...stored }))
    },
    set: async (provider: string, credential: { type: 'api_key'; key: string }) => {
      const existing = this.#rows.get(provider)?.[0]
      this.#rows.set(provider, [
        existing ? { ...existing, credential } : { id: this.#nextId++, credential }
      ])
    },
    removeById: async (provider: string, id: number) => {
      const rows = this.#rows.get(provider) ?? []
      const remaining = rows.filter((row) => row.id !== id)
      if (remaining.length === rows.length) return false
      if (remaining.length === 0) this.#rows.delete(provider)
      else this.#rows.set(provider, remaining)
      return true
    }
  }

  getProviders(): Array<{ id: string; name: string }> {
    return ['openai', 'anthropic', 'google'].map((id) => ({ id, name: id }))
  }

  getProviderAuthStatus(providerId: string): {
    configured: boolean
    source?: 'stored' | 'runtime' | 'environment' | 'models_json_key' | 'models_json_command'
  } {
    const externalSource = this.#externalSources.get(providerId)
    if (externalSource) return { configured: true, source: externalSource }
    return this.#rows.has(providerId)
      ? { configured: true, source: 'stored' }
      : { configured: false }
  }

  async listCredentials(): Promise<
    Array<{
      id: string
      providerId: string
      type: 'api_key'
      label: string
      keySha256: string
    }>
  > {
    return [...this.#rows].flatMap(([providerId, rows]) =>
      rows.map((row) => ({
        id: String(row.id),
        providerId,
        type: row.credential.type,
        label: providerId,
        keySha256: createHash('sha256').update(row.credential.key).digest('hex')
      }))
    )
  }

  async login(
    providerId: string,
    type: 'api_key' | 'oauth',
    interaction: Parameters<TeamSourceAuthStorage['login']>[2]
  ): Promise<void> {
    assert.equal(type, 'api_key')
    const key = await interaction.prompt({ type: 'secret', message: '' })
    await this.credentials.set(providerId, { type: 'api_key', key })
  }

  async logout(providerId: string): Promise<void> {
    this.logoutCalls += 1
    this.#rows.delete(providerId)
  }

  configureExternal(
    providerId: string,
    source: 'runtime' | 'environment' | 'models_json_key' | 'models_json_command'
  ): void {
    this.#externalSources.set(providerId, source)
  }

  key(provider: string): string | undefined {
    return this.#rows.get(provider)?.[0]?.credential.key
  }

  keysFor(provider: string): string[] {
    return (this.#rows.get(provider) ?? []).map((row) => row.credential.key)
  }
}
