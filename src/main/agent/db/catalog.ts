import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { getPhiAgentDir } from '../runtime-paths'
import { writeGeneratedDbConnectorDocs, type WrittenDbConnectorDocs } from './docs-generator'
import { canonicalDbConnectorDigest, parseDbConnectorManifest } from './manifest'
import type { DbConnectorCatalogEntry, DbConnectorManifest, DbTrustTier } from './manifest-types'
import {
  getInstalledDbConnectorsDir,
  isCustomDbConnectorAllowed,
  isDbConnectorQueryDisabled,
  ensureDbConnectorStorageDirs
} from './store'

interface DbConnectorSourceMarker {
  trustTier: DbTrustTier
  installedAt: string
  sourcePath?: string
}

const SOURCE_MARKER_FILE = '.source.json'
const CONNECTOR_FILE = 'connector.yaml'
const nodeRequire = createRequire(import.meta.url)
// Discovery may inspect every connector, but unchanged YAML is parsed only once per process.
const manifestCache = new Map<
  string,
  { stamp: string; manifest: DbConnectorManifest; digest: string }
>()

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true })
}

export function getBundledDbConnectorsDir(): string {
  const electronModule = nodeRequire('electron') as
    { app?: { isPackaged: boolean; getAppPath(): string } } | string
  const electronApp = typeof electronModule === 'object' ? electronModule.app : undefined
  if (!electronApp) return join(process.cwd(), 'resources', 'db-connectors')
  if (!electronApp.isPackaged) return join(electronApp.getAppPath(), 'resources', 'db-connectors')
  return join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'db-connectors')
}

function connectorDirFor(manifest: DbConnectorManifest, root: string): string {
  return join(root, ...manifest.id.split('/'))
}

function readSourceMarker(dir: string): DbConnectorSourceMarker | undefined {
  const path = join(dir, SOURCE_MARKER_FILE)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as DbConnectorSourceMarker
  } catch {
    return undefined
  }
}

function writeSourceMarker(dir: string, marker: DbConnectorSourceMarker): void {
  writeFileSync(join(dir, SOURCE_MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, 'utf-8')
}

function cachedManifestFromDir(dir: string): { manifest: DbConnectorManifest; digest: string } {
  const manifestPath = join(dir, CONNECTOR_FILE)
  if (!existsSync(manifestPath)) throw new Error(`未找到 connector.yaml: ${manifestPath}`)
  const stat = statSync(manifestPath, { bigint: true })
  const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
  const cached = manifestCache.get(manifestPath)
  if (cached?.stamp === stamp) return cached
  const result = parseDbConnectorManifest(readFileSync(manifestPath, 'utf-8'))
  if (!result.valid || !result.manifest) {
    throw new Error(`connector.yaml 校验失败 (${manifestPath}):\n${result.errors.join('\n')}`)
  }
  const entry = {
    stamp,
    manifest: result.manifest,
    digest: canonicalDbConnectorDigest(result.manifest)
  }
  manifestCache.set(manifestPath, entry)
  return entry
}

function loadManifestFromDir(dir: string): DbConnectorManifest {
  return cachedManifestFromDir(dir).manifest
}

function findConnectorDirs(root: string): string[] {
  if (!existsSync(root)) return []
  const found: string[] = []
  const walk = (dir: string): void => {
    if (existsSync(join(dir, CONNECTOR_FILE))) {
      found.push(dir)
      return
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name))
    }
  }
  walk(root)
  return found
}

function catalogEntryFrom(
  dir: string,
  marker: DbConnectorSourceMarker,
  agentDir: string
): DbConnectorCatalogEntry | undefined {
  try {
    const { manifest, digest } = cachedManifestFromDir(dir)
    const disabled = isDbConnectorQueryDisabled(manifest.id, agentDir)
    return {
      manifest,
      trustTier: marker.trustTier,
      installedPath: dir,
      installedAt: marker.installedAt,
      digest,
      enabledForQuery:
        !disabled &&
        (marker.trustTier === 'bundled' ||
          isCustomDbConnectorAllowed(manifest.id, digest, agentDir))
    }
  } catch {
    return undefined
  }
}

export function addCustomDbConnector(
  sourceDir: string,
  agentDir = getPhiAgentDir()
): DbConnectorCatalogEntry {
  ensureDbConnectorStorageDirs(agentDir)
  const manifest = loadManifestFromDir(sourceDir)
  const installedPath = connectorDirFor(manifest, getInstalledDbConnectorsDir(agentDir))
  ensureDir(installedPath)
  cpSync(join(sourceDir, CONNECTOR_FILE), join(installedPath, CONNECTOR_FILE))
  const installedAt = new Date().toISOString()
  writeSourceMarker(installedPath, { trustTier: 'custom', installedAt, sourcePath: sourceDir })
  const digest = canonicalDbConnectorDigest(manifest)
  const entry: DbConnectorCatalogEntry = {
    manifest,
    trustTier: 'custom',
    installedPath,
    installedAt,
    digest,
    enabledForQuery: isCustomDbConnectorAllowed(manifest.id, digest, agentDir)
  }
  syncGeneratedDbConnectorDocsBestEffort(agentDir)
  return entry
}

export function listDbConnectorCatalog(agentDir = getPhiAgentDir()): DbConnectorCatalogEntry[] {
  const bundled = findConnectorDirs(getBundledDbConnectorsDir())
    .map((dir) => catalogEntryFrom(dir, { trustTier: 'bundled', installedAt: 'bundled' }, agentDir))
    .filter((entry): entry is DbConnectorCatalogEntry => entry !== undefined)

  const custom = findConnectorDirs(getInstalledDbConnectorsDir(agentDir))
    .map((dir) => {
      const marker = readSourceMarker(dir)
      if (!marker) return undefined
      return catalogEntryFrom(dir, marker, agentDir)
    })
    .filter((entry): entry is DbConnectorCatalogEntry => entry !== undefined)

  return [...bundled, ...custom]
}

export function findDbConnectorCatalogEntry(
  id: string,
  agentDir = getPhiAgentDir()
): DbConnectorCatalogEntry | undefined {
  if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(id)) return undefined
  const bundledDir = join(getBundledDbConnectorsDir(), ...id.split('/'))
  const bundled = catalogEntryFrom(
    bundledDir,
    { trustTier: 'bundled', installedAt: 'bundled' },
    agentDir
  )
  if (bundled?.manifest.id === id) return bundled

  const installedDir = join(getInstalledDbConnectorsDir(agentDir), ...id.split('/'))
  const marker = readSourceMarker(installedDir)
  const custom = marker ? catalogEntryFrom(installedDir, marker, agentDir) : undefined
  return custom?.manifest.id === id ? custom : undefined
}

export function syncGeneratedDbConnectorDocs(agentDir = getPhiAgentDir()): WrittenDbConnectorDocs {
  return writeGeneratedDbConnectorDocs(listDbConnectorCatalog(agentDir), agentDir)
}

function syncGeneratedDbConnectorDocsBestEffort(agentDir: string): void {
  try {
    syncGeneratedDbConnectorDocs(agentDir)
  } catch {
    // Generated navigation docs must never block connector installation or querying.
  }
}
