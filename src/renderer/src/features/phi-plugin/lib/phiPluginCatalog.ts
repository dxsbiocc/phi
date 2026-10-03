import type {
  PackageRegistryEntryView,
  PackageTrust,
  PackageUpdateView
} from '../../../../../shared/packageManagerTypes'

export type PhiPluginCatalogEntry = PackageRegistryEntryView & {
  registryPath: string
  trust: PackageTrust
}

export type PhiPluginCatalogAction = 'install' | 'update' | 'installed'

export function phiPluginCatalogAction(
  entry: PhiPluginCatalogEntry,
  installedIds: ReadonlySet<string>,
  updates: readonly PackageUpdateView[]
): PhiPluginCatalogAction {
  if (updates.some((update) => update.type === 'plugin' && update.id === entry.id)) return 'update'
  return installedIds.has(entry.id) ? 'installed' : 'install'
}
