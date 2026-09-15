import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

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

const nodeRequire = createRequire(import.meta.url)

/**
 * Locates `resources/wrappers/` — the on-disk home for every bundled
 * wrapper package (manifest + vendored pipeline/module source). Not
 * `src/main/agent/wrappers/fixtures/`, where these lived until this
 * function replaced a rollup copy-plugin hack
 * (`copyWrapperFixturesPlugin` in electron.vite.config.ts's history):
 * `resources/` is this app's existing, already-packaging-aware home for
 * "shipped content that isn't compiled code" — electron-builder.yml's
 * `asarUnpack: - resources/**` already un-compresses it from the app
 * bundle at build time, so nothing here needs a custom build step.
 *
 * Three contexts, three answers:
 *  - Packaged Electron app: electron-builder's `asarUnpack` extracts
 *    matched files OUT of the compressed `app.asar` at build time into a
 *    sibling `app.asar.unpacked/` directory that mirrors the same
 *    project-relative layout — a standard, documented electron-builder
 *    idiom, not something to re-derive via relative path arithmetic from
 *    wherever this compiled file happens to load from (rollup flattens the
 *    whole main process into one file, so that arithmetic isn't even
 *    stable across rollup config changes — exactly what the old
 *    fixtures-under-src/ approach ran into).
 *  - Dev Electron app (`electron-vite dev`/`preview`, unpackaged):
 *    `app.getAppPath()` is the project root — no asar involved at all.
 *  - Plain `node --test` (this project's whole test suite, no Electron
 *    runtime present — `require('electron')` here returns a bare string,
 *    the path to the Electron binary, not the API object): falls back to
 *    `process.cwd()`, which every test invocation in package.json's `test`
 *    script already runs from the project root.
 */
export function getBundledWrapperPackagesDir(): string {
  const electronModule = nodeRequire('electron') as
    { app?: { isPackaged: boolean; getAppPath(): string } } | string
  const electronApp = typeof electronModule === 'object' ? electronModule.app : undefined

  if (!electronApp) {
    return join(process.cwd(), 'resources', 'wrappers')
  }
  if (!electronApp.isPackaged) {
    return join(electronApp.getAppPath(), 'resources', 'wrappers')
  }
  return join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'wrappers')
}

/**
 * Legacy package-level bundled wrappers were removed from `resources/wrappers/`.
 * The app's bundled wrapper surface is now the composition layout discovered
 * from `modules/**\/wrapper` and `subworkflows/**\/wrapper`.
 *
 * Keep this empty so the legacy catalog still supports custom installs and old
 * plan/run tests, without app startup trying to copy directories that are no
 * longer shipped.
 */
const BUNDLED_WRAPPER_PACKAGE_DIRS: string[] = []

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

/**
 * Copies every file in `sourceDir` into `installedPath` — not just
 * `wrapper.yaml`. Real pipeline code (`main.nf`, `workflows/`, `conf/`,
 * etc.) has to physically exist under `installedPath` for anything to
 * actually execute: `executor-nextflow.ts` resolves `engine.entrypoint`
 * relative to it, and the remote submit orchestrators upload its entire
 * contents (`uploadWrapperBundle`). Both bundled and custom installs used
 * to write only `wrapper.yaml` — invisible until now because the only
 * wrapper ever exercised (the fastq-qc demo fixture) never shipped a real
 * `main.nf` to begin with, so nothing ever needed the rest of the tree.
 * `.git` is excluded — a custom wrapper's source directory pointing at a
 * real git checkout shouldn't drag its whole history into `installed/`.
 */
function copyWrapperSourceTree(sourceDir: string, installedPath: string): void {
  cpSync(sourceDir, installedPath, {
    recursive: true,
    filter: (src) => !src.split(/[\\/]/).includes('.git')
  })
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
 * Writes the app's bundled wrapper packages into `installed/` if missing,
 * always refreshing the manifest content (bundled wrappers are the app's own
 * definition — there is nothing for a user to customize) and the source
 * marker. Idempotent: safe to call on every app start.
 */
export function ensureBundledWrappersInstalled(agentDir = getPhiAgentDir()): WrapperCatalogEntry[] {
  const entries: WrapperCatalogEntry[] = []
  for (const packageDir of BUNDLED_WRAPPER_PACKAGE_DIRS) {
    const manifest = loadManifestFromDir(packageDir)
    const installedPath = installedDirFor(manifest, agentDir)
    ensureDir(installedPath)
    copyWrapperSourceTree(packageDir, installedPath)
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
  copyWrapperSourceTree(sourceDir, installedPath)
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
