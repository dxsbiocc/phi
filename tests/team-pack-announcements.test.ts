import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  jsonBytes,
  parseInnerFile,
  validateAnnouncementText,
  validateTeamAnnouncements,
  validateTeamResourceMap,
  type TeamAnnouncement
} from '../src/main/agent/team-pack/format'
import { createMemberKeys, createTeamKeys } from '../src/main/agent/team-pack/keys'
import { publishTeamRelease } from '../src/main/agent/team-pack/publish'
import { pullTeamRelease } from '../src/main/agent/team-pack/pull'
import {
  readTeamSourcesState,
  teamSourcesPath,
  writeTeamSourcesState
} from '../src/main/agent/team-pack/team-source-storage'
import { DirectoryTeamPackStore } from '../src/main/agent/team-pack/store'
import { SKILL_ID, TEAM_ID, writeSkillRegistry } from './team-pack-fixtures'

const roots: string[] = []

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

test('validates announcement Unicode length, controls, ordering, and legacy inner defaults', () => {
  assert.equal(validateAnnouncementText('第一行\n第二行 😀'), '第一行\n第二行 😀')
  assert.equal(validateAnnouncementText('😀'.repeat(4_000)), '😀'.repeat(4_000))
  for (const invalid of [
    '',
    'tab\t',
    'return\r',
    `delete${String.fromCodePoint(0x7f)}`,
    `c1${String.fromCodePoint(0x85)}`,
    '😀'.repeat(4_001)
  ]) {
    assert.throws(() => validateAnnouncementText(invalid), { code: 'INVALID_FORMAT' })
  }

  const legacy = parseInnerFile(jsonBytes({ version: 1, teamId: TEAM_ID, release: 1 }))
  assert.deepEqual(legacy.announcements, [])
  assert.deepEqual(legacy.resources, {})

  const announcement = (release: number): TeamAnnouncement => ({
    release,
    publishedAt: `2026-11-${String(release).padStart(2, '0')}T01:00:00.000Z`,
    text: `Release ${release}`
  })
  assert.throws(
    () =>
      validateTeamAnnouncements(Array.from({ length: 21 }, (_, index) => announcement(index + 1))),
    { code: 'INVALID_FORMAT' }
  )
  assert.throws(() => validateTeamAnnouncements([announcement(2), announcement(1)]), {
    code: 'INVALID_FORMAT'
  })
  assert.throws(
    () =>
      parseInnerFile(
        jsonBytes({
          version: 1,
          teamId: TEAM_ID,
          release: 1,
          announcements: [announcement(2)],
          resources: {}
        })
      ),
    { code: 'INVALID_FORMAT' }
  )
})

test('strictly validates encrypted resource metadata', () => {
  assert.deepEqual(
    validateTeamResourceMap({
      [`skill:${SKILL_ID}`]: {
        sharing: 'forwardable',
        originalSource: {
          teamId: 'origin-team',
          teamName: 'Origin Team',
          teamKeyId: '0123456789abcdef'
        }
      }
    }),
    {
      [`skill:${SKILL_ID}`]: {
        sharing: 'forwardable',
        originalSource: {
          teamId: 'origin-team',
          teamName: 'Origin Team',
          teamKeyId: '0123456789abcdef'
        }
      }
    }
  )
  for (const invalid of [
    { [`unknown:${SKILL_ID}`]: { sharing: 'team-only' } },
    { 'skill:Bad_Id': { sharing: 'team-only' } },
    { [`skill:${SKILL_ID}`]: { sharing: 'public' } },
    { [`skill:${SKILL_ID}`]: { sharing: 'forwardable', extra: true } },
    {
      [`skill:${SKILL_ID}`]: {
        sharing: 'forwardable',
        originalSource: { teamId: 'origin-team', teamName: 'Origin Team', teamKeyId: 'bad' }
      }
    }
  ]) {
    assert.throws(() => validateTeamResourceMap(invalid), { code: 'INVALID_FORMAT' })
  }
})

test('publishes cumulative encrypted metadata and returns it on skipped and up-to-date pulls', async () => {
  const root = sandbox('round-trip')
  const registryDir = join(root, 'registry')
  const storeDir = join(root, 'store')
  const stateDir = join(root, 'state')
  const team = createTeamKeys({ teamId: TEAM_ID, name: 'Alpha Team' })
  const member = await createMemberKeys()
  const outsider = await createMemberKeys()
  const resources = {
    [`skill:${SKILL_ID}`]: {
      sharing: 'forwardable' as const,
      originalSource: {
        teamId: 'origin-team',
        teamName: 'Origin Team',
        teamKeyId: '0123456789abcdef'
      }
    }
  }
  const announcements: TeamAnnouncement[] = []
  writeSkillRegistry(registryDir, '1.0.0')

  announcements.push({
    release: 1,
    publishedAt: '2026-11-01T01:00:00.000Z',
    text: 'private-announcement-one\nsecond line'
  })
  await publishTeamRelease({
    storeDir,
    team,
    members: [member.recipient],
    registryDir,
    createdAt: announcements[0]!.publishedAt,
    announcements,
    resources
  })
  const store = new DirectoryTeamPackStore(storeDir)
  const first = await pullTeamRelease({
    store,
    teamKeyId: team.keyId,
    identity: member.identity,
    stateDir
  })
  assert.equal(first.status, 'updated')
  assert.deepEqual(first.announcements, announcements)
  assert.deepEqual(first.resources, resources)

  announcements.push({
    release: 2,
    publishedAt: '2026-11-02T01:00:00.000Z',
    text: 'private-announcement-two'
  })
  await publishTeamRelease({
    storeDir,
    team,
    members: [member.recipient],
    registryDir,
    createdAt: announcements[1]!.publishedAt,
    announcements,
    resources
  })
  announcements.push({
    release: 3,
    publishedAt: '2026-11-03T01:00:00.000Z',
    text: 'private-announcement-three'
  })
  await publishTeamRelease({
    storeDir,
    team,
    members: [member.recipient],
    registryDir,
    createdAt: announcements[2]!.publishedAt,
    announcements,
    resources
  })

  const skipped = await pullTeamRelease({
    store,
    teamKeyId: team.keyId,
    identity: member.identity,
    stateDir
  })
  assert.equal(skipped.release, 3)
  assert.deepEqual(skipped.announcements, announcements)
  assert.deepEqual(skipped.resources, resources)

  const current = await pullTeamRelease({
    store,
    teamKeyId: team.keyId,
    identity: member.identity,
    stateDir
  })
  assert.equal(current.status, 'up-to-date')
  assert.deepEqual(current.announcements, announcements)
  assert.deepEqual(current.resources, resources)

  const publicMetadata = [
    readFileSync(join(storeDir, 'team.json'), 'utf8'),
    readFileSync(join(storeDir, 'latest.json'), 'utf8'),
    readFileSync(join(storeDir, 'releases/3/manifest.json'), 'utf8')
  ].join('\n')
  assert.equal(publicMetadata.includes('private-announcement'), false)
  assert.equal(publicMetadata.includes('forwardable'), false)

  await assert.rejects(
    pullTeamRelease({
      store,
      teamKeyId: team.keyId,
      identity: outsider.identity,
      stateDir: join(root, 'outsider-state')
    }),
    { code: 'NOT_A_MEMBER' }
  )

  const payloadPath = join(storeDir, 'releases/3/payload.age')
  const payload = readFileSync(payloadPath)
  payload[Math.floor(payload.length / 2)]! ^= 1
  writeFileSync(payloadPath, payload)
  await assert.rejects(
    pullTeamRelease({ store, teamKeyId: team.keyId, identity: member.identity, stateDir }),
    { code: 'HASH_MISMATCH' }
  )
})

test('migrates legacy team source status defaults and writes the strict new shape', () => {
  const root = sandbox('legacy-status')
  const agentDir = join(root, 'agent')
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(
    teamSourcesPath(agentDir),
    jsonBytes({
      version: 1,
      sources: [
        {
          id: 'source-alpha',
          teamId: TEAM_ID,
          teamName: 'Alpha Team',
          teamKeyId: '0123456789abcdef',
          location: { kind: 'directory', path: join(root, 'store') },
          addedAt: '2026-11-01T00:00:00.000Z',
          status: {
            lastSuccessfulRelease: 1,
            lastCheckedAt: '2026-11-01T01:00:00.000Z',
            lastErrorCode: null,
            withdrawnReleases: [],
            credentialConflicts: [],
            skippedProviders: []
          }
        }
      ],
      credentialOwners: []
    })
  )

  const state = readTeamSourcesState(agentDir)
  assert.deepEqual(state.sources[0]!.status.announcements, [])
  assert.deepEqual(state.sources[0]!.status.resources, {})
  writeTeamSourcesState(agentDir, state)
  const persisted = JSON.parse(readFileSync(teamSourcesPath(agentDir), 'utf8')) as {
    sources: Array<{ status: Record<string, unknown> }>
  }
  assert.deepEqual(persisted.sources[0]!.status.announcements, [])
  assert.deepEqual(persisted.sources[0]!.status.resources, {})

  const invalid = structuredClone(state)
  delete (invalid.sources[0]!.status as unknown as Record<string, unknown>).resources
  assert.throws(() => writeTeamSourcesState(agentDir, invalid), { code: 'INVALID_FORMAT' })
})

function sandbox(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `phi-team-announcements-${label}-`))
  roots.push(root)
  return root
}
