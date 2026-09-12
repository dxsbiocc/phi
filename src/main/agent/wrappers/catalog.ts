import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getPhiAgentDir } from '../runtime-paths'
import { getInstalledWrappersDir } from './store'
import { parseWrapperManifest } from './manifest'
import type { WrapperManifest } from './manifest-types'
import type { WrapperTrustTier } from './types'
import type { WrapperCatalogEntry } from '../../../shared/wrapperCatalogTypes'

export type { WrapperCatalogEntry } from '../../../shared/wrapperCatalogTypes'

/**
 * Sidecar file recording how a wrapper got onto disk — bundled (shipped with
 * the app) or custom (a user-provided dev path). This, not anything inside
 * `wrapper.yaml` itself, is what trust tier resolution reads. See technical
 * design's "Trust And Registry": a manifest's own `verification:` block is
 * never trusted as a self-report.
 */
interface WrapperSourceMarker {
  trustTier: WrapperTrustTier
  installedAt: string
  /** Only set for `custom` wrappers — the local folder the user pointed at. */
  sourcePath?: string
}

const SOURCE_MARKER_FILE = '.source.json'
const MANIFEST_FILE = 'wrapper.yaml'

const WRAPPERS_MODULE_DIR = fileURLToPath(new URL('.', import.meta.url))

// Phase 1's only bundled wrapper. Adding a second bundled wrapper later is
// just adding another entry here — nothing about the shape below assumes
// there is exactly one.
const BUNDLED_FIXTURE_DIRS = [join(WRAPPERS_MODULE_DIR, 'fixtures', 'phi-ngs-fastq-qc')]

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true })
  }
}

function installedDirFor(manifest: WrapperManifest, agentDir: string): string {
  return join(getInstalledWrappersDir(agentDir), ...manifest.id.split('/'), manifest.version)
}

function writeSourceMarker(installedPath: string, marker: WrapperSourceMarker): void {
  writeFileSync(
    join(installedPath, SOURCE_MARKER_FILE),
    `${JSON.stringify(marker, null, 2)}\n`,
    'utf-8'
  )
}

function readSourceMarker(installedPath: string): WrapperSourceMarker | undefined {
  const path = join(installedPath, SOURCE_MARKER_FILE)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as WrapperSourceMarker
  } catch {
    return undefined
  }
}

function loadManifestFromDir(dir: string): WrapperManifest {
  const manifestPath = join(dir, MANIFEST_FILE)
  if (!existsSync(manifestPath)) {
    throw new Error(`未找到 wrapper.yaml: ${manifestPath}`)
  }
  const result = parseWrapperManifest(readFileSync(manifestPath, 'utf-8'))
  if (!result.valid || !result.manifest) {
    throw new Error(`wrapper.yaml 校验失败 (${manifestPath}):\n${result.errors.join('\n')}`)
  }
  return result.manifest
}

/**
 * Writes the app's bundled fixture wrappers into `installed/` if missing,
 * always refreshing the manifest content (bundled wrappers are the app's own
 * definition — there is nothing for a user to customize) and the source
 * marker. Idempotent: safe to call on every app start.
 */
export function ensureBundledWrappersInstalled(agentDir = getPhiAgentDir()): WrapperCatalogEntry[] {
  const entries: WrapperCatalogEntry[] = []
  for (const fixtureDir of BUNDLED_FIXTURE_DIRS) {
    const manifest = loadManifestFromDir(fixtureDir)
    const installedPath = installedDirFor(manifest, agentDir)
    ensureDir(installedPath)
    writeFileSync(
      join(installedPath, MANIFEST_FILE),
      readFileSync(join(fixtureDir, MANIFEST_FILE), 'utf-8'),
      'utf-8'
    )
    const installedAt = readSourceMarker(installedPath)?.installedAt ?? new Date().toISOString()
    writeSourceMarker(installedPath, { trustTier: 'bundled', installedAt })
    entries.push({ manifest, trustTier: 'bundled', installedPath, installedAt })
  }
  return entries
}

/**
 * Parses and installs a wrapper from a local directory as `custom`. Never
 * registers as a default agent tool — see technical design's Agent Tool
 * Registration.
 */
export function addCustomWrapper(
  sourceDir: string,
  agentDir = getPhiAgentDir()
): WrapperCatalogEntry {
  const manifest = loadManifestFromDir(sourceDir)
  const installedPath = installedDirFor(manifest, agentDir)
  ensureDir(installedPath)
  writeFileSync(
    join(installedPath, MANIFEST_FILE),
    readFileSync(join(sourceDir, MANIFEST_FILE), 'utf-8'),
    'utf-8'
  )
  const installedAt = new Date().toISOString()
  writeSourceMarker(installedPath, { trustTier: 'custom', installedAt, sourcePath: sourceDir })
  return { manifest, trustTier: 'custom', installedPath, installedAt }
}

function findManifestDirs(root: string): string[] {
  if (!existsSync(root)) return []
  const found: string[] = []
  const walk = (dir: string): void => {
    if (existsSync(join(dir, MANIFEST_FILE))) {
      found.push(dir)
      return
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name))
      }
    }
  }
  walk(root)
  return found
}

/** Lists every installed wrapper (bundled and custom) by scanning `installed/` for `wrapper.yaml` files. */
export function listWrapperCatalog(agentDir = getPhiAgentDir()): WrapperCatalogEntry[] {
  const root = getInstalledWrappersDir(agentDir)
  return findManifestDirs(root)
    .map((dir) => {
      const marker = readSourceMarker(dir)
      if (!marker) return undefined
      try {
        const manifest = loadManifestFromDir(dir)
        return {
          manifest,
          trustTier: marker.trustTier,
          installedPath: dir,
          installedAt: marker.installedAt
        }
      } catch {
        return undefined
      }
    })
    .filter((entry): entry is WrapperCatalogEntry => entry !== undefined)
}

export function findWrapperCatalogEntry(
  canonicalId: string,
  version: string,
  agentDir = getPhiAgentDir()
): WrapperCatalogEntry | undefined {
  return listWrapperCatalog(agentDir).find(
    (entry) => entry.manifest.id === canonicalId && entry.manifest.version === version
  )
}

/**
 * Wrappers eligible to become default agent tools (see technical design's
 * Agent Tool Registration): `bundled` only. `custom` wrappers always require
 * explicit user allowance and are never returned here.
 */
export function listDefaultAgentToolWrappers(agentDir = getPhiAgentDir()): WrapperCatalogEntry[] {
  return listWrapperCatalog(agentDir).filter((entry) => entry.trustTier === 'bundled')
}
