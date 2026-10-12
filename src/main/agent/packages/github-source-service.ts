import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type {
  GithubSourceDiff,
  GithubSourcePreview,
  GithubSourceUpdateCheck
} from '../../../shared/githubSourceTypes'
import { validateName } from '../mcp/connector-name'
import { getPhiAgentDir } from '../runtime-paths'
import {
  analyzeProject,
  PRIVATE_NPM_PACKAGE_NOTICE,
  resolveNpmPackage
} from './github-project-hint'
import {
  discoverPackages,
  fetchGithubSnapshot,
  parseGithubRepoUrl,
  resolveGithubRef,
  type GithubFetchOptions,
  type GithubPackagePreview,
  type GithubSkippedPackage,
  type GithubSnapshotLimits
} from './github-source'
import {
  githubSourceId,
  readGithubSources,
  removeGithubSourceRecord,
  saveGithubSource,
  updateGithubSourceRecord,
  type GithubSourceRecord,
  type GithubSourcesState
} from './github-source-store'
import { materializeRegistry } from './materialize-registry'
import { readRegistry } from './registry'
import { readRegistryAsset } from './registry-assets'
import { NoGithubMcpPackagesError } from './github-source-errors'

export interface GithubSourceServiceOptions extends GithubFetchOptions {
  agentDir?: string
  tmpDir?: string
  limits?: Partial<GithubSnapshotLimits>
  now?: () => Date
}

export type { GithubSourceDiff, GithubSourcePreview, GithubSourceUpdateCheck }

const mutationTails = new Map<string, Promise<unknown>>()

export async function previewGithubSource(
  url: string,
  options: GithubSourceServiceOptions = {}
): Promise<GithubSourcePreview> {
  const repository = parseGithubRepoUrl(url)
  const sha = await resolveGithubRef(repository, repository.ref, options)
  return previewResolved(repository.repo, repository.ref, sha, options, true)
}

export async function addGithubSource(
  input: { url: string; sha: string },
  options: GithubSourceServiceOptions = {}
): Promise<GithubSourceRecord> {
  const repository = parseGithubRepoUrl(input.url)
  const sha = validateSha(input.sha)
  return runSourceMutation(repository.repo.toLowerCase(), async () => {
    const agentDir = options.agentDir ?? getPhiAgentDir()
    const state = readGithubSources(agentDir)
    assertMutable(state)
    const existing = state.sources.find(
      (source) => source.repo.toLowerCase() === repository.repo.toLowerCase()
    )
    if (existing) return existing

    const discovery = await fetchAndDiscover(repository.repo, sha, options, true)
    const id = githubSourceId(repository.repo)
    const registryPath = materializeDiscovery(discovery, id, options)
    const now = isoNow(options)
    return saveGithubSource(
      {
        id,
        repo: repository.repo,
        ...(repository.ref ? { ref: repository.ref } : {}),
        sha,
        registryPath,
        addedAt: now,
        updatedAt: now
      },
      { agentDir }
    )
  })
}

export async function checkGithubSourceUpdate(
  id: string,
  options: GithubSourceServiceOptions = {}
): Promise<GithubSourceUpdateCheck> {
  const source = sourceById(id, options)
  const repository = parseGithubRepoUrl(`https://github.com/${source.repo}`)
  const sha = await resolveGithubRef(repository, source.ref, options)
  if (sha === source.sha) return { changed: false, source }
  const preview = await previewResolved(source.repo, source.ref, sha, options)
  return {
    changed: true,
    source,
    ...preview,
    diff: packageDiff(source.registryPath, preview.packages)
  }
}

export async function applyGithubSourceUpdate(
  id: string,
  shaInput: string,
  options: GithubSourceServiceOptions = {}
): Promise<GithubSourceRecord> {
  const sha = validateSha(shaInput)
  return runSourceMutation(id, async () => {
    const source = sourceById(id, options)
    if (source.sha === sha) return source
    const discovery = await fetchAndDiscover(source.repo, sha, options, true)
    const registryPath = materializeDiscovery(discovery, source.id, options)
    const updated = updateGithubSourceRecord(
      source.id,
      { sha, registryPath, updatedAt: isoNow(options) },
      { agentDir: options.agentDir }
    )
    removeSnapshot(source, options)
    return updated
  })
}

export async function removeGithubSource(
  id: string,
  options: GithubSourceServiceOptions = {}
): Promise<boolean> {
  return runSourceMutation(id, async () => {
    const state = readGithubSources(options.agentDir)
    assertMutable(state)
    const source = state.sources.find((entry) => entry.id === id)
    if (!source) return false
    assertManagedRegistryPath(source, options)
    const removed = removeGithubSourceRecord(id, { agentDir: options.agentDir })
    if (removed) {
      const repository = parseGithubRepoUrl(`https://github.com/${source.repo}`)
      const repoRoot = safeChild(cacheRoot(options), repository.owner, repository.name)
      rmSync(repoRoot, { recursive: true, force: true })
    }
    return removed
  })
}

export function listGithubSources(options: GithubSourceServiceOptions = {}): GithubSourcesState {
  return readGithubSources(options.agentDir)
}

interface ResolvedDiscovery {
  srcDir: string
  packages: GithubPackagePreview[]
  packageDirs: string[]
  skipped: GithubSkippedPackage[]
  warnings: string[]
  prebuiltRegistryDir?: string
}

async function previewResolved(
  repo: string,
  ref: string | undefined,
  sha: string,
  options: GithubSourceServiceOptions,
  allowProjectHint = false
): Promise<GithubSourcePreview> {
  try {
    const discovery = await fetchAndDiscover(repo, sha, options, false)
    return {
      repo,
      ...(ref ? { ref } : {}),
      sha,
      packages: discovery.packages,
      skipped: discovery.skipped,
      warnings: discovery.warnings
    }
  } catch (cause) {
    if (!allowProjectHint || !(cause instanceof NoGithubMcpPackagesError)) throw cause
    return previewUnpackagedProject(repo, ref, sha, cause, options)
  }
}

async function previewUnpackagedProject(
  repo: string,
  ref: string | undefined,
  sha: string,
  empty: NoGithubMcpPackagesError,
  options: GithubSourceServiceOptions
): Promise<GithubSourcePreview> {
  const repository = parseGithubRepoUrl(`https://github.com/${repo}`)
  let projectHint = analyzeProject(empty.srcDir, repository, sha)
  let localDraft: GithubSourcePreview['localDraft']
  if (
    projectHint.kind === 'node' &&
    projectHint.name &&
    !projectHint.notices.includes(PRIVATE_NPM_PACKAGE_NOTICE)
  ) {
    const resolution = await resolveNpmPackage(projectHint.name, repository, projectHint.version, {
      fetch: options.fetch ?? globalThis.fetch,
      timeoutMs: options.timeoutMs ?? 30_000
    })
    if (resolution.npm) {
      const suggestedName = safeConnectorName(resolution.npm.name)
      const notices = [...projectHint.notices]
      if (resolution.npm.deprecated) {
        notices.push(
          `npm 发布版本 ${resolution.npm.name}@${resolution.npm.version} 已标记为弃用：${resolution.npm.deprecated}`
        )
      }
      if (suggestedName) {
        notices.push(
          `将通过 Phi 内置 Bun 运行 npm 发布的 ${resolution.npm.name}@${resolution.npm.version}（不是这个仓库提交的源码）。Bun 以 Node 兼容模式运行，个别依赖可能不兼容；依赖版本不锁定，每次启动会联网。`,
          '如果该服务需要先运行初始化命令（例如 init），请先在终端完成，再添加。'
        )
        localDraft = {
          suggestedName,
          command: 'x',
          args: ['--bun', `${resolution.npm.name}@${resolution.npm.version}`],
          runtimeHint: 'bun',
          ...(projectHint.readmeUrl || projectHint.setupCommands
            ? {
                setup: {
                  ...(projectHint.readmeUrl ? { readmeUrl: projectHint.readmeUrl } : {}),
                  ...(projectHint.setupCommands ? { commands: [...projectHint.setupCommands] } : {})
                }
              }
            : {})
        }
      }
      projectHint = { ...projectHint, npm: resolution.npm, notices }
    } else {
      projectHint = {
        ...projectHint,
        notices: [...projectHint.notices, '未找到与此仓库一致的 npm 发布版本，无法生成草稿']
      }
    }
  } else if (
    projectHint.kind === 'node' &&
    !projectHint.notices.includes(PRIVATE_NPM_PACKAGE_NOTICE)
  ) {
    projectHint = {
      ...projectHint,
      notices: [...projectHint.notices, '未找到与此仓库一致的 npm 发布版本，无法生成草稿']
    }
  }
  return {
    repo,
    ...(ref ? { ref } : {}),
    sha,
    packages: [],
    skipped: empty.discovery.skipped,
    warnings: empty.discovery.warnings,
    projectHint,
    ...(localDraft ? { localDraft } : {})
  }
}

function safeConnectorName(name: string): string | undefined {
  let candidate = name
    .replace(/^@/, '')
    .replace('/', '-')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
  if (!/^[A-Za-z]/.test(candidate)) candidate = `mcp-${candidate}`
  if (candidate.length < 2) candidate = `${candidate}-mcp`
  candidate = candidate.slice(0, 64).replace(/[-_]+$/g, '')
  try {
    return validateName(candidate)
  } catch {
    return undefined
  }
}

async function fetchAndDiscover(
  repo: string,
  sha: string,
  options: GithubSourceServiceOptions,
  force: boolean
): Promise<ResolvedDiscovery> {
  const repository = parseGithubRepoUrl(`https://github.com/${repo}`)
  const srcDir = await fetchGithubSnapshot(repository, sha, {
    cacheRoot: cacheRoot(options),
    ...(options.tmpDir ? { tmpDir: options.tmpDir } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
    force
  })
  return { srcDir, ...discoverPackages(srcDir) }
}

function materializeDiscovery(
  discovery: ResolvedDiscovery,
  id: string,
  options: GithubSourceServiceOptions
): string {
  const registryPath = safeChild(resolve(discovery.srcDir, '..'), 'registry')
  rmSync(registryPath, { recursive: true, force: true })
  if (discovery.prebuiltRegistryDir) {
    materializePrebuiltRegistry(discovery, registryPath)
  } else {
    materializeRegistry(discovery.packageDirs, registryPath, {
      id,
      trust: 'imported',
      generatedAt: isoNow(options)
    })
  }
  readRegistry(registryPath)
  return registryPath
}

function materializePrebuiltRegistry(discovery: ResolvedDiscovery, registryPath: string): void {
  const source = discovery.prebuiltRegistryDir!
  const allowed = new Set(discovery.packages.map((entry) => `${entry.id}@${entry.version}`))
  const registry = readRegistry(source)
  const packages = registry.packages.filter(
    (entry) => entry.type === 'mcp' && allowed.has(`${entry.id}@${entry.version}`)
  )
  mkdirSync(registryPath, { recursive: true })
  for (const entry of packages) {
    const assets = [
      { path: entry.archive, sha256: entry.sha256, size: entry.size },
      entry.manifestAsset,
      entry.iconAsset
    ].filter((asset) => asset !== undefined)
    for (const asset of assets) {
      const target = safeChild(registryPath, ...asset.path.split('/'))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, readRegistryAsset(source, asset))
    }
  }
  writeFileSync(
    join(registryPath, 'index.json'),
    `${JSON.stringify({ schemaVersion: 1, generatedAt: registry.generatedAt, packages }, null, 2)}\n`,
    'utf8'
  )
}

function packageDiff(
  registryPath: string,
  next: readonly GithubPackagePreview[]
): GithubSourceDiff {
  const current = new Map(
    readRegistry(registryPath)
      .packages.filter((entry) => entry.type === 'mcp')
      .map((entry) => [entry.id, entry.version])
  )
  const incoming = new Map(next.map((entry) => [entry.id, entry.version]))
  const added = [...incoming]
    .filter(([id]) => !current.has(id))
    .map(([id, version]) => ({ id, version }))
  const removed = [...current]
    .filter(([id]) => !incoming.has(id))
    .map(([id, version]) => ({ id, version }))
  const changed = [...incoming]
    .filter(([id, version]) => current.has(id) && current.get(id) !== version)
    .map(([id, toVersion]) => ({ id, fromVersion: current.get(id)!, toVersion }))
  const compare = (left: { id: string }, right: { id: string }): number =>
    left.id.localeCompare(right.id)
  return {
    added: added.sort(compare),
    removed: removed.sort(compare),
    changed: changed.sort(compare)
  }
}

function sourceById(id: string, options: GithubSourceServiceOptions): GithubSourceRecord {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('GitHub 软件源标识无效')
  const state = readGithubSources(options.agentDir)
  assertMutable(state)
  const source = state.sources.find((entry) => entry.id === id)
  if (!source) throw new Error('找不到 GitHub 软件源')
  assertManagedRegistryPath(source, options)
  return source
}

function assertManagedRegistryPath(
  source: GithubSourceRecord,
  options: GithubSourceServiceOptions
): void {
  const repository = parseGithubRepoUrl(`https://github.com/${source.repo}`)
  const expected = safeChild(
    cacheRoot(options),
    repository.owner,
    repository.name,
    source.sha,
    'registry'
  )
  if (resolve(source.registryPath) !== expected) throw new Error('GitHub 软件源路径越过受管缓存')
}

function removeSnapshot(source: GithubSourceRecord, options: GithubSourceServiceOptions): void {
  assertManagedRegistryPath(source, options)
  rmSync(resolve(source.registryPath, '..'), { recursive: true, force: true })
}

function cacheRoot(options: GithubSourceServiceOptions): string {
  return resolve(options.agentDir ?? getPhiAgentDir(), 'cache', 'sources', 'github')
}

function safeChild(root: string, ...parts: string[]): string {
  const base = resolve(root)
  const target = resolve(base, ...parts)
  const suffix = relative(base, target)
  if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) {
    throw new Error('GitHub 软件源路径越过受管缓存')
  }
  return target
}

function validateSha(value: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/i.test(value)) {
    throw new Error('GitHub 提交 SHA 无效')
  }
  return value.toLowerCase()
}

function isoNow(options: GithubSourceServiceOptions): string {
  return (options.now ?? (() => new Date()))().toISOString()
}

function assertMutable(state: GithubSourcesState): void {
  if (state.error) throw new Error(`${state.error}；请先修复或移走该文件`)
}

function runSourceMutation<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = mutationTails.get(key) ?? Promise.resolve()
  const run = previous.then(task, task)
  const tail = run.catch(() => undefined)
  mutationTails.set(key, tail)
  return run.finally(() => {
    if (mutationTails.get(key) === tail) mutationTails.delete(key)
  })
}
