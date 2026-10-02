import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import semver from 'semver'

import { describeEnvironment } from '../content/environment-refs'
import {
  addReferrer,
  collectGarbage,
  computeEnvId,
  currentPlatform,
  getRuntimeRoot,
  lockSha256,
  readEnvironmentIndex,
  removeReferrer,
  updateEnvironmentEntry
} from '../envs'
import {
  installPlugin,
  listInstalledPlugins,
  uninstallPlugin,
  upgradePlugin
} from '../plugins/loader'
import { getPhiAgentDir } from '../runtime-paths'
import { listInstalledPackages, packagesAvailableForPlanning } from './installed'
import type {
  InstalledPackage,
  InstallerOptions,
  InstallPlan,
  LocalRegistry,
  PackageRequest,
  PackageSourceMetadata,
  SkillEnvironmentRecord,
  StagedPackage
} from './installer-types'
import { readPackageManifest, validatePackage, type PackageType } from './manifest'
import { planInstall } from './planning'
import { cleanupStalePackageStaging, stagePackage } from './staging'
import { readSkillsRegistry, skillPackagesDir, skillVersionDir, writeSkillsRegistry } from './store'
import {
  installStagedWrapperPackage,
  installStagedWrapperPackages,
  installedWrapperDependencies,
  promoteInstalledWrapperPackage,
  removeInstalledWrapperPackage
} from './wrapper-tree'

export async function installPackages(
  plan: InstallPlan,
  options: InstallerOptions = {}
): Promise<InstalledPackage[]> {
  const agentDir = options.agentDir ?? plan.agentDir ?? getPhiAgentDir()
  const unsupported = plan.packages.find((entry) => entry.type === 'mcp')
  if (unsupported) {
    throw new Error(`MCP 软件包 ${unsupported.id} 已被清单接受，但此安装器尚未实现 MCP 安装`)
  }
  cleanupStalePackageStaging({ agentDir, now: options.now })
  const stages: StagedPackage[] = []
  const installedNow: Array<{ type: PackageType; id: string }> = []
  try {
    for (const entry of plan.packages) {
      stages.push(stagePackage(plan.registry, entry, agentDir, options.now))
    }
    for (let index = 0; index < stages.length;) {
      const staged = stages[index]
      if (staged.entry.type === 'wrapper') {
        const wrappers: StagedPackage[] = []
        while (stages[index]?.entry.type === 'wrapper') {
          wrappers.push(stages[index])
          index += 1
        }
        installStagedWrapperPackages(wrappers, agentDir)
        installedNow.push(...wrappers.map((item) => ({ type: item.entry.type, id: item.entry.id })))
        continue
      }
      await commitStagedPackage(staged, {
        ...options,
        agentDir
      })
      installedNow.push({ type: staged.entry.type, id: staged.entry.id })
      index += 1
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
  const dependent = dependentOn(packagesAvailableForPlanning(agentDir), target, agentDir)
  if (dependent) {
    throw new Error(`无法卸载 ${type}:${id}；软件包 ${dependent.type}:${dependent.id} 仍依赖它`)
  }
  removeInstalledPackage(type, id, { ...options, agentDir })
  collectOrphanDependencies({ ...options, agentDir })
  return listInstalledPackages({ agentDir })
}

async function commitStagedPackage(
  staged: StagedPackage,
  options: InstallerOptions & { agentDir: string }
): Promise<void> {
  if (staged.entry.type === 'wrapper') {
    installStagedWrapperPackage(staged, options.agentDir)
    return
  }
  if (staged.entry.type === 'mcp') {
    throw new Error(`MCP 软件包 ${staged.entry.id} 已被清单接受，但此安装器尚未实现 MCP 安装`)
  }
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

function removeInstalledPackage(
  type: PackageType,
  id: string,
  options: InstallerOptions & { agentDir: string }
): void {
  if (type === 'wrapper') {
    removeInstalledWrapperPackage(id, options.agentDir)
    return
  }
  if (type === 'mcp') {
    throw new Error(`MCP 软件包 ${id} 的安装与卸载尚未实现`)
  }
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
      if (dependentOn(available, candidate, options.agentDir)) continue
      removeInstalledPackage(candidate.type, candidate.id, options)
      changed = true
      break
    }
  }
}

function dependentOn(
  installed: InstalledPackage[],
  target: InstalledPackage,
  agentDir: string
): InstalledPackage | undefined {
  return installed.find((candidate) => {
    if (candidate.type === target.type && candidate.id === target.id) return false
    try {
      const dependencies =
        candidate.type === 'wrapper'
          ? installedWrapperDependencies(candidate.id, agentDir)
          : (readPackageManifest(candidate.dir).dependsOn ?? [])
      return dependencies.some(
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
  if (installed.type === 'wrapper') {
    promoteInstalledWrapperPackage(installed.id, installed.version, agentDir)
    return
  }
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
