import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { parseTarGz } from './archive'
import { getPhiAgentDir } from '../runtime-paths'
import type {
  InstalledPackage,
  InstallerOptions,
  InstallPlan,
  LocalRegistry,
  PlannedPackage,
  RegistryPackageEntry
} from './installer-types'
import {
  assertSafePackagePath,
  compareText,
  localArchivePath,
  packageVersionKey,
  sha256
} from './installer-utils'
import { installPackages } from './lifecycle'
import { parsePackageManifestText } from './manifest'
import { planInstall } from './planning'
import { stagePackage } from './staging'

export interface OfflinePackageImportPreview {
  archivePath: string
  plan: InstallPlan
}

export interface OfflinePackageImportOptions extends InstallerOptions {
  registries?: readonly LocalRegistry[]
}

export function previewOfflinePackageImport(
  archivePath: string,
  options: OfflinePackageImportOptions = {}
): OfflinePackageImportPreview {
  const prepared = prepareOfflineRegistry(archivePath, options)
  try {
    return { archivePath: resolve(archivePath), plan: planOfflineImport(prepared, options) }
  } finally {
    prepared.cleanup()
  }
}

export async function importOfflinePackage(
  archivePath: string,
  options: OfflinePackageImportOptions = {}
): Promise<InstalledPackage[]> {
  const prepared = prepareOfflineRegistry(archivePath, options)
  try {
    const plan = planOfflineImport(prepared, options)
    const installed = await installPackages(plan, options)
    return installed
  } finally {
    prepared.cleanup()
  }
}

/**
 * Plans against entry metadata first, then copies only the dependency closure's archives
 * next to the imported one and plans again so declared environments are read from them.
 */
function planOfflineImport(
  prepared: ReturnType<typeof prepareOfflineRegistry>,
  options: OfflinePackageImportOptions
): InstallPlan {
  const request = {
    type: prepared.root.type,
    id: prepared.root.id,
    version: prepared.root.version
  }
  const planOptions = { agentDir: options.agentDir, appVersion: options.appVersion }
  const closure = planInstall(prepared.registry, request, planOptions)
  for (const entry of closure.packages) {
    const source = prepared.sources.get(packageVersionKey(entry))
    if (!source) continue
    copyFileSync(
      localArchivePath(source.registry, source.archive),
      join(prepared.registry.dir, entry.archive)
    )
  }
  const plan = planInstall(prepared.registry, request, planOptions)
  attachOfflineSources(plan, prepared.sources, prepared.registry)
  return plan
}

function prepareOfflineRegistry(
  archivePath: string,
  options: OfflinePackageImportOptions
): {
  registry: LocalRegistry
  root: RegistryPackageEntry
  sources: ReadonlyMap<string, { registry: LocalRegistry; archive: string }>
  cleanup: () => void
} {
  const sourcePath = resolve(archivePath)
  assertArchiveFile(sourcePath)
  const archive = readFileSync(sourcePath)
  const root = entryFromArchive(archive, basename(sourcePath))
  const stagingRoot = join(options.agentDir ?? getPhiAgentDir(), '.staging')
  mkdirSync(stagingRoot, { recursive: true })
  const temporary = mkdtempSync(join(stagingRoot, 'offline-registry-'))
  try {
    const rootArchive = `import-${randomUUID()}.tar.gz`
    writeFileSync(join(temporary, rootArchive), archive, { flag: 'wx' })
    const rootEntry = { ...root, archive: rootArchive }
    const materialized = listDependencyCandidates(rootEntry, options.registries ?? [])
    const registry: LocalRegistry = {
      id: sourcePath,
      dir: temporary,
      trust: 'imported',
      schemaVersion: 1,
      generatedAt: new Date(0).toISOString(),
      packages: materialized.packages
    }
    validateRootArchive(registry, rootEntry, options.agentDir ?? getPhiAgentDir())
    return {
      registry,
      root: rootEntry,
      sources: materialized.sources,
      cleanup: () => rmSync(temporary, { recursive: true, force: true })
    }
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}

function assertArchiveFile(path: string): void {
  let regular = false
  try {
    regular = statSync(path).isFile()
  } catch {
    // Use the stable error below.
  }
  if (!regular || !path.endsWith('.tar.gz'))
    throw new Error(`离线软件包必须是 .tar.gz 文件：${path}`)
}

function entryFromArchive(archive: Buffer, archiveName: string): RegistryPackageEntry {
  const entries = parseTarGz(archive)
  const seen = new Set<string>()
  for (const entry of entries) {
    const path = entry.type === 'directory' ? entry.path.replace(/\/+$/, '') : entry.path
    assertSafePackagePath(path)
    if (seen.has(path)) throw new Error(`归档包含重复路径: ${path}`)
    seen.add(path)
    if (entry.type === 'link') throw new Error(`归档不允许链接条目: ${path}`)
    if (entry.type !== 'file' && entry.type !== 'directory') {
      throw new Error(`归档包含不支持的条目类型: ${path}`)
    }
  }
  const manifestEntries = entries.filter(
    (entry) => entry.type === 'file' && entry.path === 'phi-package.yaml'
  )
  const filesEntries = entries.filter(
    (entry) => entry.type === 'file' && entry.path === 'files.json'
  )
  if (manifestEntries.length !== 1) throw new Error('离线软件包必须包含一个 phi-package.yaml')
  if (filesEntries.length !== 1) throw new Error('离线软件包必须包含一个 files.json')
  const manifest = parsePackageManifestText(manifestEntries[0]!.data.toString('utf8'))
  return {
    id: manifest.id,
    type: manifest.type,
    version: manifest.version,
    title: manifest.title,
    summary: manifest.summary,
    archive: archiveName,
    sha256: sha256(archive),
    size: archive.length,
    dependsOn: manifest.dependsOn ?? [],
    ...(manifest.minAppVersion ? { minAppVersion: manifest.minAppVersion } : {}),
    ...(manifest.requires ? { requires: manifest.requires } : {})
  }
}

/** Lists known registries' entries under local archive names; archives are copied only once planned. */
function listDependencyCandidates(
  root: RegistryPackageEntry,
  registries: readonly LocalRegistry[]
): {
  packages: RegistryPackageEntry[]
  sources: Map<string, { registry: LocalRegistry; archive: string }>
} {
  const selected = new Map<string, RegistryPackageEntry>([[packageVersionKey(root), root]])
  const sources = new Map<string, { registry: LocalRegistry; archive: string }>()
  for (const registry of registries) {
    for (const entry of registry.packages) {
      const key = packageVersionKey(entry)
      if (selected.has(key)) continue
      const archiveName = `${entry.type}-${entry.id}-${entry.version}-${entry.sha256.slice(0, 12)}.tar.gz`
      selected.set(key, { ...entry, archive: archiveName })
      sources.set(key, { registry, archive: entry.archive })
    }
  }
  return {
    packages: [...selected.values()].sort(
      (left, right) =>
        compareText(left.type, right.type) ||
        compareText(left.id, right.id) ||
        compareText(left.version, right.version)
    ),
    sources
  }
}

function attachOfflineSources(
  plan: InstallPlan,
  sources: ReadonlyMap<string, { registry: LocalRegistry; archive: string }>,
  importedRegistry: LocalRegistry
): void {
  for (const entry of plan.packages) {
    const source = sources.get(packageVersionKey(entry))
    entry.sourceRegistry = source?.registry ?? importedRegistry
    if (source) entry.sourceArchive = source.archive
  }
}

function validateRootArchive(
  registry: LocalRegistry,
  entry: RegistryPackageEntry,
  agentDir: string
): void {
  mkdirSync(join(agentDir, '.staging'), { recursive: true })
  const planned: PlannedPackage = { ...entry, installedBy: 'user' }
  const staged = stagePackage(registry, planned, agentDir)
  rmSync(staged.dir, { recursive: true, force: true })
}
