import type { collectGarbage, PhiPlatform } from '../envs'
import type { PluginEnvironmentBuilder, PluginNamespace } from '../plugins/loader'
import type { PackageDependency, PackageRequirements, PackageType } from './manifest'
import type { RegistryIconAsset } from '../../../shared/resourceIconTypes'
import type { RegistryManifestAsset } from './manifest-assets'
import type { EnvironmentDescriptor } from '../content/environment-refs'
import type { EnvHandle } from '../envs/execution'
import type { CatalogSkillGroup, PackageChangelogEntry } from '../../../shared/packageManagerTypes'

export type RegistryTrust = 'builtin' | 'official' | 'imported'
export type RegistryTrustTier = RegistryTrust

export type TeamResourceSharing = 'team-only' | 'forwardable'

export interface TeamResourceOrigin {
  teamId: string
  teamName: string
  teamKeyId: string
}

export interface TeamResourceMetadata {
  sharing: TeamResourceSharing
  originalSource?: TeamResourceOrigin
}

export type TeamResourceMap = Record<string, TeamResourceMetadata>

export interface InstalledTeamResourceSource extends TeamResourceOrigin {
  release: number
  sharing: TeamResourceSharing
  originalSource?: TeamResourceOrigin
}

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
  /** Website/official API presentation copy; absent in older caches and other registries. */
  overview?: string
  directoryAuthBlocked?: boolean
  group?: string
  groupLabel?: string
  groupOrder?: number
  preview?: string
  iconAsset?: RegistryIconAsset
  manifestAsset?: RegistryManifestAsset
  /** Release notes parsed from the package CHANGELOG.md, newest first. */
  changelog?: PackageChangelogEntry[]
}

export interface LocalRegistry {
  kind?: 'official' | 'directory'
  source?:
    | { kind: 'github'; repo: string; sha: string; ref?: string; id: string }
    | {
        kind: 'team'
        id: string
        teamId: string
        teamName: string
        teamKeyId: string
        release: number
        resources: TeamResourceMap
      }
  label?: string
  status?: 'ready' | 'cached'
  notice?: string
  refreshedAt?: string
  id: string
  dir: string
  trust: RegistryTrustTier
  schemaVersion: 1
  generatedAt: string
  packages: RegistryPackageEntry[]
  skillGroups?: CatalogSkillGroup[]
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
  teamSource?: InstalledTeamResourceSource
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
  teamSource?: InstalledTeamResourceSource
}

export interface InstallerOptions {
  agentDir?: string
  /** Revalidate a caller's cancellation/run authorization at every commit boundary. */
  beforeCommit?: () => void
  /** Retire old wrapper owners in the same tree transaction as their replacements. */
  retireWrapperPackageIds?: readonly string[]
  appVersion?: string
  runtimeRoot?: string
  environmentsDir?: string
  platform?: PhiPlatform
  baseEnv?: NodeJS.ProcessEnv
  names?: PluginNamespace
  build?: PluginEnvironmentBuilder
  buildMcpEnvironment?: (descriptor: EnvironmentDescriptor) => Promise<EnvHandle>
  verifyMcpStdio?: (request: {
    name: string
    entry: Record<string, unknown>
    environment: {
      root: string
      agentDir: string
      environmentsDir?: string
      platform?: PhiPlatform
    }
  }) => Promise<string[]>
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
