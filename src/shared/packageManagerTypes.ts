export type PackageManagerType = 'skill' | 'plugin' | 'wrapper' | 'mcp'
export type PackageTrust = 'builtin' | 'official' | 'imported'

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
  preview?: string
}

export interface PackageRegistryView {
  id: string
  dir: string
  trust: PackageTrust
  schemaVersion: 1
  generatedAt: string
  packages: PackageRegistryEntryView[]
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
  kind: 'bundled' | 'directory'
  path: string
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
