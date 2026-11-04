import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { isTeamPackError, teamPackError } from './errors'
import { assertManagedFile, writeAtomic } from './files'
import { jsonBytes } from './format'
import type {
  TeamCredentialOwner,
  TeamSource,
  TeamSourceErrorCode,
  TeamSourceLocation,
  TeamSourceStatus,
  TeamSourcesState
} from './team-source-types'

export function teamSourcesPath(agentDir: string): string {
  return join(agentDir, 'team-sources.json')
}

export function listTeamSources(agentDir: string): TeamSource[] {
  return readTeamSourcesState(agentDir).sources
}

export function teamSourceRegistryDir(agentDir: string, source: TeamSource): string | null {
  const release = source.status.lastSuccessfulRelease
  return release === null
    ? null
    : join(agentDir, 'team-pack', 'state', source.teamId, String(release), 'registry')
}

export function normalizeTeamSourceLocation(
  location: TeamSourceLocation,
  allowHttp: boolean
): TeamSourceLocation {
  if (location.kind === 'directory') {
    if (typeof location.path !== 'string' || location.path.length === 0) {
      throw teamPackError('INVALID_FORMAT', '团队来源目录不能为空')
    }
    return { kind: 'directory', path: resolve(location.path) }
  }
  if (location.kind !== 'https' || typeof location.url !== 'string') {
    throw teamPackError('INVALID_FORMAT', '团队来源位置无效')
  }
  const url = parseSourceUrl(location.url)
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw teamPackError('INVALID_FORMAT', '团队来源 URL 必须使用 HTTPS')
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return { kind: 'https', url: url.toString() }
}

export function readTeamSourcesState(agentDir: string): TeamSourcesState {
  const path = teamSourcesPath(agentDir)
  assertManagedFile(path, '团队来源配置文件')
  if (!existsSync(path)) return emptyState()
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    throw teamPackError('INVALID_FORMAT', '团队来源配置文件不是有效 JSON', error)
  }
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'sources', 'credentialOwners'])) {
    throw teamPackError('INVALID_FORMAT', '团队来源配置文件格式无效')
  }
  if (value.version !== 1 || !Array.isArray(value.sources)) invalidState()
  if (!Array.isArray(value.credentialOwners)) invalidState()
  const state: TeamSourcesState = {
    version: 1,
    sources: value.sources.map(parseTeamSource),
    credentialOwners: value.credentialOwners.map(parseCredentialOwner)
  }
  assertStateRelationships(state)
  return state
}

export function writeTeamSourcesState(agentDir: string, state: TeamSourcesState): void {
  for (const source of state.sources) assertTeamSource(source)
  for (const owner of state.credentialOwners) assertCredentialOwner(owner)
  assertStateRelationships(state)
  try {
    const path = teamSourcesPath(agentDir)
    assertManagedFile(path, '团队来源配置文件')
    writeAtomic(path, jsonBytes(state), 0o600)
  } catch (error) {
    if (isTeamPackError(error)) throw error
    throw teamPackError('STORE_UNAVAILABLE', '无法持久化团队来源配置', error)
  }
}

function parseSourceUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw teamPackError('INVALID_FORMAT', '团队来源 URL 无效')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw teamPackError('INVALID_FORMAT', '团队来源 URL 无效')
  }
  return url
}

function parseTeamSource(value: unknown): TeamSource {
  assertTeamSource(value)
  return value
}

function assertTeamSource(value: unknown): asserts value is TeamSource {
  if (!isRecord(value)) invalidSource()
  if (
    !hasExactKeys(value, ['id', 'teamId', 'teamName', 'teamKeyId', 'location', 'addedAt', 'status'])
  ) {
    invalidSource()
  }
  if (!validSourceIdentity(value)) invalidSource()
  if (!isIso(value.addedAt)) invalidSource()
  if (!isRecord(value.location)) invalidSource()
  if (!isRecord(value.status)) invalidSource()
  const normalized = normalizeTeamSourceLocation(value.location as TeamSourceLocation, true)
  if (JSON.stringify(normalized) !== JSON.stringify(value.location)) {
    throw teamPackError('INVALID_FORMAT', '团队来源位置未规范化')
  }
  assertStatus(value.status)
}

function validSourceIdentity(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.id) &&
    typeof value.teamId === 'string' &&
    /^[a-z][a-z0-9-]{1,63}$/.test(value.teamId) &&
    typeof value.teamName === 'string' &&
    validTeamName(value.teamName) &&
    typeof value.teamKeyId === 'string' &&
    /^[a-f0-9]{16}$/.test(value.teamKeyId) &&
    typeof value.addedAt === 'string'
  )
}

function validTeamName(value: string): boolean {
  return (
    value.trim() === value &&
    value.length >= 1 &&
    value.length <= 100 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  )
}

function assertStatus(value: unknown): asserts value is TeamSourceStatus {
  if (!isRecord(value)) invalidStatus()
  const keys = [
    'lastSuccessfulRelease',
    'lastCheckedAt',
    'lastErrorCode',
    'withdrawnReleases',
    'credentialConflicts',
    'skippedProviders'
  ]
  if (!hasExactKeys(value, keys)) invalidStatus()
  if (!validOptionalRelease(value.lastSuccessfulRelease)) invalidStatus()
  if (!validOptionalIso(value.lastCheckedAt)) invalidStatus()
  if (value.lastErrorCode !== null && !isErrorCode(value.lastErrorCode)) invalidStatus()
  if (!isUniqueProviderArray(value.credentialConflicts)) invalidStatus()
  if (!isUniqueProviderArray(value.skippedProviders)) invalidStatus()
  if (!validWithdrawn(value.withdrawnReleases, value.lastSuccessfulRelease)) invalidStatus()
}

function validOptionalRelease(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1)
}

function validOptionalIso(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && isIso(value))
}

function validWithdrawn(value: unknown, successful: unknown): value is number[] {
  if (!Array.isArray(value)) return false
  if (value.some((release) => !validOptionalRelease(release) || release === null)) return false
  if (new Set(value).size !== value.length) return false
  return typeof successful !== 'number' || value.every((release) => release <= successful)
}

function parseCredentialOwner(value: unknown): TeamCredentialOwner {
  assertCredentialOwner(value)
  return value
}

function assertCredentialOwner(value: unknown): asserts value is TeamCredentialOwner {
  if (!isRecord(value)) invalidOwner()
  if (!hasExactKeys(value, ['teamId', 'providerId', 'credentialId', 'keySha256'])) invalidOwner()
  if (typeof value.teamId !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(value.teamId)) {
    invalidOwner()
  }
  if (typeof value.providerId !== 'string' || !validProviderId(value.providerId)) invalidOwner()
  if (!validCredentialId(value.credentialId)) invalidOwner()
  if (typeof value.keySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.keySha256)) {
    invalidOwner()
  }
}

function validCredentialId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function assertStateRelationships(state: TeamSourcesState): void {
  const sourceIds = state.sources.map(({ id }) => id)
  const teamIds = state.sources.map(({ teamId }) => teamId)
  const ownedProviders = state.credentialOwners.map(({ providerId }) => providerId)
  if (new Set(sourceIds).size !== sourceIds.length) invalidState()
  if (new Set(teamIds).size !== teamIds.length) invalidState()
  if (new Set(ownedProviders).size !== ownedProviders.length) invalidState()
  if (state.credentialOwners.some((owner) => !teamIds.includes(owner.teamId))) invalidState()
}

function validProviderId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value)
}

function isUniqueProviderArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false
  if (!value.every((entry) => typeof entry === 'string' && validProviderId(entry))) return false
  return new Set(value).size === value.length
}

function isErrorCode(value: unknown): value is TeamSourceErrorCode {
  if (typeof value !== 'string') return false
  return ERROR_CODES.has(value as TeamSourceErrorCode)
}

const ERROR_CODES = new Set<TeamSourceErrorCode>([
  'NOT_A_MEMBER',
  'BAD_SIGNATURE',
  'UNTRUSTED_TEAM_KEY',
  'ROLLBACK',
  'HASH_MISMATCH',
  'INNER_MISMATCH',
  'BAD_PASSPHRASE',
  'RELEASE_WITHDRAWN',
  'STORE_UNAVAILABLE',
  'INVALID_FORMAT',
  'UNKNOWN'
])

function isIso(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    return new Date(value).toISOString() === value
  } catch {
    return false
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => keys.includes(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function emptyState(): TeamSourcesState {
  return { version: 1, sources: [], credentialOwners: [] }
}

function invalidState(): never {
  throw teamPackError('INVALID_FORMAT', '团队来源配置文件格式无效')
}

function invalidSource(): never {
  throw teamPackError('INVALID_FORMAT', '团队来源记录格式无效')
}

function invalidStatus(): never {
  throw teamPackError('INVALID_FORMAT', '团队来源状态格式无效')
}

function invalidOwner(): never {
  throw teamPackError('INVALID_FORMAT', '团队凭据归属记录格式无效')
}
