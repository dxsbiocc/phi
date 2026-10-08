import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { getPhiAgentDir } from '../runtime-paths'
import type { LocalRegistry, RegistryTrustTier } from './installer-types'
import { errorMessage, isRecord } from './installer-utils'
import { readRegistry } from './registry'
import { OFFICIAL_REGISTRY_ID, syncOfficialRegistry } from './official-registry'

export const BUNDLED_REGISTRY_ID = 'builtin'

export interface StoredKnownRegistry {
  id: string
  kind: 'directory'
  path: string
  addedAt: string
}

export interface KnownRegistriesState {
  version: 1
  registries: StoredKnownRegistry[]
  /** Present when the persisted file could not be parsed or failed schema validation. */
  error?: string
}

export interface KnownRegistryMutationOptions {
  agentDir?: string
  now?: () => Date
}

export interface KnownRegistryListOptions extends Pick<KnownRegistryMutationOptions, 'agentDir'> {
  /** Isolated source override for tests; production always syncs the signed official catalog. */
  loadOfficialRegistry?: () => Promise<LocalRegistry>
}

export interface KnownRegistryDetails {
  id: string
  kind: 'official' | 'directory'
  path: string
  addedAt?: string
  removable: boolean
  trust?: RegistryTrustTier
  packageCount?: number
  label?: string
  status?: 'ready' | 'cached' | 'unavailable'
  notice?: string
  refreshedAt?: string
  error?: string
}

export interface KnownRegistryListResult {
  registries: KnownRegistryDetails[]
  /** A persisted-state error. Individual registry read errors live on their entry. */
  error?: string
}

export interface LoadedKnownRegistries {
  registries: LocalRegistry[]
  errors: string[]
  stateError?: string
}

export function knownRegistriesPath(agentDir = getPhiAgentDir()): string {
  return join(agentDir, 'state', 'registries.json')
}

export function registryIdForPath(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 16)
}

export function readKnownRegistries(agentDir = getPhiAgentDir()): KnownRegistriesState {
  const file = knownRegistriesPath(agentDir)
  let value: unknown
  try {
    value = JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return emptyKnownRegistries()
    return invalidKnownRegistries(file, error)
  }
  return isKnownRegistriesState(value) ? value : invalidKnownRegistries(file, new Error('格式无效'))
}

export async function listKnownRegistries(
  options: KnownRegistryListOptions = {}
): Promise<KnownRegistryListResult> {
  const state = readKnownRegistries(options.agentDir)
  let official: KnownRegistryDetails
  try {
    const registry = await loadOfficialRegistry(options)
    official = {
      id: OFFICIAL_REGISTRY_ID,
      kind: 'official',
      label: 'Phi Packages',
      path: OFFICIAL_REGISTRY_ID,
      removable: false,
      trust: registry.trust,
      packageCount: registry.packages.length,
      status: registry.status ?? 'ready',
      ...(registry.notice ? { notice: registry.notice } : {}),
      ...(registry.refreshedAt ? { refreshedAt: registry.refreshedAt } : {})
    }
  } catch (error) {
    official = {
      id: OFFICIAL_REGISTRY_ID,
      kind: 'official',
      label: 'Phi Packages',
      path: OFFICIAL_REGISTRY_ID,
      removable: false,
      status: 'unavailable',
      error: errorMessage(error)
    }
  }
  const registries = [
    official,
    ...state.registries.map((entry) => registryDetails({ ...entry, removable: true }))
  ]
  return state.error ? { registries, error: state.error } : { registries }
}

export async function loadKnownRegistryIndexes(
  options: KnownRegistryListOptions = {}
): Promise<LoadedKnownRegistries> {
  const state = readKnownRegistries(options.agentDir)
  const registries: LocalRegistry[] = []
  const errors: string[] = []
  try {
    registries.push(await loadOfficialRegistry(options))
  } catch (error) {
    errors.push(`Phi Packages：${errorMessage(error)}`)
  }
  for (const source of state.registries) {
    try {
      registries.push(readRegistry(source.path))
    } catch (error) {
      errors.push(`${source.path}：${errorMessage(error)}`)
    }
  }
  return {
    registries,
    errors,
    ...(state.error ? { stateError: state.error } : {})
  }
}

function loadOfficialRegistry(options: KnownRegistryListOptions): Promise<LocalRegistry> {
  return options.loadOfficialRegistry?.() ?? syncOfficialRegistry({ agentDir: options.agentDir })
}

export function addKnownRegistry(
  path: string,
  options: KnownRegistryMutationOptions = {}
): StoredKnownRegistry {
  if (!isAbsolute(path)) throw new Error('软件源目录必须是绝对路径')
  const registryPath = resolve(path)
  let isDirectory = false
  try {
    isDirectory = statSync(registryPath).isDirectory()
  } catch {
    // Report one stable validation error below.
  }
  if (!isDirectory) throw new Error(`软件源目录不存在或不是目录：${registryPath}`)

  // Only remember a directory after it has successfully loaded as a registry.
  readRegistry(registryPath)

  const state = readKnownRegistries(options.agentDir)
  assertMutableState(state)
  const id = registryIdForPath(registryPath)
  const existing = state.registries.find((entry) => entry.id === id)
  if (existing) return existing

  const addedAt = (options.now ?? (() => new Date()))().toISOString()
  const entry: StoredKnownRegistry = {
    id,
    kind: 'directory',
    path: registryPath,
    addedAt
  }
  writeKnownRegistries({ version: 1, registries: [...state.registries, entry] }, options.agentDir)
  return entry
}

export function removeKnownRegistry(
  id: string,
  options: Pick<KnownRegistryMutationOptions, 'agentDir'> = {}
): boolean {
  if (id === OFFICIAL_REGISTRY_ID) throw new Error('官方软件源不能移除')
  if (id === BUNDLED_REGISTRY_ID) throw new Error('内置软件源不能移除')
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('软件源标识无效')
  const state = readKnownRegistries(options.agentDir)
  assertMutableState(state)
  const registries = state.registries.filter((entry) => entry.id !== id)
  if (registries.length === state.registries.length) return false
  writeKnownRegistries({ version: 1, registries }, options.agentDir)
  return true
}

function registryDetails(
  details: Omit<KnownRegistryDetails, 'trust' | 'packageCount' | 'error'>
): KnownRegistryDetails {
  try {
    const registry = readRegistry(details.path)
    return {
      ...details,
      trust: registry.trust,
      packageCount: registry.packages.length
    }
  } catch (error) {
    return {
      ...details,
      error: errorMessage(error)
    }
  }
}

function writeKnownRegistries(state: KnownRegistriesState, agentDir = getPhiAgentDir()): void {
  if (!isKnownRegistriesState(state) || state.error !== undefined) {
    throw new Error('拒绝写入无效的软件源配置')
  }
  const target = knownRegistriesPath(agentDir)
  const directory = dirname(target)
  mkdirSync(directory, { recursive: true })
  const temporary = join(
    directory,
    `.${basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  )
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    renameSync(temporary, target)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temporary file may not exist when the initial write failed.
    }
    throw error
  }
}

function isKnownRegistriesState(value: unknown): value is KnownRegistriesState {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'registries'])) return false
  if (value.version !== 1 || !Array.isArray(value.registries)) return false
  const ids = new Set<string>()
  const paths = new Set<string>()
  for (const entry of value.registries) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ['id', 'kind', 'path', 'addedAt']) ||
      typeof entry.id !== 'string' ||
      !/^[a-f0-9]{16}$/.test(entry.id) ||
      entry.kind !== 'directory' ||
      typeof entry.path !== 'string' ||
      !isAbsolute(entry.path) ||
      entry.id !== registryIdForPath(entry.path) ||
      typeof entry.addedAt !== 'string' ||
      !isIsoTimestamp(entry.addedAt) ||
      ids.has(entry.id) ||
      paths.has(entry.path)
    ) {
      return false
    }
    ids.add(entry.id)
    paths.add(entry.path)
  }
  return true
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => keys.includes(key))
}

function isIsoTimestamp(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
      value
    )
  if (!match || !Number.isFinite(Date.parse(value))) return false
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    zoneHourText,
    zoneMinuteText
  ] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const daysInMonth =
    month === 2
      ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
        ? 29
        : 28
      : [4, 6, 9, 11].includes(month)
        ? 30
        : 31
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth &&
    Number(hourText) <= 23 &&
    Number(minuteText) <= 59 &&
    Number(secondText) <= 59 &&
    (zoneHourText === undefined || Number(zoneHourText) <= 23) &&
    (zoneMinuteText === undefined || Number(zoneMinuteText) <= 59)
  )
}

function emptyKnownRegistries(): KnownRegistriesState {
  return { version: 1, registries: [] }
}

function invalidKnownRegistries(file: string, error: unknown): KnownRegistriesState {
  return {
    ...emptyKnownRegistries(),
    error: `软件源配置文件无效：${file}（${errorMessage(error)}）`
  }
}

function assertMutableState(state: KnownRegistriesState): void {
  if (state.error) throw new Error(`${state.error}；请先修复或移走该文件`)
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}
