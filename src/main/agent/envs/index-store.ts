import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { type EnvKind, type EnvStatus } from './contract'
import { PHI_PLATFORMS, type PhiPlatform } from './platform'

export interface EnvironmentIndexEntry {
  name: string
  kind: EnvKind
  platform: PhiPlatform
  prefix: string
  status: EnvStatus
  lockSha256: string
  referrers: string[]
  updatedAt: string
  error?: string
}

export interface EnvironmentIndex {
  version: 1
  environments: Record<string, EnvironmentIndexEntry>
}

/** `error: null` removes a stored error. Omitting `error` leaves the current one. */
export interface EnvironmentEntryPatch {
  name?: string
  kind?: EnvKind
  platform?: PhiPlatform
  prefix?: string
  status?: EnvStatus
  lockSha256?: string
  referrers?: string[]
  updatedAt?: string
  error?: string | null
}

const ENV_KINDS = new Set<string>(['base', 'package', 'project'])
const ENV_STATUSES = new Set<string>(['absent', 'building', 'ready', 'failed', 'drifted'])
const PLATFORMS = new Set<string>(PHI_PLATFORMS)

function emptyIndex(): EnvironmentIndex {
  return { version: 1, environments: {} }
}

function indexPath(root: string): string {
  return join(root, 'state', 'environments.json')
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error) return String(error.code)
  return undefined
}

function isEntry(value: unknown): value is EnvironmentIndexEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.name === 'string' &&
    typeof entry.kind === 'string' &&
    ENV_KINDS.has(entry.kind) &&
    typeof entry.platform === 'string' &&
    PLATFORMS.has(entry.platform) &&
    typeof entry.prefix === 'string' &&
    typeof entry.status === 'string' &&
    ENV_STATUSES.has(entry.status) &&
    typeof entry.lockSha256 === 'string' &&
    Array.isArray(entry.referrers) &&
    entry.referrers.every((referrer) => typeof referrer === 'string') &&
    typeof entry.updatedAt === 'string' &&
    (entry.error === undefined || typeof entry.error === 'string')
  )
}

function isIndex(value: unknown): value is EnvironmentIndex {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.version !== 1) return false
  if (
    record.environments === null ||
    typeof record.environments !== 'object' ||
    Array.isArray(record.environments)
  ) {
    return false
  }
  return Object.values(record.environments as Record<string, unknown>).every(isEntry)
}

function quarantine(file: string): void {
  const base = `${file}.corrupt-${Date.now()}`
  let destination = base
  let attempt = 0
  while (existsSync(destination)) {
    attempt += 1
    destination = `${base}-${attempt}`
  }
  renameSync(file, destination)
}

export function readEnvironmentIndex(root: string): EnvironmentIndex {
  const file = indexPath(root)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return emptyIndex()
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    quarantine(file)
    return emptyIndex()
  }
  if (!isIndex(parsed)) {
    quarantine(file)
    return emptyIndex()
  }
  return parsed
}

function applyPatch(
  current: EnvironmentIndexEntry | undefined,
  patch: EnvironmentEntryPatch
): EnvironmentIndexEntry {
  const name = patch.name ?? current?.name
  const kind = patch.kind ?? current?.kind
  const platform = patch.platform ?? current?.platform
  const prefix = patch.prefix ?? current?.prefix
  const status = patch.status ?? current?.status
  const digest = patch.lockSha256 ?? current?.lockSha256
  if (!name || !kind || !platform || !prefix || !status || !digest) {
    throw new Error(
      'updateEnvironmentEntry requires name, kind, platform, prefix, status, and lockSha256'
    )
  }
  const entry: EnvironmentIndexEntry = {
    name,
    kind,
    platform,
    prefix,
    status,
    lockSha256: digest,
    referrers: [...(patch.referrers ?? current?.referrers ?? [])],
    updatedAt: patch.updatedAt ?? new Date().toISOString()
  }
  const clearError = patch.error === null || entry.status === 'ready'
  if (!clearError) {
    if (typeof patch.error === 'string') entry.error = patch.error
    else if (current?.error) entry.error = current.error
  }
  return entry
}

function writeIndex(root: string, index: EnvironmentIndex): void {
  const stateDir = join(root, 'state')
  mkdirSync(stateDir, { recursive: true })
  const target = indexPath(root)
  const temporary = join(
    stateDir,
    `.environments.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  )
  try {
    writeFileSync(temporary, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
    renameSync(temporary, target)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temp file may not exist when writeFileSync fails first.
    }
    throw error
  }
}

export function updateEnvironmentEntry(
  root: string,
  envId: string,
  patch: EnvironmentEntryPatch
): EnvironmentIndexEntry {
  const index = readEnvironmentIndex(root)
  const entry = applyPatch(index.environments[envId], patch)
  index.environments[envId] = entry
  writeIndex(root, { version: 1, environments: index.environments })
  return entry
}

/** Idempotent. An unknown `envId` throws. */
export function addReferrer(root: string, envId: string, referrer: string): EnvironmentIndexEntry {
  const index = readEnvironmentIndex(root)
  const current = index.environments[envId]
  if (!current) throw new Error(`unknown environment '${envId}'`)
  if (current.referrers.includes(referrer)) return current
  const entry: EnvironmentIndexEntry = {
    ...current,
    referrers: [...current.referrers, referrer],
    updatedAt: new Date().toISOString()
  }
  index.environments[envId] = entry
  writeIndex(root, index)
  return entry
}

/** Idempotent. An unknown `envId` is left unchanged. */
export function removeReferrer(root: string, envId: string, referrer: string): void {
  const index = readEnvironmentIndex(root)
  const current = index.environments[envId]
  if (!current || !current.referrers.includes(referrer)) return
  index.environments[envId] = {
    ...current,
    referrers: current.referrers.filter((item) => item !== referrer),
    updatedAt: new Date().toISOString()
  }
  writeIndex(root, index)
}

export function deleteEnvironmentEntry(root: string, envId: string): void {
  const index = readEnvironmentIndex(root)
  if (!Object.hasOwn(index.environments, envId)) return
  delete index.environments[envId]
  writeIndex(root, index)
}
