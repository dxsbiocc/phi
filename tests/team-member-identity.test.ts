import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { SafeStorageLike } from '../src/main/agent/credentials/credential-store'
import { TeamPackError, type TeamPackErrorCode } from '../src/main/agent/team-pack/errors'
import {
  MEMBER_PRIVATE_KEY_FILE,
  MEMBER_PUBLIC_KEY_FILE
} from '../src/main/agent/team-pack/key-store'
import {
  exportMemberIdentityBackup,
  getMemberRecipient,
  importMemberIdentityBackup,
  loadOrCreateMemberIdentity,
  memberKeyDirectory
} from '../src/main/agent/team-pack/member-service'

const roots: string[] = []

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

test('首次读取 recipient 时在 agentDir 下安全生成且并发调用复用同一身份', async () => {
  const agentDir = sandbox('create')
  const safeStorage = new FakeSafeStorage(true)

  const recipients = await Promise.all([
    getMemberRecipient({ agentDir, safeStorage }),
    getMemberRecipient({ agentDir, safeStorage }),
    getMemberRecipient({ agentDir, safeStorage })
  ])

  assert.equal(new Set(recipients).size, 1)
  assert.equal(safeStorage.encryptions, 1)
  const keyDir = memberKeyDirectory(agentDir)
  const privatePath = join(keyDir, MEMBER_PRIVATE_KEY_FILE)
  const publicPath = join(keyDir, MEMBER_PUBLIC_KEY_FILE)
  assert.equal(existsSync(privatePath), true)
  assert.equal(existsSync(publicPath), true)
  assert.equal(statSync(privatePath).mode & 0o777, 0o600)

  const keys = await loadOrCreateMemberIdentity({ agentDir, safeStorage })
  const ciphertext = readFileSync(privatePath)
  assert.equal(ciphertext.includes(Buffer.from(keys.identity)), false)
  assert.equal(keys.recipient, recipients[0])
  assert.equal(safeStorage.encryptions, 1)
})

test('成员身份口令备份可导出到指定路径并导入另一个 agentDir', async () => {
  const sourceAgentDir = sandbox('backup-source')
  const targetAgentDir = sandbox('backup-target')
  const backupPath = join(sandbox('backup-file'), 'member-identity.age')
  const sourceStorage = new FakeSafeStorage(true)
  const targetStorage = new FakeSafeStorage(true)
  const passphrase = 'member backup passphrase for phi'
  const recipient = await getMemberRecipient({
    agentDir: sourceAgentDir,
    safeStorage: sourceStorage
  })

  await exportMemberIdentityBackup({
    agentDir: sourceAgentDir,
    safeStorage: sourceStorage,
    backupPath,
    passphrase
  })
  const importedRecipient = await importMemberIdentityBackup({
    agentDir: targetAgentDir,
    safeStorage: targetStorage,
    backupPath,
    passphrase,
    expectedRecipient: recipient
  })

  assert.equal(statSync(backupPath).mode & 0o777, 0o600)
  assert.equal(importedRecipient, recipient)
  assert.equal(
    await getMemberRecipient({ agentDir: targetAgentDir, safeStorage: targetStorage }),
    recipient
  )
  assert.equal(targetStorage.encryptions, 1)
})

test('safeStorage 不可用时清晰拒绝首次生成和备份导入且不写明文回退', async () => {
  const agentDir = sandbox('unavailable-create')
  const unavailableStorage = new FakeSafeStorage(false)

  const createError = await expectCode(
    () => getMemberRecipient({ agentDir, safeStorage: unavailableStorage }),
    'STORE_UNAVAILABLE'
  )
  assert.match(createError.message, /系统加密存储不可用/)
  assert.equal(existsSync(memberKeyDirectory(agentDir)), false)

  const sourceAgentDir = sandbox('unavailable-source')
  const targetAgentDir = sandbox('unavailable-target')
  const backupPath = join(sandbox('unavailable-backup'), 'member-identity.age')
  const availableStorage = new FakeSafeStorage(true)
  await exportMemberIdentityBackup({
    agentDir: sourceAgentDir,
    safeStorage: availableStorage,
    backupPath,
    passphrase: 'valid backup passphrase'
  })

  const importError = await expectCode(
    () =>
      importMemberIdentityBackup({
        agentDir: targetAgentDir,
        safeStorage: unavailableStorage,
        backupPath,
        passphrase: 'valid backup passphrase'
      }),
    'STORE_UNAVAILABLE'
  )
  assert.match(importError.message, /系统加密存储不可用/)
  assert.equal(existsSync(memberKeyDirectory(targetAgentDir)), false)
})

test('导入包装保留口令错误和 expectedRecipient 校验且失败时不创建身份目录', async () => {
  const sourceAgentDir = sandbox('invalid-source')
  const targetAgentDir = sandbox('invalid-target')
  const backupPath = join(sandbox('invalid-backup'), 'member-identity.age')
  const safeStorage = new FakeSafeStorage(true)
  const recipient = await getMemberRecipient({ agentDir: sourceAgentDir, safeStorage })
  await exportMemberIdentityBackup({
    agentDir: sourceAgentDir,
    safeStorage,
    backupPath,
    passphrase: 'correct backup passphrase'
  })

  await expectCode(
    () =>
      importMemberIdentityBackup({
        agentDir: targetAgentDir,
        safeStorage,
        backupPath,
        passphrase: 'wrong backup passphrase'
      }),
    'BAD_PASSPHRASE'
  )
  await expectCode(
    () =>
      importMemberIdentityBackup({
        agentDir: targetAgentDir,
        safeStorage,
        backupPath,
        passphrase: 'correct backup passphrase',
        expectedRecipient: differentRecipient(recipient)
      }),
    'INVALID_FORMAT'
  )
  assert.equal(existsSync(memberKeyDirectory(targetAgentDir)), false)
})

class FakeSafeStorage implements SafeStorageLike {
  encryptions = 0

  constructor(private readonly available: boolean) {}

  isEncryptionAvailable(): boolean {
    return this.available
  }

  encryptString(plainText: string): Buffer {
    if (!this.available) throw new Error('unavailable')
    this.encryptions += 1
    const input = Buffer.from(plainText)
    const encrypted = Buffer.alloc(input.length + 4)
    encrypted.set([0x50, 0x48, 0x49, 0x02])
    for (let index = 0; index < input.length; index++) encrypted[index + 4] = input[index] ^ 0x6d
    return encrypted
  }

  decryptString(encrypted: Buffer): string {
    if (!this.available) throw new Error('unavailable')
    if (!encrypted.subarray(0, 4).equals(Buffer.from([0x50, 0x48, 0x49, 0x02]))) {
      throw new Error('invalid ciphertext')
    }
    const plaintext = Buffer.alloc(encrypted.length - 4)
    for (let index = 4; index < encrypted.length; index++) {
      plaintext[index - 4] = encrypted[index] ^ 0x6d
    }
    return plaintext.toString('utf8')
  }
}

function sandbox(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `phi-team-member-${label}-`))
  roots.push(root)
  return root
}

function differentRecipient(recipient: string): string {
  const replacement = recipient.endsWith('q') ? 'p' : 'q'
  return `${recipient.slice(0, -1)}${replacement}`
}

async function expectCode(
  action: () => unknown | Promise<unknown>,
  code: TeamPackErrorCode
): Promise<TeamPackError> {
  try {
    await action()
  } catch (error) {
    assert.equal(error instanceof TeamPackError, true)
    const teamError = error as TeamPackError
    assert.equal(teamError.code, code)
    return teamError
  }
  assert.fail(`expected ${code}`)
}
