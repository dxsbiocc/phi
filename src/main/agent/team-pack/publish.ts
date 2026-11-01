import { randomUUID } from 'node:crypto'
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
  parseLatestFile,
  parseReleaseManifest,
  parseTeamFile,
  sha256,
  type InnerFile,
  type LatestFile,
  type ReleaseManifest,
  type TeamFile
} from './format'
import type { TeamKeys } from './keys'
import { signTeamFile, verifyTeamFile } from './signing'
import { assertIsoDate, assertTeamId, assertTeamName, assertX25519Recipient } from './validation'

const MAX_PUBLISH_PAYLOAD_BYTES = 128 * 1024 * 1024

export interface PublishTeamReleaseOptions {
  storeDir: string
  team: TeamKeys
  members: readonly string[]
  registryDir: string
  createdAt?: Date | string
  revoked?: readonly number[]
}

export interface PublishedTeamRelease {
  release: number
  payloadBytes: number
  manifestSha256: string
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
  const createdAt = normalizeCreatedAt(options.createdAt)
  validateRegistry(options.registryDir)
  mkdirSync(options.storeDir, { recursive: true })
  assertManagedDirectory(options.storeDir, '团队包存储目录')
  ensureTeamFile(options.storeDir, options.team)

  const previous = readPreviousLatest(options.storeDir, options.team)
  const release = (previous?.release ?? 0) + 1
  const releasesDir = join(options.storeDir, 'releases')
  assertManagedChildDirectory(options.storeDir, releasesDir, '发布根目录')
  mkdirSync(releasesDir, { recursive: true })
  assertManagedChildDirectory(options.storeDir, releasesDir, '发布根目录')
  const targetDir = join(releasesDir, String(release))
  assertManagedDirectory(targetDir, '目标发布目录')
  if (existsSync(targetDir)) {
    throw teamPackError('INVALID_FORMAT', `发布版本 ${release} 已存在且不可覆盖`)
  }

  const inner: InnerFile = { version: 1, teamId: options.team.teamId, release }
  const archive = createDeterministicTarGz([
    { path: 'inner.json', data: jsonBytes(inner) },
    ...collectArchiveFiles(options.registryDir, 'registry')
  ])
  const payload = await encryptArchive(archive, members)
  if (payload.length > MAX_PUBLISH_PAYLOAD_BYTES) {
    throw teamPackError('INVALID_FORMAT', '加密团队包超过 L0 大小限制')
  }

  const manifest: ReleaseManifest = {
    version: 1,
    teamId: options.team.teamId,
    release,
    payloadSha256: sha256(payload),
    payloadBytes: payload.length,
    createdAt,
    ...(options.revoked ? { revoked: [...options.revoked] } : {})
  }
  const manifestBytes = jsonBytes(manifest)
  parseReleaseManifest(manifestBytes, MAX_PUBLISH_PAYLOAD_BYTES)
  const manifestSignature = signTeamFile(manifestBytes, options.team.privateKey)

  const temporaryDir = join(releasesDir, `.${release}.${process.pid}.${randomUUID()}.tmp`)
  mkdirSync(temporaryDir)
  try {
    writeFileSync(join(temporaryDir, 'manifest.json'), manifestBytes)
    writeFileSync(join(temporaryDir, 'manifest.sig.json'), manifestSignature)
    writeFileSync(join(temporaryDir, 'payload.age'), payload)
    renameSync(temporaryDir, targetDir)
  } catch (error) {
    rmSync(temporaryDir, { recursive: true, force: true })
    if (isTeamPackError(error)) throw error
    throw teamPackError('STORE_UNAVAILABLE', '无法写入团队包发布目录', error)
  }

  const latest: LatestFile = {
    version: 1,
    teamId: options.team.teamId,
    release,
    manifestSha256: sha256(manifestBytes),
    createdAt
  }
  const latestBytes = jsonBytes(latest)
  const latestSignature = signTeamFile(latestBytes, options.team.privateKey)
  try {
    writeAtomic(join(options.storeDir, 'latest.sig.json'), latestSignature)
    writeAtomic(join(options.storeDir, 'latest.json'), latestBytes)
  } catch (error) {
    throw teamPackError('STORE_UNAVAILABLE', '无法更新团队包 latest 指针', error)
  }
  return { release, payloadBytes: payload.length, manifestSha256: latest.manifestSha256 }
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
  const signaturePath = join(storeDir, 'latest.sig.json')
  assertManagedFile(latestPath, 'latest.json')
  assertManagedFile(signaturePath, 'latest.sig.json')
  const hasLatest = existsSync(latestPath)
  const hasSignature = existsSync(signaturePath)
  if (!hasLatest && !hasSignature) return null
  if (!hasLatest || !hasSignature) {
    throw teamPackError('INVALID_FORMAT', 'latest 指针不完整')
  }
  const latestBytes = readFileSync(latestPath)
  verifyTeamFile(latestBytes, readFileSync(signaturePath), team.publicKey, team.keyId)
  const latest = parseLatestFile(latestBytes)
  if (latest.teamId !== team.teamId) {
    throw teamPackError('INVALID_FORMAT', 'latest.json 的团队标识不匹配')
  }
  return latest
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
