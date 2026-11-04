import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { SafeStorageLike } from '../src/main/agent/credentials/credential-store'
import { TeamPackError, type TeamPackErrorCode } from '../src/main/agent/team-pack/errors'
import {
  exportMemberKeyBackup,
  exportTeamKeyBackup,
  importMemberKeyBackup,
  importTeamKeyBackup,
  loadMemberKeyMaterial,
  loadTeamKeyMaterial,
  MEMBER_PRIVATE_KEY_FILE,
  MEMBER_PUBLIC_KEY_FILE,
  readMemberPublicKeyMaterial,
  readTeamPublicKeyMaterial,
  storeMemberKeyMaterial,
  storeTeamKeyMaterial,
  TEAM_PRIVATE_KEY_FILE,
  TEAM_PUBLIC_KEY_FILE
} from '../src/main/agent/team-pack/key-store'
import { createMemberKeys, createTeamKeys } from '../src/main/agent/team-pack/keys'

const roots: string[] = []

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

test('safeStorage 不可用时拒绝保存团队私钥和成员身份，不回退到明文', async () => {
  const root = sandbox('unavailable')
  const safeStorage = new FakeSafeStorage(false)
  const team = createTeamKeys({ teamId: 'key-store-team', name: 'Key Store Team' })
  const member = await createMemberKeys()
  const teamDir = join(root, 'team')
  const memberDir = join(root, 'member')

  const teamError = await expectCode(
    () => storeTeamKeyMaterial({ keyDir: teamDir, keys: team, safeStorage }),
    'STORE_UNAVAILABLE'
  )
  assert.match(teamError.message, /系统加密存储不可用/)
  const memberError = await expectCode(
    () => storeMemberKeyMaterial({ keyDir: memberDir, keys: member, safeStorage }),
    'STORE_UNAVAILABLE'
  )
  assert.match(memberError.message, /系统加密存储不可用/)
  assert.equal(existsSync(teamDir), false)
  assert.equal(existsSync(memberDir), false)
})

test('私钥只以 safeStorage 密文落盘且为 0600，公开部分保持可读', async () => {
  const root = sandbox('encrypted')
  const teamDir = join(root, 'team')
  const memberDir = join(root, 'member')
  const safeStorage = new FakeSafeStorage(true)
  const team = createTeamKeys({ teamId: 'encrypted-team', name: 'Encrypted Team' })
  const member = await createMemberKeys()

  storeTeamKeyMaterial({ keyDir: teamDir, keys: team, safeStorage })
  await storeMemberKeyMaterial({ keyDir: memberDir, keys: member, safeStorage })

  const teamCiphertext = readFileSync(join(teamDir, TEAM_PRIVATE_KEY_FILE))
  const memberCiphertext = readFileSync(join(memberDir, MEMBER_PRIVATE_KEY_FILE))
  assert.equal(statSync(join(teamDir, TEAM_PRIVATE_KEY_FILE)).mode & 0o777, 0o600)
  assert.equal(statSync(join(memberDir, MEMBER_PRIVATE_KEY_FILE)).mode & 0o777, 0o600)
  assert.equal(teamCiphertext.includes(Buffer.from(team.privateKey)), false)
  assert.equal(memberCiphertext.includes(Buffer.from(member.identity)), false)
  assert.throws(() => JSON.parse(teamCiphertext.toString('utf8')))
  assert.throws(() => JSON.parse(memberCiphertext.toString('utf8')))

  const teamPublicText = readFileSync(join(teamDir, TEAM_PUBLIC_KEY_FILE), 'utf8')
  const memberPublicText = readFileSync(join(memberDir, MEMBER_PUBLIC_KEY_FILE), 'utf8')
  const teamPublic = JSON.parse(teamPublicText) as Record<string, unknown>
  assert.match(teamPublicText, new RegExp(team.keyId))
  assert.equal(teamPublic.publicKey, team.publicKey)
  assert.equal(teamPublicText.includes(team.privateKey), false)
  assert.equal(memberPublicText.includes(member.recipient), true)
  assert.equal(memberPublicText.includes(member.identity), false)
  assert.deepEqual(readTeamPublicKeyMaterial(teamDir), {
    version: 1,
    type: 'phi-team-public-key',
    teamId: team.teamId,
    name: team.name,
    publicKey: team.publicKey,
    keyId: team.keyId
  })
  assert.deepEqual(readMemberPublicKeyMaterial(memberDir), {
    version: 1,
    type: 'phi-team-member-recipient',
    recipient: member.recipient
  })
  assert.deepEqual(loadTeamKeyMaterial({ keyDir: teamDir, safeStorage }), team)
  assert.deepEqual(await loadMemberKeyMaterial({ keyDir: memberDir, safeStorage }), member)
})

test('读取时拒绝公钥和密文记录来自不同团队', async () => {
  const root = sandbox('mixed-records')
  const firstDir = join(root, 'first')
  const secondDir = join(root, 'second')
  const safeStorage = new FakeSafeStorage(true)
  const first = createTeamKeys({ teamId: 'first-team', name: 'First Team' })
  const second = createTeamKeys({ teamId: 'second-team', name: 'Second Team' })
  storeTeamKeyMaterial({ keyDir: firstDir, keys: first, safeStorage })
  storeTeamKeyMaterial({ keyDir: secondDir, keys: second, safeStorage })
  copyFileSync(join(secondDir, TEAM_PUBLIC_KEY_FILE), join(firstDir, TEAM_PUBLIC_KEY_FILE))

  await expectCode(() => loadTeamKeyMaterial({ keyDir: firstDir, safeStorage }), 'INVALID_FORMAT')
})

test('age scrypt 口令备份支持团队和成员往返，并校验类型及目标一致性', async () => {
  const root = sandbox('backups')
  const teamBackup = join(root, 'team-key.age')
  const memberBackup = join(root, 'member-key.age')
  const passphrase = 'correct horse battery staple for phi'
  const team = createTeamKeys({ teamId: 'backup-team', name: 'Backup Team' })
  const member = await createMemberKeys()

  await exportTeamKeyBackup({ backupPath: teamBackup, keys: team, passphrase })
  await exportMemberKeyBackup({ backupPath: memberBackup, keys: member, passphrase })

  assert.equal(statSync(teamBackup).mode & 0o777, 0o600)
  assert.equal(statSync(memberBackup).mode & 0o777, 0o600)
  assert.equal(readFileSync(teamBackup).includes(Buffer.from(team.privateKey)), false)
  assert.equal(readFileSync(memberBackup).includes(Buffer.from(member.identity)), false)
  assert.deepEqual(
    await importTeamKeyBackup({
      backupPath: teamBackup,
      passphrase,
      expectedTeamId: team.teamId,
      expectedKeyId: team.keyId
    }),
    team
  )
  assert.deepEqual(
    await importMemberKeyBackup({
      backupPath: memberBackup,
      passphrase,
      expectedRecipient: member.recipient
    }),
    member
  )

  await expectCode(
    () => importMemberKeyBackup({ backupPath: teamBackup, passphrase }),
    'INVALID_FORMAT'
  )
  await expectCode(
    () =>
      importTeamKeyBackup({
        backupPath: teamBackup,
        passphrase,
        expectedTeamId: 'another-team'
      }),
    'INVALID_FORMAT'
  )
  const anotherMember = await createMemberKeys()
  await expectCode(
    () =>
      importMemberKeyBackup({
        backupPath: memberBackup,
        passphrase,
        expectedRecipient: anotherMember.recipient
      }),
    'INVALID_FORMAT'
  )
})

test('备份口令错误返回 BAD_PASSPHRASE 且不泄露口令', async () => {
  const root = sandbox('bad-passphrase')
  const backupPath = join(root, 'team-key.age')
  const correctPassphrase = 'a long correct backup passphrase'
  const wrongPassphrase = 'a different wrong backup passphrase'
  const team = createTeamKeys({ teamId: 'passphrase-team', name: 'Passphrase Team' })
  await exportTeamKeyBackup({ backupPath, keys: team, passphrase: correctPassphrase })

  const error = await expectCode(
    () => importTeamKeyBackup({ backupPath, passphrase: wrongPassphrase }),
    'BAD_PASSPHRASE'
  )
  assert.match(error.message, /口令错误/)
  assert.equal(error.message.includes(correctPassphrase), false)
  assert.equal(error.message.includes(wrongPassphrase), false)
})

class FakeSafeStorage implements SafeStorageLike {
  constructor(private readonly available: boolean) {}

  isEncryptionAvailable(): boolean {
    return this.available
  }

  encryptString(plainText: string): Buffer {
    if (!this.available) throw new Error('unavailable')
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

function sandbox(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `phi-team-pack-key-store-${label}-`))
  roots.push(root)
  return root
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
