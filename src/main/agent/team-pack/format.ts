import { createHash } from 'node:crypto'

import type { TeamResourceMap } from '../packages/installer-types'
import { teamPackError } from './errors'
import {
  assertIsoDate,
  assertRelease,
  assertTeamId,
  assertTeamName,
  assertX25519Recipient
} from './validation'

const MAX_ANNOUNCEMENTS = 20
const MAX_ANNOUNCEMENT_CODE_POINTS = 4_000
const MAX_TEAM_RESOURCES = 10_000
const TEAM_RESOURCE_KEY = /^(?:skill|plugin|wrapper|mcp):[a-z][a-z0-9-]{1,63}$/

export interface TeamFile {
  version: 1
  teamId: string
  name: string
  publicKey: string
}

export interface LatestFile {
  version: 1
  teamId: string
  release: number
  manifestSha256: string
  createdAt: string
}

export interface SignedLatestFile {
  pointer: LatestFile
  signature: unknown
}

export interface ModelKeyGrant {
  providerId: string
  label: string
  apiKey: string
  baseUrl?: string
}

export interface GrantFile {
  name: string
  bytes: number
  sha256: string
}

export interface GrantPlaintext {
  version: 1
  teamId: string
  release: number
  models: ModelKeyGrant[]
}

export interface ReleaseManifest {
  version: 1
  teamId: string
  release: number
  payloadSha256: string
  payloadBytes: number
  createdAt: string
  grants: GrantFile[]
  withdrawnReleases: number[]
}

export interface TeamAnnouncement {
  release: number
  publishedAt: string
  text: string
}

export interface InnerFile {
  version: 1
  teamId: string
  release: number
  announcements: TeamAnnouncement[]
  resources: TeamResourceMap
  submissionRecipient?: string
}

export interface TeamState {
  version: 1
  teamKeyId: string
  highestRelease: number
  manifestSha256: string
}

export function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
}

export function sha256(data: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export function parseTeamFile(data: Buffer): TeamFile {
  const value = parseJsonRecord(data, 'team.json')
  if (value.version !== 1 || typeof value.publicKey !== 'string') invalid('team.json')
  assertTeamId(value.teamId)
  assertTeamName(value.name)
  return {
    version: 1,
    teamId: value.teamId,
    name: value.name,
    publicKey: value.publicKey
  }
}

export function parseLatestFile(data: Buffer): LatestFile {
  const value = parseJsonRecord(data, 'latest.json')
  assertFields(
    value,
    ['version', 'teamId', 'release', 'manifestSha256', 'createdAt'],
    'latest.json pointer'
  )
  if (value.version !== 1 || !isSha256(value.manifestSha256)) invalid('latest.json')
  assertTeamId(value.teamId)
  assertRelease(value.release)
  assertIsoDate(value.createdAt)
  return {
    version: 1,
    teamId: value.teamId,
    release: value.release,
    manifestSha256: value.manifestSha256,
    createdAt: value.createdAt
  }
}

export function parseSignedLatestFile(data: Buffer): {
  pointer: LatestFile
  pointerBytes: Buffer
  signatureBytes: Buffer
} {
  const value = parseJsonRecord(data, 'latest.json')
  assertFields(value, ['pointer', 'signature'], 'latest.json')
  if (!isRecord(value.pointer) || !isRecord(value.signature)) invalid('latest.json')
  const pointer = parseLatestFile(jsonBytes(value.pointer))
  const pointerBytes = jsonBytes(pointer)
  return {
    pointer,
    pointerBytes,
    signatureBytes: jsonBytes(value.signature)
  }
}

export function parseReleaseManifest(
  data: Buffer,
  maxPayloadBytes: number,
  maxGrantFiles = 256,
  maxGrantBytes = 256 * 1024
): ReleaseManifest {
  const value = parseJsonRecord(data, 'manifest.json')
  if (
    value.version !== 1 ||
    !isSha256(value.payloadSha256) ||
    typeof value.payloadBytes !== 'number' ||
    !Number.isSafeInteger(value.payloadBytes) ||
    value.payloadBytes < 1 ||
    value.payloadBytes > maxPayloadBytes
  ) {
    invalid('manifest.json')
  }
  assertTeamId(value.teamId)
  assertRelease(value.release)
  assertIsoDate(value.createdAt)
  const grants = parseGrantFiles(value.grants, maxGrantFiles, maxGrantBytes)
  const withdrawnReleases = parseWithdrawnReleases(value.withdrawnReleases, value.release)
  return {
    version: 1,
    teamId: value.teamId,
    release: value.release,
    payloadSha256: value.payloadSha256,
    payloadBytes: value.payloadBytes,
    createdAt: value.createdAt,
    grants,
    withdrawnReleases
  }
}

export function parseGrantPlaintext(data: Buffer): GrantPlaintext {
  const value = parseJsonRecord(data, 'grant')
  assertFields(value, ['version', 'teamId', 'release', 'models'], 'grant')
  if (value.version !== 1 || !Array.isArray(value.models)) invalid('grant')
  assertTeamId(value.teamId)
  assertRelease(value.release)
  return {
    version: 1,
    teamId: value.teamId,
    release: value.release,
    models: validateModelKeyGrants(value.models)
  }
}

export function validateModelKeyGrants(value: readonly unknown[]): ModelKeyGrant[] {
  if (value.length > 64) invalid('models')
  const models = value.map((entry) => {
    if (!isRecord(entry)) invalid('model grant')
    const allowedFields =
      entry.baseUrl === undefined
        ? ['providerId', 'label', 'apiKey']
        : ['providerId', 'label', 'apiKey', 'baseUrl']
    assertFields(entry, allowedFields, 'model grant')
    assertGrantText(entry.providerId, 'providerId', 100)
    assertGrantText(entry.label, 'label', 100)
    if (
      typeof entry.apiKey !== 'string' ||
      entry.apiKey.length < 1 ||
      entry.apiKey.length > 16_384 ||
      entry.apiKey.includes('\n') ||
      entry.apiKey.includes('\r') ||
      entry.apiKey.includes('\0')
    ) {
      invalid('model grant apiKey')
    }
    if (entry.baseUrl !== undefined) assertHttpsBaseUrl(entry.baseUrl)
    return {
      providerId: entry.providerId,
      label: entry.label,
      apiKey: entry.apiKey,
      ...(entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl })
    }
  })
  const providers = models.map((model) => model.providerId)
  if (new Set(providers).size !== providers.length) invalid('model grant providerId')
  return models
}

export function parseInnerFile(data: Buffer): InnerFile {
  const value = parseJsonRecord(data, 'inner.json')
  if (value.version !== 1) invalid('inner.json')
  assertAllowedFields(
    value,
    ['version', 'teamId', 'release', 'announcements', 'resources', 'submissionRecipient'],
    'inner.json'
  )
  assertTeamId(value.teamId)
  assertRelease(value.release)
  const release = value.release
  const announcements = validateTeamAnnouncements(value.announcements ?? [])
  if (announcements.some((announcement) => announcement.release > release)) {
    invalid('inner.json announcements')
  }
  if (value.submissionRecipient !== undefined) {
    assertX25519Recipient(value.submissionRecipient)
  }
  return {
    version: 1,
    teamId: value.teamId,
    release,
    announcements,
    resources: validateTeamResourceMap(value.resources ?? {}),
    ...(value.submissionRecipient === undefined
      ? {}
      : { submissionRecipient: value.submissionRecipient })
  }
}

export function validateAnnouncementText(value: unknown): string {
  if (typeof value !== 'string') invalid('announcement text')
  const characters = [...value]
  if (
    characters.length < 1 ||
    characters.length > MAX_ANNOUNCEMENT_CODE_POINTS ||
    characters.some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return (
        (codePoint >= 0x00 && codePoint <= 0x09) ||
        (codePoint >= 0x0b && codePoint <= 0x1f) ||
        (codePoint >= 0x7f && codePoint <= 0x9f)
      )
    })
  ) {
    invalid('announcement text')
  }
  return value
}

export function validateTeamAnnouncements(value: unknown): TeamAnnouncement[] {
  if (!Array.isArray(value) || value.length > MAX_ANNOUNCEMENTS) {
    invalid('inner.json announcements')
  }
  const announcements = value.map((entry) => {
    if (!isRecord(entry)) invalid('inner.json announcement')
    assertFields(entry, ['release', 'publishedAt', 'text'], 'inner.json announcement')
    assertRelease(entry.release)
    assertIsoDate(entry.publishedAt)
    if (new Date(entry.publishedAt).toISOString() !== entry.publishedAt) {
      invalid('inner.json announcement publishedAt')
    }
    return {
      release: entry.release,
      publishedAt: entry.publishedAt,
      text: validateAnnouncementText(entry.text)
    }
  })
  if (
    announcements.some(
      ({ release }, index) => index > 0 && release <= announcements[index - 1]!.release
    )
  ) {
    invalid('inner.json announcements')
  }
  return announcements
}

export function validateTeamResourceMap(value: unknown): TeamResourceMap {
  if (!isRecord(value)) invalid('inner.json resources')
  const entries = Object.entries(value)
  if (entries.length > MAX_TEAM_RESOURCES) invalid('inner.json resources')
  return Object.fromEntries(
    entries.map(([key, metadata]) => {
      if (!TEAM_RESOURCE_KEY.test(key) || !isRecord(metadata)) {
        invalid('inner.json resource')
      }
      const fields =
        metadata.originalSource === undefined ? ['sharing'] : ['sharing', 'originalSource']
      assertFields(metadata, fields, 'inner.json resource')
      if (metadata.sharing !== 'team-only' && metadata.sharing !== 'forwardable') {
        invalid('inner.json resource sharing')
      }
      const originalSource =
        metadata.originalSource === undefined
          ? undefined
          : validateTeamResourceOrigin(metadata.originalSource)
      return [
        key,
        {
          sharing: metadata.sharing,
          ...(originalSource === undefined ? {} : { originalSource })
        }
      ]
    })
  )
}

export function parseTeamState(data: Buffer): TeamState {
  const value = parseJsonRecord(data, 'state.json')
  if (
    value.version !== 1 ||
    typeof value.teamKeyId !== 'string' ||
    !/^[a-f0-9]{16}$/.test(value.teamKeyId) ||
    typeof value.highestRelease !== 'number' ||
    !Number.isSafeInteger(value.highestRelease) ||
    value.highestRelease < 1 ||
    !isSha256(value.manifestSha256)
  ) {
    invalid('state.json')
  }
  return {
    version: 1,
    teamKeyId: value.teamKeyId,
    highestRelease: value.highestRelease,
    manifestSha256: value.manifestSha256
  }
}

export function releaseManifestPath(release: number): string {
  assertRelease(release)
  return `releases/${release}/manifest.json`
}

export function releaseSignaturePath(release: number): string {
  assertRelease(release)
  return `releases/${release}/manifest.sig.json`
}

export function releasePayloadPath(release: number): string {
  assertRelease(release)
  return `releases/${release}/payload.age`
}

export function releaseGrantPath(release: number, name: string): string {
  assertRelease(release)
  if (!/^[a-f0-9]{32}\.age$/.test(name)) invalid('grant file name')
  return `releases/${release}/grants/${name}`
}

function parseJsonRecord(data: Buffer, label: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(data.toString('utf8')) as unknown
  } catch (error) {
    throw teamPackError('INVALID_FORMAT', `${label} 不是有效 JSON`, error)
  }
  if (!isRecord(value)) invalid(label)
  return value
}

function parseWithdrawnReleases(value: unknown, currentRelease: number): number[] {
  if (!Array.isArray(value)) invalid('manifest.json withdrawnReleases')
  const releases = value.map((entry) => {
    assertRelease(entry)
    if (entry > currentRelease) invalid('manifest.json withdrawnReleases')
    return entry
  })
  if (new Set(releases).size !== releases.length) invalid('manifest.json withdrawnReleases')
  return releases
}

function parseGrantFiles(value: unknown, maxFiles: number, maxBytes: number): GrantFile[] {
  if (!Array.isArray(value) || value.length > maxFiles) invalid('manifest.json grants')
  const names = new Set<string>()
  return value.map((entry) => {
    if (!isRecord(entry)) invalid('manifest.json grant')
    assertFields(entry, ['name', 'bytes', 'sha256'], 'manifest.json grant')
    if (
      typeof entry.name !== 'string' ||
      !/^[a-f0-9]{32}\.age$/.test(entry.name) ||
      typeof entry.bytes !== 'number' ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 1 ||
      entry.bytes > maxBytes ||
      !isSha256(entry.sha256) ||
      names.has(entry.name)
    ) {
      invalid('manifest.json grant')
    }
    names.add(entry.name)
    return { name: entry.name, bytes: entry.bytes, sha256: entry.sha256 }
  })
}

function assertGrantText(
  value: unknown,
  label: string,
  maxLength: number
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maxLength ||
    value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    invalid(`model grant ${label}`)
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
}

function assertHttpsBaseUrl(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2_048) {
    invalid('model grant baseUrl')
  }
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) invalid('model grant baseUrl')
  } catch {
    invalid('model grant baseUrl')
  }
}

function assertFields(value: Record<string, unknown>, fields: string[], label: string): void {
  const expected = [...fields].sort()
  const actual = Object.keys(value).sort()
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    invalid(label)
  }
}

function assertAllowedFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string
): void {
  if (Object.keys(value).some((field) => !fields.includes(field))) invalid(label)
}

function validateTeamResourceOrigin(value: unknown): {
  teamId: string
  teamName: string
  teamKeyId: string
} {
  if (!isRecord(value)) invalid('inner.json resource originalSource')
  assertFields(value, ['teamId', 'teamName', 'teamKeyId'], 'inner.json resource originalSource')
  assertTeamId(value.teamId)
  assertTeamName(value.teamName)
  if (typeof value.teamKeyId !== 'string' || !/^[a-f0-9]{16}$/.test(value.teamKeyId)) {
    invalid('inner.json resource originalSource')
  }
  return { teamId: value.teamId, teamName: value.teamName, teamKeyId: value.teamKeyId }
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(label: string): never {
  throw teamPackError('INVALID_FORMAT', `${label} 格式无效`)
}
