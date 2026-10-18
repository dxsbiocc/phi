import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { getPhiAgentDir } from '../runtime-paths'
import type { LocalRegistry } from './installer-types'
import { isRecord, sha256 } from './installer-utils'
import { OFFICIAL_REGISTRY_ID } from './official-registry'
import { readRegistry } from './registry'
import {
  parseRegistryAsset,
  readRegistryAsset,
  registryAssetPath,
  safeRegistryDirectory,
  type RegistryAsset
} from './registry-assets'

export const OFFICIAL_WEBSITE_REPOSITORY = {
  owner: 'dxsbiocc',
  name: 'phi-packages',
  repo: 'dxsbiocc/phi-packages'
} as const
const GENERATION = /^([a-f0-9]{40})-([a-f0-9]{64})$/
const MAX_INDEX_BYTES = 4 * 1024 * 1024
/** Increment when materialization or diagnostics change even without a repository commit. */
export const OFFICIAL_WEBSITE_MATERIALIZER_REVISION = 2

export interface WebsiteCacheMetadata {
  version: 1
  commit: string
  index: RegistryAsset
  materializerRevision?: number
  notice?: string
}

export function readOfficialWebsiteMaterializerRevision(
  registry: LocalRegistry
): number | undefined {
  const metadata = readSmallJson(registry.dir, 'website-source.json', 16 * 1024)
  return isRecord(metadata) && typeof metadata.materializerRevision === 'number'
    ? metadata.materializerRevision
    : undefined
}

/** Reuse verified archive bytes when only website classification metadata changes. */
export function cloneOfficialWebsiteRegistry(
  registry: LocalRegistry,
  stagingDir: string
): LocalRegistry {
  const directory = join(stagingDir, 'registry')
  safeRegistryDirectory(stagingDir, directory, true)
  const copied = new Set<string>()
  for (const entry of registry.packages) {
    const assets = [
      { path: entry.archive, sha256: entry.sha256, size: entry.size },
      entry.iconAsset,
      entry.manifestAsset
    ]
    for (const asset of assets) {
      if (!asset || copied.has(asset.path)) continue
      const bytes = readRegistryAsset(registry.dir, asset)
      writeFileSync(registryAssetPath(directory, asset.path, true), bytes, { flag: 'wx' })
      copied.add(asset.path)
    }
  }
  return { ...registry, dir: directory }
}

/** Activate a new immutable index while retaining already-prepared install payloads. */
export function publishOfficialWebsiteRegistry(
  registry: LocalRegistry,
  commit: string,
  options: { agentDir?: string; notice?: string } = {}
): LocalRegistry {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const root = officialWebsiteRegistryDirectory(agentDir)
  safeRegistryDirectory(agentDir, registry.dir)
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid Phi Website catalog cache commit')
  const index = {
    materializerRevision: OFFICIAL_WEBSITE_MATERIALIZER_REVISION,
    schemaVersion: registry.schemaVersion,
    generatedAt: registry.generatedAt,
    packages: registry.packages,
    ...(registry.skillGroups ? { skillGroups: registry.skillGroups } : {})
  }
  const indexBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`)
  if (indexBytes.length > MAX_INDEX_BYTES)
    throw new Error('The Phi Website catalog cache index exceeds the size limit')
  writeFileSync(registryAssetPath(registry.dir, 'index.json'), indexBytes)
  const indexHash = sha256(indexBytes)
  const metadata: WebsiteCacheMetadata = {
    version: 1,
    materializerRevision: OFFICIAL_WEBSITE_MATERIALIZER_REVISION,
    commit,
    index: { path: 'index.json', sha256: indexHash, size: indexBytes.length },
    ...(options.notice ? { notice: options.notice } : {})
  }
  writeFileSync(
    registryAssetPath(registry.dir, 'website-source.json'),
    `${JSON.stringify(metadata)}\n`,
    { flag: 'wx' }
  )
  const generation = `${commit}-${indexHash}`
  const destination = join(root, 'generations', generation)
  safeRegistryDirectory(root, join(root, 'generations'), true)
  if (existsSync(destination)) {
    try {
      readOfficialWebsiteRegistry(destination, { agentDir })
    } catch {
      safeRegistryDirectory(root, destination)
      renameSync(destination, join(root, `corrupt-${randomUUID()}`))
      renameSync(registry.dir, destination)
    }
  } else renameSync(registry.dir, destination)
  const verified = readOfficialWebsiteRegistry(destination, { agentDir })
  const pointer = registryAssetPath(root, 'current.json')
  const temporary = registryAssetPath(root, `current-${randomUUID()}.json`)
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: 1, generation })}\n`, { flag: 'wx' })
    renameSync(temporary, pointer)
  } finally {
    rmSync(temporary, { force: true })
  }
  return verified
}

export function officialWebsiteRegistryDirectory(agentDir = getPhiAgentDir()): string {
  return join(resolve(agentDir), 'cache', 'registries', 'phi-packages-website')
}

export function isOfficialWebsiteRegistryDirectory(
  directory: string,
  agentDir = getPhiAgentDir()
): boolean {
  const suffix = relative(officialWebsiteRegistryDirectory(agentDir), resolve(directory))
  return (
    suffix === '' || /^generations\/[a-f0-9]{40}-[a-f0-9]{64}$/.test(suffix.split('\\').join('/'))
  )
}

/** Validate the immutable index and all prepared archives before returning a managed source. */
export function readOfficialWebsiteRegistry(
  directory: string,
  options: { agentDir?: string } = {}
): LocalRegistry {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const root = officialWebsiteRegistryDirectory(agentDir)
  if (!isOfficialWebsiteRegistryDirectory(directory, agentDir)) {
    throw new Error('The Phi Website catalog path is outside the app-managed cache')
  }
  safeRegistryDirectory(agentDir, root)
  let generationDirectory = resolve(directory)
  if (generationDirectory === root) {
    const current = readSmallJson(root, 'current.json', 1024)
    if (!isRecord(current) || current.version !== 1 || typeof current.generation !== 'string') {
      throw new Error('Invalid Phi Website catalog cache pointer')
    }
    if (!GENERATION.test(current.generation))
      throw new Error('Invalid Phi Website catalog cache generation')
    generationDirectory = join(root, 'generations', current.generation)
  }
  safeRegistryDirectory(root, generationDirectory)
  const generation = relative(join(root, 'generations'), generationDirectory)
  const identity = GENERATION.exec(generation)
  if (!identity) throw new Error('Invalid Phi Website catalog cache generation')
  const metadata = readSmallJson(generationDirectory, 'website-source.json', 16 * 1024)
  if (
    !isRecord(metadata) ||
    metadata.version !== 1 ||
    metadata.commit !== identity[1] ||
    (metadata.notice !== undefined &&
      (typeof metadata.notice !== 'string' || metadata.notice.length > 2000))
  ) {
    throw new Error('Invalid Phi Website catalog cache origin')
  }
  const index = parseRegistryAsset(metadata.index, MAX_INDEX_BYTES)
  if (index.path !== 'index.json' || index.sha256 !== identity[2]) {
    throw new Error('Invalid Phi Website catalog cache index identity')
  }
  const indexBytes = readRegistryAsset(generationDirectory, index)
  const indexValue: unknown = JSON.parse(indexBytes.toString('utf8'))
  const indexRevision = isRecord(indexValue) ? indexValue.materializerRevision : undefined
  if (
    metadata.materializerRevision !== indexRevision ||
    (indexRevision !== undefined &&
      (!Number.isSafeInteger(indexRevision) ||
        (indexRevision as number) < 1 ||
        (indexRevision as number) > 10_000))
  ) {
    throw new Error('Invalid or inconsistent Phi Website catalog cache materializer revision')
  }
  const registry = readRegistry(generationDirectory)
  for (const entry of registry.packages) {
    if (entry.size > 64 * 1024 * 1024) throw new Error('Invalid Phi Website package cache size')
    readRegistryAsset(generationDirectory, {
      path: entry.archive,
      sha256: entry.sha256,
      size: entry.size
    })
    if (entry.iconAsset) readRegistryAsset(generationDirectory, entry.iconAsset)
    if (entry.manifestAsset) readRegistryAsset(generationDirectory, entry.manifestAsset)
  }
  return {
    ...registry,
    id: OFFICIAL_REGISTRY_ID,
    kind: 'official',
    label: 'Phi 官网',
    trust: 'imported',
    status: 'cached',
    source: {
      kind: 'github',
      id: OFFICIAL_REGISTRY_ID,
      repo: OFFICIAL_WEBSITE_REPOSITORY.repo,
      sha: identity[1]
    },
    ...(typeof metadata.notice === 'string' ? { notice: metadata.notice } : {})
  }
}

function readSmallJson(root: string, path: string, maxBytes: number): unknown {
  const file = registryAssetPath(root, path)
  if (lstatSync(file).size > maxBytes)
    throw new Error('Phi Website catalog cache metadata exceeds the size limit')
  return JSON.parse(readFileSync(file, 'utf8')) as unknown
}
