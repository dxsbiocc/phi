import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { lstat, mkdir, rename, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'

import type { RemoteMicromambaArtifact } from '../../shared/remoteMicromambaTypes'
import { hashFile, transferFile } from './download/file-transfer'
import { getBundledResourceDir } from './runtime/runtime-adapter'
import { getPhiAgentDir } from './runtime-paths'
import type { HostCapabilityProfile } from './workspace-host/types'

export type { RemoteMicromambaArtifact } from '../../shared/remoteMicromambaTypes'

export const REMOTE_MICROMAMBA_TARGETS = ['linux-x64', 'linux-arm64'] as const
export type RemoteMicromambaTarget = (typeof REMOTE_MICROMAMBA_TARGETS)[number]
const artifactDownloads = new Map<string, Promise<RemoteMicromambaArtifact>>()
const nodeRequire = createRequire(import.meta.url)

export interface RemoteMicromambaArtifactPlan extends RemoteMicromambaArtifact {
  url: string
  mirrorPrefixes?: readonly string[]
}

interface RemoteMicromambaManifest {
  micromamba: {
    version: string
    platforms: Readonly<
      Record<
        string,
        { url: string; sha256: string; size: number; mirrorPrefixes?: readonly string[] }
      >
    >
  }
}

interface DescribeRemoteMicromambaOptions {
  agentDir?: string
  manifestPath?: string
}

export interface RemoteMicromambaDownloadProgress {
  downloadedBytes: number
  totalBytes: number
}

export interface RemoteMicromambaDownloadRequest {
  url: string
  destination: string
  expectedSize: number
  timeoutMs: number
  signal?: AbortSignal
  onProgress?: (progress: RemoteMicromambaDownloadProgress) => void
}

export type RemoteMicromambaDownloader = (request: RemoteMicromambaDownloadRequest) => Promise<void>

export interface GetRemoteMicromambaOptions extends DescribeRemoteMicromambaOptions {
  download?: RemoteMicromambaDownloader
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  signal?: AbortSignal
  onProgress?: (progress: RemoteMicromambaDownloadProgress) => void
}

type ElectronNet = { net?: { fetch: typeof globalThis.fetch } }

function desktopFetch(override?: typeof globalThis.fetch): typeof globalThis.fetch {
  if (override) return override
  try {
    const electron = nodeRequire('electron') as ElectronNet | string
    if (typeof electron === 'object' && electron.net?.fetch) {
      return electron.net.fetch.bind(electron.net)
    }
  } catch {
    // Plain Node and isolated tests do not expose Electron's Chromium network stack.
  }
  return globalThis.fetch
}

async function fetchWithTimeout(
  fetcher: typeof globalThis.fetch,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController()
  const abort = (): void => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('micromamba 下载请求超时')), timeoutMs)
  timer.unref?.()
  try {
    return await fetcher(url, { headers, redirect: 'follow', signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted) throw new Error('micromamba 下载请求超时')
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

async function defaultDownload(
  request: RemoteMicromambaDownloadRequest,
  fetcher: typeof globalThis.fetch
): Promise<void> {
  await transferFile({
    url: request.url,
    destination: request.destination,
    maxBytes: request.expectedSize,
    maxAttempts: 1,
    idleTimeoutMs: request.timeoutMs,
    signal: request.signal,
    onProgress: (bytes, totalBytes) =>
      request.onProgress?.({
        downloadedBytes: bytes,
        totalBytes: totalBytes ?? request.expectedSize
      }),
    request: (headers, signal) =>
      fetchWithTimeout(fetcher, request.url, headers, signal, request.timeoutMs)
  })
}

function targetForPlatform(platform: HostCapabilityProfile['platform']): RemoteMicromambaTarget {
  if (platform.os !== 'linux') throw new Error('不支持：远程 micromamba 目前仅支持 Linux')
  if (platform.libc?.name !== 'glibc') {
    const reason = platform.libc?.name === 'musl' ? 'musl' : '未知 libc'
    throw new Error(`不支持：远程 micromamba 需要 glibc，当前为 ${reason}`)
  }
  if (['x86_64', 'amd64'].includes(platform.arch)) return 'linux-x64'
  if (['aarch64', 'arm64'].includes(platform.arch)) return 'linux-arm64'
  throw new Error(`不支持：远程 micromamba 不支持架构 ${platform.arch}`)
}

function readManifest(path: string): RemoteMicromambaManifest {
  let value: RemoteMicromambaManifest
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as RemoteMicromambaManifest
  } catch {
    throw new Error('无法读取 micromamba 资源清单')
  }
  if (typeof value.micromamba?.version !== 'string') throw new Error('micromamba 清单版本无效')
  return value
}

function isValidMirrorPrefix(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && value.endsWith('/')
  } catch {
    return false
  }
}

function validMirrorPrefixes(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((prefix) => typeof prefix === 'string' && isValidMirrorPrefix(prefix))
  )
}

export function remoteMicromambaSourceUrls(
  plan: Pick<RemoteMicromambaArtifactPlan, 'url' | 'mirrorPrefixes'>,
  userMirrorPrefix?: string
): readonly string[] {
  const prefixes = [...(userMirrorPrefix ? [userMirrorPrefix] : []), ...(plan.mirrorPrefixes ?? [])]
  return [plan.url, ...prefixes.map((prefix) => `${prefix}${plan.url}`)]
}

export function remoteMicromambaManifestVersion(
  options: DescribeRemoteMicromambaOptions = {}
): string {
  const manifestPath =
    options.manifestPath ?? join(getBundledResourceDir('runtime'), 'manifest.json')
  return readManifest(manifestPath).micromamba.version
}

export function describeRemoteMicromambaArtifact(
  platform: HostCapabilityProfile['platform'],
  options: DescribeRemoteMicromambaOptions = {}
): RemoteMicromambaArtifactPlan {
  const target = targetForPlatform(platform)
  const manifestPath =
    options.manifestPath ?? join(getBundledResourceDir('runtime'), 'manifest.json')
  const manifest = readManifest(manifestPath)
  const release = manifest.micromamba.platforms[target]
  if (
    !release ||
    !/^https:\/\//.test(release.url) ||
    !/^[a-f0-9]{64}$/.test(release.sha256) ||
    !Number.isSafeInteger(release.size) ||
    release.size < 1 ||
    (release.mirrorPrefixes !== undefined && !validMirrorPrefixes(release.mirrorPrefixes))
  ) {
    throw new Error(`micromamba 清单缺少有效的 ${target} 条目`)
  }
  const version = manifest.micromamba.version
  return {
    version,
    platform: target,
    localPath: join(
      options.agentDir ?? getPhiAgentDir(),
      'cache',
      'remote-micromamba',
      version,
      target,
      'micromamba'
    ),
    sha256: release.sha256,
    size: release.size,
    url: release.url,
    ...(release.mirrorPrefixes ? { mirrorPrefixes: [...release.mirrorPrefixes] } : {})
  }
}

async function cachedArtifact(plan: RemoteMicromambaArtifactPlan): Promise<boolean> {
  try {
    const entry = await lstat(plan.localPath)
    if (!entry.isFile() || entry.size !== plan.size) return false
    return (await hashFile(plan.localPath)) === `sha256:${plan.sha256}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function artifactResult(plan: RemoteMicromambaArtifactPlan): RemoteMicromambaArtifact {
  return {
    version: plan.version,
    platform: plan.platform,
    localPath: plan.localPath,
    sha256: plan.sha256,
    size: plan.size
  }
}

async function downloadAndPublish(
  plan: RemoteMicromambaArtifactPlan,
  options: GetRemoteMicromambaOptions
): Promise<void> {
  const directory = dirname(plan.localPath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${basename(plan.localPath)}.${randomUUID()}.partial`)
  try {
    options.signal?.throwIfAborted()
    const request: RemoteMicromambaDownloadRequest = {
      url: plan.url,
      destination: temporary,
      expectedSize: plan.size,
      timeoutMs: options.timeoutMs ?? 30_000,
      signal: options.signal,
      onProgress: options.onProgress
    }
    await (options.download ?? ((input) => defaultDownload(input, desktopFetch(options.fetch))))(
      request
    )
    options.signal?.throwIfAborted()
    if (!(await cachedArtifact({ ...plan, localPath: temporary }))) {
      throw new Error(`micromamba ${plan.platform} 下载文件的大小或 sha256 不匹配`)
    }
    await rename(temporary, plan.localPath)
  } finally {
    await rm(temporary, { force: true })
    await rm(`${temporary}.part`, { force: true })
    await rm(`${temporary}.part.json`, { force: true })
  }
}

async function ensureArtifact(
  plan: RemoteMicromambaArtifactPlan,
  options: GetRemoteMicromambaOptions
): Promise<RemoteMicromambaArtifact> {
  try {
    if (await cachedArtifact(plan)) return artifactResult(plan)
    await downloadAndPublish(plan, options)
    return artifactResult(plan)
  } catch (error) {
    const message = sanitizedFailureMessage(error, plan, options)
    if (error instanceof Error && error.name === 'AbortError') {
      const aborted = new Error(`micromamba ${plan.platform} 下载已取消`)
      aborted.name = 'AbortError'
      throw aborted
    }
    throw new Error(`micromamba ${plan.platform} 下载失败：${message}`)
  }
}

function sanitizedFailureMessage(
  error: unknown,
  plan: RemoteMicromambaArtifactPlan,
  options: GetRemoteMicromambaOptions
): string {
  let message = error instanceof Error ? error.message : String(error)
  const paths = [
    options.agentDir ?? getPhiAgentDir(),
    dirname(plan.localPath),
    options.manifestPath
  ]
  for (const path of paths) {
    if (path) message = message.replaceAll(path, '[Phi 本地缓存]')
  }
  return message || '未知错误'
}

function waitForDownload(
  pending: Promise<RemoteMicromambaArtifact>,
  signal?: AbortSignal
): Promise<RemoteMicromambaArtifact> {
  if (!signal) return pending
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new Error('micromamba 下载已取消'))
    signal.addEventListener('abort', abort, { once: true })
    pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
      .catch(() => undefined)
  })
}

export async function getRemoteMicromambaArtifact(
  platform: HostCapabilityProfile['platform'],
  options: GetRemoteMicromambaOptions = {}
): Promise<RemoteMicromambaArtifact> {
  const plan = describeRemoteMicromambaArtifact(platform, options)
  const existing = artifactDownloads.get(plan.localPath)
  if (existing) return waitForDownload(existing, options.signal)
  const pending = ensureArtifact(plan, options)
  artifactDownloads.set(plan.localPath, pending)
  try {
    return await pending
  } finally {
    if (artifactDownloads.get(plan.localPath) === pending) artifactDownloads.delete(plan.localPath)
  }
}
