import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { SafeStorageLike } from '../src/main/agent/credentials/credential-store'
import {
  installPackages,
  listInstalledPackages,
  planInstall,
  readRegistry
} from '../src/main/agent/packages/installer'
import {
  ADMIN_PUBLISH_LOCK_FILE,
  TeamPackAdminService
} from '../src/main/agent/team-pack/admin-service'
import {
  ADMIN_MODEL_GRANTS_FILE,
  readAdminModelGrants
} from '../src/main/agent/team-pack/admin-grants'
import { TeamPackError, type TeamPackErrorCode } from '../src/main/agent/team-pack/errors'
import { TEAM_PRIVATE_KEY_FILE } from '../src/main/agent/team-pack/key-store'
import { createMemberKeys } from '../src/main/agent/team-pack/keys'
import { pullTeamRelease } from '../src/main/agent/team-pack/pull'
import { DirectoryTeamPackStore } from '../src/main/agent/team-pack/store'
import { writeTeamSourcesState } from '../src/main/agent/team-pack/team-source-storage'
import { installPulledSkill, installedSkillPath, writeSkillRegistry } from './team-pack-fixtures'

const roots: string[] = []

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

test('creating a team requires backup and importing its backup preserves trust and publish history', async () => {
  const root = sandbox('backup-roundtrip')
  const agentDir = join(root, 'agent')
  const storeDir = join(root, 'store')
  const backupPath = join(root, 'signing-key.age')
  const service = adminService(agentDir)
  await installFixtureSkill(agentDir, root)

  const created = service.createTeam({ name: 'Backup Team', teamId: 'backup-team' })
  assert.equal(created.backupRequired, true)
  assert.match(created.warning, /必须备份/)
  assert.match(created.publicKeyFingerprint, /^[a-f0-9]{16}$/)
  assert.deepEqual(service.listTeams(), [
    {
      teamId: 'backup-team',
      name: 'Backup Team',
      publicKeyFingerprint: created.publicKeyFingerprint
    }
  ])

  const memberKeys = await createMemberKeys()
  service.addMember({
    teamId: created.teamId,
    displayName: 'Member One',
    recipient: memberKeys.recipient
  })
  await service.exportSigningKeyBackup({
    teamId: created.teamId,
    backupPath,
    passphrase: 'a sufficiently long team backup passphrase'
  })
  const first = await service.publishRelease({
    teamId: created.teamId,
    storeDir,
    packages: [{ type: 'skill', id: 'shared-analysis' }]
  })
  const originalTrustRoot = readFileSync(join(storeDir, 'team.json'))

  rmSync(join(agentDir, 'team-pack', 'admin', created.teamId, 'keys', TEAM_PRIVATE_KEY_FILE))
  const restored = await service.importSigningKeyBackup({
    backupPath,
    passphrase: 'a sufficiently long team backup passphrase'
  })
  const second = await service.publishRelease({
    teamId: created.teamId,
    storeDir,
    packages: [{ type: 'skill', id: 'shared-analysis' }]
  })

  assert.equal(restored.publicKeyFingerprint, created.publicKeyFingerprint)
  assert.equal(first.release, 1)
  assert.equal(second.release, 2)
  assert.deepEqual(readFileSync(join(storeDir, 'team.json')), originalTrustRoot)
  assert.equal(service.getTeamSummary(created.teamId).currentMemberCount, 1)
})

test('member administration rejects duplicates and keeps soft-removed members in history', async () => {
  const root = sandbox('members')
  const service = adminService(join(root, 'agent'))
  const team = service.createTeam({ name: 'Members Team', teamId: 'members-team' })
  const [firstKeys, secondKeys] = await Promise.all([createMemberKeys(), createMemberKeys()])
  const first = service.addMember({
    teamId: team.teamId,
    displayName: 'First Member',
    recipient: firstKeys.recipient
  })

  await expectCode(
    () =>
      service.addMember({
        teamId: team.teamId,
        displayName: 'Duplicate Recipient',
        recipient: firstKeys.recipient
      }),
    'INVALID_FORMAT'
  )
  const second = service.addMember({
    teamId: team.teamId,
    displayName: 'Second Member',
    recipient: secondKeys.recipient
  })
  service.removeMember({ teamId: team.teamId, memberId: first.memberId })

  const members = service.listMembers(team.teamId)
  assert.equal(members.length, 2)
  assert.ok(members.find((member) => member.memberId === first.memberId)?.removedAt)
  assert.equal(members.find((member) => member.memberId === second.memberId)?.removedAt, undefined)
  assert.equal(service.getTeamSummary(team.teamId).currentMemberCount, 1)
})

test('prepareRegistry materializes the selected current installed package version', async () => {
  const root = sandbox('prepare')
  const agentDir = join(root, 'agent')
  const service = adminService(agentDir)
  await installFixtureSkill(agentDir, root, '1.0.0')
  const team = service.createTeam({ name: 'Prepare Team', teamId: 'prepare-team' })

  const prepared = service.prepareRegistry({
    teamId: team.teamId,
    packages: [{ type: 'skill', id: 'shared-analysis' }]
  })
  const registry = readRegistry(prepared.registryDir)

  assert.deepEqual(prepared.packages, [{ type: 'skill', id: 'shared-analysis', version: '1.0.0' }])
  assert.deepEqual(prepared.resources, {
    'skill:shared-analysis': { sharing: 'team-only' }
  })
  assert.equal(registry.packages[0]?.id, 'shared-analysis')
  assert.equal(registry.packages[0]?.version, '1.0.0')
})

test('cross-team selections reject team-only resources and preserve the original source when forwarded', async () => {
  const root = sandbox('forwarding')
  const agentDir = join(root, 'agent')
  const service = adminService(agentDir)
  await installFixtureSkill(agentDir, root)
  const installed = listInstalledPackages({ agentDir })[0]
  assert.ok(installed)
  const sourcePath = join(installed.dir, '.source.json')
  const source = JSON.parse(readFileSync(sourcePath, 'utf8')) as Record<string, unknown>
  const immediate = {
    teamId: 'source-team',
    teamName: 'Source Team',
    teamKeyId: '1111111111111111',
    release: 3,
    sharing: 'team-only'
  }
  writeFileSync(sourcePath, `${JSON.stringify({ ...source, teamSource: immediate }, null, 2)}\n`)
  const team = service.createTeam({ name: 'Forwarding Team', teamId: 'forwarding-team' })

  await expectCode(
    () =>
      service.prepareRegistry({
        teamId: team.teamId,
        packages: [{ type: 'skill', id: 'shared-analysis' }]
      }),
    'INVALID_FORMAT'
  )

  writeFileSync(
    sourcePath,
    `${JSON.stringify(
      { ...source, teamSource: { ...immediate, sharing: 'forwardable' } },
      null,
      2
    )}\n`
  )
  const immediateForward = service.prepareRegistry({
    teamId: team.teamId,
    packages: [{ type: 'skill', id: 'shared-analysis' }]
  })
  assert.deepEqual(immediateForward.resources, {
    'skill:shared-analysis': {
      sharing: 'team-only',
      originalSource: {
        teamId: immediate.teamId,
        teamName: immediate.teamName,
        teamKeyId: immediate.teamKeyId
      }
    }
  })

  const originalSource = {
    teamId: 'original-team',
    teamName: 'Original Team',
    teamKeyId: '2222222222222222'
  }
  writeFileSync(
    sourcePath,
    `${JSON.stringify(
      {
        ...source,
        teamSource: { ...immediate, sharing: 'forwardable', originalSource }
      },
      null,
      2
    )}\n`
  )
  const prepared = service.prepareRegistry({
    teamId: team.teamId,
    packages: [{ type: 'skill', id: 'shared-analysis', sharing: 'forwardable' }]
  })

  assert.deepEqual(prepared.resources, {
    'skill:shared-analysis': { sharing: 'forwardable', originalSource }
  })
})

test('legacy team installs use team source state for forwarding validation and provenance', async () => {
  const root = sandbox('forwarding-legacy')
  const agentDir = join(root, 'agent')
  const service = adminService(agentDir)
  await installFixtureSkill(agentDir, root)
  const installed = listInstalledPackages({ agentDir })[0]
  assert.ok(installed)
  const sourcePath = join(installed.dir, '.source.json')
  const source = JSON.parse(readFileSync(sourcePath, 'utf8')) as Record<string, unknown>
  writeFileSync(
    sourcePath,
    `${JSON.stringify({ ...source, registry: 'legacy-team-source' }, null, 2)}\n`
  )
  const originalSource = {
    teamId: 'original-team',
    teamName: 'Original Team',
    teamKeyId: '3333333333333333'
  }
  writeTeamSourcesState(agentDir, {
    version: 1,
    sources: [
      {
        id: 'legacy-team-source',
        teamId: 'relay-team',
        teamName: 'Relay Team',
        teamKeyId: '4444444444444444',
        location: { kind: 'directory', path: join(root, 'relay-store') },
        addedAt: '2026-11-04T00:00:00.000Z',
        status: {
          lastSuccessfulRelease: 4,
          lastCheckedAt: '2026-11-04T00:00:00.000Z',
          lastErrorCode: null,
          withdrawnReleases: [],
          announcements: [],
          resources: {
            'skill:shared-analysis': { sharing: 'forwardable', originalSource }
          },
          credentialConflicts: [],
          skippedProviders: []
        }
      }
    ],
    credentialOwners: []
  })
  const team = service.createTeam({ name: 'Legacy Forwarding', teamId: 'legacy-forwarding' })
  const prepared = service.prepareRegistry({
    teamId: team.teamId,
    packages: [{ type: 'skill', id: 'shared-analysis' }]
  })

  assert.deepEqual(prepared.resources, {
    'skill:shared-analysis': { sharing: 'team-only', originalSource }
  })
})

test('prepareRegistry rejects missing and unsupported package selections clearly', async () => {
  const root = sandbox('prepare-errors')
  const service = adminService(join(root, 'agent'))
  const team = service.createTeam({ name: 'Errors Team', teamId: 'errors-team' })

  const missing = await expectCode(
    () =>
      service.prepareRegistry({
        teamId: team.teamId,
        packages: [{ type: 'skill', id: 'missing-skill' }]
      }),
    'INVALID_FORMAT'
  )
  assert.match(missing.message, /找不到.*skill:missing-skill/)

  const unsupported = await expectCode(
    () =>
      service.prepareRegistry({
        teamId: team.teamId,
        packages: [{ type: 'unsupported', id: 'missing-skill' } as never]
      }),
    'INVALID_FORMAT'
  )
  assert.match(unsupported.message, /不支持/)
})

test('a selected installed package publishes, pulls, and installs through existing APIs', async () => {
  const root = sandbox('publish-install')
  const agentDir = join(root, 'admin-agent')
  const memberAgentDir = join(root, 'member-agent')
  const service = adminService(agentDir)
  await installFixtureSkill(agentDir, root)
  const team = service.createTeam({ name: 'Install Team', teamId: 'install-team' })
  const memberKeys = await createMemberKeys()
  service.addMember({
    teamId: team.teamId,
    displayName: 'Installer',
    recipient: memberKeys.recipient
  })

  const published = await service.publishRelease({
    teamId: team.teamId,
    storeDir: join(root, 'store'),
    packages: [{ type: 'skill', id: 'shared-analysis' }]
  })
  const pulled = await pullTeamRelease({
    store: new DirectoryTeamPackStore(published.storeDir),
    teamKeyId: team.publicKeyFingerprint,
    identity: memberKeys.identity,
    stateDir: join(root, 'member-state')
  })
  await installPulledSkill(pulled, memberAgentDir)

  assert.equal(published.release, 1)
  assert.equal(pulled.release, 1)
  assert.match(readFileSync(installedSkillPath(memberAgentDir, '1.0.0'), 'utf8'), /Shared 1\.0\.0/)
})

test('a removed member receives NOT_A_MEMBER on the next admin publication', async () => {
  const root = sandbox('removed-member')
  const agentDir = join(root, 'admin-agent')
  const storeDir = join(root, 'store')
  const service = adminService(agentDir)
  await installFixtureSkill(agentDir, root)
  const team = service.createTeam({ name: 'Removal Team', teamId: 'removal-team' })
  const [keptKeys, removedKeys] = await Promise.all([createMemberKeys(), createMemberKeys()])
  service.addMember({ teamId: team.teamId, displayName: 'Kept', recipient: keptKeys.recipient })
  const removed = service.addMember({
    teamId: team.teamId,
    displayName: 'Removed',
    recipient: removedKeys.recipient
  })
  await service.publishRelease({
    teamId: team.teamId,
    storeDir,
    packages: [{ type: 'skill', id: 'shared-analysis' }]
  })
  await pullTeamRelease({
    store: new DirectoryTeamPackStore(storeDir),
    teamKeyId: team.publicKeyFingerprint,
    identity: removedKeys.identity,
    stateDir: join(root, 'removed-state')
  })

  service.removeMember({ teamId: team.teamId, memberId: removed.memberId })
  await service.publishRelease({
    teamId: team.teamId,
    storeDir,
    packages: [{ type: 'skill', id: 'shared-analysis' }]
  })

  await expectCode(
    () =>
      pullTeamRelease({
        store: new DirectoryTeamPackStore(storeDir),
        teamKeyId: team.publicKeyFingerprint,
        identity: removedKeys.identity,
        stateDir: join(root, 'removed-state')
      }),
    'NOT_A_MEMBER'
  )
})

test('model grants reach only the selected member and never persist as admin plaintext', async () => {
  const root = sandbox('grants')
  const agentDir = join(root, 'admin-agent')
  const storeDir = join(root, 'store')
  const service = adminService(agentDir)
  await installFixtureSkill(agentDir, root)
  const team = service.createTeam({ name: 'Grant Team', teamId: 'grant-team' })
  const [firstKeys, secondKeys] = await Promise.all([createMemberKeys(), createMemberKeys()])
  const first = service.addMember({
    teamId: team.teamId,
    displayName: 'First',
    recipient: firstKeys.recipient
  })
  const second = service.addMember({
    teamId: team.teamId,
    displayName: 'Second',
    recipient: secondKeys.recipient
  })
  const firstSecret = 'sk-admin-test-first-secret'
  const secondSecret = 'sk-admin-test-second-secret'

  await service.publishRelease({
    teamId: team.teamId,
    storeDir,
    packages: [{ type: 'skill', id: 'shared-analysis' }],
    grants: [
      {
        memberId: first.memberId,
        models: [{ providerId: 'openai', label: 'First Model', apiKey: firstSecret }]
      },
      {
        memberId: second.memberId,
        models: [{ providerId: 'anthropic', label: 'Second Model', apiKey: secondSecret }]
      }
    ]
  })

  const [firstPull, secondPull] = await Promise.all(
    [firstKeys, secondKeys].map((keys, index) =>
      pullTeamRelease({
        store: new DirectoryTeamPackStore(storeDir),
        teamKeyId: team.publicKeyFingerprint,
        identity: keys.identity,
        stateDir: join(root, `state-${index}`)
      })
    )
  )
  assert.deepEqual(firstPull.models, [
    { providerId: 'openai', label: 'First Model', apiKey: firstSecret }
  ])
  assert.deepEqual(secondPull.models, [
    { providerId: 'anthropic', label: 'Second Model', apiKey: secondSecret }
  ])
  const adminDir = join(agentDir, 'team-pack', 'admin')
  assert.equal(directoryContains(adminDir, firstSecret), false)
  assert.equal(directoryContains(adminDir, secondSecret), false)
  assert.equal(directoryContains(storeDir, firstSecret), false)
  assert.equal(directoryContains(storeDir, secondSecret), false)
})

test('saved model grants survive consecutive publications and withdrawal publications', async () => {
  const root = sandbox('grant-continuity')
  const agentDir = join(root, 'admin-agent')
  const storeDir = join(root, 'store')
  const service = adminService(agentDir)
  await installFixtureSkill(agentDir, root)
  const team = service.createTeam({ name: 'Grant Continuity', teamId: 'grant-continuity' })
  const memberKeys = await createMemberKeys()
  const member = service.addMember({
    teamId: team.teamId,
    displayName: 'Member',
    recipient: memberKeys.recipient
  })
  const apiKey = 'sk-admin-continuity-secret'

  await service.publishRelease({
    teamId: team.teamId,
    storeDir,
    packages: [{ type: 'skill', id: 'shared-analysis' }],
    grants: [
      {
        memberId: member.memberId,
        models: [{ providerId: 'openai', label: 'Continuity', apiKey }]
      }
    ]
  })
  await service.publishRelease({
    teamId: team.teamId,
    storeDir,
    packages: [{ type: 'skill', id: 'shared-analysis' }]
  })
  const second = await pullTeamRelease({
    store: new DirectoryTeamPackStore(storeDir),
    teamKeyId: team.publicKeyFingerprint,
    identity: memberKeys.identity,
    stateDir: join(root, 'state-second')
  })

  await service.withdrawRelease({ teamId: team.teamId, release: 1 })
  const withdrawn = await pullTeamRelease({
    store: new DirectoryTeamPackStore(storeDir),
    teamKeyId: team.publicKeyFingerprint,
    identity: memberKeys.identity,
    stateDir: join(root, 'state-withdrawn')
  })

  const expected = [{ providerId: 'openai', label: 'Continuity', apiKey }]
  assert.deepEqual(second.models, expected)
  assert.deepEqual(withdrawn.models, expected)
  assert.deepEqual(withdrawn.withdrawnReleases, [1])
})

test('announcement-only releases reuse resources and grants while retaining the latest 20 announcements', async () => {
  const root = sandbox('announcement-only')
  const agentDir = join(root, 'admin-agent')
  const storeDir = join(root, 'store')
  const service = adminService(agentDir)
  await installFixtureSkill(agentDir, root)
  const team = service.createTeam({ name: 'Announcements', teamId: 'announcement-team' })
  const memberKeys = await createMemberKeys()
  const member = service.addMember({
    teamId: team.teamId,
    displayName: 'Member',
    recipient: memberKeys.recipient
  })
  const apiKey = 'sk-announcement-continuity'
  const first = await service.publishRelease({
    teamId: team.teamId,
    storeDir,
    packages: [{ type: 'skill', id: 'shared-analysis', sharing: 'forwardable' }],
    announcement: 'announcement 1',
    grants: [
      {
        memberId: member.memberId,
        models: [{ providerId: 'openai', label: 'Announcement Model', apiKey }]
      }
    ]
  })
  const firstSnapshot = readFileSync(
    join(agentDir, 'team-pack', 'admin', team.teamId, 'registry-snapshots', '1', 'index.json')
  )

  let latest = first
  for (let release = 2; release <= 21; release++) {
    latest = await service.publishRelease({
      teamId: team.teamId,
      storeDir,
      packages: [],
      announcement: `announcement ${release}`,
      announcementOnly: true
    })
  }
  const latestSnapshot = readFileSync(
    join(agentDir, 'team-pack', 'admin', team.teamId, 'registry-snapshots', '21', 'index.json')
  )
  const pulled = await pullTeamRelease({
    store: new DirectoryTeamPackStore(storeDir),
    teamKeyId: team.publicKeyFingerprint,
    identity: memberKeys.identity,
    stateDir: join(root, 'member-state')
  })

  assert.equal(latest.release, 21)
  assert.deepEqual(latest.packages, first.packages)
  assert.deepEqual(latestSnapshot, firstSnapshot)
  assert.deepEqual(pulled.resources, {
    'skill:shared-analysis': { sharing: 'forwardable' }
  })
  assert.deepEqual(pulled.models, [{ providerId: 'openai', label: 'Announcement Model', apiKey }])
  assert.equal(pulled.announcements.length, 20)
  assert.equal(pulled.announcements[0]?.release, 2)
  assert.equal(pulled.announcements[19]?.release, 21)
  assert.equal(
    service.getTeamSummary(team.teamId).releases.every((release) => release.hasAnnouncement),
    true
  )
})

test('model grant management replaces and deletes providers without exposing secrets', async () => {
  const root = sandbox('grant-management')
  const agentDir = join(root, 'admin-agent')
  const storeDir = join(root, 'store')
  const service = adminService(agentDir)
  await installFixtureSkill(agentDir, root)
  const team = service.createTeam({ name: 'Grant Management', teamId: 'grant-management' })
  const memberKeys = await createMemberKeys()
  const member = service.addMember({
    teamId: team.teamId,
    displayName: 'Member',
    recipient: memberKeys.recipient
  })
  const openAiKey = 'sk-admin-managed-openai'
  const anthropicKey = 'sk-admin-managed-anthropic'
  const googleKey = 'sk-admin-managed-google'

  service.setMemberModelGrants({
    teamId: team.teamId,
    memberId: member.memberId,
    models: [
      {
        providerId: 'openai',
        label: 'OpenAI',
        apiKey: openAiKey,
        baseUrl: 'https://models.example.test/v1'
      },
      { providerId: 'anthropic', label: 'Anthropic', apiKey: anthropicKey }
    ]
  })
  const metadata = service.listMemberModelGrants(team.teamId)
  assert.deepEqual(metadata, [
    {
      memberId: member.memberId,
      models: [
        { providerId: 'openai', label: 'OpenAI' },
        { providerId: 'anthropic', label: 'Anthropic' }
      ]
    }
  ])
  const publicSummary = JSON.stringify(service.getTeamSummary(team.teamId))
  assert.equal(publicSummary.includes(openAiKey), false)
  assert.equal(publicSummary.includes('https://models.example.test/v1'), false)
  const grantFile = join(agentDir, 'team-pack', 'admin', team.teamId, ADMIN_MODEL_GRANTS_FILE)
  assert.equal(statSync(grantFile).mode & 0o777, 0o600)

  await service.publishRelease({
    teamId: team.teamId,
    storeDir,
    packages: [{ type: 'skill', id: 'shared-analysis' }]
  })
  service.deleteMemberModelGrants({
    teamId: team.teamId,
    memberId: member.memberId,
    providerId: 'openai'
  })
  await service.publishRelease({
    teamId: team.teamId,
    storeDir,
    packages: [{ type: 'skill', id: 'shared-analysis' }]
  })
  const afterDelete = await pullTeamRelease({
    store: new DirectoryTeamPackStore(storeDir),
    teamKeyId: team.publicKeyFingerprint,
    identity: memberKeys.identity,
    stateDir: join(root, 'state-delete')
  })
  assert.deepEqual(afterDelete.models, [
    { providerId: 'anthropic', label: 'Anthropic', apiKey: anthropicKey }
  ])

  service.setMemberModelGrants({
    teamId: team.teamId,
    memberId: member.memberId,
    models: [{ providerId: 'google', label: 'Google', apiKey: googleKey }]
  })
  await service.publishRelease({
    teamId: team.teamId,
    storeDir,
    packages: [{ type: 'skill', id: 'shared-analysis' }]
  })
  const afterReplace = await pullTeamRelease({
    store: new DirectoryTeamPackStore(storeDir),
    teamKeyId: team.publicKeyFingerprint,
    identity: memberKeys.identity,
    stateDir: join(root, 'state-replace')
  })
  assert.deepEqual(afterReplace.models, [
    { providerId: 'google', label: 'Google', apiKey: googleKey }
  ])
  assert.deepEqual(
    service.deleteMemberModelGrants({ teamId: team.teamId, memberId: member.memberId }),
    { memberId: member.memberId, models: [] }
  )
})

test('publish grant updates preserve other members and commit only after publication succeeds', async () => {
  const root = sandbox('grant-publish-transaction')
  const agentDir = join(root, 'admin-agent')
  const storeDir = join(root, 'store')
  const safeStorage = new FakeSafeStorage()
  const service = adminService(agentDir, { safeStorage })
  await installFixtureSkill(agentDir, root)
  const team = service.createTeam({ name: 'Grant Transaction', teamId: 'grant-transaction' })
  const [firstKeys, secondKeys] = await Promise.all([createMemberKeys(), createMemberKeys()])
  const first = service.addMember({
    teamId: team.teamId,
    displayName: 'First',
    recipient: firstKeys.recipient
  })
  const second = service.addMember({
    teamId: team.teamId,
    displayName: 'Second',
    recipient: secondKeys.recipient
  })
  const firstOriginal = 'sk-admin-first-original'
  const firstRejected = 'sk-admin-first-rejected'
  const secondOriginal = 'sk-admin-second-original'

  await service.publishRelease({
    teamId: team.teamId,
    storeDir,
    packages: [{ type: 'skill', id: 'shared-analysis' }],
    grants: [
      {
        memberId: first.memberId,
        models: [{ providerId: 'openai', label: 'First Original', apiKey: firstOriginal }]
      },
      {
        memberId: second.memberId,
        models: [{ providerId: 'anthropic', label: 'Second Original', apiKey: secondOriginal }]
      }
    ]
  })

  const latestPath = join(storeDir, 'latest.json')
  const latest = readFileSync(latestPath)
  writeFileSync(latestPath, '{}\n')
  await expectCode(
    () =>
      service.publishRelease({
        teamId: team.teamId,
        storeDir,
        packages: [{ type: 'skill', id: 'shared-analysis' }],
        grants: [
          {
            memberId: first.memberId,
            models: [{ providerId: 'openai', label: 'Rejected', apiKey: firstRejected }]
          }
        ]
      }),
    'INVALID_FORMAT'
  )
  writeFileSync(latestPath, latest)
  assert.deepEqual(
    service.listMemberModelGrants(team.teamId).find((entry) => entry.memberId === first.memberId)
      ?.models,
    [{ providerId: 'openai', label: 'First Original' }]
  )

  safeStorage.failEncryption = true
  await expectCode(
    () =>
      service.publishRelease({
        teamId: team.teamId,
        storeDir,
        packages: [{ type: 'skill', id: 'shared-analysis' }],
        grants: [
          {
            memberId: first.memberId,
            models: [{ providerId: 'openai', label: 'Rejected', apiKey: firstRejected }]
          }
        ]
      }),
    'STORE_UNAVAILABLE'
  )
  safeStorage.failEncryption = false
  assert.deepEqual(readFileSync(latestPath), latest)

  await service.publishRelease({
    teamId: team.teamId,
    storeDir,
    packages: [{ type: 'skill', id: 'shared-analysis' }],
    grants: [
      {
        memberId: first.memberId,
        models: [{ providerId: 'openai', label: 'First Original', apiKey: firstOriginal }]
      }
    ]
  })
  const [firstPull, secondPull] = await Promise.all([
    pullTeamRelease({
      store: new DirectoryTeamPackStore(storeDir),
      teamKeyId: team.publicKeyFingerprint,
      identity: firstKeys.identity,
      stateDir: join(root, 'state-first')
    }),
    pullTeamRelease({
      store: new DirectoryTeamPackStore(storeDir),
      teamKeyId: team.publicKeyFingerprint,
      identity: secondKeys.identity,
      stateDir: join(root, 'state-second')
    })
  ])
  assert.equal(firstPull.models[0]?.apiKey, firstOriginal)
  assert.equal(secondPull.models[0]?.apiKey, secondOriginal)
})

test('removing a member deletes saved grants and returns a provider revocation warning', async () => {
  const root = sandbox('grant-remove-member')
  const agentDir = join(root, 'admin-agent')
  const storeDir = join(root, 'store')
  const safeStorage = new FakeSafeStorage()
  const service = adminService(agentDir, { safeStorage })
  await installFixtureSkill(agentDir, root)
  const team = service.createTeam({ name: 'Grant Removal', teamId: 'grant-removal' })
  const [keptKeys, removedKeys] = await Promise.all([createMemberKeys(), createMemberKeys()])
  service.addMember({ teamId: team.teamId, displayName: 'Kept', recipient: keptKeys.recipient })
  const removed = service.addMember({
    teamId: team.teamId,
    displayName: 'Removed',
    recipient: removedKeys.recipient
  })
  service.setMemberModelGrants({
    teamId: team.teamId,
    memberId: removed.memberId,
    models: [{ providerId: 'openai', label: 'Removed', apiKey: 'sk-admin-removed' }]
  })

  const result = service.removeMember({ teamId: team.teamId, memberId: removed.memberId })
  assert.match(result.modelKeyRevocationWarning, /服务商后台吊销/)
  const teamDirectory = join(agentDir, 'team-pack', 'admin', team.teamId)
  assert.deepEqual(readAdminModelGrants(teamDirectory, safeStorage), [])

  await service.publishRelease({
    teamId: team.teamId,
    storeDir,
    packages: [{ type: 'skill', id: 'shared-analysis' }]
  })
  await expectCode(
    () =>
      pullTeamRelease({
        store: new DirectoryTeamPackStore(storeDir),
        teamKeyId: team.publicKeyFingerprint,
        identity: removedKeys.identity,
        stateDir: join(root, 'removed-state')
      }),
    'NOT_A_MEMBER'
  )
})

test('withdrawRelease republishes the latest content with cumulative withdrawal state', async () => {
  const root = sandbox('withdraw')
  const agentDir = join(root, 'admin-agent')
  const service = adminService(agentDir)
  await installFixtureSkill(agentDir, root)
  const team = service.createTeam({ name: 'Withdraw Team', teamId: 'withdraw-team' })
  const memberKeys = await createMemberKeys()
  service.addMember({
    teamId: team.teamId,
    displayName: 'Member',
    recipient: memberKeys.recipient
  })
  await service.publishRelease({
    teamId: team.teamId,
    storeDir: join(root, 'store'),
    packages: [{ type: 'skill', id: 'shared-analysis' }],
    announcement: 'Before withdrawal'
  })

  const withdrawn = await service.withdrawRelease({ teamId: team.teamId, release: 1 })
  const summary = service.getTeamSummary(team.teamId)
  const pulled = await pullTeamRelease({
    store: new DirectoryTeamPackStore(withdrawn.storeDir),
    teamKeyId: team.publicKeyFingerprint,
    identity: memberKeys.identity,
    stateDir: join(root, 'member-state')
  })

  assert.equal(withdrawn.release, 2)
  assert.deepEqual(withdrawn.withdrawnReleases, [1])
  assert.deepEqual(pulled.withdrawnReleases, [1])
  assert.deepEqual(pulled.announcements, [
    {
      release: 1,
      publishedAt: summary.releases[0]?.publishedAt,
      text: 'Before withdrawal'
    }
  ])
  assert.equal(summary.latestRelease, 2)
  assert.deepEqual(
    summary.releases.map(({ release, withdrawn: value, hasAnnouncement }) => [
      release,
      value,
      hasAnnouncement
    ]),
    [
      [1, true, true],
      [2, false, false]
    ]
  )
})

test('concurrent publications for one team are serialized into consecutive releases', async () => {
  const root = sandbox('publish-concurrency')
  const agentDir = join(root, 'admin-agent')
  const storeDir = join(root, 'store')
  const service = adminService(agentDir)
  await installFixtureSkill(agentDir, root)
  const team = service.createTeam({ name: 'Queue Team', teamId: 'queue-team' })
  const memberKeys = await createMemberKeys()
  service.addMember({
    teamId: team.teamId,
    displayName: 'Member',
    recipient: memberKeys.recipient
  })

  const releases = await Promise.all(
    [0, 1].map(() =>
      service.publishRelease({
        teamId: team.teamId,
        storeDir,
        packages: [{ type: 'skill', id: 'shared-analysis' }]
      })
    )
  )

  assert.deepEqual(
    releases.map((release) => release.release).sort((left, right) => left - right),
    [1, 2]
  )
  assert.deepEqual(
    service.getTeamSummary(team.teamId).releases.map((release) => release.release),
    [1, 2]
  )
  assert.equal(existsSync(join(storeDir, ADMIN_PUBLISH_LOCK_FILE)), false)
})

test('a managed team keeps one canonical publication directory', async () => {
  const root = sandbox('canonical-store')
  const agentDir = join(root, 'admin-agent')
  const firstStore = join(root, 'first-store')
  const secondStore = join(root, 'second-store')
  const service = adminService(agentDir)
  await installFixtureSkill(agentDir, root)
  const team = service.createTeam({ name: 'Store Team', teamId: 'store-team' })
  const memberKeys = await createMemberKeys()
  service.addMember({
    teamId: team.teamId,
    displayName: 'Member',
    recipient: memberKeys.recipient
  })
  await service.publishRelease({
    teamId: team.teamId,
    storeDir: firstStore,
    packages: [{ type: 'skill', id: 'shared-analysis' }]
  })

  const error = await expectCode(
    () =>
      service.publishRelease({
        teamId: team.teamId,
        storeDir: secondStore,
        packages: [{ type: 'skill', id: 'shared-analysis' }]
      }),
    'INVALID_FORMAT'
  )

  assert.match(error.message, /不能切换发布规范副本目录/)
  assert.equal(service.getTeamSummary(team.teamId).latestRelease, 1)
  assert.equal(existsSync(join(secondStore, 'latest.json')), false)
})

test('publishRelease recovers a stale on-disk lock before publishing', async () => {
  const root = sandbox('stale-lock')
  const agentDir = join(root, 'admin-agent')
  const storeDir = join(root, 'store')
  const service = adminService(agentDir, {
    lockWaitMs: 20,
    lockRetryMs: 1,
    staleLockMs: 1_000
  })
  await installFixtureSkill(agentDir, root)
  const team = service.createTeam({ name: 'Stale Team', teamId: 'stale-team' })
  const memberKeys = await createMemberKeys()
  service.addMember({
    teamId: team.teamId,
    displayName: 'Member',
    recipient: memberKeys.recipient
  })
  mkdirSync(storeDir, { recursive: true })
  const lockPath = join(storeDir, ADMIN_PUBLISH_LOCK_FILE)
  writeFileSync(lockPath, 'crashed publisher\n')
  const staleTime = new Date(Date.now() - 60_000)
  utimesSync(lockPath, staleTime, staleTime)

  const published = await service.publishRelease({
    teamId: team.teamId,
    storeDir,
    packages: [{ type: 'skill', id: 'shared-analysis' }]
  })

  assert.equal(published.release, 1)
  assert.equal(existsSync(lockPath), false)
})

test('createTeam rejects unavailable SafeStorage without writing plaintext secrets', async () => {
  const root = sandbox('safe-storage-unavailable')
  const agentDir = join(root, 'agent')
  const service = new TeamPackAdminService({
    agentDir,
    safeStorage: new FakeSafeStorage(false)
  })

  await expectCode(
    () => service.createTeam({ name: 'Unavailable Team', teamId: 'unavailable-team' }),
    'STORE_UNAVAILABLE'
  )
  assert.equal(directoryContains(join(agentDir, 'team-pack', 'admin'), 'PRIVATE KEY'), false)
})

test('setting model grants rejects unavailable SafeStorage and writes no plaintext', async () => {
  const root = sandbox('grant-safe-storage-unavailable')
  const agentDir = join(root, 'agent')
  const available = adminService(agentDir)
  const team = available.createTeam({ name: 'Unavailable Grants', teamId: 'unavailable-grants' })
  const memberKeys = await createMemberKeys()
  const member = available.addMember({
    teamId: team.teamId,
    displayName: 'Member',
    recipient: memberKeys.recipient
  })
  const unavailable = new TeamPackAdminService({
    agentDir,
    safeStorage: new FakeSafeStorage(false)
  })
  const secret = 'sk-admin-must-not-be-written'

  await expectCode(
    () =>
      unavailable.setMemberModelGrants({
        teamId: team.teamId,
        memberId: member.memberId,
        models: [{ providerId: 'openai', label: 'Unavailable', apiKey: secret }]
      }),
    'STORE_UNAVAILABLE'
  )
  const teamDirectory = join(agentDir, 'team-pack', 'admin', team.teamId)
  assert.equal(existsSync(join(teamDirectory, ADMIN_MODEL_GRANTS_FILE)), false)
  assert.equal(directoryContains(teamDirectory, secret), false)
})

class FakeSafeStorage implements SafeStorageLike {
  failEncryption = false

  constructor(private readonly available = true) {}

  isEncryptionAvailable(): boolean {
    return this.available
  }

  encryptString(plainText: string): Buffer {
    if (!this.available) throw new Error('unavailable')
    if (this.failEncryption) throw new Error('injected encryption failure')
    const input = Buffer.from(plainText)
    const encrypted = Buffer.alloc(input.length + 4)
    encrypted.set([0x50, 0x48, 0x49, 0x01])
    for (let index = 0; index < input.length; index++) encrypted[index + 4] = input[index] ^ 0xa5
    return encrypted
  }

  decryptString(encrypted: Buffer): string {
    if (!this.available) throw new Error('unavailable')
    if (!encrypted.subarray(0, 4).equals(Buffer.from([0x50, 0x48, 0x49, 0x01]))) {
      throw new Error('invalid ciphertext')
    }
    const plaintext = Buffer.alloc(encrypted.length - 4)
    for (let index = 4; index < encrypted.length; index++) {
      plaintext[index - 4] = encrypted[index] ^ 0xa5
    }
    return plaintext.toString('utf8')
  }
}

function adminService(
  agentDir: string,
  options: {
    lockWaitMs?: number
    lockRetryMs?: number
    staleLockMs?: number
    safeStorage?: SafeStorageLike
  } = {}
): TeamPackAdminService {
  let tick = 0
  const { safeStorage = new FakeSafeStorage(), ...serviceOptions } = options
  return new TeamPackAdminService({
    agentDir,
    safeStorage,
    now: () => new Date(Date.UTC(2026, 10, 4, 0, 0, tick++)),
    ...serviceOptions
  })
}

function sandbox(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `phi-team-admin-${label}-`))
  roots.push(root)
  return root
}

async function installFixtureSkill(
  agentDir: string,
  root: string,
  version = '1.0.0'
): Promise<void> {
  const sourceRegistryDir = join(root, `source-registry-${version}`)
  writeSkillRegistry(sourceRegistryDir, version)
  const source = readRegistry(sourceRegistryDir)
  await installPackages(
    planInstall(source, { type: 'skill', id: 'shared-analysis' }, { agentDir }),
    { agentDir }
  )
  assert.ok(
    listInstalledPackages({ agentDir }).some(
      (item) => item.type === 'skill' && item.id === 'shared-analysis' && item.version === version
    )
  )
}

function directoryContains(directory: string, text: string): boolean {
  if (!existsSync(directory)) return false
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      if (directoryContains(path, text)) return true
    } else if (readFileSync(path).includes(Buffer.from(text))) {
      return true
    }
  }
  return false
}

async function expectCode(
  action: () => unknown | Promise<unknown>,
  code: TeamPackErrorCode
): Promise<TeamPackError> {
  try {
    await action()
  } catch (error) {
    assert.ok(error instanceof TeamPackError)
    assert.equal(error.code, code)
    return error
  }
  assert.fail(`expected ${code}`)
}
