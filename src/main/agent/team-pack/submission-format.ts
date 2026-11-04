import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { Decrypter, Encrypter } from 'age-encryption'

import { createDeterministicTarGz, parseTarGz } from '../packages/archive'
import { assertSafePackagePath } from '../packages/installer-utils'
import type { LocalRegistry } from '../packages/installer-types'
import { validatePackage, type PackageType } from '../packages/manifest'
import { readRegistry } from '../packages/registry'
import { collectArchiveFiles, assertSafeArchiveEntry } from './files'
import { jsonBytes, sha256 } from './format'
import type { MemberKeys } from './keys'
import { signTeamFile, verifyTeamFile } from './signing'
import {
  assertIsoDate,
  assertTeamId,
  assertX25519Identity,
  assertX25519Recipient
} from './validation'

export const MAX_SUBMISSION_BYTES = 32 * 1024 * 1024
const MAX_SUBMISSION_EXPANDED_BYTES = 64 * 1024 * 1024
const MAX_SUBMISSION_PACKAGES = 10_000

export type SubmissionInvalidReason =
  'decrypt' | 'signature' | 'member' | 'team' | 'hash' | 'format' | 'size' | 'unknown'

export interface SubmissionPackageRecord {
  type: PackageType
  id: string
  version: string
  sha256: string
}

export interface SubmissionManifest {
  version: 1
  teamId: string
  submissionId: string
  memberSigningKeyId: string
  createdAt: string
  note?: string
  packages: SubmissionPackageRecord[]
}

export interface BuiltSubmission {
  submissionId: string
  memberSigningKeyId: string
  data: Buffer
  manifest: SubmissionManifest
}

export interface ExtractedSubmission {
  manifest: SubmissionManifest
  manifestBytes: Buffer
  signatureBytes: Buffer
  registry: LocalRegistry
  registryDir: string
}

export class TeamSubmissionError extends Error {
  readonly reason: SubmissionInvalidReason

  constructor(reason: SubmissionInvalidReason, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'TeamSubmissionError'
    this.reason = reason
  }
}

export async function buildEncryptedSubmission(options: {
  teamId: string
  submissionRecipient: string
  member: MemberKeys
  registryDir: string
  note?: string
  createdAt?: Date | string
  submissionId?: string
}): Promise<BuiltSubmission> {
  assertTeamId(options.teamId)
  assertX25519Recipient(options.submissionRecipient)
  const registry = readRegistry(options.registryDir)
  if (registry.packages.length < 1 || registry.packages.length > MAX_SUBMISSION_PACKAGES) {
    throw new TeamSubmissionError('format', '投稿必须包含至少一个有效资源')
  }
  const manifest = parseSubmissionManifest(
    jsonBytes({
      version: 1,
      teamId: options.teamId,
      submissionId: options.submissionId ?? randomUUID(),
      memberSigningKeyId: options.member.signingKeyId,
      createdAt: normalizeCreatedAt(options.createdAt),
      ...(options.note === undefined ? {} : { note: options.note }),
      packages: registry.packages.map(({ type, id, version, sha256: digest }) => ({
        type,
        id,
        version,
        sha256: digest
      }))
    })
  )
  const manifestBytes = jsonBytes(manifest)
  const signatureBytes = signTeamFile(manifestBytes, options.member.signingPrivateKey)
  const archive = createDeterministicTarGz([
    { path: 'submission.json', data: manifestBytes },
    { path: 'submission.sig.json', data: signatureBytes },
    ...collectArchiveFiles(options.registryDir, 'registry')
  ])
  let data: Buffer
  try {
    const encrypter = new Encrypter()
    encrypter.addRecipient(options.submissionRecipient)
    data = Buffer.from(await encrypter.encrypt(archive))
  } catch (error) {
    throw new TeamSubmissionError('format', '团队投稿收件公钥无效', error)
  }
  if (data.length > MAX_SUBMISSION_BYTES) {
    throw new TeamSubmissionError('size', '投稿超过 32 MiB 大小上限')
  }
  return {
    submissionId: manifest.submissionId,
    memberSigningKeyId: manifest.memberSigningKeyId,
    data,
    manifest
  }
}

export async function decryptSubmission(data: Buffer, identity: string): Promise<Buffer> {
  if (!Buffer.isBuffer(data) || data.length < 1) {
    throw new TeamSubmissionError('format', '投稿文件为空')
  }
  if (data.length > MAX_SUBMISSION_BYTES) {
    throw new TeamSubmissionError('size', '投稿超过 32 MiB 大小上限')
  }
  assertX25519Identity(identity)
  try {
    const decrypter = new Decrypter()
    decrypter.addIdentity(identity)
    return Buffer.from(await decrypter.decrypt(data))
  } catch (error) {
    throw new TeamSubmissionError('decrypt', '投稿无法由当前团队解密', error)
  }
}

export function extractSubmission(plaintext: Buffer, destination: string): ExtractedSubmission {
  let entries: ReturnType<typeof parseTarGz>
  try {
    entries = parseTarGz(plaintext, MAX_SUBMISSION_EXPANDED_BYTES)
  } catch (error) {
    throw new TeamSubmissionError('format', '投稿归档格式无效', error)
  }
  const seen = new Set<string>()
  let manifestBytes: Buffer | undefined
  let signatureBytes: Buffer | undefined
  const registryDir = join(destination, 'registry')
  mkdirSync(registryDir, { recursive: true, mode: 0o700 })
  try {
    for (const entry of entries) {
      assertSafeArchiveEntry(entry.path)
      if (seen.has(entry.path) || entry.type !== 'file') {
        throw new TeamSubmissionError('format', '投稿归档包含重复路径或非普通文件')
      }
      seen.add(entry.path)
      if (entry.path === 'submission.json') {
        manifestBytes = entry.data
        continue
      }
      if (entry.path === 'submission.sig.json') {
        signatureBytes = entry.data
        continue
      }
      if (!entry.path.startsWith('registry/')) {
        throw new TeamSubmissionError('format', '投稿归档包含未知路径')
      }
      const relative = entry.path.slice('registry/'.length)
      assertSafeArchiveEntry(relative)
      const target = join(registryDir, ...relative.split('/'))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, entry.data, { flag: 'wx', mode: entry.mode & 0o666 })
    }
    if (!manifestBytes || !signatureBytes || !seen.has('registry/index.json')) {
      throw new TeamSubmissionError('format', '投稿归档缺少清单、签名或软件源索引')
    }
    const manifest = parseSubmissionManifest(manifestBytes)
    let registry: LocalRegistry
    try {
      registry = readRegistry(registryDir)
    } catch (error) {
      throw new TeamSubmissionError('format', '投稿软件源格式无效', error)
    }
    return { manifest, manifestBytes, signatureBytes, registry, registryDir }
  } catch (error) {
    rmSync(destination, { recursive: true, force: true })
    if (error instanceof TeamSubmissionError) throw error
    throw new TeamSubmissionError('format', '投稿归档格式无效', error)
  }
}

export function verifySubmissionSignature(
  submission: Pick<ExtractedSubmission, 'manifest' | 'manifestBytes' | 'signatureBytes'>,
  publicKey: string
): void {
  try {
    verifyTeamFile(
      submission.manifestBytes,
      submission.signatureBytes,
      publicKey,
      submission.manifest.memberSigningKeyId
    )
  } catch (error) {
    throw new TeamSubmissionError('signature', '成员投稿签名无效', error)
  }
}

// eslint-disable-next-line complexity -- the signed boundary rejects every malformed field explicitly
export function parseSubmissionManifest(data: Buffer): SubmissionManifest {
  let value: unknown
  try {
    value = JSON.parse(data.toString('utf8')) as unknown
  } catch (error) {
    throw new TeamSubmissionError('format', '投稿清单不是有效 JSON', error)
  }
  if (!isRecord(value)) invalidManifest()
  const fields =
    value.note === undefined
      ? ['version', 'teamId', 'submissionId', 'memberSigningKeyId', 'createdAt', 'packages']
      : ['version', 'teamId', 'submissionId', 'memberSigningKeyId', 'createdAt', 'note', 'packages']
  if (!hasExactKeys(value, fields) || value.version !== 1 || !Array.isArray(value.packages)) {
    invalidManifest()
  }
  assertTeamId(value.teamId)
  if (
    typeof value.submissionId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.submissionId
    ) ||
    typeof value.memberSigningKeyId !== 'string' ||
    !/^[a-f0-9]{16}$/.test(value.memberSigningKeyId)
  ) {
    invalidManifest()
  }
  assertIsoDate(value.createdAt)
  if (new Date(value.createdAt).toISOString() !== value.createdAt) invalidManifest()
  const note = value.note === undefined ? undefined : validateSubmissionNote(value.note)
  if (value.packages.length < 1 || value.packages.length > MAX_SUBMISSION_PACKAGES) {
    invalidManifest()
  }
  const packages = value.packages.map(parseSubmissionPackage)
  if (new Set(packages.map(({ type, id }) => `${type}:${id}`)).size !== packages.length) {
    invalidManifest()
  }
  return {
    version: 1,
    teamId: value.teamId,
    submissionId: value.submissionId,
    memberSigningKeyId: value.memberSigningKeyId,
    createdAt: value.createdAt,
    ...(note === undefined ? {} : { note }),
    packages
  }
}

export function validateSubmissionNote(value: unknown): string {
  if (
    typeof value !== 'string' ||
    [...value].length > 1_000 ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return (
        (codePoint >= 0x00 && codePoint <= 0x08) ||
        (codePoint >= 0x0b && codePoint <= 0x1f) ||
        (codePoint >= 0x7f && codePoint <= 0x9f)
      )
    })
  ) {
    throw new TeamSubmissionError('format', '投稿附言格式无效')
  }
  return value
}

export function verifySubmissionRegistry(
  manifest: SubmissionManifest,
  registry: LocalRegistry,
  temporaryRoot: string
): void {
  if (registry.packages.length !== manifest.packages.length) {
    throw new TeamSubmissionError('format', '投稿清单与软件源资源数量不一致')
  }
  const manifestByIdentity = new Map(
    manifest.packages.map((entry) => [`${entry.type}:${entry.id}`, entry])
  )
  for (const entry of registry.packages) {
    const record = manifestByIdentity.get(`${entry.type}:${entry.id}`)
    if (!record || record.version !== entry.version || record.sha256 !== entry.sha256) {
      throw new TeamSubmissionError('hash', '投稿清单与软件源资源摘要不一致')
    }
    assertSafeArchiveEntry(entry.archive)
    let archive: Buffer
    try {
      archive = readFileSync(join(registry.dir, ...entry.archive.split('/')))
    } catch (error) {
      throw new TeamSubmissionError('format', `投稿资源归档缺失: ${entry.type}:${entry.id}`, error)
    }
    if (archive.length !== entry.size || sha256(archive) !== entry.sha256) {
      throw new TeamSubmissionError('hash', `投稿资源哈希无效: ${entry.type}:${entry.id}`)
    }
    validatePackageArchive(
      archive,
      entry,
      join(temporaryRoot, 'validate', `${entry.type}-${entry.id}`)
    )
  }
}

function validatePackageArchive(
  archive: Buffer,
  expected: SubmissionPackageRecord,
  destination: string
): void {
  let entries: ReturnType<typeof parseTarGz>
  try {
    entries = parseTarGz(archive, MAX_SUBMISSION_EXPANDED_BYTES)
  } catch (error) {
    throw new TeamSubmissionError('format', '投稿资源归档格式无效', error)
  }
  const seen = new Set<string>()
  for (const entry of entries) {
    const path = entry.type === 'directory' ? entry.path.replace(/\/+$/u, '') : entry.path
    try {
      assertSafePackagePath(path)
    } catch (error) {
      throw new TeamSubmissionError('format', '投稿资源包含不安全路径', error)
    }
    if (
      seen.has(path) ||
      entry.type === 'link' ||
      (entry.type !== 'file' && entry.type !== 'directory')
    ) {
      throw new TeamSubmissionError('format', '投稿资源包含重复路径或不支持的条目')
    }
    seen.add(path)
    const target = join(destination, ...path.split('/'))
    if (entry.type === 'directory') mkdirSync(target, { recursive: true })
    else {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, entry.data, { flag: 'wx', mode: entry.mode & 0o666 })
    }
  }
  const validation = validatePackage(destination)
  if (
    !validation.ok ||
    !validation.package ||
    validation.package.manifest.type !== expected.type ||
    validation.package.manifest.id !== expected.id ||
    validation.package.manifest.version !== expected.version
  ) {
    throw new TeamSubmissionError('format', `投稿资源格式无效: ${expected.type}:${expected.id}`)
  }
}

function parseSubmissionPackage(value: unknown): SubmissionPackageRecord {
  if (!isRecord(value) || !hasExactKeys(value, ['type', 'id', 'version', 'sha256'])) {
    invalidManifest()
  }
  if (
    !['skill', 'plugin', 'wrapper', 'mcp'].includes(String(value.type)) ||
    typeof value.id !== 'string' ||
    !/^[a-z][a-z0-9-]{1,63}$/.test(value.id) ||
    typeof value.version !== 'string' ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  ) {
    invalidManifest()
  }
  return value as unknown as SubmissionPackageRecord
}

function normalizeCreatedAt(value: Date | string | undefined): string {
  const createdAt =
    value instanceof Date ? value.toISOString() : (value ?? new Date().toISOString())
  assertIsoDate(createdAt)
  if (new Date(createdAt).toISOString() !== createdAt) invalidManifest()
  return createdAt
}

function invalidManifest(): never {
  throw new TeamSubmissionError('format', '投稿清单格式无效')
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sorted = [...expected].sort()
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
