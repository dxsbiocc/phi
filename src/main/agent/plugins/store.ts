import { randomBytes } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { getPhiAgentDir } from '../runtime-paths'
import type { PhiPluginManifest } from './phi-package'
import { PACKAGE_ICON_FILENAMES } from '../packages/icon-assets'

export type PluginSource = 'bundled' | 'local'

export interface PluginRegistryEntry {
  version: string
  /** Legacy only. Enablement now lives in state/enabled.json. */
  enabled?: boolean
  source: PluginSource
  installedAt: string
  uninstalledBundled?: boolean
}

export interface PluginRegistry {
  version: 1
  plugins: Record<string, PluginRegistryEntry>
}

const REGISTRY_VERSION = 1

function emptyRegistry(): PluginRegistry {
  return { version: REGISTRY_VERSION, plugins: {} }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}

function isRegistryEntry(value: unknown): value is PluginRegistryEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.version === 'string' &&
    (entry.enabled === undefined || typeof entry.enabled === 'boolean') &&
    (entry.source === 'bundled' || entry.source === 'local') &&
    typeof entry.installedAt === 'string' &&
    (entry.uninstalledBundled === undefined || typeof entry.uninstalledBundled === 'boolean')
  )
}

function isRegistry(value: unknown): value is PluginRegistry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const registry = value as Record<string, unknown>
  if (registry.version !== REGISTRY_VERSION) return false
  if (
    registry.plugins === null ||
    typeof registry.plugins !== 'object' ||
    Array.isArray(registry.plugins)
  ) {
    return false
  }
  return Object.values(registry.plugins as Record<string, unknown>).every(isRegistryEntry)
}

export function pluginPackagesDir(agentDir = getPhiAgentDir()): string {
  return join(agentDir, 'packages', 'plugin')
}

export function pluginRegistryPath(agentDir = getPhiAgentDir()): string {
  return join(agentDir, 'packages', 'plugins.json')
}

export function pluginVersionDir(id: string, version: string, agentDir = getPhiAgentDir()): string {
  return join(pluginPackagesDir(agentDir), id, version)
}

export function readPluginRegistry(agentDir = getPhiAgentDir()): PluginRegistry {
  const file = pluginRegistryPath(agentDir)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return emptyRegistry()
    throw error
  }

  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw new Error(`invalid plugin registry JSON: ${file}`)
  }
  if (!isRegistry(value)) throw new Error(`invalid plugin registry: ${file}`)
  return value
}

/** The registry switch is a same-directory write + rename, so readers see old or new state. */
export function writePluginRegistry(registry: PluginRegistry, agentDir = getPhiAgentDir()): void {
  if (!isRegistry(registry)) throw new Error('refusing to write an invalid plugin registry')
  const target = pluginRegistryPath(agentDir)
  const parent = dirname(target)
  mkdirSync(parent, { recursive: true })
  const temporary = join(parent, `.plugins.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
    renameSync(temporary, target)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temporary file may not exist when the initial write failed.
    }
    throw error
  }
}

function assertSafeRelativePath(path: string): void {
  const segments = path.split(/[\\/]+/)
  if (
    !path ||
    isAbsolute(path) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`unsafe plugin package path '${path}'`)
  }
}

function isLeftover(relativePath: string): boolean {
  const parts = relativePath.split(sep)
  const name = parts.at(-1) ?? ''
  return (
    parts.includes('__pycache__') ||
    parts.includes('work') ||
    parts.includes('results') ||
    name === '.DS_Store' ||
    name.startsWith('.nextflow')
  )
}

function copyAllowlistedPath(sourceRoot: string, targetRoot: string, relativePath: string): void {
  assertSafeRelativePath(relativePath)
  if (isLeftover(relativePath)) return
  const source = join(sourceRoot, relativePath)
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(source)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    throw error
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`symbolic links are not allowed in plugin packages: ${relativePath}`)
  }
  if (stat.isDirectory()) {
    mkdirSync(join(targetRoot, relativePath), { recursive: true, mode: stat.mode })
    for (const child of readdirSync(source).sort((left, right) => left.localeCompare(right))) {
      copyAllowlistedPath(sourceRoot, targetRoot, join(relativePath, child))
    }
    return
  }
  if (!stat.isFile()) throw new Error(`unsupported plugin package entry: ${relativePath}`)
  const target = join(targetRoot, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, readFileSync(source), { mode: stat.mode })
}

function environmentDirectory(specPath: string): string {
  assertSafeRelativePath(specPath)
  return dirname(specPath)
}

/** Copy only contract-owned package paths into a staged directory, then rename it in place. */
export function copyPluginPackage(
  sourceDir: string,
  manifest: PhiPluginManifest,
  agentDir = getPhiAgentDir(),
  sourceMetadata?: string
): string {
  const sourceRoot = resolve(sourceDir)
  const target = pluginVersionDir(manifest.id, manifest.version, agentDir)
  if (existsSync(target)) {
    throw new Error(`plugin ${manifest.id}@${manifest.version} is already present`)
  }
  const parent = dirname(target)
  mkdirSync(parent, { recursive: true })
  const temporary = join(
    parent,
    `.${basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  )
  mkdirSync(temporary, { recursive: false })

  const paths = new Set<string>(['phi-package.yaml', ...PACKAGE_ICON_FILENAMES])
  if (manifest.files) paths.add(manifest.files)
  if (existsSync(join(sourceRoot, 'README.md'))) paths.add('README.md')
  for (const file of manifest.components.agents ?? []) paths.add(file)
  for (const directory of manifest.components.skills ?? []) paths.add(directory)
  for (const declaration of Object.values(manifest.environments ?? {})) {
    paths.add(environmentDirectory(declaration.spec))
  }
  if (existsSync(join(sourceRoot, 'assets'))) paths.add('assets')

  try {
    for (const path of [...paths].sort((left, right) => left.localeCompare(right))) {
      copyAllowlistedPath(sourceRoot, temporary, path)
    }
    if (sourceMetadata !== undefined) {
      writeFileSync(join(temporary, '.source.json'), sourceMetadata, 'utf8')
    }
    renameSync(temporary, target)
    return target
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}

export function removePluginVersion(
  id: string,
  version: string,
  agentDir = getPhiAgentDir()
): void {
  rmSync(pluginVersionDir(id, version, agentDir), { recursive: true, force: true })
  const idDir = join(pluginPackagesDir(agentDir), id)
  try {
    if (readdirSync(idDir).length === 0) rmSync(idDir, { recursive: false, force: true })
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
}

export function removeAllPluginVersions(id: string, agentDir = getPhiAgentDir()): void {
  const root = pluginPackagesDir(agentDir)
  const target = resolve(root, id)
  const relativeTarget = relative(resolve(root), target)
  if (!relativeTarget || relativeTarget.startsWith('..') || isAbsolute(relativeTarget)) {
    throw new Error(`unsafe plugin id '${id}'`)
  }
  rmSync(target, { recursive: true, force: true })
}
