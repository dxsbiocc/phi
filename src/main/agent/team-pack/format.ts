import { createHash } from 'node:crypto'

import { teamPackError } from './errors'
import { assertIsoDate, assertRelease, assertTeamId, assertTeamName } from './validation'

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

export interface ReleaseManifest {
  version: 1
  teamId: string
  release: number
  payloadSha256: string
  payloadBytes: number
  createdAt: string
  revoked?: number[]
}

export interface InnerFile {
  version: 1
  teamId: string
  release: number
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

export function parseReleaseManifest(data: Buffer, maxPayloadBytes: number): ReleaseManifest {
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
  const revoked = value.revoked === undefined ? undefined : parseRevoked(value.revoked)
  return {
    version: 1,
    teamId: value.teamId,
    release: value.release,
    payloadSha256: value.payloadSha256,
    payloadBytes: value.payloadBytes,
    createdAt: value.createdAt,
    ...(revoked ? { revoked } : {})
  }
}

export function parseInnerFile(data: Buffer): InnerFile {
  const value = parseJsonRecord(data, 'inner.json')
  if (value.version !== 1) invalid('inner.json')
  assertTeamId(value.teamId)
  assertRelease(value.release)
  return { version: 1, teamId: value.teamId, release: value.release }
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

function parseRevoked(value: unknown): number[] {
  if (!Array.isArray(value)) invalid('manifest.json revoked')
  const releases = value.map((entry) => {
    assertRelease(entry)
    return entry
  })
  if (new Set(releases).size !== releases.length) invalid('manifest.json revoked')
  return releases
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
