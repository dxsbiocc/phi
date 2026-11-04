import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Encrypter } from 'age-encryption'

import type { TeamResourceMap } from '../packages/installer-types'
import { registryKeyId } from '../packages/signature'
import { isTeamPackError, teamPackError } from './errors'
import { assertManagedDirectory, assertManagedFile, writeAtomic } from './files'
import { validateAnnouncementText, validateTeamResourceMap } from './format'
import { assertRelease, assertX25519Recipient } from './validation'

export const TEAM_ROSTER_FILE_NAME = 'roster.json'

const MAX_MEMBERS = 10_000
const MAX_RELEASES = 10_000
const MAX_RELEASE_MEMBERS = 10_000

export interface RosterMember {
  memberId: string
  displayName: string
  recipient: string
  signingPublicKey?: string
  addedAt: string
  removedAt?: string
}

export interface RosterRelease {
  release: number
  publishedAt: string
  memberIds: string[]
  withdrawn: boolean
  announcement?: string
  resources?: TeamResourceMap
}

export interface TeamRoster {
  version: 1
  members: RosterMember[]
  releases: RosterRelease[]
}

export type AddRosterMemberInput = Omit<RosterMember, 'removedAt'>

export function readTeamRoster(directory: string): TeamRoster {
  assertDirectory(directory)
  const path = join(directory, TEAM_ROSTER_FILE_NAME)
  assertManagedDirectory(directory, '团队成员表目录')
  assertManagedFile(path, '团队成员表文件')

  let data: Buffer
  try {
    data = readFileSync(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return emptyRoster()
    throw teamPackError('STORE_UNAVAILABLE', '无法读取团队成员表', error)
  }

  try {
    return parseRoster(JSON.parse(data.toString('utf8')) as unknown)
  } catch (error) {
    if (isTeamPackError(error)) throw error
    throw teamPackError('INVALID_FORMAT', '团队成员表不是有效 JSON', error)
  }
}

export function addRosterMember(directory: string, input: AddRosterMemberInput): RosterMember {
  const member = parseMember(input, false)
  const roster = readTeamRoster(directory)
  if (roster.members.some((entry) => entry.memberId === member.memberId)) {
    invalid('成员标识重复')
  }
  if (roster.members.some((entry) => entry.recipient === member.recipient)) {
    invalid('成员接收方重复')
  }
  if (
    member.signingPublicKey &&
    roster.members.some((entry) => entry.signingPublicKey === member.signingPublicKey)
  ) {
    invalid('成员签名公钥重复')
  }
  if (roster.members.length >= MAX_MEMBERS) invalid('成员数量超过上限')

  roster.members.push(member)
  writeRoster(directory, roster)
  return member
}

export function removeRosterMember(
  directory: string,
  memberId: string,
  removedAt = new Date().toISOString()
): RosterMember {
  assertMemberId(memberId)
  assertTimestamp(removedAt, '移除时间')
  const roster = readTeamRoster(directory)
  const member = roster.members.find((entry) => entry.memberId === memberId)
  if (!member) invalid('成员不存在')
  if (member.removedAt !== undefined) invalid('成员已经移除')
  if (removedAt < member.addedAt) invalid('移除时间不能早于加入时间')

  member.removedAt = removedAt
  writeRoster(directory, roster)
  return member
}

export function upgradeRosterMemberSigningKey(
  directory: string,
  recipient: string,
  signingPublicKey: string
): RosterMember {
  assertRecipient(recipient)
  assertSigningPublicKey(signingPublicKey)
  const roster = readTeamRoster(directory)
  const member = roster.members.find((entry) => entry.recipient === recipient)
  if (!member || member.removedAt !== undefined || member.signingPublicKey !== undefined) {
    invalid('只有当前旧版成员可以升级签名公钥')
  }
  if (roster.members.some((entry) => entry.signingPublicKey === signingPublicKey)) {
    invalid('成员签名公钥重复')
  }
  member.signingPublicKey = signingPublicKey
  writeRoster(directory, roster)
  return member
}

export function listCurrentRosterMembers(directory: string): RosterMember[] {
  return readTeamRoster(directory).members.filter((member) => member.removedAt === undefined)
}

export function recordRosterRelease(directory: string, input: RosterRelease): RosterRelease {
  const release = parseReleaseRecord(input)
  const roster = readTeamRoster(directory)
  if (roster.releases.some((entry) => entry.release === release.release)) {
    invalid('发布版本重复')
  }
  if (roster.releases.length >= MAX_RELEASES) invalid('发布记录数量超过上限')

  const currentMemberIds = new Set(
    roster.members
      .filter((member) => member.removedAt === undefined)
      .map((member) => member.memberId)
  )
  if (release.memberIds.some((memberId) => !currentMemberIds.has(memberId))) {
    invalid('发布记录只能引用当前成员')
  }

  roster.releases.push(release)
  writeRoster(directory, roster)
  return release
}

function writeRoster(directory: string, roster: TeamRoster): void {
  parseRoster(roster)
  const path = join(directory, TEAM_ROSTER_FILE_NAME)
  assertManagedDirectory(directory, '团队成员表目录')
  assertManagedFile(path, '团队成员表文件')
  try {
    writeAtomic(path, Buffer.from(`${JSON.stringify(roster, null, 2)}\n`), 0o600)
  } catch (error) {
    throw teamPackError('STORE_UNAVAILABLE', '无法写入团队成员表', error)
  }
}

function parseRoster(value: unknown): TeamRoster {
  if (!isRecord(value)) invalid('团队成员表格式无效')
  assertExactKeys(value, ['version', 'members', 'releases'], '团队成员表')
  if (value.version !== 1 || !Array.isArray(value.members) || !Array.isArray(value.releases)) {
    invalid('团队成员表格式无效')
  }
  if (value.members.length > MAX_MEMBERS) invalid('成员数量超过上限')
  if (value.releases.length > MAX_RELEASES) invalid('发布记录数量超过上限')

  const members = value.members.map((member) => parseMember(member, true))
  const releases = value.releases.map(parseReleaseRecord)
  assertUnique(
    members.map((member) => member.memberId),
    '成员标识重复'
  )
  assertUnique(
    members.map((member) => member.recipient),
    '成员接收方重复'
  )
  assertUnique(
    members.flatMap((member) => (member.signingPublicKey ? [member.signingPublicKey] : [])),
    '成员签名公钥重复'
  )
  assertUnique(
    releases.map((release) => release.release),
    '发布版本重复'
  )

  const membersById = new Map(members.map((member) => [member.memberId, member]))
  for (const release of releases) {
    for (const memberId of release.memberIds) {
      const member = membersById.get(memberId)
      if (!member) invalid('发布记录引用未知成员')
      if (release.publishedAt < member.addedAt) invalid('发布时间早于成员加入时间')
      if (member.removedAt !== undefined && release.publishedAt > member.removedAt) {
        invalid('发布记录引用当时已移除的成员')
      }
    }
  }

  return { version: 1, members, releases }
}

function parseMember(value: unknown, allowRemovedAt: boolean): RosterMember {
  if (!isRecord(value)) invalid('成员格式无效')
  assertExactKeys(
    value,
    allowRemovedAt
      ? ['memberId', 'displayName', 'recipient', 'signingPublicKey', 'addedAt', 'removedAt']
      : ['memberId', 'displayName', 'recipient', 'signingPublicKey', 'addedAt'],
    '成员'
  )
  assertMemberId(value.memberId)
  assertDisplayName(value.displayName)
  assertRecipient(value.recipient)
  assertTimestamp(value.addedAt, '加入时间')

  const member: RosterMember = {
    memberId: value.memberId,
    displayName: value.displayName,
    recipient: value.recipient,
    addedAt: value.addedAt
  }
  if (value.signingPublicKey !== undefined) {
    assertSigningPublicKey(value.signingPublicKey)
    member.signingPublicKey = value.signingPublicKey
  }
  if ('removedAt' in value) {
    if (!allowRemovedAt) invalid('新增成员不能包含移除时间')
    assertTimestamp(value.removedAt, '移除时间')
    if (value.removedAt < value.addedAt) invalid('移除时间不能早于加入时间')
    member.removedAt = value.removedAt
  }
  return member
}

function parseReleaseRecord(value: unknown): RosterRelease {
  if (!isRecord(value)) invalid('发布记录格式无效')
  assertExactKeys(
    value,
    ['release', 'publishedAt', 'memberIds', 'withdrawn', 'announcement', 'resources'],
    '发布记录'
  )
  assertRelease(value.release)
  assertTimestamp(value.publishedAt, '发布时间')
  if (
    !Array.isArray(value.memberIds) ||
    value.memberIds.length < 1 ||
    value.memberIds.length > MAX_RELEASE_MEMBERS ||
    typeof value.withdrawn !== 'boolean'
  ) {
    invalid('发布记录格式无效')
  }
  const memberIds = value.memberIds.map((memberId) => {
    assertMemberId(memberId)
    return memberId
  })
  assertUnique(memberIds, '发布记录包含重复成员')
  const announcement =
    value.announcement === undefined ? undefined : validateAnnouncementText(value.announcement)
  const resources =
    value.resources === undefined ? undefined : validateTeamResourceMap(value.resources)
  return {
    release: value.release,
    publishedAt: value.publishedAt,
    memberIds,
    withdrawn: value.withdrawn,
    ...(announcement === undefined ? {} : { announcement }),
    ...(resources === undefined ? {} : { resources })
  }
}

function assertDirectory(value: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) invalid('成员表目录不能为空')
}

function assertMemberId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    invalid('成员标识格式无效')
  }
}

function assertDisplayName(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 100 ||
    hasControlCharacter(value)
  ) {
    invalid('成员显示名称格式无效')
  }
}

function assertRecipient(value: unknown): asserts value is string {
  assertX25519Recipient(value)
  if (!/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(value)) {
    invalid('成员接收方必须是 age X25519 公钥')
  }
  try {
    new Encrypter().addRecipient(value)
  } catch {
    invalid('成员接收方必须是有效的 age X25519 公钥')
  }
}

function assertSigningPublicKey(value: unknown): asserts value is string {
  if (typeof value !== 'string') invalid('成员签名公钥格式无效')
  try {
    if (!/^[a-f0-9]{16}$/.test(registryKeyId(value))) {
      invalid('成员签名公钥格式无效')
    }
  } catch {
    invalid('成员签名公钥格式无效')
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') invalid(`${label}格式无效`)
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    invalid(`${label}格式无效`)
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: string[],
  label: string
): void {
  const allowed = new Set(allowedKeys)
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid(`${label}包含未知字段`)
}

function assertUnique(values: Array<string | number>, message: string): void {
  if (new Set(values).size !== values.length) invalid(message)
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
}

function emptyRoster(): TeamRoster {
  return { version: 1, members: [], releases: [] }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(message: string): never {
  throw teamPackError('INVALID_FORMAT', message)
}
