import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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

function loadManifestFromDir(dir: string): DbConnectorManifest {
  const manifestPath = join(dir, CONNECTOR_FILE)
  if (!existsSync(manifestPath)) throw new Error(`未找到 connector.yaml: ${manifestPath}`)
  const result = parseDbConnectorManifest(readFileSync(manifestPath, 'utf-8'))
  if (!result.valid || !result.manifest) {
    throw new Error(`connector.yaml 校验失败 (${manifestPath}):\n${result.errors.join('\n')}`)
  }
  return result.manifest
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
    const manifest = loadManifestFromDir(dir)
    const digest = canonicalDbConnectorDigest(manifest)
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
  return listDbConnectorCatalog(agentDir).find((entry) => entry.manifest.id === id)
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
