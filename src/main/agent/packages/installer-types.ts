import type { collectGarbage, PhiPlatform } from '../envs'
import type { PluginEnvironmentBuilder, PluginNamespace } from '../plugins/loader'
import type { PackageDependency, PackageRequirements, PackageType } from './manifest'

export type RegistryTrust = 'builtin' | 'official' | 'imported'
export type RegistryTrustTier = RegistryTrust

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
  trust: RegistryTrustTier
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
  /** Offline import may resolve this entry from a different known registry. */
  sourceRegistry?: LocalRegistry
  sourceArchive?: string
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
  trust: RegistryTrustTier
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
  trust: RegistryTrustTier
  enabled?: boolean
}

export interface InstallerOptions {
  agentDir?: string
  appVersion?: string
  runtimeRoot?: string
  environmentsDir?: string
  platform?: PhiPlatform
  baseEnv?: NodeJS.ProcessEnv
  names?: PluginNamespace
  build?: PluginEnvironmentBuilder
  garbageCollect?: typeof collectGarbage
  now?: () => Date
}

export interface StagedPackage {
  entry: PlannedPackage
  dir: string
  source: PackageSourceMetadata
}

export interface SkillEnvironmentRecord {
  envId: string
  name: string
  kind: 'base' | 'package' | 'project'
  platform: PhiPlatform
  lockSha256: string
}
