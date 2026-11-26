import { readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import type {
  ManagedEnvironmentCheckResult,
  ManagedEnvironmentCleanResult,
  ManagedEnvironmentEntry,
  ManagedEnvironmentRemoveResult,
  ManagedEnvironmentTrimCacheResult
} from '../../../shared/environmentTypes'
import type { EnvironmentBuilds } from '../content/environment-builds'
import { bundledEnvironmentsDir, describeEnvironment } from '../content/environment-refs'
import {
  addReferrer,
  checkEnvironment,
  collectGarbage,
  computeEnvId,
  currentPlatform,
  parseEnvironmentRef,
  readEnvironmentIndex,
  readWslRuntime,
  removeReferrer,
  removeEnvironmentCache,
  removeManagedEnvironmentPrefix,
  repairEnvironment,
  trimPackageCache,
  usesWslEnvironment,
  wslEnvironmentPrefix,
  type PhiPlatform
} from '../envs'
import { deleteEnvironmentEntry } from '../envs/index-store'
import { tryAcquireEnvironmentLock } from '../envs/lock'
import { hasLiveEnvironmentLeases } from '../envs/leases'
import { ownedEnvironmentPrefix, ownedRuntimeDirectory } from '../envs/ownership'
import { probeManagedWsl, requireReadyWsl, type WslProbe } from '../envs/wsl'
import { listInstalledPlugins } from '../plugins/loader'
import { getPhiAgentDir } from '../runtime-paths'
import {
  findExtensionEnvironmentTargetByRef,
  resolveExtensionEnvironmentDescriptor
} from './managed-extensions'
import { directorySize } from './size'

const ENV_ID = /^[a-z][a-z0-9-]*-[0-9a-f]{12}$/
const PLUGIN_ID = /^[a-z][a-z0-9-]{1,63}$/
const REMOVABLE_STATES = new Set(['ready', 'failed', 'drifted'])
const CLEAN_BUILD_GUARD_REFERRER = 'environment-panel:active-build'
const LEGACY_VERSIONED_PLUGIN_REFERRER = /^plugin:[a-z][a-z0-9-]*@/u

type Catalog = (projectCwd?: string, includeDynamic?: boolean) => Promise<ManagedEnvironmentEntry[]>

export interface ManagedEnvironmentActions {
  list(projectCwd?: unknown, includeDynamic?: unknown): Promise<ManagedEnvironmentEntry[]>
  build(ref: unknown, projectCwd?: unknown, pluginId?: unknown): Promise<{ envId: string }>
  rebuild(envId: unknown): Promise<void>
  check(envId: unknown): Promise<ManagedEnvironmentCheckResult>
  remove(envId: unknown, options?: unknown): Promise<ManagedEnvironmentRemoveResult>
  clean(): Promise<ManagedEnvironmentCleanResult>
  trimCache(): Promise<ManagedEnvironmentTrimCacheResult>
}

export interface ManagedEnvironmentActionDependencies {
  root: string
  agentDir?: string
  environmentsDir?: string
  builds: EnvironmentBuilds
  catalog: Catalog
  sizeOf?: typeof directorySize
  collect?: typeof collectGarbage
  repair?: typeof repairEnvironment
  check?: typeof checkEnvironment
  trimCache?: typeof trimPackageCache
  platform?: PhiPlatform
  probeWsl?: (root: string) => Promise<WslProbe>
}

function projectDirectory(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value.trim())) {
    throw new Error('项目目录必须是绝对路径')
  }
  const path = resolve(value.trim())
  try {
    if (!statSync(path).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new Error('项目目录不存在或不是文件夹')
  }
  return path
}

function dynamicDetails(value: unknown): boolean {
  if (value === undefined) return true
  if (typeof value !== 'boolean') throw new Error('环境详情选项必须是布尔值')
  return value
}

function environmentRef(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('环境引用不能为空')
  const ref = value.trim()
  if (ref.startsWith('skill:') || ref.startsWith('mcp:')) return ref
  let parsed: ReturnType<typeof parseEnvironmentRef>
  try {
    parsed = parseEnvironmentRef(ref)
  } catch {
    throw new Error(`环境引用无效：${ref}`)
  }
  if (parsed.kind === 'path') throw new Error('环境面板不能构建技能私有路径环境')
  return ref
}

function isForceRemove(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    'force' in value &&
    (value as { force?: unknown }).force === true
  )
}

function environmentId(value: unknown): string {
  if (typeof value !== 'string' || !ENV_ID.test(value)) throw new Error('envId 无效')
  return value
}

function pluginIdentifier(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !PLUGIN_ID.test(value)) throw new Error('插件标识无效')
  return value
}

type BuildTarget = { ref: string; projectCwd?: string; pluginId?: string }

function validatePluginEnvironment(
  ref: string,
  pluginId: string | undefined,
  agentDir: string | undefined
): void {
  const parsed = parseEnvironmentRef(ref)
  if (parsed.kind !== 'plugin') {
    if (pluginId) throw new Error('插件标识只能用于插件私有环境')
    return
  }
  if (!pluginId) throw new Error('构建插件私有环境时必须提供插件标识')
  const plugin = listInstalledPlugins({ ...(agentDir ? { agentDir } : {}) }).find(
    (candidate) => candidate.id === pluginId
  )
  if (!plugin) throw new Error(`找不到已安装插件：${pluginId}`)
  if (!Object.hasOwn(plugin.environments, parsed.name)) {
    throw new Error(`插件 ${pluginId} 未声明环境 ${parsed.name}`)
  }
}

async function envIdOf(
  target: BuildTarget,
  {
    agentDir,
    environmentsDir,
    platform
  }: Pick<ManagedEnvironmentActionDependencies, 'agentDir' | 'environmentsDir' | 'platform'>
): Promise<{ envId: string; descriptor: ReturnType<typeof describeEnvironment> }> {
  let descriptor: ReturnType<typeof describeEnvironment>
  if (target.ref.startsWith('skill:') || target.ref.startsWith('mcp:')) {
    const extensionTarget = await findExtensionEnvironmentTargetByRef(target.ref, {
      ...(agentDir ? { agentDir } : {}),
      ...(target.projectCwd ? { projectCwd: target.projectCwd } : {})
    })
    if (!extensionTarget) throw new Error(`找不到对应的扩展环境定义：${target.ref}`)
    descriptor = resolveExtensionEnvironmentDescriptor(extensionTarget, {
      environmentsDir: environmentsDir ?? bundledEnvironmentsDir(),
      agentDir: agentDir ?? getPhiAgentDir(),
      platform: platform ?? currentPlatform()
    })
  } else {
    validatePluginEnvironment(target.ref, target.pluginId, agentDir)
    descriptor = describeEnvironment(target.ref, {
      ...(target.projectCwd ? { projectDir: target.projectCwd } : {}),
      ...(target.pluginId ? { pluginId: target.pluginId } : {}),
      ...(environmentsDir ? { environmentsDir } : {}),
      ...(agentDir ? { agentDir } : {}),
      ...(platform ? { platform } : {})
    })
  }
  return {
    descriptor,
    envId: computeEnvId({
      scope: descriptor.scope,
      owner: descriptor.owner,
      name: descriptor.spec.name,
      platform: descriptor.platform,
      lockText: descriptor.lockText,
      sourcePackages: descriptor.spec.sourcePackages,
      installation: descriptor.spec.installation
    })
  }
}

function listDirectoryNames(path: string): string[] {
  try {
    return readdirSync(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
}

export function createManagedEnvironmentActions(
  dependencies: ManagedEnvironmentActionDependencies
): ManagedEnvironmentActions {
  const sizeOf = dependencies.sizeOf ?? directorySize
  const collect = dependencies.collect ?? collectGarbage
  const repair = dependencies.repair ?? repairEnvironment
  const probeWsl = dependencies.probeWsl ?? probeManagedWsl
  const descriptors = new Map<string, BuildTarget>()

  async function preflight(descriptor: ReturnType<typeof describeEnvironment>): Promise<void> {
    if (descriptor.runtime === 'wsl2') requireReadyWsl(await probeWsl(dependencies.root))
  }

  async function list(
    projectCwdValue?: unknown,
    includeDynamicValue?: unknown
  ): Promise<ManagedEnvironmentEntry[]> {
    const projectCwd = projectDirectory(projectCwdValue)
    const entries = await dependencies.catalog(projectCwd, dynamicDetails(includeDynamicValue))
    for (const entry of entries) {
      if (entry.source === 'orphaned') continue
      descriptors.set(entry.envId, {
        ref: entry.ref,
        ...(projectCwd ? { projectCwd } : {}),
        ...(entry.pluginId ? { pluginId: entry.pluginId } : {})
      })
    }
    return entries
  }

  async function build(
    refValue: unknown,
    projectCwdValue?: unknown,
    pluginIdValue?: unknown
  ): Promise<{ envId: string }> {
    const ref = environmentRef(refValue)
    const projectCwd = projectDirectory(projectCwdValue)
    const pluginId = pluginIdentifier(pluginIdValue)
    const parsed =
      ref.startsWith('skill:') || ref.startsWith('mcp:')
        ? ({ kind: 'extension' } as const)
        : parseEnvironmentRef(ref)
    if (parsed.kind === 'project' && !projectCwd) {
      throw new Error('构建项目环境时必须提供项目目录')
    }
    const target: BuildTarget = {
      ref,
      ...(projectCwd ? { projectCwd } : {}),
      ...(pluginId ? { pluginId } : {})
    }
    const { descriptor, envId } = await envIdOf(target, dependencies)
    await preflight(descriptor)
    descriptors.set(envId, target)
    void dependencies.builds
      .start(descriptor, {
        ref,
        ...(pluginId ? { requestedBy: { plugin: pluginId } } : {})
      })
      .catch(() => undefined)
    return { envId }
  }

  async function rebuild(envIdValue: unknown): Promise<void> {
    const envId = environmentId(envIdValue)
    if (
      dependencies.builds
        .list()
        .some((build) => build.envId === envId && build.state === 'building')
    ) {
      throw new Error('该环境正在构建，暂时不能重建')
    }
    let target = descriptors.get(envId)
    if (!target) {
      await list()
      target = descriptors.get(envId)
    }
    if (!target) throw new Error('找不到该环境的构建定义，请先刷新环境列表')
    const { descriptor, envId: describedId } = await envIdOf(target, dependencies)
    if (describedId !== envId) throw new Error('环境定义已经变化，请刷新环境列表后重试')
    await preflight(descriptor)
    await repair({
      root: dependencies.root,
      scope: descriptor.scope,
      owner: descriptor.owner,
      kind: descriptor.kind,
      spec: descriptor.spec,
      lockText: descriptor.lockText,
      platform: descriptor.platform
    })
  }

  async function check(envIdValue: unknown): Promise<ManagedEnvironmentCheckResult> {
    const envId = environmentId(envIdValue)
    if (
      dependencies.builds
        .list()
        .some((build) => build.envId === envId && build.state === 'building')
    ) {
      return { envId, ok: false, problems: ['该环境正在构建，请稍后再检查'] }
    }
    const indexEntry = readEnvironmentIndex(dependencies.root).environments[envId]
    if (!indexEntry) {
      return { envId, ok: false, problems: ['找不到已安装的环境索引记录'] }
    }
    let target = descriptors.get(envId)
    if (!target) {
      await list()
      target = descriptors.get(envId)
    }
    if (!target) {
      return {
        envId,
        ok: false,
        problems: ['孤立环境缺少原始 lockfile 定义，建议清理或手动删除']
      }
    }
    const { descriptor } = await envIdOf(target, dependencies)
    return (dependencies.check ?? checkEnvironment)(dependencies.root, envId, descriptor.lockText)
  }

  async function remove(
    envIdValue: unknown,
    optionsValue?: unknown
  ): Promise<ManagedEnvironmentRemoveResult> {
    const envId = environmentId(envIdValue)
    const force = isForceRemove(optionsValue)
    if (
      dependencies.builds
        .list()
        .some((build) => build.envId === envId && build.state === 'building')
    ) {
      throw new Error('该环境正在构建，暂时不能删除')
    }
    const entry = readEnvironmentIndex(dependencies.root).environments[envId]
    if (!entry) throw new Error('找不到要删除的环境')
    if (!force && entry.referrers.length > 0) throw new Error('该环境仍被引用，不能删除')
    if (!REMOVABLE_STATES.has(entry.status)) throw new Error(`环境状态为 ${entry.status}，不能删除`)
    const expectedPrefix = resolve(dependencies.root, 'envs', envId)
    if (resolve(entry.prefix) !== expectedPrefix) throw new Error('环境前缀路径异常，拒绝删除')

    const lock = tryAcquireEnvironmentLock(dependencies.root, envId)
    if (!lock) throw new Error('该环境正在被其他任务使用，暂时不能删除')
    try {
      const current = readEnvironmentIndex(dependencies.root).environments[envId]
      if (
        !current ||
        (!force && current.referrers.length > 0) ||
        !REMOVABLE_STATES.has(current.status)
      ) {
        throw new Error('环境状态已经变化，请刷新后重试')
      }
      if (hasLiveEnvironmentLeases(dependencies.root, envId)) {
        throw new Error('该环境仍被运行中的会话使用，暂时不能删除')
      }
      const prefix = ownedEnvironmentPrefix(dependencies.root, envId, current.prefix)
      const bytesFreed = await sizeOf(runtimePrefix(envId, current.platform, prefix))
      ownedRuntimeDirectory(dependencies.root, 'cache', envId)
      await removeManagedEnvironmentPrefix(dependencies.root, envId, prefix, current.platform)
      removeEnvironmentCache(dependencies.root, envId)
      deleteEnvironmentEntry(dependencies.root, envId)
      descriptors.delete(envId)
      return { removed: true, bytesFreed }
    } finally {
      lock.release()
    }
  }

  function runtimePrefix(envId: string, platform: PhiPlatform, hostPrefix: string): string {
    const wsl = usesWslEnvironment(process.platform, platform)
      ? readWslRuntime(dependencies.root)
      : undefined
    return wsl ? wslEnvironmentPrefix(wsl, envId) : hostPrefix
  }

  async function clean(): Promise<ManagedEnvironmentCleanResult> {
    const buildingIds = new Set(
      dependencies.builds
        .list()
        .filter((build) => build.state === 'building')
        .map((build) => build.envId)
    )
    const orphanedIds = new Set(
      (await dependencies.catalog())
        .filter((entry) => entry.source === 'orphaned')
        .map((entry) => entry.envId)
    )
    let index = readEnvironmentIndex(dependencies.root)
    for (const envId of orphanedIds) {
      if (buildingIds.has(envId)) continue
      const entry = index.environments[envId]
      for (const referrer of entry?.referrers ?? []) {
        if (LEGACY_VERSIONED_PLUGIN_REFERRER.test(referrer)) {
          removeReferrer(dependencies.root, envId, referrer)
        }
      }
    }
    index = readEnvironmentIndex(dependencies.root)
    for (const [envId, entry] of Object.entries(index.environments)) {
      if (!buildingIds.has(envId) && entry.referrers.includes(CLEAN_BUILD_GUARD_REFERRER)) {
        removeReferrer(dependencies.root, envId, CLEAN_BUILD_GUARD_REFERRER)
      }
    }
    index = readEnvironmentIndex(dependencies.root)
    const sizes = new Map<string, number>()
    await Promise.all(
      Object.entries(index.environments).map(async ([envId, entry]) => {
        if (
          !buildingIds.has(envId) &&
          entry.referrers.length === 0 &&
          REMOVABLE_STATES.has(entry.status)
        ) {
          sizes.set(envId, await sizeOf(runtimePrefix(envId, entry.platform, entry.prefix)))
        }
      })
    )
    const indexed = new Set(Object.keys(index.environments))
    await Promise.all(
      listDirectoryNames(join(dependencies.root, 'envs')).map(async (envId) => {
        if (!indexed.has(envId))
          sizes.set(envId, await sizeOf(join(dependencies.root, 'envs', envId)))
      })
    )
    const guarded: string[] = []
    for (const envId of buildingIds) {
      const entry = readEnvironmentIndex(dependencies.root).environments[envId]
      if (!entry || entry.referrers.includes(CLEAN_BUILD_GUARD_REFERRER)) continue
      addReferrer(dependencies.root, envId, CLEAN_BUILD_GUARD_REFERRER)
      guarded.push(envId)
    }
    let result: ReturnType<typeof collectGarbage>
    try {
      // The environment panel's explicit cleanup keeps its historical behavior of
      // removing unreferenced shared environments too.
      result = collect(dependencies.root, { includeShared: true })
    } finally {
      for (const envId of guarded) {
        removeReferrer(dependencies.root, envId, CLEAN_BUILD_GUARD_REFERRER)
      }
    }
    const skipped = [...result.skipped]
    for (const envId of buildingIds) {
      if (!skipped.some((entry) => entry.envId === envId)) {
        skipped.push({ envId, reason: 'building' })
      }
    }
    const bytesFreed = [...result.removed, ...result.orphans].reduce(
      (total, envId) => total + (sizes.get(envId) ?? 0),
      0
    )
    for (const envId of [...result.removed, ...result.orphans]) descriptors.delete(envId)
    return { ...result, skipped, bytesFreed }
  }

  async function trimCache(): Promise<ManagedEnvironmentTrimCacheResult> {
    const packagesCacheDir = ownedRuntimeDirectory(dependencies.root, 'cache', 'packages')
    const before = await sizeOf(packagesCacheDir)
    await (dependencies.trimCache ?? trimPackageCache)(dependencies.root)
    const after = await sizeOf(packagesCacheDir)
    return { bytesFreed: Math.max(0, before - after) }
  }

  return { list, build, rebuild, check, remove, clean, trimCache }
}
