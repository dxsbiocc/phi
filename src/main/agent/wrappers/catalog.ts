import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import semver from 'semver'
import { stringify as stringifyYaml } from 'yaml'

import { getPhiAgentDir } from '../runtime-paths'
import {
  installPackages,
  listInstalledPackages,
  readRegistry,
  uninstallPackage
} from '../packages/installer'
import type { InstallPlan, InstalledPackage } from '../packages/installer'
import { getWrapperCustomDir, readWrapperTreeState } from '../packages/wrapper-tree'
import { materializeWrapperRegistry, type WrapperPackageBuildDiagnostics } from './packages/builder'
import { prepareLegacyWrapperPack, selectLegacyWrapperPack } from './legacy-pack-migration'
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
 * Locates `resources/wrappers/` — the shipped source tree from which bundled
 * wrapper packages are materialized. Not
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

const BUNDLED_MARKER_VERSION = 1
const DEFAULT_BUNDLED_PACKAGE_VERSION = '1.0.0'
const BUNDLED_REGISTRY_ID = 'bundled-wrappers'

interface BundledWrapperMarker {
  version: 1
  packageVersion: string
  packageIds: string[]
  diagnostics: WrapperPackageBuildDiagnostics
}

export interface BundledWrapperInstallResult {
  packages: InstalledPackage[]
  installed: string[]
  removed: string[]
  migratedCustom: string[]
  migratedPackVersion?: string
  legacyPackWarnings: Array<{ root: string; reason: string }>
  diagnostics: WrapperPackageBuildDiagnostics
}

export interface BundledWrapperInstallOptions {
  sourceRoot?: string
  packageVersion?: string
  generatedAt?: string
}

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

function bundledMarkerPath(agentDir: string): string {
  return join(agentDir, 'wrappers', 'bundled.json')
}

function readBundledMarker(agentDir: string): BundledWrapperMarker | undefined {
  try {
    const value = JSON.parse(
      readFileSync(bundledMarkerPath(agentDir), 'utf8')
    ) as BundledWrapperMarker
    if (
      value.version !== BUNDLED_MARKER_VERSION ||
      !semver.valid(value.packageVersion) ||
      !Array.isArray(value.packageIds) ||
      value.packageIds.some((id) => typeof id !== 'string') ||
      !value.diagnostics ||
      !Array.isArray(value.diagnostics.unattributedIncludes) ||
      !Array.isArray(value.diagnostics.unattributedSupportFiles)
    ) {
      return undefined
    }
    return value
  } catch {
    return undefined
  }
}

function writeBundledMarker(agentDir: string, marker: BundledWrapperMarker): void {
  const target = bundledMarkerPath(agentDir)
  ensureDir(join(target, '..'))
  const temporary = `${target}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
  renameSync(temporary, target)
}

function markerMatchesInstalledTree(agentDir: string, marker: BundledWrapperMarker): boolean {
  const packages = readWrapperTreeState(agentDir).packages
  return marker.packageIds.every((id) => packages[id]?.version === marker.packageVersion)
}

function migrateLegacyCustomWrappers(agentDir: string): string[] {
  const migrated: string[] = []
  for (const dir of findManifestDirs(getInstalledWrappersDir(agentDir))) {
    const marker = readSourceMarker(dir)
    if (marker?.trustTier !== 'custom') continue
    let manifest: WrapperManifest
    try {
      manifest = loadManifestFromDir(dir)
    } catch {
      continue
    }
    const provider = manifest.id.split('/')[0]
    const name = manifest.shortId
    if (
      !provider ||
      !/^[a-z][a-z0-9-]*$/.test(provider) ||
      !/^[a-z][a-z0-9-]*$/.test(name) ||
      manifest.engine.entrypoint !== 'main.nf' ||
      !manifest.outputs.some((output) => output.primary === true)
    ) {
      continue
    }
    const componentDir = join(getWrapperCustomDir(agentDir), 'modules', provider, name)
    const wrapperDir = join(componentDir, 'wrapper')
    if (existsSync(wrapperDir)) continue
    ensureDir(componentDir)
    cpSync(dir, wrapperDir, {
      recursive: true,
      errorOnExist: true,
      filter: (source) => !['.source.json', 'wrapper.yaml'].includes(basename(source))
    })
    const schema = manifest.parameters.schema
    const properties = isRecord(schema.properties) ? schema.properties : {}
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((value): value is string => typeof value === 'string')
        : []
    )
    const params: Record<string, Record<string, unknown>> = {}
    const defaults: Record<string, unknown> = {}
    for (const input of manifest.inputs) {
      params[input.id] = {
        kind: 'input',
        type: input.type,
        required: input.required
      }
    }
    for (const [id, value] of Object.entries(properties)) {
      if (!isRecord(value) || !/^[a-z][a-z0-9_]*$/.test(id)) continue
      const numeric = value.type === 'integer' || value.type === 'number'
      params[id] = {
        kind: params[id]?.kind ?? 'option',
        type: typeof value.type === 'string' && value.type ? value.type : 'string',
        required: required.has(id) || params[id]?.required === true,
        ...(typeof value.description === 'string' ? { description: value.description } : {}),
        ...(numeric && typeof value.minimum === 'number' ? { minimum: value.minimum } : {}),
        ...(numeric && typeof value.maximum === 'number' ? { maximum: value.maximum } : {}),
        ...(Array.isArray(value.enum) && value.enum.every((item) => typeof item === 'string')
          ? { enum: value.enum }
          : {})
      }
      if (Object.hasOwn(value, 'default')) defaults[id] = value.default
    }
    const outputs = Object.fromEntries(
      manifest.outputs.map((output) => [
        output.id,
        {
          type: output.type,
          path: output.path,
          ...(output.primary === true ? { primary: true } : {})
        }
      ])
    )
    writeFileSync(
      join(wrapperDir, 'wrapper.yaml'),
      stringifyYaml({
        id: `${provider}/modules/${name}`,
        name: manifest.name,
        summary: manifest.summary,
        params,
        outputs
      }),
      'utf8'
    )
    writeFileSync(join(wrapperDir, 'params.json'), `${JSON.stringify(defaults, null, 2)}\n`, 'utf8')
    migrated.push(manifest.id)
  }
  return migrated.sort()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Installs the shipped wrapper source as ordinary wrapper packages. Archives
 * are materialized only into a temporary local registry, avoiding a second
 * permanent copy of the 40+ MB source tree in the application bundle.
 */
export async function ensureBundledWrappersInstalled(
  agentDir = getPhiAgentDir(),
  options: BundledWrapperInstallOptions = {}
): Promise<BundledWrapperInstallResult> {
  const packageVersion = options.packageVersion ?? DEFAULT_BUNDLED_PACKAGE_VERSION
  if (!semver.valid(packageVersion)) {
    throw new Error(`Invalid bundled wrapper package version: ${packageVersion}`)
  }
  const migratedCustom = migrateLegacyCustomWrappers(agentDir)
  const marker = readBundledMarker(agentDir)
  if (marker?.packageVersion === packageVersion && markerMatchesInstalledTree(agentDir, marker)) {
    const ids = new Set(marker.packageIds)
    return {
      packages: listInstalledPackages({ agentDir }).filter(
        (entry) => entry.type === 'wrapper' && ids.has(entry.id)
      ),
      installed: [],
      removed: [],
      migratedCustom,
      legacyPackWarnings: [],
      diagnostics: marker.diagnostics
    }
  }

  const registryDir = mkdtempSync(join(tmpdir(), 'phi-bundled-wrapper-registry-'))
  try {
    const legacyPack = marker ? { rejected: [] } : selectLegacyWrapperPack(agentDir)
    const legacyPackWarnings = [...legacyPack.rejected]
    const registryOutput = join(registryDir, 'registry')
    let migratedPackVersion: string | undefined
    let built: ReturnType<typeof materializeWrapperRegistry> | undefined
    if (legacyPack.root) {
      try {
        const legacySource = join(registryDir, 'legacy-source')
        for (const reason of prepareLegacyWrapperPack(legacyPack.root, legacySource)) {
          legacyPackWarnings.push({ root: legacyPack.root, reason })
        }
        built = materializeWrapperRegistry({
          wrappersRoot: legacySource,
          outDir: registryOutput,
          version: packageVersion,
          ...(options.generatedAt ? { generatedAt: options.generatedAt } : {})
        })
        const unresolvedLocal = built.diagnostics.unattributedIncludes.filter(
          (include) => !include.target.startsWith('plugin/')
        )
        if (unresolvedLocal.length > 0) {
          throw new Error(
            `legacy pack has unresolved local includes: ${unresolvedLocal
              .map((include) => `${include.from} -> ${include.target}`)
              .join(', ')}`
          )
        }
        migratedPackVersion = legacyPack.version
      } catch (error) {
        legacyPackWarnings.push({
          root: legacyPack.root,
          reason: `conversion failed; used bundled source: ${error instanceof Error ? error.message : String(error)}`
        })
        built = undefined
        rmSync(registryOutput, { recursive: true, force: true })
      }
    }
    built ??= materializeWrapperRegistry({
      wrappersRoot: options.sourceRoot ?? getBundledWrapperPackagesDir(),
      outDir: registryOutput,
      version: packageVersion,
      ...(options.generatedAt ? { generatedAt: options.generatedAt } : {})
    })
    const registry = { ...readRegistry(registryOutput), id: BUNDLED_REGISTRY_ID }
    const installed = new Map(
      listInstalledPackages({ agentDir })
        .filter((entry) => entry.type === 'wrapper')
        .map((entry) => [entry.id, entry])
    )
    const pending = registry.packages.filter((entry) => {
      const current = installed.get(entry.id)
      return !current || semver.lt(current.version, entry.version)
    })
    if (pending.length > 0) {
      const root = pending.at(-1)
      if (!root) throw new Error('Bundled wrapper install plan unexpectedly has no root package')
      const plan: InstallPlan = {
        registry,
        root: { type: root.type, id: root.id, version: root.version },
        packages: pending.map((entry) => ({ ...entry, installedBy: 'user' as const })),
        totalSize: pending.reduce((total, entry) => total + entry.size, 0),
        environments: [],
        agentDir
      }
      await installPackages(plan, { agentDir })
    }
    const packageIds = built.index.packages.map((entry) => entry.id).sort()
    const nextIds = new Set(packageIds)
    const stateBeforeRemoval = readWrapperTreeState(agentDir).packages
    const retired = new Set(
      (marker?.packageIds ?? []).filter((id) => {
        const current = stateBeforeRemoval[id]
        return (
          !nextIds.has(id) &&
          current?.version === marker?.packageVersion &&
          current.source.registry === BUNDLED_REGISTRY_ID
        )
      })
    )
    const removed: string[] = []
    while (retired.size > 0) {
      const removable = [...retired].find((id) =>
        [...retired].every(
          (candidate) =>
            candidate === id ||
            !(stateBeforeRemoval[candidate]?.manifest.dependsOn ?? []).some(
              (dependency) => dependency.type === 'wrapper' && dependency.id === id
            )
        )
      )
      if (!removable) {
        throw new Error(
          `Cannot reconcile cyclic retired wrapper packages: ${[...retired].join(', ')}`
        )
      }
      uninstallPackage('wrapper', removable, { agentDir })
      retired.delete(removable)
      removed.push(removable)
    }
    const nextMarker: BundledWrapperMarker = {
      version: BUNDLED_MARKER_VERSION,
      packageVersion,
      packageIds,
      diagnostics: built.diagnostics
    }
    writeBundledMarker(agentDir, nextMarker)
    const ids = new Set(packageIds)
    return {
      packages: listInstalledPackages({ agentDir }).filter(
        (entry) => entry.type === 'wrapper' && ids.has(entry.id)
      ),
      installed: pending.map((entry) => entry.id),
      removed: removed.sort(),
      migratedCustom,
      ...(migratedPackVersion ? { migratedPackVersion } : {}),
      legacyPackWarnings,
      diagnostics: built.diagnostics
    }
  } finally {
    rmSync(registryDir, { recursive: true, force: true })
  }
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
