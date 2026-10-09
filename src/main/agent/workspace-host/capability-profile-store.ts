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
  return { version: STORE_VERSION, entries: {}, latestByHost: {} }
}

function isProfile(value: unknown): value is ProbedHostCapabilityProfile {
  if (typeof value !== 'object' || value === null) return false
  const profile = value as Partial<ProbedHostCapabilityProfile>
  return (
    typeof profile.profileVersion === 'number' &&
    typeof profile.probedAt === 'string' &&
    typeof profile.platform?.os === 'string' &&
    typeof profile.platform.arch === 'string' &&
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
    return { version: STORE_VERSION, entries, latestByHost }
  } catch {
    return emptyStore()
  }
}

function writeStore(agentDir: string, store: CapabilityProfileStore): void {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  const target = capabilityProfileStorePath(agentDir)
  const temporary = join(agentDir, `.${STORE_FILE}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, {
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
  const store = readStore(agentDir)
  const cacheKey = capabilityProfileCacheKey(key)
  writeStore(agentDir, {
    ...store,
    entries: {
      ...store.entries,
      [cacheKey]: { ...profile, profileVersion: HOST_CAPABILITY_PROFILE_VERSION }
    },
    latestByHost: {
      ...store.latestByHost,
      [capabilityProfileHostKey(key.hostAlias)]: cacheKey
    }
  })
}

export function invalidateCapabilityProfile(
  key: CapabilityProfileKey,
  agentDir = getPhiAgentDir()
): void {
  const store = readStore(agentDir)
  const cacheKey = capabilityProfileCacheKey(key)
  if (!(cacheKey in store.entries)) return
  const entries = Object.fromEntries(
    Object.entries(store.entries).filter(([entryKey]) => entryKey !== cacheKey)
  )
  const hostKey = capabilityProfileHostKey(key.hostAlias)
  const latestByHost =
    store.latestByHost[hostKey] === cacheKey
      ? Object.fromEntries(
          Object.entries(store.latestByHost).filter(([entryKey]) => entryKey !== hostKey)
        )
      : store.latestByHost
  writeStore(agentDir, { ...store, entries, latestByHost })
}

export async function refreshCapabilityProfile(
  session: HostCapabilityProbeSession,
  key: CapabilityProfileKey,
  options: CapabilityProfileRefreshOptions = {}
): Promise<ProbedHostCapabilityProfile> {
  const profile = await probeHostCapabilities(session, {
    timeoutMs: options.timeoutMs,
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
