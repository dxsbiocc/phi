import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { parseTarGz } from './archive'
import { parseGitRefAdvertisement } from './github-git-refs'
import { NoGithubMcpPackagesError } from './github-source-errors'
import { readRegistryAsset } from './registry-assets'
import { readRegistry } from './registry'
import { parsePackageManifestText, validatePackage, type McpPackageManifest } from './manifest'
import type {
  GithubSourcePackagePreview,
  GithubSourceSkippedPackage
} from '../../../shared/githubSourceTypes'

import { isRecord } from '../../../shared/guards'
import { errorMessage } from '../../../shared/errorCodes'
export interface GithubRepository {
  owner: string
  name: string
  repo: string
  ref?: string
}

export interface GithubFetchOptions {
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

export interface GithubSnapshotLimits {
  maxCompressedBytes: number
  maxExpandedBytes: number
  maxEntries: number
  maxDepth: number
}

export interface GithubSnapshotOptions extends GithubFetchOptions {
  cacheRoot: string
  tmpDir?: string
  limits?: Partial<GithubSnapshotLimits>
  force?: boolean
}

const DEFAULT_SNAPSHOT_LIMITS: GithubSnapshotLimits = {
  maxCompressedBytes: 64 * 1024 * 1024,
  maxExpandedBytes: 256 * 1024 * 1024,
  maxEntries: 20_000,
  maxDepth: 12
}

export type GithubPackagePreview = GithubSourcePackagePreview
export type GithubSkippedPackage = GithubSourceSkippedPackage

export interface GithubPackageDiscovery {
  packages: GithubPackagePreview[]
  packageDirs: string[]
  skipped: GithubSkippedPackage[]
  warnings: string[]
  prebuiltRegistryDir?: string
}

const MAX_REF_ADVERTISEMENT_BYTES = 4 * 1024 * 1024
const PACKAGE_SEARCH_DEPTH = 3
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules'])
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/
const GITHUB_REF = /^[A-Za-z0-9._/-]{1,200}$/

export function parseGithubRepoUrl(input: string): GithubRepository {
  if (typeof input !== 'string' || !input.trim()) throw new Error('GitHub 仓库地址无效')
  const raw = input.trim()
  if (/%[0-9a-f]{2}/i.test(raw)) throw new Error('GitHub 仓库地址不能包含编码路径')

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('GitHub 仓库地址无效')
  }
  const authority = /^https:\/\/([^/]+)(?:\/|$)/i.exec(raw)?.[1]
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'github.com' ||
    authority?.toLowerCase() !== 'github.com' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw new Error('仅支持不含凭据、端口、查询参数的 https://github.com 仓库地址')
  }

  const parts = url.pathname.split('/').slice(1)
  const trailingSlash = parts.at(-1) === ''
  if (trailingSlash) parts.pop()
  if (parts.length < 2 || parts.some((part) => !part)) throw new Error('GitHub 仓库地址无效')
  const owner = parts[0]!
  const rawName = parts[1]!
  const name = rawName.endsWith('.git') ? rawName.slice(0, -4) : rawName
  if (!GITHUB_OWNER.test(owner) || !GITHUB_REPO.test(name) || name === '.' || name === '..') {
    throw new Error('GitHub 仓库名称无效')
  }

  let ref: string | undefined
  if (parts.length > 2) {
    if (trailingSlash) throw new Error('GitHub 分支或提交引用不能以 / 结尾')
    if (parts[2] !== 'tree' || parts.length < 4) throw new Error('GitHub 仓库地址路径无效')
    ref = parts.slice(3).join('/')
    if (
      !GITHUB_REF.test(ref) ||
      ref.includes('..') ||
      ref.startsWith('-') ||
      ref.startsWith('/') ||
      ref.endsWith('/')
    ) {
      throw new Error('GitHub 分支或提交引用无效')
    }
  }

  return { owner, name, repo: `${owner}/${name}`, ...(ref ? { ref } : {}) }
}

export async function resolveGithubRef(
  repository: GithubRepository,
  ref?: string,
  options: GithubFetchOptions = {}
): Promise<string> {
  assertGithubRepository(repository)
  if (ref && /^[a-f0-9]{40}$/i.test(ref)) return ref.toLowerCase()
  if (ref !== undefined && !validGithubRef(ref)) throw new Error('GitHub 分支或提交引用无效')

  // The git ref advertisement is anonymous and is not part of the 60-per-hour REST quota, so it
  // answers first; the REST API only handles refs it cannot (short shas) or when it is unreachable.
  const advertised = await resolveViaGitRefs(repository, ref, options)
  return advertised ?? resolveViaApi(repository, ref, options)
}

async function resolveViaGitRefs(
  repository: GithubRepository,
  ref: string | undefined,
  options: GithubFetchOptions
): Promise<string | undefined> {
  const timeoutMs = options.timeoutMs ?? 30_000
  let response: Response
  try {
    response = await githubFetch(
      options.fetch ?? globalThis.fetch,
      `https://github.com/${repository.owner}/${repository.name}.git/info/refs?service=git-upload-pack`,
      {
        headers: { Accept: 'application/x-git-upload-pack-advertisement' },
        credentials: 'omit',
        redirect: 'error'
      },
      timeoutMs,
      'GitHub 引用查询超时'
    )
  } catch {
    return undefined
  }
  // A private or missing repository answers 401/404 here; the API would say the same, without
  // costing quota.
  if (response.status === 404 || response.status === 401) {
    throw new Error('找不到仓库或分支（仅支持公开仓库）')
  }
  if (!response.ok) return undefined
  try {
    const bytes = await readBoundedResponse(
      response,
      MAX_REF_ADVERTISEMENT_BYTES,
      'GitHub 引用列表',
      timeoutMs
    )
    return parseGitRefAdvertisement(bytes).resolve(ref)
  } catch {
    return undefined
  }
}

async function resolveViaApi(
  repository: GithubRepository,
  ref: string | undefined,
  options: GithubFetchOptions
): Promise<string> {
  const response = await githubFetch(
    options.fetch ?? globalThis.fetch,
    `https://api.github.com/repos/${repository.owner}/${repository.name}/commits/${encodeURIComponent(ref ?? 'HEAD')}`,
    {
      headers: { Accept: 'application/vnd.github+json' },
      credentials: 'omit',
      redirect: 'error'
    },
    options.timeoutMs ?? 30_000,
    'GitHub 提交查询超时'
  )
  if (response.status === 404) throw new Error('找不到仓库或分支（仅支持公开仓库）')
  if (
    (response.status === 403 || response.status === 429) &&
    response.headers.get('x-ratelimit-remaining') === '0'
  ) {
    throw new Error(`GitHub 请求次数已用完${rateLimitRecovery(response)}，请稍后重试`)
  }
  if (!response.ok) throw new Error(`GitHub 提交查询失败（HTTP ${response.status}）`)
  const bytes = await readBoundedResponse(
    response,
    1024 * 1024,
    'GitHub 提交响应',
    options.timeoutMs ?? 30_000
  )
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    throw new Error('GitHub 提交响应格式无效')
  }
  const sha = isRecord(value) && typeof value.sha === 'string' ? value.sha.toLowerCase() : ''
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('GitHub 提交响应缺少有效 SHA')
  return sha
}

/** "（约 N 分钟后恢复）" from `x-ratelimit-reset`, or nothing when the header is absent or stale. */
function rateLimitRecovery(response: Response): string {
  const reset = Number(response.headers.get('x-ratelimit-reset'))
  if (!Number.isFinite(reset) || reset <= 0) return ''
  const minutes = Math.ceil((reset * 1000 - Date.now()) / 60_000)
  return minutes >= 1 && minutes <= 120 ? `（约 ${minutes} 分钟后恢复）` : ''
}

export async function fetchGithubSnapshot(
  repository: GithubRepository,
  sha: string,
  options: GithubSnapshotOptions
): Promise<string> {
  assertGithubRepository(repository)
  const normalizedSha = sha.toLowerCase()
  if (!/^[a-f0-9]{40}$/.test(normalizedSha)) throw new Error('GitHub 提交 SHA 无效')
  const cacheRoot = resolve(options.cacheRoot)
  const snapshotRoot = safeChild(cacheRoot, repository.owner, repository.name, normalizedSha)
  const sourceDir = join(snapshotRoot, 'src')
  const completeMarker = join(snapshotRoot, '.complete.json')
  if (!options.force && completeSnapshot(sourceDir, completeMarker, normalizedSha)) return sourceDir

  const stagingRoot = resolve(options.tmpDir ?? join(cacheRoot, '.staging'))
  assertContained(cacheRoot, stagingRoot, 'GitHub 暂存目录')
  mkdirSync(stagingRoot, { recursive: true })
  const staging = mkdtempSync(join(stagingRoot, `snapshot-${randomBytes(4).toString('hex')}-`))
  const stagingSource = join(staging, 'src')
  let published = false
  try {
    const limits = { ...DEFAULT_SNAPSHOT_LIMITS, ...options.limits }
    validateSnapshotLimits(limits)
    const response = await githubFetch(
      options.fetch ?? globalThis.fetch,
      `https://codeload.github.com/${repository.owner}/${repository.name}/tar.gz/${normalizedSha}`,
      { headers: { Accept: 'application/octet-stream' }, credentials: 'omit', redirect: 'error' },
      options.timeoutMs ?? 60_000,
      'GitHub 压缩包下载超时'
    )
    if (response.status === 404) throw new Error('找不到仓库或提交（仅支持公开仓库）')
    if (!response.ok) throw new Error(`GitHub 压缩包下载失败（HTTP ${response.status}）`)
    const archive = await readBoundedResponse(
      response,
      limits.maxCompressedBytes,
      'GitHub 压缩包',
      options.timeoutMs ?? 60_000
    )
    let entries: ReturnType<typeof parseTarGz>
    try {
      entries = parseTarGz(archive, limits.maxExpandedBytes)
    } catch (error) {
      throw new Error(`GitHub 压缩包无效或超过解压大小限制：${errorMessage(error)}`)
    }
    if (entries.length < 1 || entries.length > limits.maxEntries) {
      throw new Error(`GitHub 压缩包条目数量超过限制（${limits.maxEntries}）`)
    }

    // GitHub prefixes its archives with a pax global header that only carries the commit id.
    // Ignore exactly that metadata record; any other special entry is still rejected below.
    const contentEntries = entries.filter((entry) => !isPaxGlobalHeader(entry))
    const normalized = contentEntries.map((entry) => ({
      entry,
      path: checkedArchivePath(entry.path)
    }))
    const topLevels = new Set(normalized.map(({ path }) => path[0]))
    if (topLevels.size !== 1) throw new Error('GitHub 压缩包必须只有一个顶层目录')
    const topLevel = [...topLevels][0]!
    if (!topLevel.endsWith(`-${normalizedSha}`)) {
      throw new Error('GitHub 快照与预览的提交 SHA 不一致')
    }
    const seen = new Set<string>()
    for (const { entry, path } of normalized) {
      if (entry.type === 'link') throw new Error(`GitHub 压缩包不允许链接：${entry.path}`)
      if (entry.type === 'other') throw new Error(`GitHub 压缩包包含特殊文件：${entry.path}`)
      const stripped = path.slice(1)
      if (stripped.length === 0) {
        if (entry.type !== 'directory') throw new Error('GitHub 压缩包顶层条目必须是目录')
        continue
      }
      if (stripped.length > limits.maxDepth) {
        throw new Error(`GitHub 压缩包路径深度超过限制（${limits.maxDepth}）`)
      }
      const relativePath = stripped.join('/')
      if (seen.has(relativePath)) throw new Error(`GitHub 压缩包包含重复路径：${relativePath}`)
      seen.add(relativePath)
      const target = safeChild(stagingSource, ...stripped)
      if (entry.type === 'directory') {
        mkdirSync(target, { recursive: true })
      } else {
        mkdirSync(resolve(target, '..'), { recursive: true })
        writeFileSync(target, entry.data, { flag: 'wx' })
        chmodSync(target, entry.mode & 0o777)
      }
    }
    mkdirSync(stagingSource, { recursive: true })

    if (existsSync(snapshotRoot)) rmSync(snapshotRoot, { recursive: true, force: true })
    mkdirSync(resolve(snapshotRoot, '..'), { recursive: true })
    mkdirSync(snapshotRoot)
    renameSync(stagingSource, sourceDir)
    writeFileSync(
      completeMarker,
      `${JSON.stringify({ version: 1, repo: repository.repo, sha: normalizedSha })}\n`,
      { encoding: 'utf8', flag: 'wx' }
    )
    published = true
    return sourceDir
  } finally {
    rmSync(staging, { recursive: true, force: true })
    if (!published && existsSync(snapshotRoot))
      rmSync(snapshotRoot, { recursive: true, force: true })
  }
}

export function discoverPackages(srcDir: string): GithubPackageDiscovery {
  const source = resolve(srcDir)
  if (regularFile(join(source, 'index.json'))) return discoverPrebuiltRegistry(source)

  const candidates = regularFile(join(source, 'phi-package.yaml'))
    ? [source]
    : packageCandidates(source)
  const packageDirs: string[] = []
  const packages: GithubPackagePreview[] = []
  const skipped: GithubSkippedPackage[] = []
  const warnings: string[] = []
  const ids = new Set<string>()
  for (const candidate of candidates) {
    const result = validatePackage(candidate)
    const displayPath = relative(source, candidate) || '.'
    if (!result.ok || !result.package) {
      warnings.push(
        `${displayPath}: ${result.errors
          .map((problem) => `${problem.path}: ${problem.message}`)
          .join('；')}`
      )
      continue
    }
    const manifest = result.package.manifest
    for (const warning of result.warnings) {
      warnings.push(`${displayPath}: ${warning.path}: ${warning.message}`)
    }
    if (manifest.type !== 'mcp') {
      skipped.push({
        id: manifest.id,
        type: manifest.type,
        reason: `暂不支持导入: ${manifest.type} ${manifest.id}`
      })
      continue
    }
    if (ids.has(manifest.id)) throw new Error(`GitHub 仓库包含重复软件包: ${manifest.id}`)
    ids.add(manifest.id)
    packageDirs.push(candidate)
    packages.push(packagePreview(manifest))
  }
  packages.sort((left, right) => left.id.localeCompare(right.id))
  packageDirs.sort((left, right) => left.localeCompare(right))
  skipped.sort((left, right) => (left.id ?? left.type).localeCompare(right.id ?? right.type))
  const discovery = { packages, packageDirs, skipped, warnings }
  if (packages.length === 0) throw new NoGithubMcpPackagesError(source, discovery)
  return discovery
}

function isPaxGlobalHeader(entry: ReturnType<typeof parseTarGz>[number]): boolean {
  return entry.type === 'other' && entry.path === 'pax_global_header' && entry.size <= 1024
}

function assertGithubRepository(repository: GithubRepository): void {
  if (
    !GITHUB_OWNER.test(repository.owner) ||
    !GITHUB_REPO.test(repository.name) ||
    repository.name === '.' ||
    repository.name === '..' ||
    repository.repo !== `${repository.owner}/${repository.name}`
  ) {
    throw new Error('GitHub 仓库名称无效')
  }
}

function discoverPrebuiltRegistry(source: string): GithubPackageDiscovery {
  const registry = readRegistry(source)
  const packages: GithubPackagePreview[] = []
  const skipped: GithubSkippedPackage[] = []
  const warnings: string[] = []
  const ids = new Set<string>()
  for (const entry of registry.packages) {
    const archive = readRegistryAsset(source, {
      path: entry.archive,
      sha256: entry.sha256,
      size: entry.size
    })
    if (entry.type !== 'mcp') {
      skipped.push({
        id: entry.id,
        type: entry.type,
        reason: `暂不支持导入: ${entry.type} ${entry.id}`
      })
      continue
    }
    try {
      const manifestEntry = parseTarGz(archive, DEFAULT_SNAPSHOT_LIMITS.maxExpandedBytes).find(
        (item) => item.type === 'file' && item.path === 'phi-package.yaml'
      )
      if (!manifestEntry) throw new Error('archive is missing phi-package.yaml')
      const manifest = parsePackageManifestText(manifestEntry.data.toString('utf8'))
      if (
        manifest.type !== 'mcp' ||
        manifest.id !== entry.id ||
        manifest.version !== entry.version
      ) {
        throw new Error(`manifest identity does not match mcp:${entry.id}@${entry.version}`)
      }
      if (ids.has(manifest.id)) throw new Error(`GitHub 仓库包含重复软件包: ${manifest.id}`)
      ids.add(manifest.id)
      packages.push(packagePreview(manifest))
    } catch (error) {
      warnings.push(`${entry.archive}: ${errorMessage(error)}`)
    }
  }
  packages.sort((left, right) => left.id.localeCompare(right.id))
  skipped.sort((left, right) => (left.id ?? left.type).localeCompare(right.id ?? right.type))
  const discovery = {
    packages,
    packageDirs: [],
    skipped,
    warnings,
    prebuiltRegistryDir: source
  }
  if (packages.length === 0) throw new NoGithubMcpPackagesError(source, discovery)
  return discovery
}

function packageCandidates(source: string): string[] {
  const candidates: string[] = []
  // Phi's own content repository keeps connectors at resources/connectors/<id>, three levels down.
  const visit = (dir: string, depth: number): void => {
    if (depth > PACKAGE_SEARCH_DEPTH) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || SKIPPED_DIRECTORIES.has(entry.name)) {
        continue
      }
      const child = join(dir, entry.name)
      if (regularFile(join(child, 'phi-package.yaml'))) candidates.push(child)
      if (depth < PACKAGE_SEARCH_DEPTH) visit(child, depth + 1)
    }
  }
  visit(source, 1)
  return [...new Set(candidates)].sort((left, right) => left.localeCompare(right))
}

function packagePreview(manifest: McpPackageManifest): GithubPackagePreview {
  return {
    id: manifest.id,
    version: manifest.version,
    title: manifest.title,
    summary: manifest.summary,
    publisher: manifest.connector.publisher,
    transport: manifest.connector.transport
  }
}

function regularFile(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function completeSnapshot(sourceDir: string, marker: string, sha: string): boolean {
  try {
    if (!lstatSync(sourceDir).isDirectory() || lstatSync(sourceDir).isSymbolicLink()) return false
    const value = JSON.parse(readFileSync(marker, 'utf8')) as unknown
    return isRecord(value) && value.version === 1 && value.sha === sha
  } catch {
    return false
  }
}

function validateSnapshotLimits(limits: GithubSnapshotLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`GitHub 压缩包限制无效：${name}`)
  }
}

function checkedArchivePath(path: string): string[] {
  if (
    !path ||
    path.includes('\0') ||
    path.includes('\\') ||
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path)
  ) {
    throw new Error(`GitHub 压缩包路径不安全：${path}`)
  }
  const parts = path.split('/').filter((part, index, all) => part || index !== all.length - 1)
  if (parts.length < 1 || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`GitHub 压缩包路径不安全：${path}`)
  }
  return parts
}

function safeChild(root: string, ...parts: string[]): string {
  const target = resolve(root, ...parts)
  assertContained(resolve(root), target, 'GitHub 缓存路径')
  return target
}

function assertContained(root: string, target: string, label: string): void {
  const suffix = relative(root, target)
  if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) {
    throw new Error(`${label}越过受管目录`)
  }
}

function validGithubRef(ref: string): boolean {
  return (
    GITHUB_REF.test(ref) &&
    !ref.includes('..') &&
    !ref.startsWith('-') &&
    !ref.startsWith('/') &&
    !ref.endsWith('/')
  )
}

async function githubFetch(
  fetcher: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  timeoutMessage: string
): Promise<Response> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fetcher(url, { ...init, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error(timeoutMessage))
        }, timeoutMs)
        timer.unref?.()
      })
    ])
  } catch (error) {
    if (controller.signal.aborted && error instanceof Error && error.name === 'AbortError') {
      throw new Error(timeoutMessage)
    }
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  label: string,
  timeoutMs: number
): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new Error(`${label} exceeds the size limit`)
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  const deadline = Date.now() + timeoutMs
  try {
    while (true) {
      const result = await readWithDeadline(reader, deadline, label)
      if (result.done) break
      const chunk = Buffer.from(result.value)
      size += chunk.length
      if (size > maxBytes) throw new Error(`${label} exceeds the size limit`)
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size)
}

async function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadline: number,
  label: string
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error(`${label} read timed out`)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} read timed out`)), remaining)
        timer.unref?.()
      })
    ])
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export {
  addGithubSource,
  applyGithubSourceUpdate,
  checkGithubSourceUpdate,
  listGithubSources,
  previewGithubSource,
  removeGithubSource
} from './github-source-service'
export type {
  GithubSourceDiff,
  GithubSourcePreview,
  GithubSourceServiceOptions,
  GithubSourceUpdateCheck
} from './github-source-service'
