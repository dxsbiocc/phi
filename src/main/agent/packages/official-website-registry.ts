import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, linkSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import semver from 'semver'

import { getPhiAgentDir } from '../runtime-paths'
import { readBoundedResponse } from './github-source'
import { parseRegistryIconAsset } from './icon-assets'
import type {
  InstallerOptions,
  LocalRegistry,
  PackageRequest,
  RegistryPackageEntry
} from './installer-types'
import { errorMessage, isRecord, packageKey, packageVersionKey, sha256 } from './installer-utils'
import { readRegistryManifestAsset } from './manifest-assets'
import {
  OFFICIAL_REGISTRY_ID,
  syncOfficialRegistry,
  type OfficialRegistryOptions
} from './official-registry'
import {
  isOfficialWebsiteRegistryDirectory,
  officialWebsiteRegistryDirectory,
  publishOfficialWebsiteRegistry,
  readOfficialWebsiteRegistry
} from './official-website-cache'
import { boundedMap, ensureArchive, fetchBytes } from './registry-download'
import { parseRegistryEntry } from './registry'
import { planInstall } from './planning'
import {
  assertSafeRegistryAssetPath,
  readRegistryAsset,
  registryAssetPath,
  safeRegistryDirectory,
  type RegistryAsset
} from './registry-assets'
import {
  applyOfficialSkillGroups,
  loadOfficialSkillGroups,
  type OfficialSkillGroups
} from './official-skill-groups'

export {
  isOfficialWebsiteRegistryDirectory,
  officialWebsiteRegistryDirectory,
  readOfficialWebsiteRegistry
} from './official-website-cache'

export const WEBSITE_REGISTRY_BASE_URL = 'https://phi.omicsagent.cn/api/registry/'
const WEBSITE_CATALOG_URL = 'https://phi.omicsagent.cn/api/catalog'
const MAX_INDEX_BYTES = 4 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
const MAX_INDEX_ENTRIES = 10_000
const REFRESH_WINDOW_MS = 5 * 60_000
const refreshes = new Map<string, number>()
const synchronizations = new Map<string, Promise<LocalRegistry>>()
const endpoint = {
  baseUrl: WEBSITE_REGISTRY_BASE_URL,
  redirect: 'error' as const,
  maxTimeoutMs: 120_000
}

/** Prefer the website's unsigned per-package registry; retain the signed release as fallback. */
export async function syncPreferredOfficialRegistry(
  options: OfficialRegistryOptions = {}
): Promise<LocalRegistry> {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const root = officialWebsiteRegistryDirectory(agentDir)
  const now = (options.now?.() ?? new Date()).getTime()
  const refreshedAt = refreshes.get(root)
  if (
    !options.forceRefresh &&
    refreshedAt !== undefined &&
    now >= refreshedAt &&
    now - refreshedAt < REFRESH_WINDOW_MS
  ) {
    try {
      return ready(readOfficialWebsiteRegistry(root, { agentDir }), options, refreshedAt)
    } catch {
      // A damaged cache is repaired from the website instead of being silently reused.
    }
  }
  const pending = synchronizations.get(root)
  if (pending) return pending
  const synchronization = synchronizeWebsite({ ...options, agentDir })
    .then((registry) => {
      if (registry.status === 'ready' && registry.label === 'Phi 官网') refreshes.set(root, now)
      return registry
    })
    .finally(() => synchronizations.delete(root))
  synchronizations.set(root, synchronization)
  return synchronization
}

/** Resolve and fetch only the website package closure selected for installation. */
export async function prepareOfficialWebsitePackageInstall(
  registry: LocalRegistry,
  request: PackageRequest,
  options: OfficialRegistryOptions & Pick<InstallerOptions, 'appVersion'> = {}
): Promise<LocalRegistry> {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  if (!isWebsiteRegistry(registry, agentDir)) return registry
  const verified = readOfficialWebsiteRegistry(registry.dir, { agentDir })
  const plan = planInstall(verified, request, options)
  await boundedMap(plan.packages, 3, async (entry) => {
    await ensureArchive(verified.dir, websiteArchiveAsset(entry), options, endpoint)
  })
  planInstall(verified, request, options)
  return {
    ...verified,
    status: registry.status,
    notice: registry.notice,
    refreshedAt: registry.refreshedAt
  }
}

/** Fetch one website archive lazily for read-only package inspection. */
export async function readOfficialWebsitePackageArchive(
  registry: LocalRegistry,
  entry: RegistryPackageEntry,
  options: OfficialRegistryOptions = {}
): Promise<Buffer> {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  if (!isWebsiteRegistry(registry, agentDir)) {
    throw new Error('website package archives require a verified website cache generation')
  }
  const verified = readOfficialWebsiteRegistry(registry.dir, { agentDir })
  const selected = verified.packages.find(
    (candidate) => packageVersionKey(candidate) === packageVersionKey(entry)
  )
  if (!selected) throw new Error(`website package is not present in the verified index`)
  const asset = websiteArchiveAsset(selected)
  await ensureArchive(verified.dir, asset, options, endpoint)
  return readRegistryAsset(verified.dir, asset)
}

function isWebsiteRegistry(registry: LocalRegistry, agentDir: string): boolean {
  return isOfficialWebsiteRegistryDirectory(registry.dir, agentDir)
}

function websiteArchiveAsset(entry: RegistryPackageEntry): RegistryAsset {
  validateWebsiteArchive(entry)
  return { path: entry.archive, sha256: entry.sha256, size: entry.size }
}

async function synchronizeWebsite(options: OfficialRegistryOptions): Promise<LocalRegistry> {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const root = officialWebsiteRegistryDirectory(agentDir)
  let staging: string | undefined
  try {
    safeRegistryDirectory(agentDir, root, true)
    let previous: LocalRegistry | undefined
    try {
      previous = readOfficialWebsiteRegistry(root, { agentDir })
    } catch {
      // The first sync and damaged old cache formats both rebuild from the small index.
    }

    const indexBytes = await fetchBytes('index.json', MAX_INDEX_BYTES, options, endpoint)
    staging = join(root, `staging-${randomUUID()}`)
    safeRegistryDirectory(root, staging, true)
    const registryDir = join(staging, 'registry')
    safeRegistryDirectory(staging, registryDir, true)
    const parsed = validateOfficialWebsiteRegistryIndex(indexBytes)
    const stagedRegistry: LocalRegistry = {
      id: OFFICIAL_REGISTRY_ID,
      dir: registryDir,
      trust: 'imported',
      schemaVersion: 1,
      generatedAt: parsed.generatedAt,
      packages: parsed.packages
    }
    if (previous) carryOverSmallAssets(previous, stagedRegistry)
    const downloaded = await downloadSmallAssets(stagedRegistry, parsed.notices, options)
    const dependencyChecked = dropEntriesWithMissingDependencies(
      downloaded.registry.packages,
      downloaded.notices
    )
    if (dependencyChecked.packages.length === 0) {
      throw new Error('Phi Website registry contains no valid package entries')
    }
    let registry: LocalRegistry = {
      ...downloaded.registry,
      packages: dependencyChecked.packages
    }
    const groups = await loadWebsiteSkillGroups(options)
    if (groups) {
      try {
        registry = applyOfficialSkillGroups(registry, groups)
      } catch {
        // Group metadata is optional classification; the package index remains usable without it.
      }
    }
    if (previous) carryOverArchives(previous, registry)
    const notice = formatNotices(dependencyChecked.notices)
    const published = publishOfficialWebsiteRegistry(registry, { agentDir, notice })
    return ready(published, options)
  } catch (error) {
    const reason = errorMessage(error).slice(0, 500)
    try {
      const cached = readOfficialWebsiteRegistry(root, { agentDir })
      return {
        ...cached,
        status: 'cached',
        notice:
          `The Phi Website update is unavailable. Using the verified website cache (${reason}). ${cached.notice ?? ''}`.trim()
      }
    } catch {
      const fallback = await syncOfficialRegistry({ ...options, baseUrl: undefined })
      return {
        ...fallback,
        notice:
          `The Phi Website content is unavailable. Using the signed release catalog (${reason}). ${fallback.notice ?? ''}`.trim()
      }
    }
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true })
  }
}

function ready(
  registry: LocalRegistry,
  options: OfficialRegistryOptions,
  refreshedAt?: number
): LocalRegistry {
  return {
    ...registry,
    status: 'ready',
    refreshedAt: new Date(refreshedAt ?? (options.now?.() ?? new Date()).getTime()).toISOString()
  }
}

export function validateOfficialWebsiteRegistryIndex(bytes: Buffer): {
  generatedAt: string
  packages: RegistryPackageEntry[]
  notices: string[]
} {
  const value = parseWebsiteIndexDocument(bytes)
  const packages: RegistryPackageEntry[] = []
  const notices: string[] = []
  const identities = new Set<string>()
  const assetPaths = new Set(['index.json', 'website-source.json', 'current.json'])
  for (const [index, candidate] of value.packages.entries()) {
    try {
      packages.push(parseWebsiteIndexEntry(candidate, index, identities, assetPaths, notices))
    } catch (error) {
      notices.push(`packages[${index}] skipped: ${errorMessage(error)}`)
    }
  }
  const checked = dropEntriesWithMissingDependencies(packages, notices)
  if (checked.packages.length === 0) {
    throw new Error('Phi Website registry contains no valid package entries')
  }
  return {
    generatedAt: value.generatedAt,
    packages: checked.packages,
    notices: checked.notices
  }
}

function parseWebsiteIndexDocument(bytes: Buffer): {
  generatedAt: string
  packages: unknown[]
} {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown
  } catch (error) {
    throw new Error(`Invalid Phi Website registry JSON: ${errorMessage(error)}`)
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.generatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.generatedAt)) ||
    !Array.isArray(value.packages) ||
    value.packages.length > MAX_INDEX_ENTRIES
  ) {
    throw new Error('Invalid Phi Website registry schema')
  }
  return { generatedAt: value.generatedAt, packages: value.packages }
}

function parseWebsiteIndexEntry(
  candidate: unknown,
  index: number,
  identities: Set<string>,
  assetPaths: Set<string>,
  notices: string[]
): RegistryPackageEntry {
  let entry = parseRegistryEntry(withoutInvalidIcon(candidate, index, notices), index)
  validateWebsiteArchive(entry)
  const identity = packageVersionKey(entry)
  if (entry.type === 'mcp' && !entry.manifestAsset) {
    throw new Error(`${identity} is missing its manifestAsset`)
  }
  if (entry.manifestAsset && !/^manifests\/[^/]+$/.test(entry.manifestAsset.path)) {
    throw new Error(`invalid website manifest path ${entry.manifestAsset.path}`)
  }
  if (identities.has(identity)) throw new Error(`duplicate package identity ${identity}`)
  const requiredAssets = [entry.archive, entry.manifestAsset?.path].filter(
    (path): path is string => path !== undefined
  )
  if (requiredAssets.some((path) => assetPaths.has(path))) {
    throw new Error(`duplicate registry asset path for ${identity}`)
  }
  identities.add(identity)
  requiredAssets.forEach((path) => assetPaths.add(path))
  if (entry.iconAsset) {
    if (!/^icons\/[^/]+$/.test(entry.iconAsset.path) || assetPaths.has(entry.iconAsset.path)) {
      notices.push(`${identity} icon skipped: invalid or duplicate website icon path`)
      entry = { ...entry, iconAsset: undefined }
    } else {
      assetPaths.add(entry.iconAsset.path)
    }
  }
  return entry
}

function withoutInvalidIcon(candidate: unknown, index: number, notices: string[]): unknown {
  if (!isRecord(candidate) || candidate.iconAsset === undefined) return candidate
  try {
    parseRegistryIconAsset(candidate.iconAsset)
    return candidate
  } catch {
    notices.push(
      `packages[${index}] ${String(candidate.id ?? 'unknown')} icon skipped: invalid metadata`
    )
    const sanitized = { ...candidate }
    delete sanitized.iconAsset
    return sanitized
  }
}

function validateWebsiteArchive(entry: RegistryPackageEntry): void {
  assertSafeRegistryAssetPath(entry.archive)
  const expected = `${entry.type}-${entry.id}-${entry.version}.tar.gz`
  if (
    entry.archive.includes('/') ||
    entry.archive !== expected ||
    entry.size < 1 ||
    entry.size > MAX_ARCHIVE_BYTES
  ) {
    throw new Error(`invalid website package archive ${entry.archive}`)
  }
}

async function downloadSmallAssets(
  registry: LocalRegistry,
  initialNotices: string[],
  options: OfficialRegistryOptions
): Promise<{ registry: LocalRegistry; notices: string[] }> {
  const notices = [...initialNotices]
  const results = new Map<string, RegistryPackageEntry | undefined>()
  await boundedMap(registry.packages, 4, async (entry) => {
    let next = entry
    if (entry.manifestAsset) {
      try {
        await downloadSmallAsset(registry.dir, entry.manifestAsset, options)
        readRegistryManifestAsset(registry.dir, entry)
      } catch (error) {
        rmSync(registryAssetPath(registry.dir, entry.manifestAsset.path, true), { force: true })
        notices.push(`${packageVersionKey(entry)} skipped: manifest ${errorMessage(error)}`)
        results.set(packageVersionKey(entry), undefined)
        return
      }
    }
    if (entry.iconAsset) {
      try {
        await downloadSmallAsset(registry.dir, entry.iconAsset, options)
      } catch (error) {
        notices.push(`${packageVersionKey(entry)} icon skipped: ${errorMessage(error)}`)
        next = { ...entry, iconAsset: undefined }
      }
    }
    results.set(packageVersionKey(entry), next)
  })
  return {
    registry: {
      ...registry,
      packages: registry.packages
        .map((entry) => results.get(packageVersionKey(entry)))
        .filter((entry): entry is RegistryPackageEntry => entry !== undefined)
    },
    notices
  }
}

async function downloadSmallAsset(
  dir: string,
  asset: RegistryAsset,
  options: OfficialRegistryOptions
): Promise<void> {
  try {
    readRegistryAsset(dir, asset)
    return
  } catch {
    rmSync(registryAssetPath(dir, asset.path, true), { force: true })
  }
  const bytes = await fetchBytes(asset.path, asset.size, options, endpoint)
  if (bytes.length !== asset.size || sha256(bytes) !== asset.sha256) {
    throw new Error(`registry asset size or checksum mismatch: ${asset.path}`)
  }
  writeFileSync(registryAssetPath(dir, asset.path, true), bytes, { flag: 'wx' })
}

function dropEntriesWithMissingDependencies(
  entries: RegistryPackageEntry[],
  initialNotices: string[]
): { packages: RegistryPackageEntry[]; notices: string[] } {
  let packages = entries
  const notices = initialNotices
  while (true) {
    const missing = new Set<string>()
    for (const entry of packages) {
      const dependency = entry.dependsOn.find(
        (required) =>
          !packages.some(
            (candidate) =>
              packageKey(candidate) === packageKey(required) &&
              semver.satisfies(candidate.version, required.version)
          )
      )
      if (dependency) {
        missing.add(packageVersionKey(entry))
        notices.push(
          `${packageVersionKey(entry)} skipped: missing dependency ${packageKey(dependency)}@${dependency.version}`
        )
      }
    }
    if (missing.size === 0) return { packages, notices }
    packages = packages.filter((entry) => !missing.has(packageVersionKey(entry)))
  }
}

function carryOverArchives(previous: LocalRegistry, next: LocalRegistry): void {
  for (const entry of next.packages) {
    const existing = previous.packages.find(
      (candidate) =>
        candidate.archive === entry.archive &&
        candidate.sha256 === entry.sha256 &&
        candidate.size === entry.size
    )
    if (!existing) continue
    const asset = { path: existing.archive, sha256: existing.sha256, size: existing.size }
    carryOverAsset(previous.dir, next.dir, asset)
  }
}

function carryOverSmallAssets(previous: LocalRegistry, next: LocalRegistry): void {
  const previousAssets = previous.packages.flatMap((entry) =>
    [entry.iconAsset, entry.manifestAsset].filter((asset): asset is RegistryAsset => Boolean(asset))
  )
  for (const entry of next.packages) {
    for (const asset of [entry.iconAsset, entry.manifestAsset]) {
      if (!asset) continue
      const existing = previousAssets.find(
        (candidate) =>
          candidate.path === asset.path &&
          candidate.sha256 === asset.sha256 &&
          candidate.size === asset.size
      )
      if (existing) carryOverAsset(previous.dir, next.dir, existing)
    }
  }
}

function carryOverAsset(previousDir: string, nextDir: string, asset: RegistryAsset): void {
  try {
    readRegistryAsset(previousDir, asset)
    const source = registryAssetPath(previousDir, asset.path)
    const destination = registryAssetPath(nextDir, asset.path, true)
    if (existsSync(destination)) return
    try {
      linkSync(source, destination)
    } catch {
      copyFileSync(source, destination)
    }
  } catch {
    // Missing, damaged, or uncopyable assets fall back to the normal download path.
  }
}

async function loadWebsiteSkillGroups(
  options: OfficialRegistryOptions
): Promise<OfficialSkillGroups | undefined> {
  try {
    const catalog = await fetchWebsiteCatalog(options)
    return await loadOfficialSkillGroups(catalog, options)
  } catch {
    return undefined
  }
}

async function fetchWebsiteCatalog(options: OfficialRegistryOptions): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new Error('Invalid Phi Website catalog request timeout')
  }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let response: Response
  try {
    response = await Promise.race([
      (options.fetch ?? fetch)(WEBSITE_CATALOG_URL, {
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('Phi Website catalog request timed out'))
        }, timeoutMs)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  if (!response.ok || (response.url && response.url !== WEBSITE_CATALOG_URL)) {
    throw new Error(`Phi Website catalog request failed (HTTP ${response.status})`)
  }
  const bytes = await readBoundedResponse(response, 256 * 1024, 'Phi Website catalog', timeoutMs)
  return JSON.parse(bytes.toString('utf8')) as unknown
}

function formatNotices(notices: string[]): string | undefined {
  if (notices.length === 0) return undefined
  return `${notices.length} Phi Website package item(s) were skipped: ${notices.join('; ')}`.slice(
    0,
    1900
  )
}
