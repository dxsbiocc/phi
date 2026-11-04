import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isTeamPackError, teamPackError } from './errors'
import { assertManagedDirectory, assertManagedFile, writeAtomic } from './files'
import { validateModelKeyGrants, type ModelKeyGrant } from './format'
import type { SafeStorageLike } from './key-store'
import { readTeamRoster, type RosterMember } from './roster'

export const ADMIN_MODEL_GRANTS_FILE = 'model-grants.enc'

const MAX_MEMBERS = 10_000
const MAX_ENCRYPTED_BYTES = 64 * 1024 * 1024

export interface AdminMemberModelGrant {
  memberId: string
  models: ModelKeyGrant[]
}

export interface AdminModelGrantMetadata {
  providerId: string
  label: string
}

export interface AdminMemberModelGrantMetadata {
  memberId: string
  models: AdminModelGrantMetadata[]
}

export interface PreparedAdminModelGrants {
  encrypted: Buffer
}

interface AdminModelGrantFile {
  version: 1
  grants: Record<string, ModelKeyGrant[]>
}

export function readAdminModelGrants(
  teamDirectory: string,
  safeStorage: SafeStorageLike
): AdminMemberModelGrant[] {
  const path = grantFilePath(teamDirectory)
  assertManagedDirectory(teamDirectory, '模型子 key 目录')
  assertManagedFile(path, '模型子 key 加密文件')
  if (!existsSync(path)) return []

  let encrypted: Buffer
  try {
    const stat = lstatSync(path)
    if (stat.size < 1 || stat.size > MAX_ENCRYPTED_BYTES) {
      throw teamPackError('INVALID_FORMAT', '模型子 key 加密文件大小无效')
    }
    encrypted = readFileSync(path)
  } catch (error) {
    if (isTeamPackError(error)) throw error
    throw teamPackError('STORE_UNAVAILABLE', '无法读取模型子 key 加密文件', error)
  }

  assertSafeStorageAvailable(safeStorage)
  let plaintext: string
  try {
    plaintext = safeStorage.decryptString(encrypted)
  } catch (error) {
    throw teamPackError('STORE_UNAVAILABLE', '无法使用系统加密存储解密模型子 key', error)
  }

  return parseGrantFile(plaintext)
}

export function writeAdminModelGrants(
  teamDirectory: string,
  safeStorage: SafeStorageLike,
  grants: readonly AdminMemberModelGrant[]
): void {
  commitPreparedAdminModelGrants(teamDirectory, prepareAdminModelGrants(safeStorage, grants))
}

export function prepareAdminModelGrants(
  safeStorage: SafeStorageLike,
  grants: readonly AdminMemberModelGrant[]
): PreparedAdminModelGrants {
  const normalized = normalizeEntries(grants)
  assertSafeStorageAvailable(safeStorage)

  const serialized: AdminModelGrantFile = {
    version: 1,
    grants: Object.fromEntries(normalized.map((entry) => [entry.memberId, entry.models]))
  }
  let encrypted: Buffer
  try {
    encrypted = safeStorage.encryptString(JSON.stringify(serialized))
    if (!Buffer.isBuffer(encrypted) || encrypted.length < 1) throw new Error('empty ciphertext')
    if (encrypted.length > MAX_ENCRYPTED_BYTES) {
      throw teamPackError('INVALID_FORMAT', '模型子 key 加密文件超过大小限制')
    }
  } catch (error) {
    if (isTeamPackError(error)) throw error
    throw teamPackError('STORE_UNAVAILABLE', '无法使用系统加密存储保护模型子 key', error)
  }

  return { encrypted }
}

export function commitPreparedAdminModelGrants(
  teamDirectory: string,
  prepared: PreparedAdminModelGrants
): void {
  if (
    !prepared ||
    typeof prepared !== 'object' ||
    !Buffer.isBuffer(prepared.encrypted) ||
    prepared.encrypted.length < 1 ||
    prepared.encrypted.length > MAX_ENCRYPTED_BYTES
  ) {
    throw teamPackError('INVALID_FORMAT', '待提交的模型子 key 密文格式无效')
  }
  const path = grantFilePath(teamDirectory)
  assertManagedDirectory(teamDirectory, '模型子 key 目录')
  assertManagedFile(path, '模型子 key 加密文件')
  try {
    writeAtomic(path, prepared.encrypted, 0o600)
  } catch (error) {
    throw teamPackError('STORE_UNAVAILABLE', '无法写入模型子 key 加密文件', error)
  }
}

export function applyAdminModelGrantUpdates(
  current: readonly AdminMemberModelGrant[],
  updates: readonly AdminMemberModelGrant[]
): AdminMemberModelGrant[] {
  if (!Array.isArray(updates) || updates.length > MAX_MEMBERS) {
    throw teamPackError('INVALID_FORMAT', '模型子 key 更新格式无效')
  }
  const updated = new Map(normalizeEntries(current).map((entry) => [entry.memberId, entry.models]))
  const seen = new Set<string>()
  for (const entry of updates) {
    const normalized = normalizeEntry(entry)
    if (seen.has(normalized.memberId)) {
      throw teamPackError('INVALID_FORMAT', `模型子 key 成员重复: ${normalized.memberId}`)
    }
    seen.add(normalized.memberId)
    if (normalized.models.length === 0) updated.delete(normalized.memberId)
    else updated.set(normalized.memberId, normalized.models)
  }
  return entriesFromMap(updated)
}

export function removeAdminModelGrants(
  current: readonly AdminMemberModelGrant[],
  memberId: string,
  providerId?: string
): AdminMemberModelGrant[] {
  assertMemberId(memberId)
  const updated = new Map(normalizeEntries(current).map((entry) => [entry.memberId, entry.models]))
  if (providerId === undefined) {
    updated.delete(memberId)
    return entriesFromMap(updated)
  }

  assertProviderId(providerId)
  const remaining = updated.get(memberId)?.filter((model) => model.providerId !== providerId) ?? []
  if (remaining.length === 0) updated.delete(memberId)
  else updated.set(memberId, remaining)
  return entriesFromMap(updated)
}

export function modelGrantMetadata(
  grants: readonly AdminMemberModelGrant[]
): AdminMemberModelGrantMetadata[] {
  return normalizeEntries(grants).map(({ memberId, models }) => ({
    memberId,
    models: models.map(({ providerId, label }) => ({ providerId, label }))
  }))
}

export function setAdminMemberModelGrants(
  teamDirectory: string,
  safeStorage: SafeStorageLike,
  memberId: string,
  models: readonly ModelKeyGrant[]
): AdminMemberModelGrantMetadata {
  assertCurrentGrantMember(teamDirectory, memberId)
  const updated = applyAdminModelGrantUpdates(readAdminModelGrants(teamDirectory, safeStorage), [
    { memberId, models: models as ModelKeyGrant[] }
  ])
  writeAdminModelGrants(teamDirectory, safeStorage, updated)
  return metadataForMember(updated, memberId)
}

export function deleteAdminMemberModelGrants(
  teamDirectory: string,
  safeStorage: SafeStorageLike,
  memberId: string,
  providerId?: string
): AdminMemberModelGrantMetadata {
  assertCurrentGrantMember(teamDirectory, memberId)
  const current = readAdminModelGrants(teamDirectory, safeStorage)
  const updated = removeAdminModelGrants(current, memberId, providerId)
  if (JSON.stringify(updated) !== JSON.stringify(current)) {
    writeAdminModelGrants(teamDirectory, safeStorage, updated)
  }
  return metadataForMember(updated, memberId)
}

export function readCurrentAdminModelGrants(
  teamDirectory: string,
  safeStorage: SafeStorageLike
): AdminMemberModelGrant[] {
  const memberIds = new Set(currentGrantMembers(teamDirectory).map((member) => member.memberId))
  return readAdminModelGrants(teamDirectory, safeStorage).filter((grant) =>
    memberIds.has(grant.memberId)
  )
}

export function currentAdminModelGrantMetadata(
  teamDirectory: string,
  safeStorage: SafeStorageLike
): AdminMemberModelGrantMetadata[] {
  const metadata = new Map(
    modelGrantMetadata(readAdminModelGrants(teamDirectory, safeStorage)).map((entry) => [
      entry.memberId,
      entry.models
    ])
  )
  return currentGrantMembers(teamDirectory).map((member) => ({
    memberId: member.memberId,
    models: metadata.get(member.memberId) ?? []
  }))
}

export function assertAdminGrantMembersAreCurrent(
  teamDirectory: string,
  grants: readonly AdminMemberModelGrant[]
): void {
  for (const grant of normalizeEntries(grants)) {
    assertCurrentGrantMember(teamDirectory, grant.memberId)
  }
}

function parseGrantFile(plaintext: string): AdminMemberModelGrant[] {
  let value: unknown
  try {
    value = JSON.parse(plaintext) as unknown
  } catch (error) {
    throw teamPackError('INVALID_FORMAT', '模型子 key 加密内容不是有效 JSON', error)
  }
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'grants']) || value.version !== 1) {
    throw teamPackError('INVALID_FORMAT', '模型子 key 加密内容格式无效')
  }
  if (!isRecord(value.grants)) {
    throw teamPackError('INVALID_FORMAT', '模型子 key 加密内容格式无效')
  }
  return normalizeEntries(
    Object.entries(value.grants).map(([memberId, models]) => ({ memberId, models }))
  )
}

function normalizeEntries(grants: readonly unknown[]): AdminMemberModelGrant[] {
  if (!Array.isArray(grants) || grants.length > MAX_MEMBERS) {
    throw teamPackError('INVALID_FORMAT', '模型子 key 成员数量超过限制')
  }
  const normalized = grants.map(normalizeEntry)
  if (new Set(normalized.map((entry) => entry.memberId)).size !== normalized.length) {
    throw teamPackError('INVALID_FORMAT', '模型子 key 成员重复')
  }
  return normalized.sort((left, right) => left.memberId.localeCompare(right.memberId))
}

function normalizeEntry(value: unknown): AdminMemberModelGrant {
  if (!isRecord(value) || !hasExactKeys(value, ['memberId', 'models'])) {
    throw teamPackError('INVALID_FORMAT', '模型子 key 成员配置格式无效')
  }
  assertMemberId(value.memberId)
  if (!Array.isArray(value.models)) {
    throw teamPackError('INVALID_FORMAT', '模型子 key 成员配置格式无效')
  }
  return { memberId: value.memberId, models: validateModelKeyGrants(value.models) }
}

function entriesFromMap(grants: ReadonlyMap<string, ModelKeyGrant[]>): AdminMemberModelGrant[] {
  return [...grants]
    .map(([memberId, models]) => ({ memberId, models }))
    .sort((left, right) => left.memberId.localeCompare(right.memberId))
}

function metadataForMember(
  grants: readonly AdminMemberModelGrant[],
  memberId: string
): AdminMemberModelGrantMetadata {
  return (
    modelGrantMetadata(grants).find((entry) => entry.memberId === memberId) ?? {
      memberId,
      models: []
    }
  )
}

function assertCurrentGrantMember(teamDirectory: string, memberId: string): RosterMember {
  const member = readTeamRoster(teamDirectory).members.find((entry) => entry.memberId === memberId)
  if (!member || member.removedAt !== undefined) {
    throw teamPackError('INVALID_FORMAT', `模型子 key 的接收成员不存在或已移除: ${memberId}`)
  }
  return member
}

function currentGrantMembers(teamDirectory: string): RosterMember[] {
  return readTeamRoster(teamDirectory).members.filter((member) => member.removedAt === undefined)
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
    throw teamPackError('STORE_UNAVAILABLE', '系统加密存储不可用，拒绝以明文保存模型子 key')
  }
}

function assertMemberId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw teamPackError('INVALID_FORMAT', '模型子 key 成员标识格式无效')
  }
}

function assertProviderId(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 100 ||
    value.trim() !== value ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    throw teamPackError('INVALID_FORMAT', '模型 provider 标识格式无效')
  }
}

function grantFilePath(teamDirectory: string): string {
  if (typeof teamDirectory !== 'string' || teamDirectory.length === 0) {
    throw teamPackError('INVALID_FORMAT', '模型子 key 目录不能为空')
  }
  return join(teamDirectory, ADMIN_MODEL_GRANTS_FILE)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
