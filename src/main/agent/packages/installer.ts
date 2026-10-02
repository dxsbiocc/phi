export { listInstalledPackages } from './installed'
export { installPackages, uninstallPackage, upgradePackage } from './lifecycle'
export { planInstall } from './planning'
export {
  addKnownRegistry,
  BUNDLED_REGISTRY_ID,
  knownRegistriesPath,
  loadKnownRegistryIndexes,
  listKnownRegistries,
  readKnownRegistries,
  registryIdForPath,
  removeKnownRegistry
} from './registries'
export { readRegistry } from './registry'
export { cleanupStalePackageStaging } from './staging'
export { importOfflinePackage, previewOfflinePackageImport } from './offline-import'
export {
  applyPackageUpdate,
  applyPackageUpdates,
  computePackageUpdates,
  listPackageUpdates
} from './updates'
export {
  getWrapperCustomDir,
  getWrapperTreeDir,
  getWrapperTreeOwnershipPath,
  readWrapperTreeState
} from './wrapper-tree'

export type {
  InstalledPackage,
  InstallerOptions,
  InstallPlan,
  LocalRegistry,
  PackageRequest,
  PackageSourceMetadata,
  PlannedPackage,
  RegistryPackageEntry,
  RegistryTrust,
  RegistryTrustTier
} from './installer-types'
export type { ReadRegistryOptions } from './registry'
export type { OfflinePackageImportOptions, OfflinePackageImportPreview } from './offline-import'
export type {
  KnownRegistriesState,
  KnownRegistryDetails,
  KnownRegistryListOptions,
  KnownRegistryListResult,
  LoadedKnownRegistries,
  KnownRegistryMutationOptions,
  StoredKnownRegistry
} from './registries'
export type { RegistrySignature, TrustedRegistryKey } from './signature'
export type { PackageUpdate, PackageUpdateOptions } from './updates'
export type { PluginBuildOptions } from '../plugins/loader'
export type { WrapperTreePackageState, WrapperTreeRegistry, WrapperTreeState } from './wrapper-tree'
