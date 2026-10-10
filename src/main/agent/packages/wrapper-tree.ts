import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'

import semver from 'semver'

import { getPhiAgentDir } from '../runtime-paths'
import { collectIncludeReferences } from '../wrappers/composition/includes'
import { parseWrapperCompositionManifest } from '../wrappers/composition/manifest'
import type { InstalledPackage, PackageSourceMetadata, StagedPackage } from './installer-types'
import {
  assertSafePackagePath,
  compareText,
  errorCode,
  isRecord,
  normalizeSourceMetadata
} from './installer-utils'
import {
  readPackageManifest,
  type PackageDependency,
  type WrapperPackageManifest
} from './manifest'

const TREE_REGISTRY_VERSION = 1
const PACKAGE_METADATA = new Set(['files.json', 'phi-package.yaml'])

export interface WrapperTreePackageState {
  version: string
  title: string
  summary: string
  manifest: WrapperPackageManifest
  source: PackageSourceMetadata
  paths: string[]
}

export interface WrapperTreeRegistry {
  version: 1
  packages: Record<string, WrapperTreePackageState>
}

export type WrapperTreeState = WrapperTreeRegistry

export function getWrapperTreeDir(agentDir = getPhiAgentDir()): string {
  return join(agentDir, 'wrappers', 'tree')
}

export function getWrapperTreeOwnershipPath(agentDir = getPhiAgentDir()): string {
  return join(agentDir, 'wrappers', 'tree.json')
}

export function getWrapperCustomDir(agentDir = getPhiAgentDir()): string {
  return join(agentDir, 'wrappers', 'custom')
}

// Transitional aliases for callers moved from the former wrapper-pack paths.
export const wrapperTreeDir = getWrapperTreeDir
export const wrapperTreeRegistryPath = getWrapperTreeOwnershipPath

export function readWrapperTreeState(agentDir = getPhiAgentDir()): WrapperTreeRegistry {
  const path = getWrapperTreeOwnershipPath(agentDir)
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return emptyRegistry()
    if (error instanceof SyntaxError) throw new Error(`invalid wrapper tree registry JSON: ${path}`)
    throw error
  }
  if (!isRecord(value) || value.version !== TREE_REGISTRY_VERSION || !isRecord(value.packages)) {
    throw new Error(`invalid wrapper tree registry: ${path}`)
  }

  const packages: Record<string, WrapperTreePackageState> = {}
  const owners = new Map<string, string>()
  for (const [id, candidate] of Object.entries(value.packages).sort(([left], [right]) =>
    compareText(left, right)
  )) {
    const state = parsePackageState(id, candidate, path)
    for (const ownedPath of state.paths) {
      const existing = owners.get(ownedPath)
      if (existing !== undefined) throwOwnershipConflict(ownedPath, existing, ownedPath, id)
      owners.set(ownedPath, id)
    }
    packages[id] = state
  }
  assertNoNestedOwnership(owners)
  return { version: TREE_REGISTRY_VERSION, packages }
}

/** A path owned inside another owned path conflicts; checks each path's ancestors, not every pair. */
function assertNoNestedOwnership(owners: ReadonlyMap<string, string>): void {
  for (const [ownedPath, id] of owners) {
    let slash = ownedPath.lastIndexOf('/')
    while (slash > 0) {
      const ancestor = ownedPath.slice(0, slash)
      const ancestorOwner = owners.get(ancestor)
      if (ancestorOwner !== undefined)
        throwOwnershipConflict(ancestor, ancestorOwner, ownedPath, id)
      slash = ancestor.lastIndexOf('/')
    }
  }
}

function throwOwnershipConflict(
  firstPath: string,
  firstOwner: string,
  secondPath: string,
  secondOwner: string
): never {
  throw new Error(
    `invalid wrapper tree registry: paths ${firstPath} and ${secondPath} conflict between ${firstOwner} and ${secondOwner}`
  )
}

export const readWrapperTreeRegistry = readWrapperTreeState

export function listInstalledWrapperPackages(agentDir = getPhiAgentDir()): InstalledPackage[] {
  const treeDir = getWrapperTreeDir(agentDir)
  return Object.entries(readWrapperTreeState(agentDir).packages)
    .sort(([left], [right]) => compareText(left, right))
    .map(([id, state]) => ({
      id,
      type: 'wrapper',
      version: state.version,
      title: state.title,
      summary: state.summary,
      dir: treeDir,
      installedAt: state.source.installedAt,
      installedBy: state.source.installedBy,
      registry: state.source.registry,
      sha256: state.source.sha256,
      trust: state.source.trust
    }))
}

export function installedWrapperDependencies(
  id: string,
  agentDir = getPhiAgentDir()
): PackageDependency[] {
  return readWrapperTreeState(agentDir).packages[id]?.manifest.dependsOn ?? []
}

export function installStagedWrapperPackage(
  staged: StagedPackage,
  agentDir = getPhiAgentDir()
): void {
  installStagedWrapperPackages([staged], agentDir)
}

export function installStagedWrapperPackages(
  stages: StagedPackage[],
  agentDir = getPhiAgentDir(),
  retirePackageIds: readonly string[] = []
): void {
  if (stages.length === 0 && retirePackageIds.length === 0) return
  let registry = readWrapperTreeState(agentDir)
  const candidate = createCandidateTree(agentDir)
  const installedPaths = new Map<string, string[]>()
  const retired = new Set(retirePackageIds)
  try {
    for (const id of retired) {
      const previous = registry.packages[id]
      if (!previous) throw new Error(`wrapper package ${id} is not installed`)
      removeOwnedFiles(candidate, previous.paths)
      const packages = { ...registry.packages }
      delete packages[id]
      registry = { version: TREE_REGISTRY_VERSION, packages }
    }
    for (const staged of stages) {
      if (staged.entry.type !== 'wrapper') {
        throw new Error(
          `expected a wrapper package, received ${staged.entry.type}:${staged.entry.id}`
        )
      }
      const manifest = readPackageManifest(staged.dir)
      if (manifest.type !== 'wrapper') {
        throw new Error(`expected a wrapper package manifest, received ${manifest.type}`)
      }
      const paths = listPackageTreeFiles(staged.dir)
      const adapterCount = paths.filter((path) => path.endsWith('/wrapper/wrapper.yaml')).length
      if (adapterCount > 1) {
        throw new Error(
          `软件包 ${staged.entry.id} 包含 ${adapterCount} 个 wrapper；请更新目录后逐个安装。`
        )
      }
      assertNoOwnershipConflicts(registry, staged.entry.id, paths, candidate)
      const previous = registry.packages[staged.entry.id]
      if (previous) removeOwnedFiles(candidate, previous.paths)
      copyPackageFiles(staged.dir, candidate, paths)
      registry = {
        version: TREE_REGISTRY_VERSION,
        packages: {
          ...registry.packages,
          [staged.entry.id]: {
            version: staged.entry.version,
            title: staged.entry.title,
            summary: staged.entry.summary,
            manifest,
            source: staged.source,
            paths
          }
        }
      }
      installedPaths.set(staged.entry.id, paths)
    }
    for (const [id, state] of Object.entries(registry.packages)) {
      const missing = (state.manifest.dependsOn ?? []).find(
        (dependency) =>
          dependency.type === 'wrapper' &&
          retired.has(dependency.id) &&
          !registry.packages[dependency.id]
      )
      if (missing) {
        throw new Error(`wrapper package ${id} still depends on retired package ${missing.id}`)
      }
    }
    // Validate against the completed candidate so dependency packages may
    // appear later in the batch without bypassing ownership checks.
    for (const [packageId, paths] of installedPaths) {
      validatePackageIncludes(candidate, packageId, paths, registry)
    }
    validateWrapperIds(candidate, agentDir)
    replaceTreeAndRegistry(candidate, registry, agentDir)
  } catch (error) {
    rmSync(candidate, { recursive: true, force: true })
    throw error
  }
}

export function removeInstalledWrapperPackage(id: string, agentDir = getPhiAgentDir()): void {
  const registry = readWrapperTreeState(agentDir)
  const current = registry.packages[id]
  if (!current) throw new Error(`wrapper package ${id} is not installed`)
  const candidate = createCandidateTree(agentDir)
  try {
    removeOwnedFiles(candidate, current.paths)
    const packages = { ...registry.packages }
    delete packages[id]
    replaceTreeAndRegistry(candidate, { version: TREE_REGISTRY_VERSION, packages }, agentDir)
  } catch (error) {
    rmSync(candidate, { recursive: true, force: true })
    throw error
  }
}

export function promoteInstalledWrapperPackage(
  id: string,
  version: string,
  agentDir = getPhiAgentDir()
): void {
  const registry = readWrapperTreeState(agentDir)
  const current = registry.packages[id]
  if (!current || current.version !== version || current.source.installedBy === 'user') return
  writeWrapperTreeRegistry(
    {
      version: TREE_REGISTRY_VERSION,
      packages: {
        ...registry.packages,
        [id]: {
          ...current,
          source: { ...current.source, installedBy: 'user' }
        }
      }
    },
    agentDir
  )
}

function emptyRegistry(): WrapperTreeRegistry {
  return { version: TREE_REGISTRY_VERSION, packages: {} }
}

function listPackageTreeFiles(root: string): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort(compareText)) {
      const path = join(dir, name)
      const stat = lstatSync(path)
      const relativePath = relative(root, path).split('\\').join('/')
      if (stat.isDirectory()) walk(path)
      else if (stat.isFile() && !PACKAGE_METADATA.has(relativePath)) files.push(relativePath)
      else if (!stat.isFile())
        throw new Error(`wrapper package contains a non-file: ${relativePath}`)
    }
  }
  walk(root)
  return files.sort(compareText)
}

function assertNoOwnershipConflicts(
  registry: WrapperTreeRegistry,
  packageId: string,
  paths: string[],
  tree: string
): void {
  const owned = new Map<string, string>()
  // Paths owned by other packages, and every directory above them, so each new path is
  // checked against its own ancestors and descendants by lookup rather than every pair.
  const otherOwned = new Map<string, string>()
  const otherOwnedDirs = new Map<string, string>()
  for (const [owner, state] of Object.entries(registry.packages)) {
    for (const path of state.paths) {
      owned.set(path, owner)
      if (owner === packageId) continue
      otherOwned.set(path, owner)
      for (let slash = path.lastIndexOf('/'); slash > 0; slash = path.lastIndexOf('/', slash - 1)) {
        const dir = path.slice(0, slash)
        if (otherOwnedDirs.has(dir)) break
        otherOwnedDirs.set(dir, owner)
      }
    }
  }
  const ownedAncestor = (path: string): string | undefined => {
    for (let slash = path.lastIndexOf('/'); slash > 0; slash = path.lastIndexOf('/', slash - 1)) {
      const owner = otherOwned.get(path.slice(0, slash))
      if (owner !== undefined) return owner
    }
    return undefined
  }
  for (const path of paths) {
    const conflictingOwner = otherOwned.get(path) ?? otherOwnedDirs.get(path) ?? ownedAncestor(path)
    if (conflictingOwner !== undefined) {
      throw new Error(`wrapper path ${path} 已由软件包 ${conflictingOwner} 拥有`)
    }
    const target = join(tree, ...path.split('/'))
    if (existsSync(target) && owned.get(path) !== packageId) {
      throw new Error(`wrapper path ${path} 已存在但不受软件包所有权管理`)
    }
    assertDirectoryAncestors(tree, path, owned, packageId)
  }
}

function assertDirectoryAncestors(
  tree: string,
  path: string,
  owned: Map<string, string>,
  packageId: string
): void {
  const parts = path.split('/')
  for (let index = 1; index < parts.length; index += 1) {
    const relativePath = parts.slice(0, index).join('/')
    const candidate = join(tree, ...parts.slice(0, index))
    if (!existsSync(candidate) || lstatSync(candidate).isDirectory()) continue
    const owner = owned.get(relativePath)
    if (owner && owner !== packageId) {
      throw new Error(`wrapper path ${path} 与软件包 ${owner} 拥有的 ${relativePath} 冲突`)
    }
    if (owner === packageId) continue
    throw new Error(`wrapper path ${path} 的父路径 ${relativePath} 不受软件包所有权管理`)
  }
}

function createCandidateTree(agentDir: string): string {
  const wrappersDir = join(agentDir, 'wrappers')
  mkdirSync(wrappersDir, { recursive: true })
  const candidate = join(wrappersDir, `.tree-next-${randomUUID()}`)
  const tree = getWrapperTreeDir(agentDir)
  if (existsSync(tree)) cpSync(tree, candidate, { recursive: true, errorOnExist: true })
  else mkdirSync(candidate, { recursive: false })
  return candidate
}

function removeOwnedFiles(tree: string, paths: string[]): void {
  const parents = new Set<string>()
  for (const path of paths) {
    const target = join(tree, ...path.split('/'))
    if (existsSync(target)) {
      const stat = lstatSync(target)
      if (stat.isDirectory()) {
        throw new Error(`owned wrapper path unexpectedly became a directory: ${path}`)
      }
      unlinkSync(target)
    }
    let parent = dirname(target)
    while (parent !== tree && parent.startsWith(`${tree}/`)) {
      parents.add(parent)
      parent = dirname(parent)
    }
  }
  for (const parent of [...parents].sort((left, right) => right.length - left.length)) {
    if (existsSync(parent) && readdirSync(parent).length === 0) rmdirSync(parent)
  }
}

function copyPackageFiles(source: string, tree: string, paths: string[]): void {
  for (const path of paths) {
    const target = join(tree, ...path.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(source, ...path.split('/')), target)
  }
}

function validatePackageIncludes(
  tree: string,
  packageId: string,
  paths: string[],
  registry: WrapperTreeRegistry
): void {
  const packagePaths = new Set(paths)
  const dependencies = new Set(
    (registry.packages[packageId]?.manifest.dependsOn ?? []).map(
      (dependency) => `${dependency.type}:${dependency.id}`
    )
  )
  const owners = new Map<string, string>()
  for (const [owner, state] of Object.entries(registry.packages)) {
    for (const path of state.paths) owners.set(path, owner)
  }

  for (const path of paths.filter((candidate) => candidate.endsWith('.nf'))) {
    const entry = join(tree, ...path.split('/'))
    for (const reference of collectIncludeReferences(entry)) {
      const fromPath = relative(tree, reference.fromFile).split('\\').join('/')
      if (!packagePaths.has(fromPath) || reference.target.startsWith('plugin/')) continue
      if (!reference.resolvedFile) {
        throw new Error(
          `wrapper package ${packageId} include '${reference.target}' from ${fromPath} cannot be resolved`
        )
      }
      const targetPath = relative(tree, reference.resolvedFile).split('\\').join('/')
      if (!targetPath || targetPath.startsWith('../')) {
        throw new Error(
          `wrapper package ${packageId} include '${reference.target}' escapes the wrapper tree`
        )
      }
      const owner = owners.get(targetPath)
      if (!owner) {
        throw new Error(
          `wrapper package ${packageId} include '${reference.target}' is not provided by an installed package`
        )
      }
      if (owner !== packageId && !dependencies.has(`wrapper:${owner}`)) {
        throw new Error(
          `wrapper package ${packageId} include '${reference.target}' is owned by ${owner} but is missing from dependsOn`
        )
      }
    }
  }
}

function findCompositionManifests(root: string): string[] {
  if (!existsSync(root)) return []
  const manifests: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort(compareText)) {
      const path = join(dir, name)
      const stat = lstatSync(path)
      if (stat.isDirectory()) walk(path)
      else if (stat.isFile() && name === 'wrapper.yaml' && basename(dirname(path)) === 'wrapper') {
        manifests.push(path)
      }
    }
  }
  walk(root)
  return manifests
}

function validateWrapperIds(tree: string, agentDir: string): void {
  const ids = new Map<string, string>()
  const register = (path: string, strict: boolean): void => {
    let id: string
    try {
      id = parseWrapperCompositionManifest(readFileSync(path, 'utf8')).id
    } catch (error) {
      if (!strict) return
      throw new Error(
        `invalid installed wrapper adapter ${path}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    const previous = ids.get(id)
    if (previous) throw new Error(`wrapper id '${id}' is declared by both ${previous} and ${path}`)
    ids.set(id, path)
  }
  for (const path of findCompositionManifests(tree)) register(path, true)
  for (const path of findCompositionManifests(getWrapperCustomDir(agentDir))) register(path, false)
}

function replaceTreeAndRegistry(
  candidate: string,
  registry: WrapperTreeRegistry,
  agentDir: string
): void {
  const wrappersDir = join(agentDir, 'wrappers')
  const tree = getWrapperTreeDir(agentDir)
  const token = randomUUID()
  const backup = join(wrappersDir, `.tree-old-${token}`)
  const registryTarget = getWrapperTreeOwnershipPath(agentDir)
  const registryTemporary = join(wrappersDir, `.tree-${token}.json.tmp`)
  writeFileSync(registryTemporary, serializeRegistry(registry), { encoding: 'utf8', flag: 'wx' })
  const hadTree = existsSync(tree)
  try {
    if (hadTree) renameSync(tree, backup)
    try {
      renameSync(candidate, tree)
      try {
        renameSync(registryTemporary, registryTarget)
      } catch (error) {
        renameSync(tree, candidate)
        if (hadTree) renameSync(backup, tree)
        throw error
      }
    } catch (error) {
      if (hadTree && !existsSync(tree) && existsSync(backup)) renameSync(backup, tree)
      throw error
    }
  } finally {
    rmSync(registryTemporary, { force: true })
  }
  rmSync(backup, { recursive: true, force: true })
}

function writeWrapperTreeRegistry(registry: WrapperTreeRegistry, agentDir: string): void {
  const target = getWrapperTreeOwnershipPath(agentDir)
  const parent = dirname(target)
  mkdirSync(parent, { recursive: true })
  const temporary = join(parent, `.tree-${randomUUID()}.json.tmp`)
  writeFileSync(temporary, serializeRegistry(registry), { encoding: 'utf8', flag: 'wx' })
  try {
    renameSync(temporary, target)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

function serializeRegistry(registry: WrapperTreeRegistry): string {
  const packages = Object.fromEntries(
    Object.entries(registry.packages)
      .sort(([left], [right]) => compareText(left, right))
      .map(([id, state]) => [id, { ...state, paths: [...state.paths].sort(compareText) }])
  )
  return `${JSON.stringify({ version: TREE_REGISTRY_VERSION, packages }, null, 2)}\n`
}

function parsePackageState(
  id: string,
  value: unknown,
  registryPath: string
): WrapperTreePackageState {
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(id) || !isRecord(value)) {
    throw new Error(`invalid wrapper tree package entry '${id}' in ${registryPath}`)
  }
  const manifest = value.manifest
  const source = normalizeSourceMetadata(value.source)
  if (
    typeof value.version !== 'string' ||
    !semver.valid(value.version) ||
    typeof value.title !== 'string' ||
    typeof value.summary !== 'string' ||
    !isRecord(manifest) ||
    manifest.type !== 'wrapper' ||
    manifest.id !== id ||
    manifest.version !== value.version ||
    !isWrapperSource(source, id, value.version) ||
    !Array.isArray(value.paths)
  ) {
    throw new Error(`invalid wrapper tree package entry '${id}' in ${registryPath}`)
  }
  const paths = value.paths.map((path) => {
    if (typeof path !== 'string') {
      throw new Error(`invalid wrapper tree package path for '${id}' in ${registryPath}`)
    }
    assertSafePackagePath(path)
    if (PACKAGE_METADATA.has(path)) {
      throw new Error(`wrapper tree package '${id}' cannot own package metadata path ${path}`)
    }
    return path
  })
  const sorted = [...paths].sort(compareText)
  if (new Set(paths).size !== paths.length || paths.some((path, index) => path !== sorted[index])) {
    throw new Error(`wrapper tree package '${id}' paths must be unique and sorted`)
  }
  return {
    version: value.version,
    title: value.title,
    summary: value.summary,
    manifest: manifest as unknown as WrapperPackageManifest,
    source,
    paths
  }
}

function isWrapperSource(
  value: PackageSourceMetadata | undefined,
  id: string,
  version: string
): value is PackageSourceMetadata {
  return (
    value !== undefined &&
    value.id === id &&
    value.type === 'wrapper' &&
    value.version === version &&
    Number.isFinite(Date.parse(value.installedAt)) &&
    (value.trust === 'builtin' || value.trust === 'official' || value.trust === 'imported')
  )
}
