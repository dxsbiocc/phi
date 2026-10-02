export { listInstalledPackages } from './installed'
export { installPackages, uninstallPackage, upgradePackage } from './lifecycle'
export { planInstall } from './planning'
export { readRegistry } from './registry'
export { cleanupStalePackageStaging } from './staging'

export type {
  InstalledPackage,
  InstallerOptions,
  InstallPlan,
  LocalRegistry,
  PackageRequest,
  PackageSourceMetadata,
  PlannedPackage,
  RegistryPackageEntry
} from './installer-types'
export type { PluginBuildOptions } from '../plugins/loader'
