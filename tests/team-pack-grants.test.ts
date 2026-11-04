import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { TeamPackError, type TeamPackErrorCode } from '../src/main/agent/team-pack/errors'
import { createMemberKeys, createTeamKeys } from '../src/main/agent/team-pack/keys'
import { publishTeamRelease } from '../src/main/agent/team-pack/publish'
import { pullTeamRelease } from '../src/main/agent/team-pack/pull'
import { DirectoryTeamPackStore } from '../src/main/agent/team-pack/store'
import { readJson, TEAM_ID, writeSkillRegistry } from './team-pack-fixtures'

const roots: string[] = []

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

test('model key grants are delivered only to their recipient and omitted grants yield an empty list', async () => {
  const root = sandbox('delivery')
  const registryDir = join(root, 'registry')
  const storeDir = join(root, 'store')
  const team = createTeamKeys({ teamId: TEAM_ID, name: 'Alpha Team' })
  const [first, second, withoutGrant] = await Promise.all([
    createMemberKeys(),
    createMemberKeys(),
    createMemberKeys()
  ])
  writeSkillRegistry(registryDir, '1.0.0')

  await publishTeamRelease({
    storeDir,
    team,
    members: [first.recipient, second.recipient, withoutGrant.recipient],
    grants: [
      {
        recipient: first.recipient,
        models: [
          {
            providerId: 'openai',
            label: 'Team OpenAI',
            apiKey: 'sk-first-secret',
            baseUrl: 'https://api.openai.example/v1'
          }
        ]
      },
      {
        recipient: second.recipient,
        models: [{ providerId: 'anthropic', label: 'Team Claude', apiKey: 'sk-second-secret' }]
      }
    ],
    registryDir
  })

  const store = new DirectoryTeamPackStore(storeDir)
  const pulls = await Promise.all(
    [first, second, withoutGrant].map((member, index) =>
      pullTeamRelease({
        store,
        teamKeyId: team.keyId,
        identity: member.identity,
        stateDir: join(root, `state-${index}`)
      })
    )
  )
  assert.deepEqual(pulls[0].models, [
    {
      providerId: 'openai',
      label: 'Team OpenAI',
      apiKey: 'sk-first-secret',
      baseUrl: 'https://api.openai.example/v1'
    }
  ])
  assert.deepEqual(pulls[1].models, [
    { providerId: 'anthropic', label: 'Team Claude', apiKey: 'sk-second-secret' }
  ])
  assert.deepEqual(pulls[2].models, [])

  const manifest = readFileSync(join(storeDir, 'releases/1/manifest.json'), 'utf8')
  assert.equal(manifest.includes('sk-first-secret'), false)
  assert.equal(manifest.includes('sk-second-secret'), false)
  assert.equal(directoryContains(root, 'sk-first-secret'), false)
  assert.equal(directoryContains(root, 'sk-second-secret'), false)
})

test('every grant hash is checked before state is committed', async () => {
  const root = sandbox('tamper')
  const registryDir = join(root, 'registry')
  const storeDir = join(root, 'store')
  const stateDir = join(root, 'state')
  const team = createTeamKeys({ teamId: TEAM_ID, name: 'Alpha Team' })
  const [first, second] = await Promise.all([createMemberKeys(), createMemberKeys()])
  writeSkillRegistry(registryDir, '1.0.0')
  await publishTeamRelease({
    storeDir,
    team,
    members: [first.recipient, second.recipient],
    grants: [
      {
        recipient: first.recipient,
        models: [{ providerId: 'openai', label: 'First', apiKey: 'sk-first' }]
      },
      {
        recipient: second.recipient,
        models: [{ providerId: 'openai', label: 'Second', apiKey: 'sk-second' }]
      }
    ],
    registryDir
  })
  const manifest = readJson(join(storeDir, 'releases/1/manifest.json'))
  const grants = manifest.grants as Array<{ name: string }>
  const path = join(storeDir, 'releases/1/grants', grants[1].name)
  const data = readFileSync(path)
  data[data.length - 1] ^= 1
  writeFileSync(path, data)

  await expectCode(
    pullTeamRelease({
      store: new DirectoryTeamPackStore(storeDir),
      teamKeyId: team.keyId,
      identity: first.identity,
      stateDir
    }),
    'HASH_MISMATCH'
  )
  assert.equal(existsSync(stateDir), false)
})

test('model grants reject duplicate recipients, unsafe fields, secrets, and endpoints', async () => {
  const root = sandbox('validation')
  const registryDir = join(root, 'registry')
  const team = createTeamKeys({ teamId: TEAM_ID, name: 'Alpha Team' })
  const member = await createMemberKeys()
  writeSkillRegistry(registryDir, '1.0.0')

  await expectCode(
    publishTeamRelease({
      storeDir: join(root, 'duplicate-store'),
      team,
      members: [member.recipient],
      grants: [
        {
          recipient: member.recipient,
          models: [{ providerId: 'openai', label: 'First', apiKey: 'sk-first' }]
        },
        {
          recipient: member.recipient,
          models: [{ providerId: 'openai', label: 'Second', apiKey: 'sk-second' }]
        }
      ],
      registryDir
    }),
    'INVALID_FORMAT'
  )

  await expectCode(
    publishTeamRelease({
      storeDir: join(root, 'http-store'),
      team,
      members: [member.recipient],
      grants: [
        {
          recipient: member.recipient,
          models: [
            {
              providerId: 'openai',
              label: 'Unsafe endpoint',
              apiKey: 'sk-value',
              baseUrl: 'http://models.example/v1'
            }
          ]
        }
      ],
      registryDir
    }),
    'INVALID_FORMAT'
  )

  for (const apiKey of ['line1\nline2', 'nul\0secret']) {
    await expectCode(
      publishTeamRelease({
        storeDir: join(root, `secret-store-${apiKey.length}`),
        team,
        members: [member.recipient],
        grants: [
          {
            recipient: member.recipient,
            models: [{ providerId: 'openai', label: 'Invalid secret', apiKey }]
          }
        ],
        registryDir
      }),
      'INVALID_FORMAT'
    )
  }

  await expectCode(
    publishTeamRelease({
      storeDir: join(root, 'unknown-field-store'),
      team,
      members: [member.recipient],
      grants: [
        {
          recipient: member.recipient,
          models: [
            {
              providerId: 'openai',
              label: 'Unknown field',
              apiKey: 'sk-value',
              unknown: true
            }
          ]
        }
      ] as never,
      registryDir
    }),
    'INVALID_FORMAT'
  )
})

test('a latest release that withdraws itself is rejected without committing state', async () => {
  const root = sandbox('withdraw-current')
  const registryDir = join(root, 'registry')
  const storeDir = join(root, 'store')
  const stateDir = join(root, 'state')
  const team = createTeamKeys({ teamId: TEAM_ID, name: 'Alpha Team' })
  const member = await createMemberKeys()
  writeSkillRegistry(registryDir, '1.0.0')
  await publishTeamRelease({
    storeDir,
    team,
    members: [member.recipient],
    registryDir,
    withdrawReleases: [1]
  })

  await expectCode(
    pullTeamRelease({
      store: new DirectoryTeamPackStore(storeDir),
      teamKeyId: team.keyId,
      identity: member.identity,
      stateDir
    }),
    'RELEASE_WITHDRAWN'
  )
  assert.equal(existsSync(stateDir), false)
})

test('withdrawals remain cumulative when later releases add no new withdrawal', async () => {
  const root = sandbox('withdraw-cumulative')
  const registryDir = join(root, 'registry')
  const storeDir = join(root, 'store')
  const team = createTeamKeys({ teamId: TEAM_ID, name: 'Alpha Team' })
  const member = await createMemberKeys()
  writeSkillRegistry(registryDir, '1.0.0')

  await publishTeamRelease({ storeDir, team, members: [member.recipient], registryDir })
  await publishTeamRelease({
    storeDir,
    team,
    members: [member.recipient],
    registryDir,
    withdrawReleases: [1]
  })
  await publishTeamRelease({ storeDir, team, members: [member.recipient], registryDir })

  const manifest = readJson(join(storeDir, 'releases/3/manifest.json'))
  assert.deepEqual(manifest.withdrawnReleases, [1])
  const result = await pullTeamRelease({
    store: new DirectoryTeamPackStore(storeDir),
    teamKeyId: team.keyId,
    identity: member.identity,
    stateDir: join(root, 'state')
  })
  assert.deepEqual(result.withdrawnReleases, [1])
})

function sandbox(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `phi-team-pack-grants-${label}-`))
  roots.push(root)
  return root
}

function directoryContains(directory: string, text: string): boolean {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (directoryContains(path, text)) return true
    } else if (entry.isFile() && readFileSync(path).includes(Buffer.from(text))) {
      return true
    }
  }
  return false
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
