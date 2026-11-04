import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { getPhiAgentDir } from '../runtime-paths'
import { listTeamSources, teamSourceRegistryDir, type TeamSource } from '../team-pack/team-source'
import { readGithubSources, type GithubSourceRecord } from './github-source-store'
import type { LocalRegistry, RegistryTrustTier } from './installer-types'
import { errorMessage, isRecord } from './installer-utils'
import { readRegistry } from './registry'
import { OFFICIAL_REGISTRY_ID } from './official-registry'
import { syncPreferredOfficialRegistry } from './official-website-registry'

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
  /** Isolated source override for tests; production prefers complete website content. */
  loadOfficialRegistry?: () => Promise<LocalRegistry>
  /** Isolated team-source override for registry integration tests. */
  loadTeamSources?: (agentDir: string) => TeamSource[]
}

export interface KnownRegistryDetails {
  id: string
  kind: 'official' | 'directory' | 'github' | 'team'
  path: string
  addedAt?: string
  removable: boolean
  trust?: RegistryTrustTier
  packageCount?: number
  label?: string
  status?: 'ready' | 'cached' | 'unavailable'
  notice?: string
  refreshedAt?: string
  sha?: string
  ref?: string
  version?: number
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
  const github = readGithubSources(options.agentDir)
  const team = readTeamSourcesForRegistries(options)
  let official: KnownRegistryDetails
  try {
    const registry = await loadOfficialRegistry(options)
    official = {
      id: OFFICIAL_REGISTRY_ID,
      kind: 'official',
      label: registry.label ?? 'Phi Packages',
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
    ...state.registries.map((entry) => registryDetails({ ...entry, removable: true })),
    ...github.sources.map(githubRegistryDetails),
    ...team.sources.map((source) => teamRegistryDetails(source, options.agentDir))
  ]
  const error = [state.error, github.error, team.error].filter(Boolean).join('\n')
  return error ? { registries, error } : { registries }
}

export async function loadKnownRegistryIndexes(
  options: KnownRegistryListOptions = {}
): Promise<LoadedKnownRegistries> {
  const state = readKnownRegistries(options.agentDir)
  const github = readGithubSources(options.agentDir)
  const team = readTeamSourcesForRegistries(options)
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
  for (const source of github.sources) {
    try {
      const registry = readRegistry(source.registryPath)
      registries.push({
        ...registry,
        id: source.id,
        trust: 'imported',
        source: {
          kind: 'github',
          id: source.id,
          repo: source.repo,
          ...(source.ref ? { ref: source.ref } : {}),
          sha: source.sha
        }
      })
    } catch (error) {
      errors.push(`GitHub · ${source.repo}@${source.sha.slice(0, 7)}：${errorMessage(error)}`)
    }
  }
  const loadedTeam = loadTeamRegistryIndexes(team.sources, options.agentDir)
  registries.push(...loadedTeam.registries)
  errors.push(...loadedTeam.errors)
  const stateError = [state.error, github.error, team.error].filter(Boolean).join('\n')
  return {
    registries,
    errors,
    ...(stateError ? { stateError } : {})
  }
}

function loadTeamRegistryIndexes(
  sources: readonly TeamSource[],
  customAgentDir?: string
): Pick<LoadedKnownRegistries, 'registries' | 'errors'> {
  const registries: LocalRegistry[] = []
  const errors: string[] = []
  for (const source of sources) {
    const label = teamRegistryLabel(source)
    const release = source.status.lastSuccessfulRelease
    const registryDir = teamSourceRegistryDir(agentDir(customAgentDir), source)
    const unavailable = teamRegistryUnavailableReason(source, registryDir)
    if (unavailable || !registryDir || release === null) {
      errors.push(`${label}：${unavailable ?? '团队来源尚无成功拉取的版本'}`)
      continue
    }
    try {
      const registry = readRegistry(registryDir)
      const cached = source.status.lastErrorCode !== null
      registries.push({
        ...registry,
        id: source.id,
        dir: registryDir,
        trust: 'imported',
        label,
        status: cached ? 'cached' : 'ready',
        ...(cached ? { notice: teamRegistryCachedNotice(source, release) } : {}),
        source: {
          kind: 'team',
          id: source.id,
          teamId: source.teamId,
          teamName: source.teamName,
          teamKeyId: source.teamKeyId,
          release,
          resources: teamSourceResources(source)
        }
      })
    } catch (error) {
      errors.push(`${label}：${errorMessage(error)}`)
    }
  }
  return { registries, errors }
}

function teamSourceResources(
  source: TeamSource
): Extract<NonNullable<LocalRegistry['source']>, { kind: 'team' }>['resources'] {
  const status = source.status as TeamSource['status'] & {
    resources?: Extract<NonNullable<LocalRegistry['source']>, { kind: 'team' }>['resources']
  }
  return status.resources ?? {}
}

function loadOfficialRegistry(options: KnownRegistryListOptions): Promise<LocalRegistry> {
  return (
    options.loadOfficialRegistry?.() ??
    syncPreferredOfficialRegistry({ agentDir: options.agentDir })
  )
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

function githubRegistryDetails(source: GithubSourceRecord): KnownRegistryDetails {
  const details = {
    id: source.id,
    kind: 'github' as const,
    label: `GitHub · ${source.repo}@${source.sha.slice(0, 7)}`,
    path: source.registryPath,
    addedAt: source.addedAt,
    removable: true,
    trust: 'imported' as const,
    sha: source.sha,
    ...(source.ref ? { ref: source.ref } : {})
  }
  try {
    const registry = readRegistry(source.registryPath)
    return { ...details, packageCount: registry.packages.length }
  } catch (error) {
    return { ...details, error: errorMessage(error) }
  }
}

function teamRegistryDetails(source: TeamSource, customAgentDir?: string): KnownRegistryDetails {
  const registryDir = teamSourceRegistryDir(agentDir(customAgentDir), source)
  const unavailable = teamRegistryUnavailableReason(source, registryDir)
  const details: KnownRegistryDetails = {
    id: source.id,
    kind: 'team',
    label: teamRegistryLabel(source),
    path: registryDir ?? teamSourceLocation(source),
    addedAt: source.addedAt,
    removable: true,
    trust: 'imported',
    status: unavailable ? 'unavailable' : source.status.lastErrorCode ? 'cached' : 'ready',
    ...(source.status.lastSuccessfulRelease === null
      ? {}
      : { version: source.status.lastSuccessfulRelease }),
    ...(source.status.lastCheckedAt ? { refreshedAt: source.status.lastCheckedAt } : {}),
    ...(unavailable ? { error: unavailable } : {}),
    ...(!unavailable && source.status.lastErrorCode && source.status.lastSuccessfulRelease !== null
      ? {
          notice: teamRegistryCachedNotice(source, source.status.lastSuccessfulRelease)
        }
      : {})
  }
  if (unavailable || !registryDir) return details
  try {
    const registry = readRegistry(registryDir)
    return { ...details, packageCount: registry.packages.length }
  } catch (error) {
    return {
      ...details,
      status: 'unavailable',
      error: errorMessage(error)
    }
  }
}

function teamRegistryUnavailableReason(
  source: TeamSource,
  registryDir: string | null
): string | undefined {
  const release = source.status.lastSuccessfulRelease
  if (release === null || !registryDir) {
    return source.status.lastErrorCode
      ? `团队来源不可用：${source.status.lastErrorCode}`
      : '团队来源尚无成功拉取的版本'
  }
  if (source.status.withdrawnReleases.includes(release)) {
    return `团队版本 ${release} 已撤回`
  }
  return undefined
}

function teamRegistryCachedNotice(source: TeamSource, release: number): string {
  return `最近检查失败（${source.status.lastErrorCode}），使用已成功拉取的团队版本 ${release}`
}

function teamRegistryLabel(source: TeamSource): string {
  return `来自 ${source.teamName} 团队`
}

function teamSourceLocation(source: TeamSource): string {
  return source.location.kind === 'directory' ? source.location.path : source.location.url
}

function readTeamSourcesForRegistries(options: KnownRegistryListOptions): {
  sources: TeamSource[]
  error?: string
} {
  try {
    return {
      sources: (options.loadTeamSources ?? listTeamSources)(agentDir(options.agentDir))
    }
  } catch (error) {
    return { sources: [], error: `团队来源配置：${errorMessage(error)}` }
  }
}

function agentDir(customAgentDir?: string): string {
  return customAgentDir ?? getPhiAgentDir()
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
