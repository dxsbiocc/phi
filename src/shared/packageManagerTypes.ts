import type { WrapperCompositionManifest } from './wrapperCompositionManifestTypes'
import type { WrapperModuleDetails } from './wrapperModuleDetailsTypes'

export type PackageManagerType = 'skill' | 'plugin' | 'wrapper' | 'mcp'
export type PackageTrust = 'builtin' | 'official' | 'imported'

export interface CatalogSkillGroup {
  id: string
  label: string
  count: number
}

export interface PackageRegistryEntryView {
  icon?: ResourceIconRef
  id: string
  type: PackageManagerType
  version: string
  title: string
  summary: string
  archive: string
  sha256: string
  size: number
  minAppVersion?: string
  dependsOn: Array<{ id: string; type: PackageManagerType; version: string }>
  requires?: { coreTools?: string[] }
  category?: string
  directoryAuthBlocked?: boolean
  group?: string
  groupLabel?: string
  groupOrder?: number
  preview?: string
}

export interface PackageRegistryView {
  id: string
  dir: string
  kind?: 'official' | 'directory'
  label?: string
  status?: 'ready' | 'cached'
  notice?: string
  refreshedAt?: string
  trust: PackageTrust
  schemaVersion: 1
  generatedAt: string
  packages: PackageRegistryEntryView[]
  skillGroups?: CatalogSkillGroup[]
}

export interface PackageInstallPlanView {
  registry: PackageRegistryView
  root: { type: PackageManagerType; id: string; version: string }
  packages: Array<PackageRegistryEntryView & { installedBy: 'user' | 'dependency' }>
  totalSize: number
  environments: string[]
  agentDir: string
}

export interface InstalledPackageView {
  icon?: ResourceIconRef
  id: string
  type: PackageManagerType
  version: string
  title: string
  summary: string
  dir: string
  installedAt: string
  installedBy: 'user' | 'dependency'
  registry: string
  sha256: string
  trust: PackageTrust
  enabled?: boolean
}

export interface KnownPackageRegistryView {
  id: string
  kind: 'official' | 'bundled' | 'directory'
  path: string
  label?: string
  status?: 'ready' | 'cached' | 'unavailable'
  notice?: string
  refreshedAt?: string
  addedAt?: string
  removable: boolean
  trust?: PackageTrust
  packageCount?: number
  error?: string
}

export interface PackageUpdateView {
  id: string
  type: PackageManagerType
  title: string
  currentVersion: string
  newVersion: string
  registryId: string
  registryPath: string
  trust: PackageTrust
}

export interface OfflinePackageImportPreview {
  archivePath: string
  plan: PackageInstallPlanView
}
import type { ResourceIconRef } from './resourceIconTypes'

/** The wrappers inside one wrapper package, read from the local tree or the verified archive. */
/** A wrapper with the extra files the detail page shows beside its manifest. */
export interface WrapperPackageMember extends WrapperCompositionManifest {
  /** Mermaid DAG next to the wrapper, when one was generated. */
  dag?: string
  /** The component's `meta.yml` / `environment.yml`. */
  details?: WrapperModuleDetails
}

export interface WrapperPackageDetailView {
  id: string
  version: string
  source: 'installed' | 'registry'
  wrappers: WrapperPackageMember[]
  /** Wrapper manifests in the package that could not be parsed. */
  skipped: number
}

/** Another wrapper package that keeps this one enabled and would be disabled by its removal. */
export interface WrapperRemovalDependent {
  id: string
  name: string
}

/** What confirming a wrapper removal will do, before anything is changed. */
export interface WrapperRemovalPreview {
  id: string
  name: string
  /** Enabled packages that depend on this one; removal disables them first. */
  dependents: WrapperRemovalDependent[]
}

export interface WrapperRemovalView {
  id: string
  /** Enabled dependents that were switched off so the removal could proceed. */
  disabledDependents: WrapperRemovalDependent[]
}

/** What the catalog shows for one skill package before it is installed. */
export interface SkillPackageDetailView {
  id: string
  version: string
  source: 'installed' | 'registry'
  /** The package's raw SKILL.md, or null when it cannot be read. */
  skillMd: string | null
}
