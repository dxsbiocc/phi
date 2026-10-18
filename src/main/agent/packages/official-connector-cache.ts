import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { getPhiAgentDir } from '../runtime-paths'
import type { LocalRegistry } from './installer-types'
import { isRecord, sha256 } from './installer-utils'
import { readRegistryManifestAsset } from './manifest-assets'
import {
  OFFICIAL_CONNECTOR_ORIGIN,
  parseCompleteOfficialConnectorManifest
} from './official-connector-client'
import { OFFICIAL_REGISTRY_ID } from './official-registry'
import { readRegistry } from './registry'
import {
  parseRegistryAsset,
  readRegistryAsset,
  registryAssetPath,
  safeRegistryDirectory
} from './registry-assets'

const CACHE_REVISION = 2
const MAX_INDEX_BYTES = 4 * 1024 * 1024

export function officialConnectorRegistryDirectory(agentDir = getPhiAgentDir()): string {
  return join(resolve(agentDir), 'cache', 'registries', 'phi-connectors-api')
}

export function isOfficialConnectorRegistryDirectory(
  directory: string,
  agentDir = getPhiAgentDir()
): boolean {
  const suffix = relative(officialConnectorRegistryDirectory(agentDir), resolve(directory))
    .split('\\')
    .join('/')
  return suffix === '' || /^generations\/[a-f0-9]{64}$/.test(suffix)
}

export function readOfficialConnectorRegistry(
  directory: string,
  options: { agentDir?: string } = {}
): LocalRegistry {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const root = officialConnectorRegistryDirectory(agentDir)
  if (!isOfficialConnectorRegistryDirectory(directory, agentDir))
    throw new Error('连接器 API 目录不属于受管缓存')
  safeRegistryDirectory(agentDir, root)
  let target = resolve(directory)
  if (target === root) {
    const pointer = readSmallJson(root, 'current.json', 1024)
    if (
      !isRecord(pointer) ||
      pointer.version !== 1 ||
      typeof pointer.generation !== 'string' ||
      !/^[a-f0-9]{64}$/.test(pointer.generation)
    )
      throw new Error('连接器 API 缓存指针无效')
    target = join(root, 'generations', pointer.generation)
  }
  safeRegistryDirectory(root, target)
  const metadata = readSmallJson(target, 'connector-source.json', 4096)
  if (
    !isRecord(metadata) ||
    metadata.version !== CACHE_REVISION ||
    metadata.origin !== OFFICIAL_CONNECTOR_ORIGIN
  )
    throw new Error('连接器 API 缓存来源无效')
  const index = parseRegistryAsset(metadata.index, MAX_INDEX_BYTES)
  const generation = relative(join(root, 'generations'), target)
  if (index.path !== 'index.json' || index.sha256 !== generation)
    throw new Error('连接器 API 缓存索引身份无效')
  const indexBytes = readRegistryAsset(target, index)
  const value: unknown = JSON.parse(indexBytes.toString('utf8'))
  if (!isRecord(value) || value.connectorApiRevision !== CACHE_REVISION)
    throw new Error('连接器 API 缓存版本无效')
  const registry = readRegistry(target)
  if (
    registry.packages.length < 1 ||
    registry.packages.length > 500 ||
    registry.packages.some((entry) => entry.type !== 'mcp')
  )
    throw new Error('连接器 API 缓存不含完整 MCP 目录')
  for (const entry of registry.packages) {
    if (
      entry.size > 512 * 1024 ||
      !entry.manifestAsset ||
      typeof entry.directoryAuthBlocked !== 'boolean'
    )
      throw new Error('连接器 API 软件包大小或清单无效')
    readRegistryAsset(target, { path: entry.archive, size: entry.size, sha256: entry.sha256 })
    if (entry.iconAsset) readRegistryAsset(target, entry.iconAsset)
    const manifest = readRegistryManifestAsset(target, entry)
    if (!manifest || manifest.type !== 'mcp') throw new Error('连接器 API 软件包缺少可安装清单')
    if (manifest.connector.category !== entry.category || entry.dependsOn.length)
      throw new Error('连接器 API 目录元数据与清单不一致')
    const bytes = readRegistryAsset(target, entry.manifestAsset)
    parseCompleteOfficialConnectorManifest(bytes.toString('utf8'))
  }
  return {
    ...registry,
    id: OFFICIAL_REGISTRY_ID,
    kind: 'official',
    label: 'Phi 官网',
    trust: 'imported',
    status: 'cached',
    source: undefined
  }
}

export function publishOfficialConnectorRegistry(
  registry: LocalRegistry,
  options: { agentDir?: string } = {}
): LocalRegistry {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const root = officialConnectorRegistryDirectory(agentDir)
  safeRegistryDirectory(root, registry.dir)
  const indexBytes = Buffer.from(
    `${JSON.stringify({ connectorApiRevision: CACHE_REVISION, schemaVersion: 1, generatedAt: registry.generatedAt, packages: registry.packages }, null, 2)}\n`
  )
  if (indexBytes.length > MAX_INDEX_BYTES) throw new Error('连接器 API 索引超过大小限制')
  writeFileSync(registryAssetPath(registry.dir, 'index.json'), indexBytes)
  const generation = sha256(indexBytes)
  writeFileSync(
    registryAssetPath(registry.dir, 'connector-source.json'),
    JSON.stringify({
      version: CACHE_REVISION,
      origin: OFFICIAL_CONNECTOR_ORIGIN,
      index: { path: 'index.json', size: indexBytes.length, sha256: generation }
    }),
    { flag: 'wx' }
  )
  safeRegistryDirectory(root, join(root, 'generations'), true)
  const destination = join(root, 'generations', generation)
  if (existsSync(destination)) {
    try {
      readOfficialConnectorRegistry(destination, { agentDir })
    } catch {
      safeRegistryDirectory(root, destination)
      renameSync(destination, join(root, `corrupt-${randomUUID()}`))
      renameSync(registry.dir, destination)
    }
  } else renameSync(registry.dir, destination)
  const verified = readOfficialConnectorRegistry(destination, { agentDir })
  const pointer = registryAssetPath(root, 'current.json')
  const temporary = registryAssetPath(root, `current-${randomUUID()}.json`)
  try {
    writeFileSync(temporary, JSON.stringify({ version: 1, generation }), { flag: 'wx' })
    renameSync(temporary, pointer)
  } finally {
    rmSync(temporary, { force: true })
  }
  return verified
}

function readSmallJson(root: string, path: string, maxBytes: number): unknown {
  const file = registryAssetPath(root, path)
  if (lstatSync(file).size > maxBytes) throw new Error('连接器 API 缓存元数据超过大小限制')
  return JSON.parse(readFileSync(file, 'utf8')) as unknown
}
