import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { TeamPackError, type TeamPackErrorCode } from '../src/main/agent/team-pack/errors'
import {
  createMemberKeys,
  createTeamKeys,
  readMemberKeys,
  readTeamKeys,
  writeMemberKeys,
  writeTeamKeys
} from '../src/main/agent/team-pack/keys'
import { publishTeamRelease } from '../src/main/agent/team-pack/publish'
import { pullTeamRelease } from '../src/main/agent/team-pack/pull'
import { DirectoryTeamPackStore, HttpTeamPackStore } from '../src/main/agent/team-pack/store'
import {
  installPulledSkill,
  installedSkillPath,
  TEAM_ID,
  writeSkillRegistry
} from './team-pack-fixtures'

const roots: string[] = []

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

test('three members install v1; a removed member cannot decrypt v2 and keeps v1', async () => {
  const root = sandbox('release')
  const registryDir = join(root, 'registry')
  const storeDir = join(root, 'store')
  const keyDir = join(root, 'keys')
  const team = createTeamKeys({ teamId: TEAM_ID, name: 'Alpha Team' })
  const members = await Promise.all([createMemberKeys(), createMemberKeys(), createMemberKeys()])
  const outsider = await createMemberKeys()

  mkdirSync(keyDir, { recursive: true })
  const teamKeyPath = join(keyDir, 'team.json')
  writeTeamKeys(teamKeyPath, team)
  assert.equal(statSync(teamKeyPath).mode & 0o777, 0o600)
  assert.deepEqual(readTeamKeys(teamKeyPath), team)
  for (const [index, member] of members.entries()) {
    const path = join(keyDir, `member-${index}.json`)
    writeMemberKeys(path, member)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.deepEqual(await readMemberKeys(path), member)
  }

  writeSkillRegistry(registryDir, '1.0.0')
  await publishTeamRelease({
    storeDir,
    team,
    members: members.map((member) => member.recipient),
    registryDir,
    createdAt: '2026-10-24T01:00:00.000Z'
  })
  const store = new DirectoryTeamPackStore(storeDir)
  for (const [index, member] of members.entries()) {
    const pull = await pullTeamRelease({
      store,
      teamKeyId: team.keyId,
      identity: member.identity,
      stateDir: join(root, `state-${index}`)
    })
    assert.equal(pull.status, 'updated')
    assert.equal(pull.release, 1)
    const agentDir = join(root, `agent-${index}`)
    await installPulledSkill(pull, agentDir)
    assert.match(readFileSync(installedSkillPath(agentDir, '1.0.0'), 'utf8'), /Shared 1\.0\.0/)
  }

  const outsiderError = await expectCode(
    pullTeamRelease({
      store,
      teamKeyId: team.keyId,
      identity: outsider.identity,
      stateDir: join(root, 'outsider-state')
    }),
    'NOT_A_MEMBER'
  )
  assert.equal(outsiderError.message.includes(outsider.identity), false)

  writeSkillRegistry(registryDir, '2.0.0')
  await publishTeamRelease({
    storeDir,
    team,
    members: members.slice(0, 2).map((member) => member.recipient),
    registryDir,
    createdAt: '2026-10-24T02:00:00.000Z',
    revoked: [1]
  })
  for (let index = 0; index < 2; index++) {
    const pull = await pullTeamRelease({
      store,
      teamKeyId: team.keyId,
      identity: members[index].identity,
      stateDir: join(root, `state-${index}`)
    })
    assert.equal(pull.release, 2)
    assert.deepEqual(pull.status === 'updated' ? pull.revoked : [], [1])
  }
  const removedError = await expectCode(
    pullTeamRelease({
      store,
      teamKeyId: team.keyId,
      identity: members[2].identity,
      stateDir: join(root, 'state-2')
    }),
    'NOT_A_MEMBER'
  )
  assert.equal(removedError.message.includes(members[2].identity), false)
  assert.equal(existsSync(installedSkillPath(join(root, 'agent-2'), '1.0.0')), true)
})

test('publication requires recipients and never overwrites an existing release directory', async () => {
  const root = sandbox('immutable')
  const registryDir = join(root, 'registry')
  const storeDir = join(root, 'store')
  const team = createTeamKeys({ teamId: TEAM_ID, name: 'Alpha Team' })
  const member = await createMemberKeys()
  writeSkillRegistry(registryDir, '1.0.0')
  await expectCode(
    publishTeamRelease({ storeDir, team, members: [], registryDir }),
    'INVALID_FORMAT'
  )
  await publishTeamRelease({
    storeDir,
    team,
    members: [member.recipient],
    registryDir,
    createdAt: '2026-10-24T01:00:00.000Z'
  })
  const store = new DirectoryTeamPackStore(storeDir)
  const stateDir = join(root, 'state')
  const first = await pullTeamRelease({
    store,
    teamKeyId: team.keyId,
    identity: member.identity,
    stateDir
  })
  const same = await pullTeamRelease({
    store,
    teamKeyId: team.keyId,
    identity: member.identity,
    stateDir
  })
  assert.equal(first.status, 'updated')
  assert.equal(same.status, 'up-to-date')

  const occupied = join(storeDir, 'releases/2')
  mkdirSync(occupied, { recursive: true })
  await expectCode(
    publishTeamRelease({
      storeDir,
      team,
      members: [member.recipient],
      registryDir,
      createdAt: '2026-10-24T02:00:00.000Z'
    }),
    'INVALID_FORMAT'
  )
  assert.equal(readFileSync(join(storeDir, 'latest.json'), 'utf8').includes('"release": 1'), true)
})

test('members pull and install from static HTTP after publisher keys are deleted', async (t) => {
  const root = sandbox('http')
  const registryDir = join(root, 'registry')
  const storeDir = join(root, 'store')
  const publisherDir = join(root, 'publisher-private')
  const team = createTeamKeys({ teamId: TEAM_ID, name: 'Alpha Team' })
  const member = await createMemberKeys()
  mkdirSync(publisherDir, { recursive: true })
  writeTeamKeys(join(publisherDir, 'team-keys.json'), team)
  writeSkillRegistry(registryDir, '1.0.0')
  await publishTeamRelease({
    storeDir,
    team,
    members: [member.recipient],
    registryDir,
    createdAt: '2026-10-24T03:00:00.000Z'
  })
  rmSync(publisherDir, { recursive: true, force: true })

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
  const store = new HttpTeamPackStore(`http://127.0.0.1:${address.port}/`, { timeoutMs: 2_000 })
  const pull = await pullTeamRelease({
    store,
    teamKeyId: team.keyId,
    identity: member.identity,
    stateDir: join(root, 'member-state')
  })
  await installPulledSkill(pull, join(root, 'member-agent'))
  assert.equal(existsSync(publisherDir), false)
  assert.match(
    readFileSync(installedSkillPath(join(root, 'member-agent'), '1.0.0'), 'utf8'),
    /Shared 1\.0\.0/
  )
})

function sandbox(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `phi-team-pack-${label}-`))
  roots.push(root)
  return root
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
