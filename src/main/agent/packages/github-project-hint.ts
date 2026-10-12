import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import semver from 'semver'

import type { GithubProjectHint, GithubProjectHintNpm } from '../../../shared/githubSourceTypes'
import { readBoundedResponse, type GithubRepository } from './github-source'

const MAX_PROJECT_FILE_BYTES = 1024 * 1024
const LOCKFILES = ['package-lock.json', 'bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'yarn.lock']
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare']
const NPM_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/
const MAX_NPM_METADATA_BYTES = 8 * 1024 * 1024
export const PRIVATE_NPM_PACKAGE_NOTICE = '该包标记为 private，不会发布到 npm'

export type NpmPackageResolution =
  { npm: GithubProjectHintNpm; notice?: never } | { npm?: never; notice: string }

export async function resolveNpmPackage(
  name: string,
  repository: GithubRepository,
  preferredVersion: string | undefined,
  options: { fetch: typeof globalThis.fetch; timeoutMs: number }
): Promise<NpmPackageResolution> {
  if (name.length > 214 || !NPM_NAME.test(name)) return { notice: 'npm 包名无效' }
  const encodedName = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : name
  let response: Response
  try {
    response = await fetchWithTimeout(
      options.fetch,
      `https://registry.npmjs.org/${encodedName}`,
      {
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        redirect: 'error'
      },
      options.timeoutMs
    )
    if (response.status === 404) return { notice: 'npm 上没有这个包' }
    if (response.status >= 300 && response.status < 400) {
      return { notice: 'npm 元数据重定向已拒绝' }
    }
    if (!response.ok) return { notice: `npm 元数据请求失败（HTTP ${response.status}）` }
    const bytes = await readBoundedResponse(
      response,
      MAX_NPM_METADATA_BYTES,
      'npm 元数据',
      options.timeoutMs
    )
    const document = parseJsonRecord(bytes.toString('utf8'))
    if (!document) return { notice: 'npm 元数据格式无效' }
    return resolvedNpmMetadata(name, repository, preferredVersion, document)
  } catch {
    return { notice: 'npm 元数据不可用' }
  }
}

export function analyzeProject(
  srcDir: string,
  repository: GithubRepository,
  sha: string
): GithubProjectHint {
  const root = resolve(srcDir)
  const packageText = readRootFile(root, 'package.json')
  if (packageText !== undefined) {
    const manifest = parseJsonRecord(packageText)
    if (manifest) return analyzeNodeProject(root, repository, sha, manifest)
  }
  const pyproject = readRootFile(root, 'pyproject.toml')
  if (pyproject !== undefined) return analyzePythonProject(root, repository, sha, pyproject)
  return {
    kind: 'unknown',
    summary: '未识别的项目',
    notices: [
      '这个仓库不是 Phi 软件包格式（没有 phi-package.yaml），也没有识别到 Node 或 Python 项目。'
    ]
  }
}

function analyzePythonProject(
  root: string,
  repository: GithubRepository,
  sha: string,
  pyproject: string
): GithubProjectHint {
  const project = projectTomlFields(pyproject)
  const name = project.name
  const version = project.version
  return {
    kind: 'python',
    summary: ['Python 项目', name, version].filter(Boolean).join(' '),
    ...(name ? { name } : {}),
    ...(version ? { version } : {}),
    ...readme(root, repository, sha),
    notices: ['Python 项目暂不支持自动安装；可在终端自行安装后，用 本地 (stdio) 添加']
  }
}

function analyzeNodeProject(
  root: string,
  repository: GithubRepository,
  sha: string,
  manifest: Record<string, unknown>
): GithubProjectHint {
  const name = stringValue(manifest.name)
  const version = stringValue(manifest.version)
  const scripts = recordValue(manifest.scripts)
  const entry = nodeEntry(manifest.bin, name) ?? stringValue(manifest.main)
  const entryCommitted = entry === undefined ? undefined : containedRegularFile(root, entry)
  const needsBuild = Boolean(entry && !entryCommitted && stringValue(scripts?.build))
  const nodeEngine = stringValue(recordValue(manifest.engines)?.node)
  const hasLifecycleScripts = LIFECYCLE_SCRIPTS.some((key) => Boolean(stringValue(scripts?.[key])))
  const hasLockfile = LOCKFILES.some((file) => regularRootFile(root, file))
  const notices: string[] = []
  if (needsBuild) {
    notices.push(`入口 ${entry} 未随源码提交，需要先构建；Phi 不会自动构建源码`)
  }
  if (hasLifecycleScripts) notices.push('npm 安装时可能运行脚本或编译原生模块')
  if (nodeEngine) {
    notices.push(`声明需要 Node ${nodeEngine}；Phi 内置 Bun 提供 Node 兼容 API，不保证所有依赖可用`)
  }
  if (manifest.private === true) notices.push(PRIVATE_NPM_PACKAGE_NOTICE)

  return {
    kind: 'node',
    summary: ['Node.js 项目', name, version].filter(Boolean).join(' '),
    ...(name ? { name } : {}),
    ...(version ? { version } : {}),
    ...(entry ? { entry, entryCommitted, needsBuild } : {}),
    ...(nodeEngine ? { nodeEngine } : {}),
    hasLifecycleScripts,
    hasLockfile,
    ...readme(root, repository, sha),
    notices
  }
}

function readRootFile(root: string, name: string): string | undefined {
  const path = resolve(root, name)
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PROJECT_FILE_BYTES) {
      return undefined
    }
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function regularRootFile(root: string, name: string): boolean {
  try {
    const stat = lstatSync(resolve(root, name))
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function containedRegularFile(root: string, entry: string): boolean {
  if (!entry || entry.includes('\0') || isAbsolute(entry)) return false
  const target = resolve(root, entry)
  const suffix = relative(root, target)
  if (suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) return false
  try {
    const stat = lstatSync(target)
    if (!stat.isFile() || stat.isSymbolicLink()) return false
    const realTarget = realpathSync(target)
    const realSuffix = relative(realpathSync(root), realTarget)
    return !(realSuffix === '..' || realSuffix.startsWith(`..${sep}`) || isAbsolute(realSuffix))
  } catch {
    return false
  }
}

function nodeEntry(bin: unknown, name: string | undefined): string | undefined {
  if (typeof bin === 'string' && bin.trim()) return bin
  const entries = Object.entries(recordValue(bin) ?? {}).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1].trim())
  )
  return entries.find(([key]) => key === name)?.[1] ?? entries[0]?.[1]
}

function readme(
  root: string,
  repository: GithubRepository,
  sha: string
): Pick<GithubProjectHint, 'readmeUrl'> {
  try {
    const entry = readdirSync(root, { withFileTypes: true }).find(
      (item) => item.name.toLowerCase() === 'readme.md' && item.isFile() && !item.isSymbolicLink()
    )
    return entry
      ? { readmeUrl: `https://github.com/${repository.repo}/blob/${sha}/${entry.name}` }
      : {}
  } catch {
    return {}
  }
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    return recordValue(JSON.parse(text) as unknown)
  } catch {
    return undefined
  }
}

function projectTomlFields(text: string): { name?: string; version?: string } {
  const result: { name?: string; version?: string } = {}
  let inProject = false
  for (const line of text.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line)
    if (section) {
      inProject = section[1] === 'project'
      continue
    }
    if (!inProject) continue
    const field = /^\s*(name|version)\s*=\s*(["'])([^"']*)\2\s*(?:#.*)?$/.exec(line)
    if (field && field[3]?.trim()) result[field[1] as 'name' | 'version'] = field[3].trim()
  }
  return result
}

function resolvedNpmMetadata(
  name: string,
  repository: GithubRepository,
  preferredVersion: string | undefined,
  document: Record<string, unknown>
): NpmPackageResolution {
  const versions = recordValue(document.versions)
  const preferred = preferredVersion ? recordValue(versions?.[preferredVersion]) : undefined
  const preferredDeprecated = stringValue(preferred?.deprecated)
  const latest = stringValue(recordValue(document['dist-tags'])?.latest)
  const version = preferred && !preferredDeprecated ? preferredVersion : latest
  const selected = version ? recordValue(versions?.[version]) : undefined
  const declaredVersion = stringValue(selected?.version)
  if (
    !version ||
    !selected ||
    !semver.valid(version) ||
    (declaredVersion !== undefined &&
      (!semver.valid(declaredVersion) || declaredVersion !== version))
  ) {
    return { notice: 'npm 发布版本不是有效的 semver' }
  }
  const publishedRepository = normalizeGithubRepository(selected.repository ?? document.repository)
  const expectedRepository = `github.com/${repository.repo}`.toLowerCase()
  if (!publishedRepository) return { notice: 'npm 元数据缺少仓库地址' }
  if (publishedRepository !== expectedRepository) return { notice: 'npm 发布版本的仓库地址不匹配' }
  const deprecated = stringValue(selected.deprecated)
  return {
    npm: {
      name,
      version,
      repositoryMatches: true,
      ...(deprecated ? { deprecated } : {})
    }
  }
}

function normalizeGithubRepository(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value : stringValue(recordValue(value)?.url)
  if (!raw) return undefined
  let normalized = raw
    .trim()
    .replace(/#.*$/, '')
    .replace(/^git\+/i, '')
  normalized = normalized
    .replace(/^git@github\.com:/i, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//i, 'https://github.com/')
    .replace(/^git:\/\/github\.com\//i, 'https://github.com/')
    .replace(/^github\.com\//i, 'https://github.com/')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
  try {
    const parsed = new URL(normalized)
    if (parsed.hostname.toLowerCase() !== 'github.com' || parsed.username || parsed.password) {
      return undefined
    }
    const parts = parsed.pathname.split('/').filter(Boolean)
    return parts.length === 2 ? `github.com/${parts[0]}/${parts[1]}`.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

async function fetchWithTimeout(
  fetcher: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fetcher(url, { ...init, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('npm 元数据请求超时'))
        }, timeoutMs)
        timer.unref?.()
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
