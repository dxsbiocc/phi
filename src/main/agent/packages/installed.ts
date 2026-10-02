import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import semver from 'semver'

import { listInstalledPlugins } from '../plugins/loader'
import { getPhiAgentDir } from '../runtime-paths'
import type { InstalledPackage, InstallerOptions, PackageSourceMetadata } from './installer-types'
import { isSourceMetadata, packageKey } from './installer-utils'
import { readPackageManifest, type PackageManifest, type PackageType } from './manifest'
import { listActiveSkillPackages } from './store'
import { listInstalledWrapperPackages } from './wrapper-tree'

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
  installed.push(...listInstalledWrapperPackages(agentDir))
  return installed.sort(
    (left, right) =>
      left.type.localeCompare(right.type) ||
      left.id.localeCompare(right.id) ||
      semver.compare(left.version, right.version)
  )
}

export function packagesAvailableForPlanning(agentDir: string): InstalledPackage[] {
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
