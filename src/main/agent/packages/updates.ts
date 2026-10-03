import semver from 'semver'

import { listInstalledPackages } from './installed'
import type {
  InstalledPackage,
  InstallerOptions,
  LocalRegistry,
  RegistryPackageEntry,
  RegistryTrustTier
} from './installer-types'
import { compareText, packageKey } from './installer-utils'
import { upgradePackage } from './lifecycle'
import type { PackageType } from './manifest'
import { checkPackageCompatibility, readAppVersion } from './planning'

export interface PackageUpdate {
  id: string
  type: PackageType
  title: string
  currentVersion: string
  newVersion: string
  registryId: string
  registryPath: string
  trust: RegistryTrustTier
}

export interface PackageUpdateOptions extends Pick<InstallerOptions, 'agentDir' | 'appVersion'> {
  installed?: readonly InstalledPackage[]
}

const TRUST_RANK: Record<RegistryTrustTier, number> = {
  imported: 0,
  builtin: 1,
  official: 1
}

export function computePackageUpdates(
  installed: readonly InstalledPackage[],
  registries: readonly LocalRegistry[],
  options: Pick<PackageUpdateOptions, 'appVersion'> = {}
): PackageUpdate[] {
  const appVersion = options.appVersion ?? readAppVersion()
  if (!semver.valid(appVersion)) throw new Error(`应用版本无效: ${appVersion}`)

  return installed
    .filter((item) => !isAppManaged(item))
    .flatMap((item) => {
      const candidates = eligibleCandidates(item, registries, appVersion)
      const preferred = candidates.filter(({ registry }) => registry.id === item.registry)
      const selected = selectCandidate(preferred.length > 0 ? preferred : candidates)
      if (!selected) return []
      return [toPackageUpdate(item, selected.registry, selected.entry)]
    })
    .sort(
      (left, right) =>
        compareText(left.type, right.type) ||
        compareText(left.id, right.id) ||
        semver.compare(left.newVersion, right.newVersion)
    )
}

export function listPackageUpdates(
  registries: readonly LocalRegistry[],
  options: PackageUpdateOptions = {}
): PackageUpdate[] {
  const installed = options.installed ?? listInstalledPackages({ agentDir: options.agentDir })
  return computePackageUpdates(installed, registries, options)
}

export async function applyPackageUpdate(
  update: PackageUpdate,
  registries: readonly LocalRegistry[],
  options: InstallerOptions = {}
): Promise<InstalledPackage[]> {
  const current = listPackageUpdates(registries, options).find(
    (candidate) =>
      candidate.type === update.type &&
      candidate.id === update.id &&
      candidate.currentVersion === update.currentVersion &&
      candidate.newVersion === update.newVersion &&
      candidate.registryId === update.registryId
  )
  if (!current) {
    throw new Error(`软件包更新已不可用或已过期: ${update.type}:${update.id}@${update.newVersion}`)
  }
  const registry = findUpdateRegistry(current, registries)
  return upgradePackage(
    registry,
    { type: current.type, id: current.id, version: current.newVersion },
    options
  )
}

export async function applyPackageUpdates(
  updates: readonly PackageUpdate[],
  registries: readonly LocalRegistry[],
  options: InstallerOptions = {}
): Promise<InstalledPackage[]> {
  for (const update of orderUpdates(updates, registries)) {
    await applyPackageUpdate(update, registries, options)
  }
  return listInstalledPackages({ agentDir: options.agentDir })
}

function eligibleCandidates(
  installed: InstalledPackage,
  registries: readonly LocalRegistry[],
  appVersion: string
): Array<{ registry: LocalRegistry; entry: RegistryPackageEntry }> {
  const candidates: Array<{ registry: LocalRegistry; entry: RegistryPackageEntry }> = []
  for (const registry of registries) {
    if (TRUST_RANK[registry.trust] < TRUST_RANK[installed.trust]) continue
    for (const entry of registry.packages) {
      if (
        entry.type !== installed.type ||
        entry.id !== installed.id ||
        !semver.gt(entry.version, installed.version)
      ) {
        continue
      }
      try {
        checkPackageCompatibility(entry, appVersion)
      } catch {
        continue
      }
      candidates.push({ registry, entry })
    }
  }
  return candidates
}

function selectCandidate(
  candidates: Array<{ registry: LocalRegistry; entry: RegistryPackageEntry }>
): { registry: LocalRegistry; entry: RegistryPackageEntry } | undefined {
  return [...candidates].sort(
    (left, right) =>
      semver.rcompare(left.entry.version, right.entry.version) ||
      TRUST_RANK[right.registry.trust] - TRUST_RANK[left.registry.trust] ||
      compareText(left.registry.id, right.registry.id)
  )[0]
}

function toPackageUpdate(
  installed: InstalledPackage,
  registry: LocalRegistry,
  entry: RegistryPackageEntry
): PackageUpdate {
  return {
    id: installed.id,
    type: installed.type,
    title: installed.title,
    currentVersion: installed.version,
    newVersion: entry.version,
    registryId: registry.id,
    registryPath: registry.dir,
    trust: registry.trust
  }
}

function isAppManaged(item: InstalledPackage): boolean {
  return item.trust === 'builtin'
}

function findUpdateRegistry(
  update: PackageUpdate,
  registries: readonly LocalRegistry[]
): LocalRegistry {
  const registry = registries.find(
    (candidate) => candidate.id === update.registryId && candidate.dir === update.registryPath
  )
  if (!registry) throw new Error(`找不到更新源: ${update.registryId}`)
  return registry
}

function orderUpdates(
  updates: readonly PackageUpdate[],
  registries: readonly LocalRegistry[]
): PackageUpdate[] {
  const byKey = new Map(updates.map((update) => [packageKey(update), update]))
  const ordered: PackageUpdate[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()

  const visit = (update: PackageUpdate): void => {
    const key = packageKey(update)
    if (visited.has(key)) return
    if (visiting.has(key)) throw new Error(`检测到循环更新依赖: ${key}`)
    visiting.add(key)
    const registry = findUpdateRegistry(update, registries)
    const entry = registry.packages.find(
      (candidate) =>
        candidate.type === update.type &&
        candidate.id === update.id &&
        candidate.version === update.newVersion
    )
    if (!entry) throw new Error(`更新源中找不到软件包: ${key}@${update.newVersion}`)
    for (const dependency of entry.dependsOn) {
      const pending = byKey.get(packageKey(dependency))
      if (pending && semver.satisfies(pending.newVersion, dependency.version)) visit(pending)
    }
    visiting.delete(key)
    visited.add(key)
    ordered.push(update)
  }

  for (const update of updates) visit(update)
  return ordered
}
