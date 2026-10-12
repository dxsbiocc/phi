import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { getPhiAgentDir } from '../runtime-paths'

export interface GithubSourceRecord {
  id: string
  repo: string
  ref?: string
  sha: string
  registryPath: string
  addedAt: string
  updatedAt: string
}

export interface GithubSourcesState {
  version: 1
  sources: GithubSourceRecord[]
  error?: string
}

export interface GithubSourceStoreOptions {
  agentDir?: string
}

export function githubSourcesPath(agentDir = getPhiAgentDir()): string {
  return join(agentDir, 'state', 'github-sources.json')
}

export function githubSourceId(repo: string): string {
  return createHash('sha256').update(repo.toLowerCase()).digest('hex').slice(0, 16)
}

export function readGithubSources(agentDir = getPhiAgentDir()): GithubSourcesState {
  const file = githubSourcesPath(agentDir)
  let value: unknown
  try {
    value = JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return emptyState()
    return invalidState(file, error)
  }
  return isGithubSourcesState(value, agentDir) ? value : invalidState(file, new Error('格式无效'))
}

export function saveGithubSource(
  source: GithubSourceRecord,
  options: GithubSourceStoreOptions = {}
): GithubSourceRecord {
  const state = readGithubSources(options.agentDir)
  assertMutable(state)
  if (!isGithubSourceRecord(source, options.agentDir ?? getPhiAgentDir())) {
    throw new Error('拒绝写入无效的 GitHub 软件源配置')
  }
  const existing = state.sources.find(
    (entry) => entry.id === source.id || entry.repo.toLowerCase() === source.repo.toLowerCase()
  )
  if (existing) return existing
  writeState({ version: 1, sources: [...state.sources, source] }, options.agentDir)
  return source
}

export function updateGithubSourceRecord(
  id: string,
  update: Pick<GithubSourceRecord, 'sha' | 'registryPath' | 'updatedAt'>,
  options: GithubSourceStoreOptions = {}
): GithubSourceRecord {
  const state = readGithubSources(options.agentDir)
  assertMutable(state)
  const index = state.sources.findIndex((entry) => entry.id === id)
  if (index < 0) throw new Error('找不到 GitHub 软件源')
  const changed = { ...state.sources[index]!, ...update }
  const sources = state.sources.map((entry, entryIndex) => (entryIndex === index ? changed : entry))
  writeState({ version: 1, sources }, options.agentDir)
  return changed
}

export function removeGithubSourceRecord(
  id: string,
  options: GithubSourceStoreOptions = {}
): boolean {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('GitHub 软件源标识无效')
  const state = readGithubSources(options.agentDir)
  assertMutable(state)
  const sources = state.sources.filter((entry) => entry.id !== id)
  if (sources.length === state.sources.length) return false
  writeState({ version: 1, sources }, options.agentDir)
  return true
}

function writeState(state: GithubSourcesState, agentDir = getPhiAgentDir()): void {
  if (!isGithubSourcesState(state, agentDir) || state.error !== undefined) {
    throw new Error('拒绝写入无效的 GitHub 软件源配置')
  }
  const target = githubSourcesPath(agentDir)
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

function isGithubSourcesState(value: unknown, agentDir: string): value is GithubSourcesState {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'sources'])) return false
  if (value.version !== 1 || !Array.isArray(value.sources)) return false
  const ids = new Set<string>()
  const repos = new Set<string>()
  for (const source of value.sources) {
    if (!isGithubSourceRecord(source, agentDir)) return false
    const repoKey = source.repo.toLowerCase()
    if (ids.has(source.id) || repos.has(repoKey)) return false
    ids.add(source.id)
    repos.add(repoKey)
  }
  return true
}

function isGithubSourceRecord(value: unknown, agentDir: string): value is GithubSourceRecord {
  if (!isRecord(value)) return false
  const expected = ['id', 'repo', 'sha', 'registryPath', 'addedAt', 'updatedAt']
  if (value.ref !== undefined) expected.push('ref')
  if (!hasExactKeys(value, expected)) return false
  if (
    typeof value.id !== 'string' ||
    typeof value.repo !== 'string' ||
    value.id !== githubSourceId(value.repo) ||
    !validRepo(value.repo) ||
    (value.ref !== undefined && (typeof value.ref !== 'string' || !validRef(value.ref))) ||
    typeof value.sha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(value.sha) ||
    typeof value.registryPath !== 'string' ||
    !isAbsolute(value.registryPath) ||
    typeof value.addedAt !== 'string' ||
    !isIsoTimestamp(value.addedAt) ||
    typeof value.updatedAt !== 'string' ||
    !isIsoTimestamp(value.updatedAt)
  ) {
    return false
  }
  const [owner, name] = value.repo.split('/') as [string, string]
  const expectedRegistryPath = resolve(
    agentDir,
    'cache',
    'sources',
    'github',
    owner,
    name,
    value.sha,
    'registry'
  )
  return resolve(value.registryPath) === expectedRegistryPath
}

function validRepo(repo: string): boolean {
  const parts = repo.split('/')
  return (
    parts.length === 2 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(parts[0]!) &&
    /^[A-Za-z0-9._-]{1,100}$/.test(parts[1]!) &&
    parts[1] !== '.' &&
    parts[1] !== '..'
  )
}

function validRef(ref: string): boolean {
  return (
    /^[A-Za-z0-9._/-]{1,200}$/.test(ref) &&
    !ref.includes('..') &&
    !ref.startsWith('-') &&
    !ref.startsWith('/') &&
    !ref.endsWith('/')
  )
}

function isIsoTimestamp(value: string): boolean {
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

function emptyState(): GithubSourcesState {
  return { version: 1, sources: [] }
}

function invalidState(file: string, error: unknown): GithubSourcesState {
  return {
    ...emptyState(),
    error: `GitHub 软件源配置文件无效：${file}（${errorMessage(error)}）`
  }
}

function assertMutable(state: GithubSourcesState): void {
  if (state.error) throw new Error(`${state.error}；请先修复或移走该文件`)
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
