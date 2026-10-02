import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import semver from 'semver'
import { parse as parseYaml } from 'yaml'

import { parseSkillFile } from '../content/skill'
import { CORE_TOOLS } from '../core-tools'
import { getPhiAgentDir } from '../runtime-paths'
import { parseTarGz } from './archive'
import { packagesAvailableForPlanning } from './installed'
import type {
  InstalledPackage,
  InstallerOptions,
  InstallPlan,
  LocalRegistry,
  PackageRequest,
  PlannedPackage,
  RegistryPackageEntry
} from './installer-types'
import { compareText, isRecord, localArchivePath, packageKey } from './installer-utils'

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

function readAppVersion(): string {
  const path = fileURLToPath(new URL('../../../../package.json', import.meta.url))
  const value = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
  if (typeof value.version !== 'string' || !semver.valid(value.version)) {
    throw new Error('package.json version is not valid semver')
  }
  return value.version
}
