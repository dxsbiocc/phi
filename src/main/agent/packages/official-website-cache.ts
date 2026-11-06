import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { getPhiAgentDir } from '../runtime-paths'
import type { LocalRegistry, RegistryPackageEntry } from './installer-types'
import { isRecord, sha256 } from './installer-utils'
import { OFFICIAL_REGISTRY_ID } from './official-registry'
import { readRegistry } from './registry'
import {
  assertSafeRegistryAssetPath,
  parseRegistryAsset,
  readRegistryAsset,
  registryAssetPath,
  safeRegistryDirectory,
  type RegistryAsset
} from './registry-assets'

const GENERATION = /^[a-f0-9]{64}$/
const MAX_INDEX_BYTES = 4 * 1024 * 1024
const MAX_WEBSITE_ARCHIVE_BYTES = 256 * 1024 * 1024
export const OFFICIAL_WEBSITE_CACHE_FORMAT_VERSION = 3

interface WebsiteCacheMetadata {
  version: 2
  cacheFormatVersion: number
  index: RegistryAsset
  notice?: string
}

interface WebsiteCachePointer {
  version: 2
  generation: string
  previousGeneration?: string
}

/** Activate a new immutable metadata generation. Archives may be populated lazily later. */
export function publishOfficialWebsiteRegistry(
  registry: LocalRegistry,
  options: { agentDir?: string; notice?: string } = {}
): LocalRegistry {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const root = officialWebsiteRegistryDirectory(agentDir)
  safeRegistryDirectory(agentDir, root, true)
  safeRegistryDirectory(root, registry.dir)
  const currentPointer = readCurrentPointer(root)
  const index = {
    schemaVersion: registry.schemaVersion,
    generatedAt: registry.generatedAt,
    packages: registry.packages,
    ...(registry.skillGroups ? { skillGroups: registry.skillGroups } : {})
  }
  const indexBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`)
  if (indexBytes.length > MAX_INDEX_BYTES) {
    throw new Error('The Phi Website catalog cache index exceeds the size limit')
  }
  writeFileSync(registryAssetPath(registry.dir, 'index.json'), indexBytes)
  const indexHash = sha256(indexBytes)
  const previousGeneration =
    currentPointer?.generation === indexHash
      ? currentPointer.previousGeneration
      : currentPointer?.generation
  const metadata: WebsiteCacheMetadata = {
    version: 2,
    cacheFormatVersion: OFFICIAL_WEBSITE_CACHE_FORMAT_VERSION,
    index: { path: 'index.json', sha256: indexHash, size: indexBytes.length },
    ...(options.notice ? { notice: options.notice } : {})
  }
  writeFileSync(
    registryAssetPath(registry.dir, 'website-source.json'),
    `${JSON.stringify(metadata)}\n`,
    { flag: 'wx' }
  )

  const generations = join(root, 'generations')
  safeRegistryDirectory(root, generations, true)
  const destination = join(generations, indexHash)
  if (existsSync(destination)) {
    try {
      readOfficialWebsiteRegistry(destination, { agentDir })
      rmSync(registry.dir, { recursive: true, force: true })
    } catch {
      safeRegistryDirectory(root, destination)
      const quarantine = join(root, `corrupt-${randomUUID()}`)
      renameSync(destination, quarantine)
      try {
        renameSync(registry.dir, destination)
      } catch (error) {
        renameSync(quarantine, destination)
        throw error
      }
      rmSync(quarantine, { recursive: true, force: true })
    }
  } else {
    renameSync(registry.dir, destination)
  }

  const verified = readOfficialWebsiteRegistry(destination, { agentDir })
  const pointer = registryAssetPath(root, 'current.json')
  const temporary = registryAssetPath(root, `current-${randomUUID()}.json`)
  try {
    const nextPointer: WebsiteCachePointer = {
      version: 2,
      generation: indexHash,
      ...(previousGeneration ? { previousGeneration } : {})
    }
    writeFileSync(temporary, `${JSON.stringify(nextPointer)}\n`, { flag: 'wx' })
    renameSync(temporary, pointer)
  } finally {
    rmSync(temporary, { force: true })
  }
  try {
    pruneWebsiteCache(root, indexHash, previousGeneration)
  } catch {
    // Cleanup is best effort and must not reverse an already durable publication.
  }
  return verified
}

function readCurrentPointer(root: string): WebsiteCachePointer | undefined {
  try {
    const current = readSmallJson(root, 'current.json', 1024)
    if (
      !isRecord(current) ||
      current.version !== 2 ||
      typeof current.generation !== 'string' ||
      !GENERATION.test(current.generation)
    ) {
      return undefined
    }
    const previousGeneration =
      typeof current.previousGeneration === 'string' &&
      GENERATION.test(current.previousGeneration) &&
      current.previousGeneration !== current.generation
        ? current.previousGeneration
        : undefined
    return {
      version: 2,
      generation: current.generation,
      ...(previousGeneration ? { previousGeneration } : {})
    }
  } catch {
    return undefined
  }
}

function pruneWebsiteCache(
  root: string,
  currentGeneration: string,
  previousGeneration: string | undefined
): void {
  const generations = join(root, 'generations')
  const generationEntries = readdirSync(generations, { withFileTypes: true })
  const retained = new Set([currentGeneration, previousGeneration].filter(Boolean))
  for (const entry of generationEntries) {
    if (!entry.isDirectory() || !GENERATION.test(entry.name) || retained.has(entry.name)) continue
    removeManagedDirectory(root, join(generations, entry.name))
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^(?:staging|corrupt)-/.test(entry.name)) continue
    removeManagedDirectory(root, join(root, entry.name))
  }
}

function removeManagedDirectory(root: string, directory: string): void {
  try {
    safeRegistryDirectory(root, directory)
    rmSync(directory, { recursive: true, force: true })
  } catch {
    // Publishing is already durable; unsafe or temporarily busy paths remain for a later cleanup.
  }
}

export function officialWebsiteRegistryDirectory(agentDir = getPhiAgentDir()): string {
  return join(resolve(agentDir), 'cache', 'registries', 'phi-packages-website')
}

export function isOfficialWebsiteRegistryDirectory(
  directory: string,
  agentDir = getPhiAgentDir()
): boolean {
  const suffix = relative(officialWebsiteRegistryDirectory(agentDir), resolve(directory))
  return suffix === '' || /^generations\/[a-f0-9]{64}$/.test(suffix.split('\\').join('/'))
}

/** Validate metadata and present small assets; archives are verified only after they exist. */
export function readOfficialWebsiteRegistry(
  directory: string,
  options: { agentDir?: string } = {}
): LocalRegistry {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const root = officialWebsiteRegistryDirectory(agentDir)
  const { generationDirectory, generation } = resolveWebsiteGeneration(directory, agentDir, root)
  const metadata = parseWebsiteCacheMetadata(
    readSmallJson(generationDirectory, 'website-source.json', 16 * 1024)
  )
  const index = parseRegistryAsset(metadata.index, MAX_INDEX_BYTES)
  if (index.path !== 'index.json' || index.sha256 !== generation) {
    throw new Error('Invalid Phi Website catalog cache index identity')
  }
  readRegistryAsset(generationDirectory, index)
  const registry = readRegistry(generationDirectory)
  for (const entry of registry.packages) validateCachedWebsiteEntry(generationDirectory, entry)
  return {
    ...registry,
    id: OFFICIAL_REGISTRY_ID,
    kind: 'official',
    label: 'Phi 官网',
    trust: 'imported',
    status: 'cached',
    ...(typeof metadata.notice === 'string' ? { notice: metadata.notice } : {})
  }
}

function resolveWebsiteGeneration(
  directory: string,
  agentDir: string,
  root: string
): { generationDirectory: string; generation: string } {
  if (!isOfficialWebsiteRegistryDirectory(directory, agentDir)) {
    throw new Error('The Phi Website catalog path is outside the app-managed cache')
  }
  safeRegistryDirectory(agentDir, root)
  let generationDirectory = resolve(directory)
  if (generationDirectory === root) {
    const current = readSmallJson(root, 'current.json', 1024)
    if (
      !isRecord(current) ||
      current.version !== 2 ||
      typeof current.generation !== 'string' ||
      !GENERATION.test(current.generation)
    ) {
      throw new Error('Invalid Phi Website catalog cache pointer')
    }
    generationDirectory = join(root, 'generations', current.generation)
  }
  safeRegistryDirectory(root, generationDirectory)
  const generation = relative(join(root, 'generations'), generationDirectory)
  if (!GENERATION.test(generation)) {
    throw new Error('Invalid Phi Website catalog cache generation')
  }
  return { generationDirectory, generation }
}

function parseWebsiteCacheMetadata(value: unknown): WebsiteCacheMetadata {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    value.cacheFormatVersion !== OFFICIAL_WEBSITE_CACHE_FORMAT_VERSION ||
    (value.notice !== undefined && (typeof value.notice !== 'string' || value.notice.length > 2000))
  ) {
    throw new Error('Invalid Phi Website catalog cache origin')
  }
  return value as unknown as WebsiteCacheMetadata
}

function validateCachedWebsiteEntry(
  generationDirectory: string,
  entry: RegistryPackageEntry
): void {
  assertSafeRegistryAssetPath(entry.archive)
  const expectedArchive = `${entry.type}-${entry.id}-${entry.version}.tar.gz`
  if (
    entry.archive.includes('/') ||
    entry.archive !== expectedArchive ||
    entry.size < 1 ||
    entry.size > MAX_WEBSITE_ARCHIVE_BYTES
  ) {
    throw new Error(`Invalid Phi Website package archive: ${entry.archive}`)
  }
  if (entry.iconAsset && !/^icons\/[^/]+$/.test(entry.iconAsset.path)) {
    throw new Error(`Invalid Phi Website package icon: ${entry.iconAsset.path}`)
  }
  if (entry.type === 'mcp' && !entry.manifestAsset) {
    throw new Error(`Invalid Phi Website package manifest: ${entry.id} has no manifestAsset`)
  }
  if (entry.manifestAsset && !/^manifests\/[^/]+$/.test(entry.manifestAsset.path)) {
    throw new Error(`Invalid Phi Website package manifest: ${entry.manifestAsset.path}`)
  }
  const archive = registryAssetPath(generationDirectory, entry.archive)
  if (existsSync(archive)) {
    readRegistryAsset(generationDirectory, {
      path: entry.archive,
      sha256: entry.sha256,
      size: entry.size
    })
  }
  if (entry.iconAsset) readRegistryAsset(generationDirectory, entry.iconAsset)
  if (entry.manifestAsset) readRegistryAsset(generationDirectory, entry.manifestAsset)
}

function readSmallJson(root: string, path: string, maxBytes: number): unknown {
  const file = registryAssetPath(root, path)
  if (lstatSync(file).size > maxBytes) {
    throw new Error('Phi Website catalog cache metadata exceeds the size limit')
  }
  return JSON.parse(readFileSync(file, 'utf8')) as unknown
}
