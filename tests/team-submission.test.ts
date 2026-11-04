import assert from 'node:assert/strict'
import {
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

import type { SafeStorageLike } from '../src/main/agent/credentials/credential-store'
import {
  installPackages,
  listInstalledPackages,
  planInstall,
  readRegistry
} from '../src/main/agent/packages/installer'
import { TeamPackAdminService } from '../src/main/agent/team-pack/admin-service'
import { materializeInstalledRegistry } from '../src/main/agent/team-pack/admin-registry'
import { loadTeamKeyMaterial } from '../src/main/agent/team-pack/key-store'
import { loadOrCreateMemberIdentity } from '../src/main/agent/team-pack/member-service'
import { TeamMemberSubmissionService } from '../src/main/agent/team-pack/member-submissions'
import {
  createMemberKeys,
  formatMemberPublicKey,
  parseMemberPublicKey
} from '../src/main/agent/team-pack/keys'
import {
  buildEncryptedSubmission,
  decryptSubmission,
  MAX_SUBMISSION_BYTES,
  TeamSubmissionError
} from '../src/main/agent/team-pack/submission-format'
import { TeamSourceService } from '../src/main/agent/team-pack/team-source'
import {
  readTeamSourcesState,
  teamSourceRegistryDir,
  writeTeamSourcesState
} from '../src/main/agent/team-pack/team-source-storage'
import { writeSkillRegistry } from './team-pack-fixtures'

const roots: string[] = []

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

test('组合成员公钥兼容旧 recipient，并绑定 Ed25519 签名公钥', async () => {
  const member = await createMemberKeys()
  const combined = formatMemberPublicKey(member)
  const parsed = parseMemberPublicKey(combined)

  assert.match(combined, /^phi-member-v1\./u)
  assert.equal(parsed.recipient, member.recipient)
  assert.equal(parsed.signingPublicKey, member.signingPublicKey)
  assert.equal(parsed.signingKeyId, member.signingKeyId)
  assert.deepEqual(parseMemberPublicKey(member.recipient), {
    recipient: member.recipient,
    combined: member.recipient
  })
  assert.throws(() => parseMemberPublicKey(`${combined}x`))
})

test('管理员可用组合公钥原地升级旧成员，而不会创建重复 roster 记录', async () => {
  const root = sandbox('member-upgrade')
  const admin = new TeamPackAdminService({
    agentDir: join(root, 'agent'),
    safeStorage: new FakeSafeStorage()
  })
  const team = admin.createTeam({ name: 'Upgrade Team', teamId: 'upgrade-team' })
  const keys = await createMemberKeys()
  const legacy = admin.addMember({
    teamId: team.teamId,
    displayName: 'Legacy Member',
    recipient: keys.recipient
  })
  const upgraded = admin.addMember({
    teamId: team.teamId,
    displayName: 'Legacy Member',
    recipient: formatMemberPublicKey(keys)
  })

  assert.equal(upgraded.memberId, legacy.memberId)
  assert.equal(upgraded.signingPublicKey, keys.signingPublicKey)
  assert.equal(admin.listMembers(team.teamId).length, 1)
})

test('成员文件夹投稿经管理员接受后进入默认待发布区，并能发布和拉取', async () => {
  const environment = await setupEnvironment('roundtrip')
  const candidates = environment.memberSubmissions.listCandidates(environment.source.id)
  assert.equal(candidates.find(({ id }) => id === 'shared-analysis')?.canSubmit, true)

  const delivered = await environment.memberSubmissions.submit(
    {
      sourceId: environment.source.id,
      packages: [{ type: 'skill', id: 'shared-analysis' }],
      note: 'Please review this update.'
    },
    async () => {
      assert.fail('writable directory delivery must not ask for an export path')
    }
  )
  assert.equal(delivered?.delivery, 'directory')
  assert.equal(existsSync(delivered!.path), true)

  const submissions = await environment.admin.listSubmissions(environment.team.teamId)
  assert.equal(submissions.length, 1)
  assert.equal(submissions[0]?.valid, true)
  assert.equal(submissions[0]?.memberName, 'Member One')
  assert.equal(submissions[0]?.note, 'Please review this update.')
  assert.deepEqual(
    submissions[0]?.packages.map(({ version }) => version),
    ['2.0.0']
  )

  const accepted = await environment.admin.acceptSubmission({
    teamId: environment.team.teamId,
    entryId: submissions[0]!.entryId
  })
  assert.equal(existsSync(delivered!.path), false)
  const pending = environment.admin.getTeamSummary(
    environment.team.teamId
  ).pendingSubmissionPackages
  assert.equal(pending.length, 1)
  assert.equal(pending[0]?.memberName, 'Member One')
  assert.equal(pending[0]?.submissionId, accepted.submissionId)

  const published = await environment.admin.publishRelease({
    teamId: environment.team.teamId,
    storeDir: environment.storeDir,
    packages: [
      {
        type: 'skill',
        id: 'shared-analysis',
        pendingSubmissionId: accepted.submissionId,
        sharing: 'team-only'
      }
    ]
  })
  assert.equal(published.release, 2)
  assert.equal(
    environment.admin.getTeamSummary(environment.team.teamId).pendingSubmissionPackages.length,
    0
  )

  const pulled = await environment.sources.pullSource(environment.source.id)
  const registryDir = teamSourceRegistryDir(environment.memberAgentDir, pulled)
  assert.ok(registryDir)
  const registry = readRegistry(registryDir)
  assert.equal(registry.packages[0]?.version, '2.0.0')
  await installPackages(
    planInstall(
      registry,
      { type: 'skill', id: 'shared-analysis' },
      {
        agentDir: environment.memberAgentDir
      }
    ),
    { agentDir: environment.memberAgentDir }
  )
  assert.equal(
    listInstalledPackages({ agentDir: environment.memberAgentDir }).some(
      ({ id, version }) => id === 'shared-analysis' && version === '2.0.0'
    ),
    true
  )
})

test('HTTPS 来源走 .phi-submission 导出，文件夹投稿可以由管理员删除', async () => {
  const environment = await setupEnvironment('delivery')
  const state = readTeamSourcesState(environment.memberAgentDir)
  state.sources[0]!.location = { kind: 'https', url: 'https://packages.example/team/' }
  writeTeamSourcesState(environment.memberAgentDir, state)
  const exportPath = join(environment.root, 'out.phi-submission')

  const exported = await environment.memberSubmissions.submit(
    {
      sourceId: environment.source.id,
      packages: [{ type: 'skill', id: 'shared-analysis' }]
    },
    async (suggestedName) => {
      assert.match(suggestedName, /\.phi-submission$/u)
      return exportPath
    }
  )
  assert.equal(exported?.delivery, 'export')
  assert.equal(exported?.path, exportPath)
  assert.equal(existsSync(exportPath), true)

  const imported = await environment.admin.importSubmission({
    teamId: environment.team.teamId,
    path: exportPath
  })
  assert.equal(imported.valid, true)
  assert.equal(
    environment.admin.deleteSubmission({
      teamId: environment.team.teamId,
      entryId: imported.entryId
    }),
    true
  )
  assert.equal((await environment.admin.listSubmissions(environment.team.teamId)).length, 0)
})

test('文件夹 submissions 符号链接不会把成员目录或投稿写到来源之外', async () => {
  const environment = await setupEnvironment('delivery-symlink')
  const outside = join(environment.root, 'outside')
  mkdirSync(outside)
  symlinkSync(outside, join(environment.storeDir, 'submissions'))
  const exportPath = join(environment.root, 'safe-fallback.phi-submission')

  const result = await environment.memberSubmissions.submit(
    {
      sourceId: environment.source.id,
      packages: [{ type: 'skill', id: 'shared-analysis' }]
    },
    async () => exportPath
  )

  assert.equal(result?.delivery, 'export')
  assert.deepEqual(readdirSync(outside), [])
  assert.equal(existsSync(exportPath), true)
})

test('管理员扫描拒绝换签名、伪造成员、已移除成员、错团队和哈希篡改', async () => {
  const environment = await setupEnvironment('invalid')
  const member = await loadOrCreateMemberIdentity({
    agentDir: environment.memberAgentDir,
    safeStorage: environment.memberStorage
  })
  const outsider = await createMemberKeys()
  const registryDir = materializedMemberRegistry(environment, 'invalid-registry')
  const inbox = join(environment.storeDir, 'submissions', member.signingKeyId)
  mkdirSync(inbox, { recursive: true })

  const forged = await buildEncryptedSubmission({
    teamId: environment.team.teamId,
    submissionRecipient: environment.submissionRecipient,
    member: { ...outsider, signingKeyId: member.signingKeyId },
    registryDir
  })
  writeFileSync(join(inbox, `${forged.submissionId}.age`), forged.data)

  const unknown = await buildEncryptedSubmission({
    teamId: environment.team.teamId,
    submissionRecipient: environment.submissionRecipient,
    member: outsider,
    registryDir
  })
  writeFileSync(join(inbox, `${unknown.submissionId}.age`), unknown.data)

  const wrongTeam = await buildEncryptedSubmission({
    teamId: 'other-team',
    submissionRecipient: environment.submissionRecipient,
    member,
    registryDir
  })
  writeFileSync(join(inbox, `${wrongTeam.submissionId}.age`), wrongTeam.data)

  const tamperedRegistry = materializedMemberRegistry(environment, 'tampered-registry')
  const registry = readRegistry(tamperedRegistry)
  writeFileSync(join(tamperedRegistry, registry.packages[0]!.archive), Buffer.from('tampered'))
  const badHash = await buildEncryptedSubmission({
    teamId: environment.team.teamId,
    submissionRecipient: environment.submissionRecipient,
    member,
    registryDir: tamperedRegistry
  })
  writeFileSync(join(inbox, `${badHash.submissionId}.age`), badHash.data)

  const removedKeys = await createMemberKeys()
  const removed = environment.admin.addMember({
    teamId: environment.team.teamId,
    displayName: 'Removed Member',
    recipient: formatMemberPublicKey(removedKeys)
  })
  const removedSubmission = await buildEncryptedSubmission({
    teamId: environment.team.teamId,
    submissionRecipient: environment.submissionRecipient,
    member: removedKeys,
    registryDir
  })
  writeFileSync(join(inbox, `${removedSubmission.submissionId}.age`), removedSubmission.data)
  environment.admin.removeMember({ teamId: environment.team.teamId, memberId: removed.memberId })

  const views = await environment.admin.listSubmissions(environment.team.teamId)
  const reasons = views.map(({ invalidReasonCode }) => invalidReasonCode).sort()
  assert.deepEqual(reasons, ['hash', 'member', 'member', 'signature', 'team'])
})

test('投稿只可由管理员收件密钥解密，超大小文件安全失败', async () => {
  const environment = await setupEnvironment('crypto')
  const member = await loadOrCreateMemberIdentity({
    agentDir: environment.memberAgentDir,
    safeStorage: environment.memberStorage
  })
  const built = await buildEncryptedSubmission({
    teamId: environment.team.teamId,
    submissionRecipient: environment.submissionRecipient,
    member,
    registryDir: materializedMemberRegistry(environment, 'crypto-registry')
  })
  const adminKeys = loadTeamKeyMaterial({
    keyDir: join(environment.adminAgentDir, 'team-pack', 'admin', environment.team.teamId, 'keys'),
    safeStorage: environment.adminStorage
  })
  assert.ok((await decryptSubmission(built.data, adminKeys.submissionIdentity)).length > 0)
  const outsider = await createMemberKeys()
  await assert.rejects(
    () => decryptSubmission(built.data, outsider.identity),
    (error: unknown) => error instanceof TeamSubmissionError && error.reason === 'decrypt'
  )

  const oversizedDir = join(environment.storeDir, 'submissions', member.signingKeyId)
  mkdirSync(oversizedDir, { recursive: true })
  writeFileSync(join(oversizedDir, 'oversized.age'), Buffer.alloc(MAX_SUBMISSION_BYTES + 1))
  const invalid = (await environment.admin.listSubmissions(environment.team.teamId)).find(
    ({ bytes }) => bytes > MAX_SUBMISSION_BYTES
  )
  assert.equal(invalid?.invalidReasonCode, 'size')
})

test('仅限其他团队的已安装资源在候选列表禁用且服务层拒绝投稿', async () => {
  const environment = await setupEnvironment('team-only')
  const installed = listInstalledPackages({ agentDir: environment.memberAgentDir }).find(
    ({ id }) => id === 'shared-analysis'
  )
  assert.ok(installed)
  const sourcePath = join(installed!.dir, '.source.json')
  const source = JSON.parse(readFileSync(sourcePath, 'utf8')) as Record<string, unknown>
  source.teamSource = {
    teamId: 'other-team',
    teamName: 'Other Team',
    teamKeyId: '0123456789abcdef',
    release: 1,
    sharing: 'team-only'
  }
  writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`)

  const candidate = environment.memberSubmissions
    .listCandidates(environment.source.id)
    .find(({ id }) => id === 'shared-analysis')
  assert.equal(candidate?.canSubmit, false)
  assert.equal(candidate?.reason, 'team-only')
  await assert.rejects(() =>
    environment.memberSubmissions.submit(
      {
        sourceId: environment.source.id,
        packages: [{ type: 'skill', id: 'shared-analysis' }]
      },
      async () => join(environment.root, 'blocked.phi-submission')
    )
  )
})

test('未签名 team.json 字段不能替换投稿收件公钥，submissions 目录不影响发布拉取', async () => {
  const environment = await setupEnvironment('metadata')
  const teamPath = join(environment.storeDir, 'team.json')
  const team = JSON.parse(readFileSync(teamPath, 'utf8')) as Record<string, unknown>
  const attacker = await createMemberKeys()
  team.submissionRecipient = attacker.recipient
  writeFileSync(teamPath, `${JSON.stringify(team, null, 2)}\n`)
  mkdirSync(join(environment.storeDir, 'submissions', 'noise'), { recursive: true })
  writeFileSync(join(environment.storeDir, 'submissions', 'noise', 'ignored.txt'), 'ignored')

  const pulled = await environment.sources.pullSource(environment.source.id)
  assert.equal(pulled.status.submissionRecipient, environment.submissionRecipient)
  const published = await environment.admin.publishRelease({
    teamId: environment.team.teamId,
    storeDir: environment.storeDir,
    packages: [{ type: 'skill', id: 'shared-analysis' }]
  })
  assert.equal(published.release, 2)
  assert.equal(
    (await environment.sources.pullSource(environment.source.id)).status.lastSuccessfulRelease,
    2
  )
})

interface Environment {
  root: string
  adminAgentDir: string
  memberAgentDir: string
  storeDir: string
  adminStorage: FakeSafeStorage
  memberStorage: FakeSafeStorage
  admin: TeamPackAdminService
  memberSubmissions: TeamMemberSubmissionService
  sources: TeamSourceService
  source: ReturnType<TeamSourceService['listSources']>[number]
  team: ReturnType<TeamPackAdminService['createTeam']>
  submissionRecipient: string
}

async function setupEnvironment(label: string): Promise<Environment> {
  const root = sandbox(label)
  const adminAgentDir = join(root, 'admin-agent')
  const memberAgentDir = join(root, 'member-agent')
  const storeDir = join(root, 'store')
  const adminStorage = new FakeSafeStorage()
  const memberStorage = new FakeSafeStorage()
  await installFixture(adminAgentDir, join(root, 'admin-registry'), '1.0.0')
  await installFixture(memberAgentDir, join(root, 'member-registry'), '2.0.0')
  const admin = new TeamPackAdminService({
    agentDir: adminAgentDir,
    safeStorage: adminStorage,
    now: monotonicNow()
  })
  const team = admin.createTeam({ name: 'Submission Team', teamId: `submission-${label}` })
  const member = await loadOrCreateMemberIdentity({
    agentDir: memberAgentDir,
    safeStorage: memberStorage
  })
  admin.addMember({
    teamId: team.teamId,
    displayName: 'Member One',
    recipient: formatMemberPublicKey(member)
  })
  await admin.publishRelease({
    teamId: team.teamId,
    storeDir,
    packages: [{ type: 'skill', id: 'shared-analysis' }]
  })
  const sources = new TeamSourceService({
    agentDir: memberAgentDir,
    getMemberIdentity: async () => member.identity,
    createId: () => `source-${label}`,
    now: new Date('2026-11-04T01:00:00.000Z')
  })
  const source = await sources.addSource({
    teamKeyId: team.publicKeyFingerprint,
    location: { kind: 'directory', path: storeDir }
  })
  await sources.pullSource(source.id)
  const current = sources.listSources()[0]!
  assert.ok(current.status.submissionRecipient)
  return {
    root,
    adminAgentDir,
    memberAgentDir,
    storeDir,
    adminStorage,
    memberStorage,
    admin,
    memberSubmissions: new TeamMemberSubmissionService({
      agentDir: memberAgentDir,
      safeStorage: memberStorage,
      now: monotonicNow()
    }),
    sources,
    source: current,
    team,
    submissionRecipient: current.status.submissionRecipient
  }
}

function materializedMemberRegistry(environment: Environment, label: string): string {
  const installed = listInstalledPackages({ agentDir: environment.memberAgentDir }).find(
    ({ id }) => id === 'shared-analysis'
  )
  assert.ok(installed)
  const registryDir = join(environment.root, label)
  materializeInstalledRegistry({
    agentDir: environment.memberAgentDir,
    teamId: environment.team.teamId,
    installed: [installed],
    registryDir,
    generatedAt: '2026-11-04T02:00:00.000Z'
  })
  return registryDir
}

async function installFixture(
  agentDir: string,
  registryDir: string,
  version: string
): Promise<void> {
  writeSkillRegistry(registryDir, version)
  const registry = readRegistry(registryDir)
  await installPackages(
    planInstall(registry, { type: 'skill', id: 'shared-analysis' }, { agentDir }),
    { agentDir }
  )
}

function monotonicNow(): () => Date {
  let tick = 0
  return () => new Date(Date.UTC(2026, 10, 4, 0, 0, tick++))
}

function sandbox(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `phi-team-submission-${label}-`))
  roots.push(root)
  return root
}

class FakeSafeStorage implements SafeStorageLike {
  isEncryptionAvailable(): boolean {
    return true
  }

  encryptString(plaintext: string): Buffer {
    return Buffer.from(`safe:${Buffer.from(plaintext).toString('base64')}`)
  }

  decryptString(ciphertext: Buffer): string {
    const value = ciphertext.toString()
    if (!value.startsWith('safe:')) throw new Error('invalid ciphertext')
    return Buffer.from(value.slice(5), 'base64').toString()
  }
}
