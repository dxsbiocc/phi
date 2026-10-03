import { readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import type {
  ManagedEnvironmentCleanResult,
  ManagedEnvironmentEntry,
  ManagedEnvironmentRemoveResult
} from '../../../shared/environmentTypes'
import type { EnvironmentBuilds } from '../content/environment-builds'
import { describeEnvironment } from '../content/environment-refs'
import {
  addReferrer,
  collectGarbage,
  computeEnvId,
  parseEnvironmentRef,
  readEnvironmentIndex,
  removeReferrer,
  removeEnvironmentCache,
  removeTree,
  repairEnvironment
} from '../envs'
import { deleteEnvironmentEntry } from '../envs/index-store'
import { tryAcquireEnvironmentLock } from '../envs/lock'
import { directorySize } from './size'

const ENV_ID = /^[a-z][a-z0-9-]*-[0-9a-f]{12}$/
const REMOVABLE_STATES = new Set(['ready', 'failed', 'drifted'])
const CLEAN_BUILD_GUARD_REFERRER = 'environment-panel:active-build'

type Catalog = (projectCwd?: string) => Promise<ManagedEnvironmentEntry[]>

export interface ManagedEnvironmentActions {
  list(projectCwd?: unknown): Promise<ManagedEnvironmentEntry[]>
  build(ref: unknown, projectCwd?: unknown): { envId: string }
  rebuild(envId: unknown): Promise<void>
  remove(envId: unknown): Promise<ManagedEnvironmentRemoveResult>
  clean(): Promise<ManagedEnvironmentCleanResult>
}

export interface ManagedEnvironmentActionDependencies {
  root: string
  builds: EnvironmentBuilds
  catalog: Catalog
  sizeOf?: typeof directorySize
  collect?: typeof collectGarbage
  repair?: typeof repairEnvironment
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

function environmentRef(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('环境引用不能为空')
  const ref = value.trim()
  let parsed: ReturnType<typeof parseEnvironmentRef>
  try {
    parsed = parseEnvironmentRef(ref)
  } catch {
    throw new Error(`环境引用无效：${ref}`)
  }
  if (parsed.kind === 'path') throw new Error('环境面板不能构建技能私有路径环境')
  return ref
}

function environmentId(value: unknown): string {
  if (typeof value !== 'string' || !ENV_ID.test(value)) throw new Error('envId 无效')
  return value
}

function envIdOf(
  ref: string,
  projectCwd?: string
): { envId: string; descriptor: ReturnType<typeof describeEnvironment> } {
  const descriptor = describeEnvironment(ref, { projectDir: projectCwd })
  return {
    descriptor,
    envId: computeEnvId({
      scope: descriptor.scope,
      owner: descriptor.owner,
      name: descriptor.spec.name,
      platform: descriptor.platform,
      lockText: descriptor.lockText,
      sourcePackages: descriptor.spec.sourcePackages
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
  const descriptors = new Map<string, { ref: string; projectCwd?: string }>()

  async function list(projectCwdValue?: unknown): Promise<ManagedEnvironmentEntry[]> {
    const projectCwd = projectDirectory(projectCwdValue)
    const entries = await dependencies.catalog(projectCwd)
    for (const entry of entries) {
      if (entry.source === 'orphaned') continue
      descriptors.set(entry.envId, {
        ref: entry.ref,
        ...(projectCwd ? { projectCwd } : {})
      })
    }
    return entries
  }

  function build(refValue: unknown, projectCwdValue?: unknown): { envId: string } {
    const ref = environmentRef(refValue)
    const projectCwd = projectDirectory(projectCwdValue)
    const parsed = parseEnvironmentRef(ref)
    if (parsed.kind === 'project' && !projectCwd) {
      throw new Error('构建项目环境时必须提供项目目录')
    }
    const { descriptor, envId } = envIdOf(ref, projectCwd)
    descriptors.set(envId, { ref, ...(projectCwd ? { projectCwd } : {}) })
    void dependencies.builds.start(descriptor, { ref }).catch(() => undefined)
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
      const known = await list()
      const entry = known.find((candidate) => candidate.envId === envId)
      if (entry && entry.source !== 'orphaned') target = { ref: entry.ref }
    }
    if (!target) throw new Error('找不到该环境的构建定义，请先刷新环境列表')
    const { descriptor, envId: describedId } = envIdOf(target.ref, target.projectCwd)
    if (describedId !== envId) throw new Error('环境定义已经变化，请刷新环境列表后重试')
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

  async function remove(envIdValue: unknown): Promise<ManagedEnvironmentRemoveResult> {
    const envId = environmentId(envIdValue)
    if (
      dependencies.builds
        .list()
        .some((build) => build.envId === envId && build.state === 'building')
    ) {
      throw new Error('该环境正在构建，暂时不能删除')
    }
    const entry = readEnvironmentIndex(dependencies.root).environments[envId]
    if (!entry) throw new Error('找不到要删除的环境')
    if (entry.referrers.length > 0) throw new Error('该环境仍被引用，不能删除')
    if (!REMOVABLE_STATES.has(entry.status)) throw new Error(`环境状态为 ${entry.status}，不能删除`)
    const expectedPrefix = resolve(dependencies.root, 'envs', envId)
    if (resolve(entry.prefix) !== expectedPrefix) throw new Error('环境前缀路径异常，拒绝删除')

    const lock = tryAcquireEnvironmentLock(dependencies.root, envId)
    if (!lock) throw new Error('该环境正在被其他任务使用，暂时不能删除')
    try {
      const current = readEnvironmentIndex(dependencies.root).environments[envId]
      if (!current || current.referrers.length > 0 || !REMOVABLE_STATES.has(current.status)) {
        throw new Error('环境状态已经变化，请刷新后重试')
      }
      const bytesFreed = await sizeOf(current.prefix)
      removeTree(current.prefix)
      removeEnvironmentCache(dependencies.root, envId)
      deleteEnvironmentEntry(dependencies.root, envId)
      descriptors.delete(envId)
      return { removed: true, bytesFreed }
    } finally {
      lock.release()
    }
  }

  async function clean(): Promise<ManagedEnvironmentCleanResult> {
    const buildingIds = new Set(
      dependencies.builds
        .list()
        .filter((build) => build.state === 'building')
        .map((build) => build.envId)
    )
    let index = readEnvironmentIndex(dependencies.root)
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
          sizes.set(envId, await sizeOf(entry.prefix))
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
      result = collect(dependencies.root)
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

  return { list, build, rebuild, remove, clean }
}
