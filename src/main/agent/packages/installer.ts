import { createHash, randomUUID } from 'node:crypto'
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
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

import semver from 'semver'
import { parse as parseYaml } from 'yaml'

import { parseSkillFile } from '../content/skill'
import { describeEnvironment } from '../content/environment-refs'
import { CORE_TOOLS } from '../core-tools'
import {
  addReferrer,
  collectGarbage,
  computeEnvId,
  currentPlatform,
  getRuntimeRoot,
  lockSha256,
  readEnvironmentIndex,
  removeReferrer,
  updateEnvironmentEntry,
  type PhiPlatform
} from '../envs'
import { getPhiAgentDir } from '../runtime-paths'
import {
  installPlugin,
  listInstalledPlugins,
  uninstallPlugin,
  upgradePlugin,
  type PluginBuildOptions,
  type PluginEnvironmentBuilder,
  type PluginNamespace
} from '../plugins/loader'
import { parseTarGz } from './archive'
import {
  readPackageManifest,
  validatePackage,
  type PackageDependency,
  type PackageManifest,
  type PackageRequirements,
  type PackageType
} from './manifest'
import {
  listActiveSkillPackages,
  readSkillsRegistry,
  skillPackagesDir,
  skillVersionDir,
  writeSkillsRegistry
} from './store'

export interface RegistryPackageEntry {
  id: string
  type: PackageType
  version: string
  title: string
  summary: string
  archive: string
  sha256: string
  size: number
  minAppVersion?: string
  dependsOn: PackageDependency[]
  requires?: PackageRequirements
  category?: string
  preview?: string
}

export interface LocalRegistry {
  id: string
  dir: string
  schemaVersion: 1
  generatedAt: string
  packages: RegistryPackageEntry[]
}

export interface PackageRequest {
  type: PackageType
  id: string
  version?: string
}

export interface PlannedPackage extends RegistryPackageEntry {
  installedBy: 'user' | 'dependency'
}

export interface InstallPlan {
  registry: LocalRegistry
  root: { type: PackageType; id: string; version: string }
  packages: PlannedPackage[]
  totalSize: number
  environments: string[]
  agentDir: string
}

export interface PackageSourceMetadata {
  registry: string
  id: string
  type: PackageType
  version: string
  sha256: string
  installedAt: string
  installedBy: 'user' | 'dependency'
}

export interface InstalledPackage {
  id: string
  type: PackageType
  version: string
  title: string
  summary: string
  dir: string
  installedAt: string
  installedBy: 'user' | 'dependency'
  registry: string
  sha256: string
  enabled?: boolean
}

export interface InstallerOptions {
  agentDir?: string
  appVersion?: string
  runtimeRoot?: string
  platform?: PhiPlatform
  names?: PluginNamespace
  build?: PluginEnvironmentBuilder
  garbageCollect?: typeof collectGarbage
  now?: () => Date
}

interface StagedPackage {
  entry: PlannedPackage
  dir: string
  source: PackageSourceMetadata
}

interface FilesList {
  version: 1
  files: Array<{ path: string; sha256: string; size: number }>
}

const DAY_MS = 24 * 60 * 60 * 1000
export function readRegistry(dir: string): LocalRegistry {
  const registryDir = resolve(dir)
  let value: unknown
  try {
    value = JSON.parse(readFileSync(join(registryDir, 'index.json'), 'utf8')) as unknown
  } catch (error) {
    throw new Error(`无法读取本地软件包注册表: ${errorMessage(error)}`)
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.packages)) {
    throw new Error('本地软件包注册表 index.json 格式无效')
  }
  if (typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt))) {
    throw new Error('本地软件包注册表 generatedAt 无效')
  }
  const packages = value.packages.map((entry, index) => parseRegistryEntry(entry, index))
  const identities = new Set<string>()
  for (const entry of packages) {
    const key = packageVersionKey(entry)
    if (identities.has(key)) throw new Error(`注册表包含重复软件包: ${key}`)
    identities.add(key)
  }
  return {
    id: registryDir,
    dir: registryDir,
    schemaVersion: 1,
    generatedAt: value.generatedAt,
    packages
  }
}

export function planInstall(
  registry: LocalRegistry,
  request: PackageRequest,
  options: Pick<InstallerOptions, 'agentDir' | 'appVersion'> = {}
): InstallPlan {
  validateRequest(request)
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const installed = packagesAvailableForPlanning(agentDir)
  const rootRange = request.version ?? '*'
  const roots = [{ key: packageKey(request), range: rootRange }]
  const assignments = solveDependencies(registry, roots, installed)
  const rootEntry = assignments.get(packageKey(request))
  if (!rootEntry) throw new Error(`注册表中找不到软件包 ${request.type}:${request.id}`)
  const installedRoot = installed.find(
    (item) => item.type === rootEntry.type && item.id === rootEntry.id
  )
  if (installedRoot && semver.gt(installedRoot.version, rootEntry.version)) {
    throw new Error(
      `拒绝降级 ${rootEntry.type}:${rootEntry.id}：已安装 ${installedRoot.version}，请求 ${rootEntry.version}`
    )
  }

  const appVersion = options.appVersion ?? readAppVersion()
  if (!semver.valid(appVersion)) throw new Error(`应用版本无效: ${appVersion}`)
  for (const entry of assignments.values()) checkCompatibility(entry, appVersion)
  const ordered = dependencyOrder(assignments, rootEntry)
  const planned = ordered
    .filter((entry) => !isInstalledVersion(installed, entry))
    .map<PlannedPackage>((entry) => ({
      ...entry,
      installedBy:
        entry.type === rootEntry.type && entry.id === rootEntry.id ? 'user' : 'dependency'
    }))
  return {
    registry,
    root: { type: rootEntry.type, id: rootEntry.id, version: rootEntry.version },
    packages: planned,
    totalSize: planned.reduce((sum, entry) => sum + entry.size, 0),
    environments: declaredEnvironments(registry, planned),
    agentDir
  }
}

export async function installPackages(
  plan: InstallPlan,
  options: InstallerOptions = {}
): Promise<InstalledPackage[]> {
  const agentDir = options.agentDir ?? plan.agentDir ?? getPhiAgentDir()
  cleanupStalePackageStaging({ agentDir, now: options.now })
  const stages: StagedPackage[] = []
  const installedNow: Array<{ type: PackageType; id: string }> = []
  try {
    for (const entry of plan.packages) {
      stages.push(stagePackage(plan.registry, entry, agentDir, options.now))
    }
    for (const staged of stages) {
      await commitStagedPackage(staged, {
        ...options,
        agentDir
      })
      installedNow.push({ type: staged.entry.type, id: staged.entry.id })
    }
    promoteRootToUser(plan.root, agentDir)
    return listInstalledPackages({ agentDir })
  } catch (error) {
    for (const item of installedNow.reverse()) {
      try {
        removeInstalledPackage(item.type, item.id, { ...options, agentDir })
      } catch {
        // Preserve the original installation failure.
      }
    }
    throw error
  } finally {
    for (const staged of stages) rmSync(staged.dir, { recursive: true, force: true })
  }
}

export async function upgradePackage(
  registry: LocalRegistry,
  request: PackageRequest,
  options: InstallerOptions = {}
): Promise<InstalledPackage[]> {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const current = listInstalledPackages({ agentDir }).find(
    (item) => item.type === request.type && item.id === request.id
  )
  if (!current) throw new Error(`软件包 ${request.type}:${request.id} 尚未安装，无法升级`)
  const plan = planInstall(registry, request, {
    agentDir,
    ...(options.appVersion ? { appVersion: options.appVersion } : {})
  })
  if (!semver.gt(plan.root.version, current.version)) {
    throw new Error(`升级版本必须高于 ${current.version}，收到 ${plan.root.version}`)
  }
  return installPackages(plan, { ...options, agentDir })
}

export function uninstallPackage(
  type: PackageType,
  id: string,
  options: InstallerOptions = {}
): InstalledPackage[] {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const installed = listInstalledPackages({ agentDir })
  const target = installed.find((item) => item.type === type && item.id === id)
  if (!target) throw new Error(`软件包 ${type}:${id} 尚未安装`)
  const dependent = dependentOn(packagesAvailableForPlanning(agentDir), target)
  if (dependent) {
    throw new Error(`无法卸载 ${type}:${id}；软件包 ${dependent.type}:${dependent.id} 仍依赖它`)
  }
  removeInstalledPackage(type, id, { ...options, agentDir })
  collectOrphanDependencies({ ...options, agentDir })
  return listInstalledPackages({ agentDir })
}

export function listInstalledPackages(
  options: Pick<InstallerOptions, 'agentDir'> = {}
): InstalledPackage[] {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const installed: InstalledPackage[] = []
  for (const entry of listActiveSkillPackages(agentDir)) {
    const item = installedPackageFromDir(entry.dir, 'skill')
    if (item && item.id === entry.id && item.version === entry.version) installed.push(item)
  }
  for (const plugin of listInstalledPlugins({ agentDir })) {
    const item = installedPackageFromDir(plugin.dir, 'plugin')
    if (item && item.id === plugin.id && item.version === plugin.version) {
      installed.push({ ...item, enabled: plugin.enabled })
    }
  }
  return installed.sort(
    (left, right) =>
      left.type.localeCompare(right.type) ||
      left.id.localeCompare(right.id) ||
      semver.compare(left.version, right.version)
  )
}

export function cleanupStalePackageStaging(
  options: {
    agentDir?: string
    now?: () => Date
  } = {}
): string[] {
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const stagingRoot = join(agentDir, '.staging')
  let names: string[]
  try {
    names = readdirSync(stagingRoot)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  }
  const cutoff = (options.now?.() ?? new Date()).getTime() - DAY_MS
  const removed: string[] = []
  for (const name of names) {
    const path = join(stagingRoot, name)
    if (lstatSync(path).mtimeMs >= cutoff) continue
    rmSync(path, { recursive: true, force: true })
    removed.push(path)
  }
  return removed.sort()
}

function solveDependencies(
  registry: LocalRegistry,
  roots: Array<{ key: string; range: string }>,
  installed: InstalledPackage[]
): Map<string, RegistryPackageEntry> {
  const rootKeys = new Set(roots.map((root) => root.key))

  function search(
    assignments: Map<string, RegistryPackageEntry>
  ): Map<string, RegistryPackageEntry> | undefined {
    const requirements = new Map<string, string[]>()
    for (const root of roots) addRequirement(requirements, root.key, root.range)
    for (const entry of assignments.values()) {
      for (const dependency of entry.dependsOn) {
        addRequirement(requirements, packageKey(dependency), dependency.version)
      }
    }

    for (const [key, entry] of assignments) {
      const ranges = requirements.get(key)
      if (!ranges || !ranges.every((range) => semver.satisfies(entry.version, range))) {
        return undefined
      }
    }

    const unresolved = [...requirements.entries()].find(([key, ranges]) => {
      if (assignments.has(key)) return false
      if (rootKeys.has(key)) return true
      const item = installed.find((candidate) => packageKey(candidate) === key)
      return !item || !ranges.every((range) => semver.satisfies(item.version, range))
    })
    if (!unresolved) return assignments

    const [key, ranges] = unresolved
    if (!rootKeys.has(key) && installed.some((candidate) => packageKey(candidate) === key)) {
      return undefined
    }
    const candidates = registry.packages
      .filter(
        (entry) =>
          packageKey(entry) === key &&
          ranges.every((range) => semver.satisfies(entry.version, range))
      )
      .sort((left, right) => semver.rcompare(left.version, right.version))
    for (const candidate of candidates) {
      const next = new Map(assignments)
      next.set(key, candidate)
      const solution = search(next)
      if (solution) return solution
    }
    return undefined
  }

  const solution = search(new Map())
  if (!solution) {
    const requested = roots.map((root) => `${root.key}@${root.range}`).join(', ')
    throw new Error(`无法解析软件包依赖或版本冲突: ${requested}`)
  }
  return solution
}

function dependencyOrder(
  assignments: Map<string, RegistryPackageEntry>,
  root: RegistryPackageEntry
): RegistryPackageEntry[] {
  const ordered: RegistryPackageEntry[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const visit = (entry: RegistryPackageEntry): void => {
    const key = packageKey(entry)
    if (visited.has(key)) return
    if (visiting.has(key)) throw new Error(`检测到循环依赖: ${key}`)
    visiting.add(key)
    for (const dependency of entry.dependsOn) {
      const selected = assignments.get(packageKey(dependency))
      if (selected) visit(selected)
    }
    visiting.delete(key)
    visited.add(key)
    ordered.push(entry)
  }
  visit(root)
  return ordered
}

function checkCompatibility(entry: RegistryPackageEntry, appVersion: string): void {
  if (entry.minAppVersion && semver.lt(appVersion, entry.minAppVersion)) {
    throw new Error(
      `软件包 ${entry.type}:${entry.id}@${entry.version} 需要应用版本 ${entry.minAppVersion}，当前为 ${appVersion}`
    )
  }
  const missing = (entry.requires?.coreTools ?? []).filter((tool) => !CORE_TOOLS.has(tool))
  if (missing.length > 0) {
    throw new Error(`软件包 ${entry.type}:${entry.id} 缺少核心工具: ${missing.join(', ')}`)
  }
}

function stagePackage(
  registry: LocalRegistry,
  entry: PlannedPackage,
  agentDir: string,
  now?: () => Date
): StagedPackage {
  const archivePath = localArchivePath(registry, entry.archive)
  const archive = readFileSync(archivePath)
  if (archive.length !== entry.size) {
    throw new Error(`软件包 ${entry.id} 归档大小不匹配: 期望 ${entry.size}，实际 ${archive.length}`)
  }
  const digest = sha256(archive)
  if (digest !== entry.sha256) {
    throw new Error(`软件包 ${entry.id} 归档 SHA-256 哈希不匹配`)
  }
  const entries = parseTarGz(archive)
  const seen = new Set<string>()
  for (const item of entries) {
    if (item.type === 'directory') item.path = item.path.replace(/\/+$/, '')
    assertSafePackagePath(item.path)
    if (seen.has(item.path)) throw new Error(`归档包含重复路径: ${item.path}`)
    seen.add(item.path)
    if (item.type === 'link') throw new Error(`归档不允许链接条目: ${item.path}`)
    if (item.type !== 'file' && item.type !== 'directory') {
      throw new Error(`归档包含不支持的条目类型: ${item.path}`)
    }
  }

  const stagingRoot = join(agentDir, '.staging')
  mkdirSync(stagingRoot, { recursive: true })
  const dir = join(stagingRoot, randomUUID())
  mkdirSync(dir, { recursive: false })
  try {
    for (const item of entries) {
      const target = join(dir, ...item.path.split('/'))
      if (item.type === 'directory') mkdirSync(target, { recursive: true })
      else {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, item.data, { flag: 'wx' })
      }
    }
    verifyStagedPackage(dir, entry)
    const source: PackageSourceMetadata = {
      registry: registry.id,
      id: entry.id,
      type: entry.type,
      version: entry.version,
      sha256: entry.sha256,
      installedAt: (now?.() ?? new Date()).toISOString(),
      installedBy: entry.installedBy
    }
    return { entry, dir, source }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

function verifyStagedPackage(dir: string, entry: RegistryPackageEntry): void {
  const filesList = readFilesList(join(dir, 'files.json'))
  const listed = new Map(filesList.files.map((file) => [file.path, file]))
  const actual = listRegularFiles(dir)
  for (const path of actual) {
    if (path === 'files.json') continue
    const expected = listed.get(path)
    if (!expected) throw new Error(`文件 ${path} 未列入 files.json`)
    const data = readFileSync(join(dir, ...path.split('/')))
    if (data.length !== expected.size) throw new Error(`文件 ${path} 大小与 files.json 不匹配`)
    if (sha256(data) !== expected.sha256) throw new Error(`文件 ${path} 哈希与 files.json 不匹配`)
  }
  for (const file of filesList.files) {
    const path = join(dir, ...file.path.split('/'))
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      throw new Error(`files.json 列出的文件不存在: ${file.path}`)
    }
  }

  const manifest = readPackageManifest(dir)
  if (
    manifest.id !== entry.id ||
    manifest.type !== entry.type ||
    manifest.version !== entry.version
  ) {
    throw new Error(`软件包清单与注册表不匹配: 期望 ${entry.type}:${entry.id}@${entry.version}`)
  }
  const validation = validatePackage(dir)
  if (!validation.ok) {
    throw new Error(
      `软件包类型验证失败: ${validation.errors
        .map((problem) => `${problem.path}: ${problem.message}`)
        .join('; ')}`
    )
  }
}

async function commitStagedPackage(
  staged: StagedPackage,
  options: InstallerOptions & { agentDir: string }
): Promise<void> {
  if (staged.entry.type === 'plugin') {
    const current = listInstalledPlugins({ agentDir: options.agentDir }).find(
      (plugin) => plugin.id === staged.entry.id
    )
    const common = {
      agentDir: options.agentDir,
      runtimeRoot: options.runtimeRoot ?? getRuntimeRoot(options.agentDir),
      names: options.names,
      now: options.now,
      source: 'local' as const,
      sourceMetadata: `${JSON.stringify(staged.source, null, 2)}\n`
    }
    const result = current
      ? await upgradePlugin(staged.dir, {
          ...common,
          ...(options.build ? { build: options.build } : {}),
          ...(options.garbageCollect ? { garbageCollect: options.garbageCollect } : {})
        })
      : installPlugin(staged.dir, common)
    if (!result.ok || !result.plugin) {
      throw new Error(
        `插件安装失败: ${result.errors.map((problem) => problem.message).join('; ') || '未知错误'}`
      )
    }
    return
  }

  const target = skillVersionDir(staged.entry.id, staged.entry.version, options.agentDir)
  if (existsSync(target)) throw new Error(`技能软件包目标已存在: ${target}`)
  const registry = readSkillsRegistry(options.agentDir)
  const previous = registry.skills[staged.entry.id]
  const runtimeRoot = options.runtimeRoot ?? getRuntimeRoot(options.agentDir)
  const previousEnvironment = previous
    ? skillEnvironment(
        skillVersionDir(staged.entry.id, previous.version, options.agentDir),
        options.agentDir,
        options.platform
      )
    : undefined
  const nextEnvironment = skillEnvironment(staged.dir, options.agentDir, options.platform)
  mkdirSync(dirname(target), { recursive: true })
  writeSourceMetadata(staged.dir, staged.source)
  renameSync(staged.dir, target)
  try {
    if (nextEnvironment) addSkillEnvironmentReference(runtimeRoot, staged.entry.id, nextEnvironment)
    writeSkillsRegistry(
      {
        version: 1,
        skills: {
          ...registry.skills,
          [staged.entry.id]: {
            version: staged.entry.version,
            installedAt: staged.source.installedAt
          }
        }
      },
      options.agentDir
    )
  } catch (error) {
    if (nextEnvironment && previousEnvironment?.envId !== nextEnvironment.envId) {
      removeReferrer(runtimeRoot, nextEnvironment.envId, `skill:${staged.entry.id}`)
    }
    rmSync(target, { recursive: true, force: true })
    throw error
  }
  if (previousEnvironment && previousEnvironment.envId !== nextEnvironment?.envId) {
    removeReferrer(runtimeRoot, previousEnvironment.envId, `skill:${staged.entry.id}`)
  }
  if (previous && previous.version !== staged.entry.version) {
    rmSync(skillVersionDir(staged.entry.id, previous.version, options.agentDir), {
      recursive: true,
      force: true
    })
  }
  if (previousEnvironment && previousEnvironment.envId !== nextEnvironment?.envId) {
    ;(options.garbageCollect ?? collectGarbage)(runtimeRoot)
  }
}

function readFilesList(path: string): FilesList {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    throw new Error(`无法读取 files.json: ${errorMessage(error)}`)
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.files)) {
    throw new Error('files.json 格式无效')
  }
  const seen = new Set<string>()
  const files = value.files.map((item, index) => {
    if (
      !isRecord(item) ||
      typeof item.path !== 'string' ||
      typeof item.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      typeof item.size !== 'number' ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0
    ) {
      throw new Error(`files.json 第 ${index + 1} 项无效`)
    }
    assertSafePackagePath(item.path)
    if (item.path === 'files.json') throw new Error('files.json 不得列出自身')
    if (seen.has(item.path)) throw new Error(`files.json 包含重复路径: ${item.path}`)
    seen.add(item.path)
    return { path: item.path, sha256: item.sha256, size: item.size }
  })
  const sorted = [...files].sort((left, right) => compareText(left.path, right.path))
  if (files.some((file, index) => file.path !== sorted[index]?.path)) {
    throw new Error('files.json 路径必须排序')
  }
  return { version: 1, files }
}

function listRegularFiles(root: string): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort(compareText)) {
      const path = join(dir, name)
      const stat = lstatSync(path)
      const relativePath = relative(root, path).split('\\').join('/')
      if (stat.isSymbolicLink()) throw new Error(`暂存目录不允许链接: ${relativePath}`)
      if (stat.isDirectory()) walk(path)
      else if (stat.isFile()) files.push(relativePath)
      else throw new Error(`暂存目录包含非普通文件: ${relativePath}`)
    }
  }
  walk(root)
  return files.sort(compareText)
}

function installedPackageFromDir(
  dir: string,
  expectedType: PackageType
): InstalledPackage | undefined {
  let manifest: PackageManifest
  let source: PackageSourceMetadata
  try {
    manifest = readPackageManifest(dir)
    source = JSON.parse(readFileSync(join(dir, '.source.json'), 'utf8')) as PackageSourceMetadata
  } catch {
    return undefined
  }
  if (
    manifest.type !== expectedType ||
    !isSourceMetadata(source) ||
    source.id !== manifest.id ||
    source.type !== manifest.type ||
    source.version !== manifest.version
  ) {
    return undefined
  }
  return {
    id: manifest.id,
    type: manifest.type,
    version: manifest.version,
    title: manifest.title,
    summary: manifest.summary,
    dir,
    installedAt: source.installedAt,
    installedBy: source.installedBy,
    registry: source.registry,
    sha256: source.sha256
  }
}

function packagesAvailableForPlanning(agentDir: string): InstalledPackage[] {
  const managed = listInstalledPackages({ agentDir })
  const keys = new Set(managed.map(packageKey))
  const loaderPlugins = listInstalledPlugins({ agentDir })
    .filter((plugin) => !keys.has(packageKey({ type: 'plugin', id: plugin.id })))
    .map<InstalledPackage>((plugin) => ({
      id: plugin.id,
      type: 'plugin',
      version: plugin.version,
      title: plugin.manifest.title,
      summary: plugin.manifest.summary,
      dir: plugin.dir,
      installedAt: plugin.installedAt,
      installedBy: 'user',
      registry: plugin.source,
      sha256: '',
      enabled: plugin.enabled
    }))
  return [...managed, ...loaderPlugins]
}

function removeInstalledPackage(
  type: PackageType,
  id: string,
  options: InstallerOptions & { agentDir: string }
): void {
  if (type === 'plugin') {
    const result = uninstallPlugin(id, {
      agentDir: options.agentDir,
      runtimeRoot: options.runtimeRoot ?? getRuntimeRoot(options.agentDir),
      ...(options.garbageCollect ? { garbageCollect: options.garbageCollect } : {})
    })
    if (!result.ok) {
      throw new Error(`插件卸载失败: ${result.errors.map((problem) => problem.message).join('; ')}`)
    }
    return
  }
  const registry = readSkillsRegistry(options.agentDir)
  const entry = registry.skills[id]
  if (!entry) throw new Error(`技能软件包 ${id} 尚未安装`)
  const runtimeRoot = options.runtimeRoot ?? getRuntimeRoot(options.agentDir)
  const environment = skillEnvironment(
    skillVersionDir(id, entry.version, options.agentDir),
    options.agentDir,
    options.platform
  )
  const skills = { ...registry.skills }
  delete skills[id]
  writeSkillsRegistry({ version: 1, skills }, options.agentDir)
  rmSync(join(skillPackagesDir(options.agentDir), id), { recursive: true, force: true })
  if (environment) {
    removeReferrer(runtimeRoot, environment.envId, `skill:${id}`)
    ;(options.garbageCollect ?? collectGarbage)(runtimeRoot)
  }
}

interface SkillEnvironmentRecord {
  envId: string
  name: string
  kind: 'base' | 'package' | 'project'
  platform: PhiPlatform
  lockSha256: string
}

function skillEnvironment(
  dir: string,
  agentDir: string,
  platform = currentPlatform()
): SkillEnvironmentRecord | undefined {
  if (!existsSync(dir)) return undefined
  const validation = validatePackage(dir)
  const skill = validation.package?.skill
  const ref = skill?.phi?.environment
  if (!validation.ok || !skill || !ref) return undefined
  const descriptor = describeEnvironment(ref, { skill, agentDir, platform })
  const envId = computeEnvId({
    scope: descriptor.scope,
    owner: descriptor.owner,
    name: descriptor.spec.name,
    platform: descriptor.platform,
    lockText: descriptor.lockText,
    sourcePackages: descriptor.spec.sourcePackages
  })
  return {
    envId,
    name: descriptor.spec.name,
    kind: descriptor.kind,
    platform: descriptor.platform,
    lockSha256: lockSha256(descriptor.lockText)
  }
}

function addSkillEnvironmentReference(
  runtimeRoot: string,
  skillId: string,
  environment: SkillEnvironmentRecord
): void {
  if (!readEnvironmentIndex(runtimeRoot).environments[environment.envId]) {
    updateEnvironmentEntry(runtimeRoot, environment.envId, {
      name: environment.name,
      kind: environment.kind,
      platform: environment.platform,
      prefix: join(runtimeRoot, 'envs', environment.envId),
      status: 'absent',
      lockSha256: environment.lockSha256,
      referrers: []
    })
  }
  addReferrer(runtimeRoot, environment.envId, `skill:${skillId}`)
}

function collectOrphanDependencies(options: InstallerOptions & { agentDir: string }): void {
  let changed = true
  while (changed) {
    changed = false
    const managed = listInstalledPackages({ agentDir: options.agentDir })
    const available = packagesAvailableForPlanning(options.agentDir)
    for (const candidate of managed) {
      if (candidate.installedBy !== 'dependency') continue
      if (dependentOn(available, candidate)) continue
      removeInstalledPackage(candidate.type, candidate.id, options)
      changed = true
      break
    }
  }
}

function dependentOn(
  installed: InstalledPackage[],
  target: InstalledPackage
): InstalledPackage | undefined {
  return installed.find((candidate) => {
    if (candidate.type === target.type && candidate.id === target.id) return false
    try {
      const manifest = readPackageManifest(candidate.dir)
      return (manifest.dependsOn ?? []).some(
        (dependency) => dependency.type === target.type && dependency.id === target.id
      )
    } catch {
      return false
    }
  })
}

function promoteRootToUser(root: InstallPlan['root'], agentDir: string): void {
  const installed = listInstalledPackages({ agentDir }).find(
    (item) => item.type === root.type && item.id === root.id && item.version === root.version
  )
  if (!installed || installed.installedBy === 'user') return
  writeSourceMetadata(installed.dir, {
    registry: installed.registry,
    id: installed.id,
    type: installed.type,
    version: installed.version,
    sha256: installed.sha256,
    installedAt: installed.installedAt,
    installedBy: 'user'
  })
}

function writeSourceMetadata(dir: string, source: PackageSourceMetadata): void {
  const target = join(dir, '.source.json')
  const temporary = join(dir, `.source.${process.pid}.${randomUUID()}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(source, null, 2)}\n`, 'utf8')
  try {
    renameSync(temporary, target)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // Ignore cleanup failure and preserve the write error.
    }
    throw error
  }
}

function localArchivePath(registry: LocalRegistry, archive: string): string {
  if (/^https:\/\//i.test(archive)) throw new Error('当前仅支持本地目录注册表，不支持远程归档')
  assertSafePackagePath(archive)
  const path = resolve(registry.dir, ...archive.split('/'))
  const relativePath = relative(registry.dir, path)
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`注册表归档路径不安全: ${archive}`)
  }
  return path
}

function declaredEnvironments(registry: LocalRegistry, packages: RegistryPackageEntry[]): string[] {
  const environments = new Set<string>()
  for (const entry of packages) {
    try {
      const files = parseTarGz(readFileSync(localArchivePath(registry, entry.archive)))
      const manifestEntry = files.find(
        (item) => item.type === 'file' && item.path === 'phi-package.yaml'
      )
      const manifest = manifestEntry ? parseYaml(manifestEntry.data.toString('utf8')) : undefined
      if (entry.type === 'plugin' && isRecord(manifest) && isRecord(manifest.environments)) {
        for (const name of Object.keys(manifest.environments)) environments.add(`plugin:${name}`)
      }
      if (entry.type === 'skill') {
        const skillEntry = files.find((item) => item.type === 'file' && item.path === 'SKILL.md')
        if (!skillEntry) continue
        const skill = parseSkillFile(skillEntry.data.toString('utf8'))
        if (
          skill.ok &&
          isRecord(skill.frontmatter.phi) &&
          typeof skill.frontmatter.phi.environment === 'string'
        ) {
          environments.add(skill.frontmatter.phi.environment)
        }
      }
    } catch {
      // Integrity and format errors are reported during fetch/stage; the plan can still be shown.
    }
  }
  return [...environments].sort(compareText)
}

function assertSafePackagePath(path: string): void {
  const normalized = path.replaceAll('\\', '/')
  const parts = normalized.split('/')
  if (
    !path ||
    path.includes('\\') ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    normalized.startsWith('//') ||
    parts.some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`不安全的软件包路径: ${path}`)
  }
}

function parseRegistryEntry(value: unknown, index: number): RegistryPackageEntry {
  if (!isRecord(value)) throw new Error(`注册表 packages[${index}] 无效`)
  const entry = value as Record<string, unknown>
  if (
    typeof entry.id !== 'string' ||
    !/^[a-z][a-z0-9-]{1,63}$/.test(entry.id) ||
    (entry.type !== 'skill' && entry.type !== 'plugin') ||
    typeof entry.version !== 'string' ||
    !semver.valid(entry.version) ||
    typeof entry.title !== 'string' ||
    entry.title.length < 1 ||
    entry.title.length > 80 ||
    typeof entry.summary !== 'string' ||
    entry.summary.length < 1 ||
    entry.summary.length > 300 ||
    typeof entry.archive !== 'string' ||
    typeof entry.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(entry.sha256) ||
    typeof entry.size !== 'number' ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 0
  ) {
    throw new Error(`注册表 packages[${index}] 字段无效`)
  }
  if (entry.minAppVersion !== undefined && !semver.valid(String(entry.minAppVersion))) {
    throw new Error(`注册表 packages[${index}].minAppVersion 无效`)
  }
  const dependsOn = parseDependencies(entry.dependsOn, index)
  const requires = parseRequirements(entry.requires, index)
  return {
    id: entry.id,
    type: entry.type,
    version: entry.version,
    title: entry.title,
    summary: entry.summary,
    archive: entry.archive,
    sha256: entry.sha256,
    size: entry.size,
    dependsOn,
    ...(typeof entry.minAppVersion === 'string' ? { minAppVersion: entry.minAppVersion } : {}),
    ...(requires ? { requires } : {}),
    ...(typeof entry.category === 'string' ? { category: entry.category } : {}),
    ...(typeof entry.preview === 'string' ? { preview: entry.preview } : {})
  }
}

function parseDependencies(value: unknown, packageIndex: number): PackageDependency[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`注册表 packages[${packageIndex}].dependsOn 无效`)
  return value.map((dependency, index) => {
    if (
      !isRecord(dependency) ||
      typeof dependency.id !== 'string' ||
      !/^[a-z][a-z0-9-]{1,63}$/.test(dependency.id) ||
      (dependency.type !== 'skill' && dependency.type !== 'plugin') ||
      typeof dependency.version !== 'string' ||
      !semver.validRange(dependency.version)
    ) {
      throw new Error(`注册表 packages[${packageIndex}].dependsOn[${index}] 依赖或版本范围无效`)
    }
    return {
      id: dependency.id,
      type: dependency.type,
      version: dependency.version
    }
  })
}

function parseRequirements(value: unknown, packageIndex: number): PackageRequirements | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'coreTools')) {
    throw new Error(`注册表 packages[${packageIndex}].requires 无效`)
  }
  if (value.coreTools === undefined) return {}
  if (
    !Array.isArray(value.coreTools) ||
    value.coreTools.some((tool) => typeof tool !== 'string' || !/^[a-z][a-z0-9_]*$/.test(tool)) ||
    new Set(value.coreTools).size !== value.coreTools.length
  ) {
    throw new Error(`注册表 packages[${packageIndex}].requires.coreTools 无效`)
  }
  return { coreTools: value.coreTools as string[] }
}

function validateRequest(request: PackageRequest): void {
  if (
    (request.type !== 'skill' && request.type !== 'plugin') ||
    !/^[a-z][a-z0-9-]{1,63}$/.test(request.id)
  ) {
    throw new Error('软件包请求的 type 或 id 无效')
  }
  if (request.version !== undefined && !semver.valid(request.version)) {
    throw new Error(`软件包版本必须是完整语义版本: ${request.version}`)
  }
}

function isInstalledVersion(installed: InstalledPackage[], entry: RegistryPackageEntry): boolean {
  return installed.some(
    (item) => item.type === entry.type && item.id === entry.id && item.version === entry.version
  )
}

function addRequirement(requirements: Map<string, string[]>, key: string, range: string): void {
  const ranges = requirements.get(key) ?? []
  if (!ranges.includes(range)) requirements.set(key, [...ranges, range])
}

function packageKey(value: { type: PackageType; id: string }): string {
  return `${value.type}:${value.id}`
}

function packageVersionKey(value: { type: PackageType; id: string; version: string }): string {
  return `${packageKey(value)}@${value.version}`
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function readAppVersion(): string {
  const path = fileURLToPath(new URL('../../../../package.json', import.meta.url))
  const value = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
  if (typeof value.version !== 'string' || !semver.valid(value.version)) {
    throw new Error('package.json version is not valid semver')
  }
  return value.version
}

function isSourceMetadata(value: unknown): value is PackageSourceMetadata {
  return (
    isRecord(value) &&
    typeof value.registry === 'string' &&
    typeof value.id === 'string' &&
    (value.type === 'skill' || value.type === 'plugin') &&
    typeof value.version === 'string' &&
    typeof value.sha256 === 'string' &&
    typeof value.installedAt === 'string' &&
    (value.installedBy === 'user' || value.installedBy === 'dependency')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type { PluginBuildOptions }
