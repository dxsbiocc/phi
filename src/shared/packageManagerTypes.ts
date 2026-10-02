export type PackageManagerType = 'skill' | 'plugin' | 'wrapper' | 'mcp'

export interface PackageRegistryEntryView {
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
  enabled?: boolean
}
