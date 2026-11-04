import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Encrypter } from 'age-encryption'

import { createDeterministicTarGz } from '../packages/archive'
import { readRegistry } from '../packages/registry'
import { publicKeyPem, registryKeyId } from '../packages/signature'
import { teamPackError, isTeamPackError } from './errors'
import {
  assertManagedChildDirectory,
  assertManagedDirectory,
  assertManagedFile,
  collectArchiveFiles,
  writeAtomic
} from './files'
import {
  jsonBytes,
  parseReleaseManifest,
  parseSignedLatestFile,
  parseTeamFile,
  sha256,
  validateModelKeyGrants,
  type GrantFile,
  type GrantPlaintext,
  type InnerFile,
  type LatestFile,
  type ModelKeyGrant,
  type ReleaseManifest,
  type TeamFile
} from './format'
import type { TeamKeys } from './keys'
import { signTeamFile, verifyTeamFile } from './signing'
import { assertIsoDate, assertTeamId, assertTeamName, assertX25519Recipient } from './validation'

const MAX_PUBLISH_PAYLOAD_BYTES = 128 * 1024 * 1024
const MAX_GRANT_FILES = 256
const MAX_GRANT_BYTES = 256 * 1024

export type { ModelKeyGrant } from './format'

export interface MemberModelGrant {
  recipient: string
  models: ModelKeyGrant[]
}

export interface PublishTeamReleaseOptions {
  storeDir: string
  team: TeamKeys
  members: readonly string[]
  grants?: readonly MemberModelGrant[]
  registryDir: string
  createdAt?: Date | string
  withdrawReleases?: readonly number[]
}

export interface PublishedTeamRelease {
  release: number
  payloadBytes: number
  manifestSha256: string
}

interface EncryptedGrant {
  file: GrantFile
  data: Buffer
}

export async function publishTeamRelease(
  options: PublishTeamReleaseOptions
): Promise<PublishedTeamRelease> {
  try {
    return await publishTeamReleaseInternal(options)
  } catch (error) {
    if (isTeamPackError(error)) throw error
    throw teamPackError('STORE_UNAVAILABLE', '团队包发布失败', error)
  }
}

async function publishTeamReleaseInternal(
  options: PublishTeamReleaseOptions
): Promise<PublishedTeamRelease> {
  validatePublisher(options.team)
  const members = [...new Set(options.members)]
  if (members.length === 0) {
    throw teamPackError('INVALID_FORMAT', '团队发布至少需要一名接收成员')
  }
  for (const member of members) assertX25519Recipient(member)
  const grants = validateGrants(options.grants ?? [], new Set(members))
  const createdAt = normalizeCreatedAt(options.createdAt)
  validateRegistry(options.registryDir)
  mkdirSync(options.storeDir, { recursive: true })
  assertManagedDirectory(options.storeDir, '团队包存储目录')
  ensureTeamFile(options.storeDir, options.team)

  const previous = readPreviousLatest(options.storeDir, options.team)
  const previousManifest = previous
    ? readPreviousManifest(options.storeDir, options.team, previous)
    : null
  const release = (previous?.release ?? 0) + 1
  const { releasesDir, targetDir } = prepareReleaseDirectory(options.storeDir, release)

  const inner: InnerFile = { version: 1, teamId: options.team.teamId, release }
  const archive = createDeterministicTarGz([
    { path: 'inner.json', data: jsonBytes(inner) },
    ...collectArchiveFiles(options.registryDir, 'registry')
  ])
  const payload = await encryptArchive(archive, members)
  if (payload.length > MAX_PUBLISH_PAYLOAD_BYTES) {
    throw teamPackError('INVALID_FORMAT', '加密团队包超过 L0 大小限制')
  }

  const encryptedGrants = await encryptGrants(grants, options.team.teamId, release)
  const withdrawnReleases = normalizeWithdrawnReleases(
    options.withdrawReleases ?? [],
    previousManifest?.withdrawnReleases ?? [],
    release
  )
  const manifest: ReleaseManifest = {
    version: 1,
    teamId: options.team.teamId,
    release,
    payloadSha256: sha256(payload),
    payloadBytes: payload.length,
    createdAt,
    grants: encryptedGrants.map(({ file }) => file),
    withdrawnReleases
  }
  const manifestBytes = jsonBytes(manifest)
  parseReleaseManifest(manifestBytes, MAX_PUBLISH_PAYLOAD_BYTES)
  const manifestSignature = signTeamFile(manifestBytes, options.team.privateKey)

  commitPublishedRelease({
    releasesDir,
    targetDir,
    release,
    manifestBytes,
    manifestSignature,
    payload,
    encryptedGrants
  })

  const latest: LatestFile = {
    version: 1,
    teamId: options.team.teamId,
    release,
    manifestSha256: sha256(manifestBytes),
    createdAt
  }
  const pointerBytes = jsonBytes(latest)
  const signature = JSON.parse(
    signTeamFile(pointerBytes, options.team.privateKey).toString('utf8')
  ) as unknown
  const latestBytes = jsonBytes({ pointer: latest, signature })
  try {
    writeAtomic(join(options.storeDir, 'latest.json'), latestBytes)
  } catch (error) {
    throw teamPackError('STORE_UNAVAILABLE', '无法更新团队包 latest 指针', error)
  }
  return { release, payloadBytes: payload.length, manifestSha256: latest.manifestSha256 }
}

function prepareReleaseDirectory(
  storeDir: string,
  release: number
): { releasesDir: string; targetDir: string } {
  const releasesDir = join(storeDir, 'releases')
  assertManagedChildDirectory(storeDir, releasesDir, '发布根目录')
  mkdirSync(releasesDir, { recursive: true })
  assertManagedChildDirectory(storeDir, releasesDir, '发布根目录')
  const targetDir = join(releasesDir, String(release))
  assertManagedDirectory(targetDir, '目标发布目录')
  if (existsSync(targetDir)) {
    throw teamPackError('INVALID_FORMAT', `发布版本 ${release} 已存在且不可覆盖`)
  }
  return { releasesDir, targetDir }
}

function commitPublishedRelease(options: {
  releasesDir: string
  targetDir: string
  release: number
  manifestBytes: Buffer
  manifestSignature: Buffer
  payload: Buffer
  encryptedGrants: EncryptedGrant[]
}): void {
  const temporaryDir = join(
    options.releasesDir,
    `.${options.release}.${process.pid}.${randomUUID()}.tmp`
  )
  mkdirSync(temporaryDir)
  try {
    writeFileSync(join(temporaryDir, 'manifest.json'), options.manifestBytes)
    writeFileSync(join(temporaryDir, 'manifest.sig.json'), options.manifestSignature)
    writeFileSync(join(temporaryDir, 'payload.age'), options.payload)
    writeEncryptedGrants(temporaryDir, options.encryptedGrants)
    renameSync(temporaryDir, options.targetDir)
  } catch (error) {
    rmSync(temporaryDir, { recursive: true, force: true })
    if (isTeamPackError(error)) throw error
    throw teamPackError('STORE_UNAVAILABLE', '无法写入团队包发布目录', error)
  }
}

function writeEncryptedGrants(directory: string, grants: EncryptedGrant[]): void {
  if (grants.length === 0) return
  const grantsDir = join(directory, 'grants')
  mkdirSync(grantsDir)
  for (const grant of grants) writeFileSync(join(grantsDir, grant.file.name), grant.data)
}

function validatePublisher(team: TeamKeys): void {
  assertTeamId(team.teamId)
  assertTeamName(team.name)
  try {
    if (
      team.version !== 1 ||
      publicKeyPem(team.privateKey) !== team.publicKey ||
      registryKeyId(team.publicKey) !== team.keyId
    ) {
      throw new Error('key mismatch')
    }
  } catch {
    throw teamPackError('INVALID_FORMAT', '团队发布密钥无效')
  }
}

function validateRegistry(registryDir: string): void {
  try {
    readRegistry(registryDir)
  } catch (error) {
    throw teamPackError('INVALID_FORMAT', '待发布的软件源无效', error)
  }
}

function ensureTeamFile(storeDir: string, team: TeamKeys): void {
  const path = join(storeDir, 'team.json')
  assertManagedFile(path, 'team.json')
  const expected: TeamFile = {
    version: 1,
    teamId: team.teamId,
    name: team.name,
    publicKey: team.publicKey
  }
  if (existsSync(path)) {
    const actual = parseTeamFile(readFileSync(path))
    if (
      actual.teamId !== expected.teamId ||
      actual.name !== expected.name ||
      actual.publicKey !== expected.publicKey
    ) {
      throw teamPackError('UNTRUSTED_TEAM_KEY', '存储中的 team.json 与发布团队不匹配')
    }
    return
  }
  try {
    writeAtomic(path, jsonBytes(expected))
  } catch (error) {
    throw teamPackError('STORE_UNAVAILABLE', '无法写入 team.json', error)
  }
}

function readPreviousLatest(storeDir: string, team: TeamKeys): LatestFile | null {
  const latestPath = join(storeDir, 'latest.json')
  assertManagedFile(latestPath, 'latest.json')
  if (!existsSync(latestPath)) return null
  const latestBytes = readFileSync(latestPath)
  const signedLatest = parseSignedLatestFile(latestBytes)
  verifyTeamFile(signedLatest.pointerBytes, signedLatest.signatureBytes, team.publicKey, team.keyId)
  const latest = signedLatest.pointer
  if (latest.teamId !== team.teamId) {
    throw teamPackError('INVALID_FORMAT', 'latest.json 的团队标识不匹配')
  }
  return latest
}

function readPreviousManifest(
  storeDir: string,
  team: TeamKeys,
  latest: LatestFile
): ReleaseManifest {
  const manifestPath = join(storeDir, 'releases', String(latest.release), 'manifest.json')
  const signaturePath = join(storeDir, 'releases', String(latest.release), 'manifest.sig.json')
  assertManagedFile(manifestPath, '上一版本 manifest.json')
  assertManagedFile(signaturePath, '上一版本 manifest.sig.json')
  if (!existsSync(manifestPath) || !existsSync(signaturePath)) {
    throw teamPackError('INVALID_FORMAT', '上一版本发布记录不完整')
  }
  const manifestBytes = readFileSync(manifestPath)
  if (sha256(manifestBytes) !== latest.manifestSha256) {
    throw teamPackError('HASH_MISMATCH', '上一版本 manifest 哈希与 latest.json 不匹配')
  }
  verifyTeamFile(manifestBytes, readFileSync(signaturePath), team.publicKey, team.keyId)
  const manifest = parseReleaseManifest(manifestBytes, MAX_PUBLISH_PAYLOAD_BYTES)
  if (manifest.teamId !== team.teamId || manifest.release !== latest.release) {
    throw teamPackError('INVALID_FORMAT', '上一版本 manifest 与 latest.json 不匹配')
  }
  return manifest
}

function validateGrants(
  grants: readonly MemberModelGrant[],
  members: ReadonlySet<string>
): MemberModelGrant[] {
  if (grants.length > MAX_GRANT_FILES) {
    throw teamPackError('INVALID_FORMAT', '模型子 key grant 数量超过限制')
  }
  const recipients = new Set<string>()
  return grants.map((grant) => {
    if (!grant || typeof grant !== 'object' || Array.isArray(grant)) {
      throw teamPackError('INVALID_FORMAT', '模型子 key grant 格式无效')
    }
    const fields = Object.keys(grant).sort()
    if (fields.length !== 2 || fields[0] !== 'models' || fields[1] !== 'recipient') {
      throw teamPackError('INVALID_FORMAT', '模型子 key grant 包含未知字段')
    }
    assertX25519Recipient(grant.recipient)
    if (!members.has(grant.recipient)) {
      throw teamPackError('INVALID_FORMAT', '模型子 key grant 接收方不在本次发布成员中')
    }
    if (recipients.has(grant.recipient)) {
      throw teamPackError('INVALID_FORMAT', '同一接收方只能有一个模型子 key grant')
    }
    if (!Array.isArray(grant.models)) {
      throw teamPackError('INVALID_FORMAT', '模型子 key grant 格式无效')
    }
    recipients.add(grant.recipient)
    return { recipient: grant.recipient, models: validateModelKeyGrants(grant.models) }
  })
}

async function encryptGrants(
  grants: readonly MemberModelGrant[],
  teamId: string,
  release: number
): Promise<EncryptedGrant[]> {
  const names = new Set<string>()
  return await Promise.all(
    grants.map(async (grant) => {
      let name: string
      do name = `${randomBytes(16).toString('hex')}.age`
      while (names.has(name))
      names.add(name)
      const plaintext: GrantPlaintext = {
        version: 1,
        teamId,
        release,
        models: grant.models
      }
      const data = await encryptArchive(jsonBytes(plaintext), [grant.recipient])
      if (data.length > MAX_GRANT_BYTES) {
        throw teamPackError('INVALID_FORMAT', '单个模型子 key grant 超过大小限制')
      }
      return {
        file: { name, bytes: data.length, sha256: sha256(data) },
        data
      }
    })
  )
}

function normalizeWithdrawnReleases(
  values: readonly number[],
  previousValues: readonly number[],
  release: number
): number[] {
  const releases = [...values]
  for (const value of releases) {
    if (!Number.isSafeInteger(value) || value < 1 || value > release) {
      throw teamPackError('INVALID_FORMAT', '已撤回版本必须是不晚于当前发布的正整数')
    }
  }
  if (new Set(releases).size !== releases.length) {
    throw teamPackError('INVALID_FORMAT', '已撤回版本不能重复')
  }
  return [...new Set([...previousValues, ...releases])].sort((left, right) => left - right)
}

async function encryptArchive(archive: Buffer, recipients: string[]): Promise<Buffer> {
  try {
    const encrypter = new Encrypter()
    for (const recipient of recipients) {
      assertX25519Recipient(recipient)
      encrypter.addRecipient(recipient)
    }
    return Buffer.from(await encrypter.encrypt(archive))
  } catch (error) {
    throw teamPackError('INVALID_FORMAT', '成员 age 接收方格式无效', error)
  }
}

function normalizeCreatedAt(value: Date | string | undefined): string {
  const createdAt =
    value instanceof Date ? value.toISOString() : (value ?? new Date().toISOString())
  assertIsoDate(createdAt)
  return createdAt
}
