import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Decrypter, Encrypter, identityToRecipient } from 'age-encryption'

import type { SafeStorageLike } from '../credentials/credential-store'
import { publicKeyPem, registryKeyId } from '../packages/signature'
import { isTeamPackError, teamPackError } from './errors'
import { writeAtomic } from './files'
import type { MemberKeys, TeamKeys } from './keys'
import {
  assertTeamId,
  assertTeamName,
  assertX25519Identity,
  assertX25519Recipient
} from './validation'

export type { SafeStorageLike } from '../credentials/credential-store'

export const TEAM_PUBLIC_KEY_FILE = 'team-public-key.json'
export const TEAM_PRIVATE_KEY_FILE = 'team-signing-private-key.enc'
export const MEMBER_PUBLIC_KEY_FILE = 'member-recipient.json'
export const MEMBER_PRIVATE_KEY_FILE = 'member-age-identity.enc'

const PUBLIC_FILE_MODE = 0o644
const PRIVATE_FILE_MODE = 0o600
const MAX_PUBLIC_FILE_BYTES = 64 * 1024
const MAX_PRIVATE_FILE_BYTES = 1024 * 1024
const MAX_BACKUP_FILE_BYTES = 1024 * 1024

export interface TeamPublicKeyMaterial {
  version: 1
  type: 'phi-team-public-key'
  teamId: string
  name: string
  publicKey: string
  keyId: string
}

export interface MemberPublicKeyMaterial {
  version: 1
  type: 'phi-team-member-recipient'
  recipient: string
}

export interface StoreTeamKeyMaterialOptions {
  keyDir: string
  keys: TeamKeys
  safeStorage: SafeStorageLike
}

export interface LoadTeamKeyMaterialOptions {
  keyDir: string
  safeStorage: SafeStorageLike
}

export interface StoreMemberKeyMaterialOptions {
  keyDir: string
  keys: MemberKeys
  safeStorage: SafeStorageLike
}

export interface LoadMemberKeyMaterialOptions {
  keyDir: string
  safeStorage: SafeStorageLike
}

export interface ExportTeamKeyBackupOptions {
  backupPath: string
  keys: TeamKeys
  passphrase: string
}

export interface ImportTeamKeyBackupOptions {
  backupPath: string
  passphrase: string
  expectedTeamId?: string
  expectedKeyId?: string
}

export interface ExportMemberKeyBackupOptions {
  backupPath: string
  keys: MemberKeys
  passphrase: string
}

export interface ImportMemberKeyBackupOptions {
  backupPath: string
  passphrase: string
  expectedRecipient?: string
}

interface TeamPrivateKeyMaterial {
  version: 1
  type: 'phi-team-signing-private-key'
  teamId: string
  keyId: string
  privateKey: string
}

interface MemberPrivateKeyMaterial {
  version: 1
  type: 'phi-team-member-identity'
  recipient: string
  identity: string
}

interface TeamKeyBackup {
  version: 1
  type: 'phi-team-key-backup'
  keys: TeamKeys
}

interface MemberKeyBackup {
  version: 1
  type: 'phi-team-member-key-backup'
  keys: MemberKeys
}

export function storeTeamKeyMaterial(options: StoreTeamKeyMaterialOptions): void {
  assertKeyDirectory(options.keyDir)
  validateTeamKeys(options.keys)
  const publicMaterial = teamPublicMaterial(options.keys)
  const privateMaterial: TeamPrivateKeyMaterial = {
    version: 1,
    type: 'phi-team-signing-private-key',
    teamId: options.keys.teamId,
    keyId: options.keys.keyId,
    privateKey: options.keys.privateKey
  }
  const encrypted = encryptWithSafeStorage(options.safeStorage, privateMaterial)
  writeKeyFile(join(options.keyDir, TEAM_PRIVATE_KEY_FILE), encrypted, PRIVATE_FILE_MODE)
  writeKeyFile(
    join(options.keyDir, TEAM_PUBLIC_KEY_FILE),
    jsonBytes(publicMaterial),
    PUBLIC_FILE_MODE
  )
}

export function loadTeamKeyMaterial(options: LoadTeamKeyMaterialOptions): TeamKeys {
  assertKeyDirectory(options.keyDir)
  const publicMaterial = readTeamPublicKeyMaterial(options.keyDir)
  const encrypted = readKeyFile(
    join(options.keyDir, TEAM_PRIVATE_KEY_FILE),
    MAX_PRIVATE_FILE_BYTES,
    '团队签名私钥密文'
  )
  const privateMaterial = parseTeamPrivateKeyMaterial(
    decryptWithSafeStorage(options.safeStorage, encrypted)
  )
  if (
    privateMaterial.teamId !== publicMaterial.teamId ||
    privateMaterial.keyId !== publicMaterial.keyId
  ) {
    throw teamPackError('INVALID_FORMAT', '团队公钥与签名私钥记录不一致')
  }
  const keys: TeamKeys = {
    version: 1,
    teamId: publicMaterial.teamId,
    name: publicMaterial.name,
    publicKey: publicMaterial.publicKey,
    privateKey: privateMaterial.privateKey,
    keyId: publicMaterial.keyId
  }
  validateTeamKeys(keys)
  return keys
}

export async function storeMemberKeyMaterial(
  options: StoreMemberKeyMaterialOptions
): Promise<void> {
  assertKeyDirectory(options.keyDir)
  await validatedMemberKeys(options.keys)
  const publicMaterial: MemberPublicKeyMaterial = {
    version: 1,
    type: 'phi-team-member-recipient',
    recipient: options.keys.recipient
  }
  const privateMaterial: MemberPrivateKeyMaterial = {
    version: 1,
    type: 'phi-team-member-identity',
    recipient: options.keys.recipient,
    identity: options.keys.identity
  }
  const encrypted = encryptWithSafeStorage(options.safeStorage, privateMaterial)
  writeKeyFile(join(options.keyDir, MEMBER_PRIVATE_KEY_FILE), encrypted, PRIVATE_FILE_MODE)
  writeKeyFile(
    join(options.keyDir, MEMBER_PUBLIC_KEY_FILE),
    jsonBytes(publicMaterial),
    PUBLIC_FILE_MODE
  )
}

export async function loadMemberKeyMaterial(
  options: LoadMemberKeyMaterialOptions
): Promise<MemberKeys> {
  assertKeyDirectory(options.keyDir)
  const publicMaterial = readMemberPublicKeyMaterial(options.keyDir)
  const encrypted = readKeyFile(
    join(options.keyDir, MEMBER_PRIVATE_KEY_FILE),
    MAX_PRIVATE_FILE_BYTES,
    '成员身份密文'
  )
  const privateMaterial = parseMemberPrivateKeyMaterial(
    decryptWithSafeStorage(options.safeStorage, encrypted)
  )
  if (privateMaterial.recipient !== publicMaterial.recipient) {
    throw teamPackError('INVALID_FORMAT', '成员 recipient 与身份记录不一致')
  }
  const keys: MemberKeys = {
    version: 1,
    identity: privateMaterial.identity,
    recipient: publicMaterial.recipient
  }
  return validatedMemberKeys(keys)
}

export function readTeamPublicKeyMaterial(keyDir: string): TeamPublicKeyMaterial {
  assertKeyDirectory(keyDir)
  const value = parseJson(
    readKeyFile(join(keyDir, TEAM_PUBLIC_KEY_FILE), MAX_PUBLIC_FILE_BYTES, '团队公钥文件'),
    '团队公钥文件'
  )
  if (
    !hasExactKeys(value, ['version', 'type', 'teamId', 'name', 'publicKey', 'keyId']) ||
    value.version !== 1 ||
    value.type !== 'phi-team-public-key' ||
    typeof value.publicKey !== 'string' ||
    typeof value.keyId !== 'string'
  ) {
    throw teamPackError('INVALID_FORMAT', '团队公钥文件格式无效')
  }
  try {
    assertTeamId(value.teamId)
    assertTeamName(value.name)
    if (!/^[a-f0-9]{16}$/.test(value.keyId) || registryKeyId(value.publicKey) !== value.keyId) {
      throw new Error('key mismatch')
    }
  } catch (error) {
    if (isTeamPackError(error)) throw error
    throw teamPackError('INVALID_FORMAT', '团队公钥文件格式无效', error)
  }
  return {
    version: 1,
    type: 'phi-team-public-key',
    teamId: value.teamId,
    name: value.name,
    publicKey: value.publicKey,
    keyId: value.keyId
  }
}

export function readMemberPublicKeyMaterial(keyDir: string): MemberPublicKeyMaterial {
  assertKeyDirectory(keyDir)
  const value = parseJson(
    readKeyFile(join(keyDir, MEMBER_PUBLIC_KEY_FILE), MAX_PUBLIC_FILE_BYTES, '成员 recipient 文件'),
    '成员 recipient 文件'
  )
  if (
    !hasExactKeys(value, ['version', 'type', 'recipient']) ||
    value.version !== 1 ||
    value.type !== 'phi-team-member-recipient'
  ) {
    throw teamPackError('INVALID_FORMAT', '成员 recipient 文件格式无效')
  }
  assertX25519Recipient(value.recipient)
  return { version: 1, type: 'phi-team-member-recipient', recipient: value.recipient }
}

export async function exportTeamKeyBackup(options: ExportTeamKeyBackupOptions): Promise<void> {
  assertBackupPath(options.backupPath)
  assertPassphrase(options.passphrase)
  validateTeamKeys(options.keys)
  await writePassphraseBackup(options.backupPath, options.passphrase, {
    version: 1,
    type: 'phi-team-key-backup',
    keys: options.keys
  } satisfies TeamKeyBackup)
}

export async function importTeamKeyBackup(options: ImportTeamKeyBackupOptions): Promise<TeamKeys> {
  assertBackupPath(options.backupPath)
  assertPassphrase(options.passphrase)
  const value = await readPassphraseBackup(options.backupPath, options.passphrase)
  if (
    !hasExactKeys(value, ['version', 'type', 'keys']) ||
    value.version !== 1 ||
    value.type !== 'phi-team-key-backup'
  ) {
    throw teamPackError('INVALID_FORMAT', '备份不是团队签名密钥备份')
  }
  validateTeamKeys(value.keys)
  if (options.expectedTeamId !== undefined && value.keys.teamId !== options.expectedTeamId) {
    throw teamPackError('INVALID_FORMAT', '团队密钥备份与目标团队不一致')
  }
  if (options.expectedKeyId !== undefined && value.keys.keyId !== options.expectedKeyId) {
    throw teamPackError('INVALID_FORMAT', '团队密钥备份与目标团队公钥不一致')
  }
  return value.keys
}

export async function exportMemberKeyBackup(options: ExportMemberKeyBackupOptions): Promise<void> {
  assertBackupPath(options.backupPath)
  assertPassphrase(options.passphrase)
  await validatedMemberKeys(options.keys)
  await writePassphraseBackup(options.backupPath, options.passphrase, {
    version: 1,
    type: 'phi-team-member-key-backup',
    keys: options.keys
  } satisfies MemberKeyBackup)
}

export async function importMemberKeyBackup(
  options: ImportMemberKeyBackupOptions
): Promise<MemberKeys> {
  assertBackupPath(options.backupPath)
  assertPassphrase(options.passphrase)
  const value = await readPassphraseBackup(options.backupPath, options.passphrase)
  if (
    !hasExactKeys(value, ['version', 'type', 'keys']) ||
    value.version !== 1 ||
    value.type !== 'phi-team-member-key-backup'
  ) {
    throw teamPackError('INVALID_FORMAT', '备份不是成员 age 身份备份')
  }
  const keys = await validatedMemberKeys(value.keys)
  if (options.expectedRecipient !== undefined && keys.recipient !== options.expectedRecipient) {
    throw teamPackError('INVALID_FORMAT', '成员身份备份与目标成员不一致')
  }
  return keys
}

function encryptWithSafeStorage(safeStorage: SafeStorageLike, value: unknown): Buffer {
  assertSafeStorageAvailable(safeStorage)
  try {
    const encrypted = safeStorage.encryptString(JSON.stringify(value))
    if (!Buffer.isBuffer(encrypted) || encrypted.length < 1) throw new Error('empty ciphertext')
    return encrypted
  } catch (error) {
    throw teamPackError('STORE_UNAVAILABLE', '无法使用系统加密存储保护团队密钥', error)
  }
}

function decryptWithSafeStorage(safeStorage: SafeStorageLike, encrypted: Buffer): unknown {
  assertSafeStorageAvailable(safeStorage)
  let plaintext: string
  try {
    plaintext = safeStorage.decryptString(encrypted)
  } catch (error) {
    throw teamPackError('STORE_UNAVAILABLE', '无法使用系统加密存储解密团队密钥', error)
  }
  return parseJson(Buffer.from(plaintext), '系统加密存储中的团队密钥')
}

function assertSafeStorageAvailable(safeStorage: SafeStorageLike): void {
  let available = false
  try {
    available =
      safeStorage.isEncryptionAvailable() &&
      !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text')
  } catch {
    available = false
  }
  if (!available) {
    throw teamPackError('STORE_UNAVAILABLE', '系统加密存储不可用，拒绝以明文保存团队密钥')
  }
}

async function writePassphraseBackup(
  path: string,
  passphrase: string,
  value: TeamKeyBackup | MemberKeyBackup
): Promise<void> {
  let encrypted: Buffer
  try {
    const encrypter = new Encrypter()
    encrypter.setPassphrase(passphrase)
    encrypted = Buffer.from(await encrypter.encrypt(jsonBytes(value)))
  } catch (error) {
    throw teamPackError('STORE_UNAVAILABLE', '无法加密团队密钥备份', error)
  }
  writeKeyFile(path, encrypted, PRIVATE_FILE_MODE)
}

async function readPassphraseBackup(
  path: string,
  passphrase: string
): Promise<Record<string, unknown>> {
  const encrypted = readKeyFile(path, MAX_BACKUP_FILE_BYTES, '团队密钥备份')
  let plaintext: Uint8Array
  try {
    const decrypter = new Decrypter()
    decrypter.addPassphrase(passphrase)
    plaintext = await decrypter.decrypt(encrypted)
  } catch (error) {
    throw teamPackError('BAD_PASSPHRASE', '团队密钥备份口令错误', error)
  }
  return parseJson(Buffer.from(plaintext), '团队密钥备份')
}

function validateTeamKeys(value: unknown): asserts value is TeamKeys {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'teamId', 'name', 'publicKey', 'privateKey', 'keyId']) ||
    value.version !== 1 ||
    typeof value.publicKey !== 'string' ||
    typeof value.privateKey !== 'string' ||
    typeof value.keyId !== 'string'
  ) {
    throw teamPackError('INVALID_FORMAT', '团队密钥格式无效')
  }
  try {
    assertTeamId(value.teamId)
    assertTeamName(value.name)
    if (
      !/^[a-f0-9]{16}$/.test(value.keyId) ||
      publicKeyPem(value.privateKey) !== value.publicKey ||
      registryKeyId(value.publicKey) !== value.keyId
    ) {
      throw new Error('key mismatch')
    }
  } catch (error) {
    if (isTeamPackError(error)) throw error
    throw teamPackError('INVALID_FORMAT', '团队密钥格式无效', error)
  }
}

async function validatedMemberKeys(value: unknown): Promise<MemberKeys> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'identity', 'recipient']) ||
    value.version !== 1
  ) {
    throw teamPackError('INVALID_FORMAT', '成员密钥格式无效')
  }
  try {
    assertX25519Identity(value.identity)
    assertX25519Recipient(value.recipient)
    if ((await identityToRecipient(value.identity)) !== value.recipient) {
      throw new Error('recipient mismatch')
    }
  } catch (error) {
    if (isTeamPackError(error)) throw error
    throw teamPackError('INVALID_FORMAT', '成员密钥格式无效', error)
  }
  return { version: 1, identity: value.identity, recipient: value.recipient }
}

function teamPublicMaterial(keys: TeamKeys): TeamPublicKeyMaterial {
  return {
    version: 1,
    type: 'phi-team-public-key',
    teamId: keys.teamId,
    name: keys.name,
    publicKey: keys.publicKey,
    keyId: keys.keyId
  }
}

function parseTeamPrivateKeyMaterial(value: unknown): TeamPrivateKeyMaterial {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'type', 'teamId', 'keyId', 'privateKey']) ||
    value.version !== 1 ||
    value.type !== 'phi-team-signing-private-key' ||
    typeof value.keyId !== 'string' ||
    typeof value.privateKey !== 'string'
  ) {
    throw teamPackError('INVALID_FORMAT', '团队签名私钥密文格式无效')
  }
  assertTeamId(value.teamId)
  if (!/^[a-f0-9]{16}$/.test(value.keyId)) {
    throw teamPackError('INVALID_FORMAT', '团队签名私钥密文格式无效')
  }
  return {
    version: 1,
    type: 'phi-team-signing-private-key',
    teamId: value.teamId,
    keyId: value.keyId,
    privateKey: value.privateKey
  }
}

function parseMemberPrivateKeyMaterial(value: unknown): MemberPrivateKeyMaterial {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'type', 'recipient', 'identity']) ||
    value.version !== 1 ||
    value.type !== 'phi-team-member-identity'
  ) {
    throw teamPackError('INVALID_FORMAT', '成员身份密文格式无效')
  }
  assertX25519Recipient(value.recipient)
  assertX25519Identity(value.identity)
  return {
    version: 1,
    type: 'phi-team-member-identity',
    recipient: value.recipient,
    identity: value.identity
  }
}

function writeKeyFile(path: string, data: Buffer, mode: number): void {
  try {
    writeAtomic(path, data, mode)
  } catch (error) {
    throw teamPackError('STORE_UNAVAILABLE', '无法写入团队密钥文件', error)
  }
}

function readKeyFile(path: string, maximumBytes: number, label: string): Buffer {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw teamPackError('INVALID_FORMAT', `${label}必须是普通文件`)
    }
    if (stat.size < 1 || stat.size > maximumBytes) {
      throw teamPackError('INVALID_FORMAT', `${label}大小无效`)
    }
    return readFileSync(path)
  } catch (error) {
    if (isTeamPackError(error)) throw error
    throw teamPackError('STORE_UNAVAILABLE', `无法读取${label}`, error)
  }
}

function parseJson(data: Buffer, label: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(data.toString('utf8'))
    if (!isRecord(value)) throw new Error('not an object')
    return value
  } catch (error) {
    throw teamPackError('INVALID_FORMAT', `${label}格式无效`, error)
  }
}

function assertKeyDirectory(keyDir: string): void {
  if (!keyDir) throw teamPackError('INVALID_FORMAT', '团队密钥目录不能为空')
}

function assertBackupPath(path: string): void {
  if (!path) throw teamPackError('INVALID_FORMAT', '团队密钥备份路径不能为空')
}

function assertPassphrase(passphrase: string): void {
  if (typeof passphrase !== 'string' || passphrase.length < 1 || passphrase.length > 1024) {
    throw teamPackError('INVALID_FORMAT', '团队密钥备份口令格式无效')
  }
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
