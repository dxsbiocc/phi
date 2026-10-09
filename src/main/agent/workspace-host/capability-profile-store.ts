import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

import { getPhiAgentDir } from '../runtime-paths'
import {
  probeHostCapabilities,
  type HostCapabilityProbeOptions,
  type HostCapabilityProbeSession
} from './probe'
import type { ProbedHostCapabilityProfile } from './probe-parse'
import { HOST_CAPABILITY_PROFILE_VERSION } from './types'

const STORE_FILE = 'ssh-host-capabilities.json'
const STORE_VERSION = 1

interface CapabilityProfileStore {
  version: number
  entries: Readonly<Record<string, ProbedHostCapabilityProfile>>
  latestByHost: Readonly<Record<string, string>>
  cacheKeysByHost: Readonly<Record<string, readonly string[]>>
  hostIndexComplete: boolean
}

export interface CapabilityProfileKey {
  hostAlias: string
  projectRoot: string
}

export interface CapabilityProfileReadOptions {
  agentDir?: string
  expectedHelperVersion?: string
  expectedProfileVersion?: number
}

export interface CapabilityProfileRefreshOptions extends HostCapabilityProbeOptions {
  agentDir?: string
}

export interface CapabilityProfileGetOptions
  extends CapabilityProfileReadOptions, HostCapabilityProbeOptions {
  refresh?: boolean
}

function emptyStore(): CapabilityProfileStore {
  return {
    version: STORE_VERSION,
    entries: {},
    latestByHost: {},
    cacheKeysByHost: {},
    hostIndexComplete: true
  }
}

function isProfile(value: unknown): value is ProbedHostCapabilityProfile {
  if (typeof value !== 'object' || value === null) return false
  const profile = value as Partial<ProbedHostCapabilityProfile>
  return (
    typeof profile.profileVersion === 'number' &&
    typeof profile.probedAt === 'string' &&
    typeof profile.platform?.os === 'string' &&
    profile.platform.os !== 'unknown' &&
    typeof profile.platform.arch === 'string' &&
    profile.platform.arch !== 'unknown' &&
    profile.probe?.state !== 'unavailable' &&
    typeof profile.toolchain === 'object' &&
    profile.toolchain !== null
  )
}

function readStore(agentDir: string): CapabilityProfileStore {
  const path = capabilityProfileStorePath(agentDir)
  if (!existsSync(path)) return emptyStore()
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof raw !== 'object' || raw === null) return emptyStore()
    const store = raw as Partial<CapabilityProfileStore>
    if (store.version !== STORE_VERSION || typeof store.entries !== 'object' || !store.entries) {
      return emptyStore()
    }
    const entries = Object.fromEntries(
      Object.entries(store.entries).filter(
        (entry): entry is [string, ProbedHostCapabilityProfile] => isProfile(entry[1])
      )
    )
    const latestByHost =
      typeof store.latestByHost === 'object' && store.latestByHost
        ? Object.fromEntries(
            Object.entries(store.latestByHost).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string'
            )
          )
        : {}
    const rawHostIndex =
      typeof store.cacheKeysByHost === 'object' && store.cacheKeysByHost
        ? store.cacheKeysByHost
        : undefined
    const cacheKeysByHost = rawHostIndex
      ? Object.fromEntries(
          Object.entries(rawHostIndex).flatMap(([key, value]) =>
            Array.isArray(value) && value.every((item) => typeof item === 'string')
              ? [[key, value]]
              : []
          )
        )
      : {}
    const hostIndexComplete = Boolean(rawHostIndex) && store.hostIndexComplete !== false
    return { version: STORE_VERSION, entries, latestByHost, cacheKeysByHost, hostIndexComplete }
  } catch {
    return emptyStore()
  }
}

function writeStore(agentDir: string, store: CapabilityProfileStore): void {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  const target = capabilityProfileStorePath(agentDir)
  const temporary = join(agentDir, `.${STORE_FILE}.${process.pid}.${randomUUID()}.tmp`)
  try {
    const document: CapabilityProfileStore = {
      version: STORE_VERSION,
      entries: store.entries,
      latestByHost: store.latestByHost,
      cacheKeysByHost: store.cacheKeysByHost,
      hostIndexComplete: store.hostIndexComplete
    }
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    })
    renameSync(temporary, target)
    chmodSync(target, 0o600)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function checkedPart(value: string, label: string): string {
  if (!value || /[\r\n\0]/.test(value)) throw new Error(`${label} is invalid`)
  return value
}

export function capabilityProfileCacheKey(key: CapabilityProfileKey): string {
  const hostAlias = checkedPart(key.hostAlias, 'host alias')
  const projectRoot = checkedPart(key.projectRoot, 'project root')
  return createHash('sha256').update(hostAlias).update('\0').update(projectRoot).digest('hex')
}

function capabilityProfileHostKey(hostAlias: string): string {
  return createHash('sha256').update(checkedPart(hostAlias, 'host alias')).digest('hex')
}

export function capabilityProfileStorePath(agentDir = getPhiAgentDir()): string {
  return join(agentDir, STORE_FILE)
}

export function readCapabilityProfile(
  key: CapabilityProfileKey,
  options: CapabilityProfileReadOptions = {}
): ProbedHostCapabilityProfile | undefined {
  const store = readStore(options.agentDir ?? getPhiAgentDir())
  const profile = store.entries[capabilityProfileCacheKey(key)]
  if (!profile) return undefined
  const expectedProfileVersion = options.expectedProfileVersion ?? HOST_CAPABILITY_PROFILE_VERSION
  if (profile.profileVersion !== expectedProfileVersion) return undefined
  if (
    options.expectedHelperVersion !== undefined &&
    profile.helperVersion !== options.expectedHelperVersion
  ) {
    return undefined
  }
  return profile
}

export function readLatestCapabilityProfileForHost(
  hostAlias: string,
  options: CapabilityProfileReadOptions = {}
): ProbedHostCapabilityProfile | undefined {
  const store = readStore(options.agentDir ?? getPhiAgentDir())
  const cacheKey = store.latestByHost[capabilityProfileHostKey(hostAlias)]
  if (!cacheKey) return undefined
  const profile = store.entries[cacheKey]
  if (!profile) return undefined
  const expectedProfileVersion = options.expectedProfileVersion ?? HOST_CAPABILITY_PROFILE_VERSION
  if (profile.profileVersion !== expectedProfileVersion) return undefined
  if (
    options.expectedHelperVersion !== undefined &&
    profile.helperVersion !== options.expectedHelperVersion
  ) {
    return undefined
  }
  return profile
}

export function saveCapabilityProfile(
  key: CapabilityProfileKey,
  profile: ProbedHostCapabilityProfile,
  agentDir = getPhiAgentDir()
): void {
  if (
    profile.platform.os === 'unknown' ||
    profile.platform.arch === 'unknown' ||
    profile.probe.state === 'unavailable'
  ) {
    return
  }
  const store = readStore(agentDir)
  const cacheKey = capabilityProfileCacheKey(key)
  const hostKey = capabilityProfileHostKey(key.hostAlias)
  const hostCacheKeys = [...new Set([...(store.cacheKeysByHost[hostKey] ?? []), cacheKey])]
  writeStore(agentDir, {
    ...store,
    entries: {
      ...store.entries,
      [cacheKey]: { ...profile, profileVersion: HOST_CAPABILITY_PROFILE_VERSION }
    },
    latestByHost: {
      ...store.latestByHost,
      [hostKey]: cacheKey
    },
    cacheKeysByHost: {
      ...store.cacheKeysByHost,
      [hostKey]: hostCacheKeys
    }
  })
}

function withoutEntry(
  store: CapabilityProfileStore,
  hostKey: string,
  cacheKey: string
): CapabilityProfileStore {
  const remaining = (store.cacheKeysByHost[hostKey] ?? []).filter((key) => key !== cacheKey)
  const entries = Object.fromEntries(
    Object.entries(store.entries).filter(([entryKey]) => entryKey !== cacheKey)
  )
  const latestByHost = { ...store.latestByHost }
  if (latestByHost[hostKey] === cacheKey) {
    const fallback = remaining.at(-1)
    if (fallback) latestByHost[hostKey] = fallback
    else delete latestByHost[hostKey]
  }
  const cacheKeysByHost = { ...store.cacheKeysByHost }
  if (remaining.length > 0) cacheKeysByHost[hostKey] = remaining
  else delete cacheKeysByHost[hostKey]
  return { ...store, entries, latestByHost, cacheKeysByHost }
}

export function invalidateCapabilityProfile(
  key: CapabilityProfileKey,
  agentDir = getPhiAgentDir()
): void {
  const store = readStore(agentDir)
  const cacheKey = capabilityProfileCacheKey(key)
  if (!(cacheKey in store.entries)) return
  const hostKey = capabilityProfileHostKey(key.hostAlias)
  writeStore(agentDir, withoutEntry(store, hostKey, cacheKey))
}

export function invalidateCapabilityProfilesForHost(
  hostAlias: string,
  agentDir = getPhiAgentDir()
): void {
  const store = readStore(agentDir)
  if (!store.hostIndexComplete) {
    writeStore(agentDir, emptyStore())
    return
  }
  const hostKey = capabilityProfileHostKey(hostAlias)
  const knownKeys = store.cacheKeysByHost[hostKey] ?? []
  const cacheKeys = knownKeys.length > 0 ? knownKeys : [store.latestByHost[hostKey]].filter(Boolean)
  if (cacheKeys.length === 0) return
  const removals = new Set(cacheKeys)
  const entries = Object.fromEntries(
    Object.entries(store.entries).filter(([cacheKey]) => !removals.has(cacheKey))
  )
  const latestByHost = { ...store.latestByHost }
  const cacheKeysByHost = { ...store.cacheKeysByHost }
  delete latestByHost[hostKey]
  delete cacheKeysByHost[hostKey]
  writeStore(agentDir, { ...store, entries, latestByHost, cacheKeysByHost })
}

export async function refreshCapabilityProfile(
  session: HostCapabilityProbeSession,
  key: CapabilityProfileKey,
  options: CapabilityProfileRefreshOptions = {}
): Promise<ProbedHostCapabilityProfile> {
  const profile = await probeHostCapabilities(session, {
    timeoutMs: options.timeoutMs,
    fastTimeoutMs: options.fastTimeoutMs,
    slowTimeoutMs: options.slowTimeoutMs,
    now: options.now
  })
  saveCapabilityProfile(key, profile, options.agentDir)
  return profile
}

export async function getCapabilityProfile(
  session: HostCapabilityProbeSession,
  key: CapabilityProfileKey,
  options: CapabilityProfileGetOptions = {}
): Promise<ProbedHostCapabilityProfile> {
  const cached = options.refresh ? undefined : readCapabilityProfile(key, options)
  if (cached) return cached
  return refreshCapabilityProfile(session, key, options)
}
