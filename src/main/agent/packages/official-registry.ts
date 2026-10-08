import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

import { getPhiAgentDir } from '../runtime-paths'
import type {
  InstallerOptions,
  LocalRegistry,
  PackageRequest,
  RegistryPackageEntry
} from './installer-types'
import { errorMessage, sha256 } from './installer-utils'
import { readRegistryManifestAsset } from './manifest-assets'
import { planInstall } from './planning'
import { readRegistry } from './registry'
import {
  assertSafeRegistryAssetPath,
  readRegistryAsset,
  registryAssetPath,
  safeRegistryDirectory,
  type RegistryAsset
} from './registry-assets'
import { TRUSTED_REGISTRY_KEYS } from './trusted-keys'
import type { TrustedRegistryKey } from './signature'

export const OFFICIAL_REGISTRY_ID = 'phi-packages'
export const OFFICIAL_REGISTRY_BASE_URL =
  'https://github.com/dxsbiocc/phi-packages/releases/download/catalog-v1/'
const MAX_INDEX_BYTES = 4 * 1024 * 1024
const MAX_SIGNATURE_BYTES = 4096
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const REFRESH_WINDOW_MS = 5 * 60_000
const FAILED_RETRY_WINDOW_MS = 60_000
const archiveDownloads = new Map<string, Promise<void>>()
const syncs = new Map<string, Promise<LocalRegistry>>()
const refreshed = new Map<string, number>()
const failedRefreshes = new Map<string, { attemptedAt: number; error: Error }>()

export interface OfficialRegistryOptions {
  agentDir?: string
  /** Injected transport and identity are used by pure temporary-directory tests. */
  fetch?: typeof fetch
  baseUrl?: string
  trustedKeys?: readonly TrustedRegistryKey[]
  timeoutMs?: number
  now?: () => Date
  forceRefresh?: boolean
}

export function officialRegistryDirectory(agentDir = getPhiAgentDir()): string {
  return join(resolve(agentDir), 'cache', 'registries', OFFICIAL_REGISTRY_ID)
}

export function isOfficialRegistryDirectory(
  directory: string,
  agentDir = getPhiAgentDir()
): boolean {
  const root = officialRegistryDirectory(agentDir)
  const path = relative(root, resolve(directory))
  return (
    path === '' ||
    new RegExp(`^generations[${sep === '\\' ? '\\\\' : '/'}][a-f0-9]{64}$`).test(path)
  )
}

/** An invalid or missing cache is unavailable, never implicitly trusted. */
export function getCachedOfficialRegistry(
  options: Pick<OfficialRegistryOptions, 'agentDir' | 'trustedKeys'> = {}
): LocalRegistry | undefined {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const root = officialRegistryDirectory(agentDir)
  try {
    safeRegistryDirectory(agentDir, root)
    const currentPath = registryAssetPath(root, 'current.json')
    if (lstatSync(currentPath).size > 1024) return undefined
    const current: unknown = JSON.parse(readFileSync(currentPath, 'utf8'))
    if (
      !current ||
      typeof current !== 'object' ||
      !('generation' in current) ||
      typeof current.generation !== 'string' ||
      !/^[a-f0-9]{64}$/.test(current.generation)
    )
      return undefined
    const dir = join(root, 'generations', current.generation)
    const registry = verifiedGeneration(
      dir,
      root,
      options.trustedKeys ?? TRUSTED_REGISTRY_KEYS,
      current.generation
    )
    return { ...registry, status: 'cached', notice: '当前离线，正在使用已验证的软件源缓存。' }
  } catch {
    return undefined
  }
}

/** Atomically activate a complete, signature-verified metadata generation. */
export async function syncOfficialRegistry(
  options: OfficialRegistryOptions = {}
): Promise<LocalRegistry> {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const root = officialRegistryDirectory(agentDir)
  const now = (options.now?.() ?? new Date()).getTime()
  const failure = failedRefreshes.get(root)
  if (
    !options.forceRefresh &&
    failure &&
    now >= failure.attemptedAt &&
    now - failure.attemptedAt < FAILED_RETRY_WINDOW_MS
  ) {
    const cached = getCachedOfficialRegistry(options)
    if (cached) return cached
    throw failure.error
  }
  const previous = refreshed.get(root)
  if (
    !options.forceRefresh &&
    previous !== undefined &&
    now >= previous &&
    now - previous < REFRESH_WINDOW_MS
  ) {
    const cached = getCachedOfficialRegistry(options)
    if (cached)
      return {
        ...cached,
        status: 'ready',
        notice: undefined,
        refreshedAt: new Date(previous).toISOString()
      }
  }
  const pending = syncs.get(root)
  if (pending) return pending
  const task = synchronize(options)
    .then((registry) => {
      if (registry.status === 'ready') {
        refreshed.set(root, now)
        failedRefreshes.delete(root)
      }
      return registry
    })
    .finally(() => syncs.delete(root))
  syncs.set(root, task)
  return task
}

async function synchronize(options: OfficialRegistryOptions): Promise<LocalRegistry> {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const root = officialRegistryDirectory(agentDir)
  const trustedKeys = options.trustedKeys ?? TRUSTED_REGISTRY_KEYS
  let staging: string | undefined
  try {
    safeRegistryDirectory(agentDir, root, true)
    const [indexBytes, signatureBytes] = await Promise.all([
      fetchBytes('index.json', MAX_INDEX_BYTES, options),
      fetchBytes('index.sig.json', MAX_SIGNATURE_BYTES, options)
    ])
    const generation = sha256(indexBytes)
    staging = join(root, `staging-${randomUUID()}`)
    safeRegistryDirectory(root, staging, true)
    writeFileSync(registryAssetPath(staging, 'index.json'), indexBytes)
    writeFileSync(registryAssetPath(staging, 'index.sig.json'), signatureBytes)
    const registry = readRegistry(staging, { trustedKeys })
    assertOfficialRegistry(registry)
    const cached = getCachedOfficialRegistry({ agentDir, trustedKeys })
    if (cached && cached.dir === join(root, 'generations', generation)) {
      return {
        ...cached,
        status: 'ready',
        notice: undefined,
        refreshedAt: (options.now?.() ?? new Date()).toISOString()
      }
    }
    const assets = catalogAssets(registry)
    await boundedMap(assets, 4, async (asset) => {
      const bytes = await fetchBytes(asset.path, asset.size, options)
      verifyAsset(bytes, asset)
      writeFileSync(registryAssetPath(staging!, asset.path, true), bytes)
    })
    for (const entry of registry.packages) readRegistryManifestAsset(staging, entry)
    const dir = join(root, 'generations', generation)
    safeRegistryDirectory(root, join(root, 'generations'), true)
    const stagedDirectory = staging
    try {
      renameSync(staging, dir)
      staging = undefined
    } catch (error) {
      // Another sync or a prior refresh may already have produced this immutable generation.
      if (!['EEXIST', 'ENOTEMPTY'].includes(String((error as NodeJS.ErrnoException).code)))
        throw error
      try {
        verifiedGeneration(dir, root, trustedKeys, generation)
      } catch {
        // Replace a corrupt managed generation only after its replacement has been verified.
        safeRegistryDirectory(root, dir)
        const quarantine = join(root, `invalid-${generation}-${randomUUID()}`)
        renameSync(dir, quarantine)
        try {
          renameSync(stagedDirectory, dir)
          staging = undefined
        } catch (replacementError) {
          renameSync(quarantine, dir)
          throw replacementError
        }
        rmSync(quarantine, { recursive: true, force: true })
      }
    }
    const activated = verifiedGeneration(dir, root, trustedKeys, generation)
    const currentTemp = `current-${randomUUID()}.json`
    writeFileSync(registryAssetPath(root, currentTemp), `${JSON.stringify({ generation })}\n`)
    renameSync(registryAssetPath(root, currentTemp), registryAssetPath(root, 'current.json'))
    return {
      ...activated,
      status: 'ready',
      refreshedAt: (options.now?.() ?? new Date()).toISOString()
    }
  } catch (error) {
    const failure = new Error(`无法获取 Phi Packages 软件源: ${errorMessage(error)}`)
    refreshed.delete(root)
    failedRefreshes.set(root, {
      attemptedAt: (options.now?.() ?? new Date()).getTime(),
      error: failure
    })
    const cached = getCachedOfficialRegistry({ agentDir, trustedKeys })
    if (cached) return cached
    throw failure
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true })
  }
}

/** Use the existing dependency solver; fetch archives only for its selected closure. */
export async function prepareOfficialPackageInstall(
  registry: LocalRegistry,
  request: PackageRequest,
  options: OfficialRegistryOptions & Pick<InstallerOptions, 'appVersion'> = {}
): Promise<LocalRegistry> {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  if (registry.id !== OFFICIAL_REGISTRY_ID && !isOfficialRegistryDirectory(registry.dir, agentDir))
    return registry
  const root = officialRegistryDirectory(agentDir)
  if (!isOfficialRegistryDirectory(registry.dir, agentDir) || resolve(registry.dir) === root) {
    throw new Error('official registry installation requires a verified cache generation')
  }
  const generation = registry.dir.split(sep).at(-1)!
  safeRegistryDirectory(agentDir, root)
  const verified = verifiedGeneration(
    registry.dir,
    root,
    options.trustedKeys ?? TRUSTED_REGISTRY_KEYS,
    generation
  )
  const plan = planInstall(verified, request, options)
  await boundedMap(plan.packages, 3, async (entry) => {
    const asset = archiveAsset(entry)
    try {
      readRegistryAsset(verified.dir, asset)
      return
    } catch {
      /* Replace only with verified bytes. */
    }
    const path = registryAssetPath(verified.dir, asset.path, true)
    let download = archiveDownloads.get(path)
    if (!download) {
      download = downloadArchive(verified.dir, asset, options).finally(() =>
        archiveDownloads.delete(path)
      )
      archiveDownloads.set(path, download)
    }
    await download
  })
  planInstall(verified, request, options)
  return {
    ...verified,
    status: registry.status,
    notice: registry.notice,
    refreshedAt: registry.refreshedAt
  }
}

function verifiedGeneration(
  dir: string,
  root: string,
  trustedKeys: readonly TrustedRegistryKey[],
  generation: string
): LocalRegistry {
  safeRegistryDirectory(root, dir)
  const indexPath = registryAssetPath(dir, 'index.json')
  const signaturePath = registryAssetPath(dir, 'index.sig.json')
  if (
    lstatSync(indexPath).size > MAX_INDEX_BYTES ||
    lstatSync(signaturePath).size > MAX_SIGNATURE_BYTES
  ) {
    throw new Error('cached registry metadata exceeds the size limit')
  }
  if (sha256(readFileSync(indexPath)) !== generation)
    throw new Error('registry generation checksum mismatch')
  const registry = readRegistry(dir, { trustedKeys })
  assertOfficialRegistry(registry)
  for (const asset of catalogAssets(registry)) readRegistryAsset(dir, asset)
  for (const entry of registry.packages) readRegistryManifestAsset(dir, entry)
  return { ...registry, id: OFFICIAL_REGISTRY_ID, kind: 'official', label: 'Phi Packages' }
}

function assertOfficialRegistry(registry: LocalRegistry): void {
  if (registry.trust !== 'official')
    throw new Error('official registry signature is not from a trusted signing key')
  for (const entry of registry.packages) {
    archiveAsset(entry)
    if (entry.type === 'mcp' && !entry.manifestAsset) {
      throw new Error(`official connector metadata is missing: ${entry.id}`)
    }
  }
}

function archiveAsset(entry: RegistryPackageEntry): RegistryAsset {
  assertSafeRegistryAssetPath(entry.archive)
  if (!entry.archive.endsWith('.tar.gz') || entry.size < 1 || entry.size > MAX_ARCHIVE_BYTES) {
    throw new Error(`invalid package archive size or path: ${entry.archive}`)
  }
  return { path: entry.archive, sha256: entry.sha256, size: entry.size }
}

function catalogAssets(registry: LocalRegistry): RegistryAsset[] {
  const assets = new Map<string, RegistryAsset>()
  const paths = new Set(['index.json', 'index.sig.json', 'current.json'])
  for (const entry of registry.packages) {
    if (paths.has(entry.archive)) throw new Error(`duplicate registry asset path: ${entry.archive}`)
    paths.add(entry.archive)
  }
  for (const entry of registry.packages) {
    for (const asset of [entry.iconAsset, entry.manifestAsset]) {
      if (!asset) continue
      if (paths.has(asset.path)) throw new Error(`duplicate registry asset path: ${asset.path}`)
      paths.add(asset.path)
      assets.set(asset.path, asset)
    }
  }
  return [...assets.values()]
}

async function downloadArchive(
  dir: string,
  asset: RegistryAsset,
  options: OfficialRegistryOptions
): Promise<void> {
  const bytes = await fetchBytes(asset.path, asset.size, options)
  verifyAsset(bytes, asset)
  const temp = `${asset.path}.${randomUUID()}.tmp`
  const tempPath = registryAssetPath(dir, temp, true)
  try {
    writeFileSync(tempPath, bytes, { flag: 'wx' })
    renameSync(tempPath, registryAssetPath(dir, asset.path, true))
  } finally {
    rmSync(tempPath, { force: true })
  }
}

function verifyAsset(bytes: Buffer, asset: RegistryAsset): void {
  if (bytes.length !== asset.size || sha256(bytes) !== asset.sha256) {
    throw new Error(`registry asset size or checksum mismatch: ${asset.path}`)
  }
}

async function fetchBytes(
  path: string,
  limit: number,
  options: OfficialRegistryOptions
): Promise<Buffer> {
  assertSafeRegistryAssetPath(path)
  const base = new URL(options.baseUrl ?? OFFICIAL_REGISTRY_BASE_URL)
  if (base.protocol !== 'https:' || base.search || base.hash || base.username || base.password) {
    throw new Error('official registry endpoint must be an HTTPS directory')
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  const url = new URL(path, base)
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new Error('invalid registry fetch timeout')
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`registry fetch timed out: ${path}`))
    }, timeoutMs)
  })
  const request = (async (): Promise<Buffer> => {
    const response = await (options.fetch ?? fetch)(url.href, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { Accept: 'application/octet-stream' }
    })
    if (!response.ok) throw new Error(`registry fetch failed (${response.status}): ${path}`)
    const contentLength = response.headers.get('content-length')
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > limit))
      throw new Error(`registry response exceeds size limit: ${path}`)
    if (!response.body) throw new Error(`empty registry response: ${path}`)
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > limit) throw new Error(`registry response exceeds size limit: ${path}`)
        chunks.push(Buffer.from(chunk.value))
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    return Buffer.concat(chunks, size)
  })()
  try {
    return await Promise.race([request, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function boundedMap<T>(
  items: T[],
  concurrency: number,
  action: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0
  let failure: unknown
  const outcomes = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length && failure === undefined) {
        try {
          await action(items[cursor++])
        } catch (error) {
          failure = error
          throw error
        }
      }
    })
  )
  const rejected = outcomes.find((result) => result.status === 'rejected')
  if (rejected?.status === 'rejected') throw rejected.reason
}
