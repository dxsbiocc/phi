import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { TeamPackError, type TeamPackErrorCode } from '../src/main/agent/team-pack/errors'
import { createMemberKeys } from '../src/main/agent/team-pack/keys'
import {
  addRosterMember,
  listCurrentRosterMembers,
  readTeamRoster,
  recordRosterRelease,
  removeRosterMember,
  TEAM_ROSTER_FILE_NAME,
  type AddRosterMemberInput
} from '../src/main/agent/team-pack/roster'

const roots: string[] = []

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

test('roster adds members, rejects duplicates, and soft-removes members', async () => {
  const root = sandbox('members')
  const firstKeys = await createMemberKeys()
  const secondKeys = await createMemberKeys()
  const first = member('member-1', 'Alice', firstKeys.recipient, '2026-11-04T01:00:00.000Z')
  const second = member('member-2', 'Bob', secondKeys.recipient, '2026-11-04T01:01:00.000Z')

  assert.deepEqual(addRosterMember(root, first), first)
  assert.deepEqual(addRosterMember(root, second), second)
  assert.deepEqual(listCurrentRosterMembers(root), [first, second])

  expectCode(
    () => addRosterMember(root, { ...second, recipient: firstKeys.recipient }),
    'INVALID_FORMAT'
  )
  expectCode(() => addRosterMember(root, { ...first, memberId: 'member-3' }), 'INVALID_FORMAT')

  const removed = removeRosterMember(root, 'member-2', '2026-11-04T02:00:00.000Z')
  assert.deepEqual(removed, { ...second, removedAt: '2026-11-04T02:00:00.000Z' })
  assert.deepEqual(listCurrentRosterMembers(root), [first])
  assert.deepEqual(readTeamRoster(root).members, [first, removed])
  expectCode(
    () => removeRosterMember(root, 'member-2', '2026-11-04T03:00:00.000Z'),
    'INVALID_FORMAT'
  )
})

test('roster records releases with their exact member snapshot and withdrawal state', async () => {
  const root = sandbox('releases')
  const firstKeys = await createMemberKeys()
  const secondKeys = await createMemberKeys()
  addRosterMember(
    root,
    member('member-1', 'Alice', firstKeys.recipient, '2026-11-04T01:00:00.000Z')
  )
  addRosterMember(root, member('member-2', 'Bob', secondKeys.recipient, '2026-11-04T01:00:00.000Z'))

  const firstRelease = {
    release: 1,
    publishedAt: '2026-11-04T02:00:00.000Z',
    memberIds: ['member-1', 'member-2'],
    withdrawn: true
  }
  assert.deepEqual(recordRosterRelease(root, firstRelease), firstRelease)

  removeRosterMember(root, 'member-2', '2026-11-04T03:00:00.000Z')
  const secondRelease = {
    release: 2,
    publishedAt: '2026-11-04T04:00:00.000Z',
    memberIds: ['member-1'],
    withdrawn: false
  }
  assert.deepEqual(recordRosterRelease(root, secondRelease), secondRelease)
  assert.deepEqual(readTeamRoster(root).releases, [firstRelease, secondRelease])

  expectCode(() => recordRosterRelease(root, firstRelease), 'INVALID_FORMAT')
  expectCode(
    () => recordRosterRelease(root, { ...secondRelease, release: 3, memberIds: ['member-2'] }),
    'INVALID_FORMAT'
  )
  expectCode(
    () =>
      recordRosterRelease(root, {
        ...secondRelease,
        release: 3,
        memberIds: ['member-1', 'member-1']
      }),
    'INVALID_FORMAT'
  )
})

test('roster validates fields strictly and leaves the previous atomic file intact on rejection', async () => {
  const root = sandbox('validation')
  const keys = await createMemberKeys()
  const valid = member('member-1', 'Alice', keys.recipient, '2026-11-04T01:00:00.000Z')

  expectCode(
    () =>
      addRosterMember(
        root,
        member('member-1', 'Alice', `age1${'b'.repeat(58)}`, '2026-11-04T01:00:00.000Z')
      ),
    'INVALID_FORMAT'
  )
  const checksumMismatch = `${keys.recipient.slice(0, -1)}${
    keys.recipient.endsWith('q') ? 'p' : 'q'
  }`
  expectCode(
    () => addRosterMember(root, { ...valid, recipient: checksumMismatch }),
    'INVALID_FORMAT'
  )
  expectCode(
    () => addRosterMember(root, { ...valid, displayName: 'x'.repeat(101) }),
    'INVALID_FORMAT'
  )
  expectCode(
    () =>
      addRosterMember(root, {
        ...valid,
        unexpected: true
      } as AddRosterMemberInput),
    'INVALID_FORMAT'
  )

  addRosterMember(root, valid)
  const path = join(root, TEAM_ROSTER_FILE_NAME)
  const before = readFileSync(path, 'utf8')
  expectCode(
    () => addRosterMember(root, { ...valid, memberId: 'member-2', displayName: ' invalid ' }),
    'INVALID_FORMAT'
  )
  assert.equal(readFileSync(path, 'utf8'), before)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.deepEqual(
    readdirSync(root).filter((name) => name.startsWith(`.${TEAM_ROSTER_FILE_NAME}.`)),
    []
  )
})

test('roster persists a versioned, indented JSON format and rejects unknown persisted fields', async () => {
  const root = sandbox('format')
  const keys = await createMemberKeys()
  const input = member('member-1', 'Alice', keys.recipient, '2026-11-04T01:00:00.000Z')
  addRosterMember(root, input)
  recordRosterRelease(root, {
    release: 1,
    publishedAt: '2026-11-04T02:00:00.000Z',
    memberIds: ['member-1'],
    withdrawn: false
  })

  const path = join(root, TEAM_ROSTER_FILE_NAME)
  const expected = {
    version: 1,
    members: [input],
    releases: [
      {
        release: 1,
        publishedAt: '2026-11-04T02:00:00.000Z',
        memberIds: ['member-1'],
        withdrawn: false
      }
    ]
  }
  assert.equal(readFileSync(path, 'utf8'), `${JSON.stringify(expected, null, 2)}\n`)

  writeFileSync(path, `${JSON.stringify({ ...expected, unknown: true })}\n`)
  expectCode(() => readTeamRoster(root), 'INVALID_FORMAT')
})

function member(
  memberId: string,
  displayName: string,
  recipient: string,
  addedAt: string
): AddRosterMemberInput {
  return { memberId, displayName, recipient, addedAt }
}

function sandbox(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `phi-team-pack-roster-${label}-`))
  roots.push(root)
  return root
}

function expectCode(action: () => unknown, code: TeamPackErrorCode): TeamPackError {
  try {
    action()
  } catch (error) {
    assert.ok(error instanceof TeamPackError)
    assert.equal(error.code, code)
    return error
  }
  assert.fail(`expected ${code}`)
}
