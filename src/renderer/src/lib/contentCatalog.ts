import semver from 'semver'
import { resourceCatalogCopy, resourceSourceLabel } from './resourceUi'
import type {
  InstalledPackageView,
  KnownPackageRegistryView,
  PackageManagerType,
  PackageRegistryEntryView,
  PackageRegistryView
} from '../../../shared/packageManagerTypes'
import { errorMessage } from '../../../shared/errorCodes'

type ContentCatalogApi = {
  readOfficialContentCatalog?: (forceRefresh?: boolean) => Promise<PackageRegistryView>
  listPackageRegistries: () => Promise<KnownPackageRegistryView[]>
  readPackageRegistry: (path: string) => Promise<PackageRegistryView>
}

export interface ContentCatalogResult {
  registries: PackageRegistryView[]
  errors: string[]
  notices: string[]
}

/** Load the official source first; a failed source remains visible as feedback. */
export async function loadContentCatalog(
  api: ContentCatalogApi,
  options: { forceRefresh?: boolean } = {}
): Promise<ContentCatalogResult> {
  let officialRegistry: PackageRegistryView | undefined
  const errors: string[] = []
  const notices: string[] = []
  if (api.readOfficialContentCatalog) {
    try {
      officialRegistry = await api.readOfficialContentCatalog(options.forceRefresh)
    } catch (cause) {
      errors.push(resourceCatalogCopy.officialRefreshFailed(errorMessage(cause)))
      notices.push(resourceCatalogCopy.fallbackSource)
    }
  }
  let knownSources: KnownPackageRegistryView[] = []
  try {
    knownSources = await api.listPackageRegistries()
  } catch (cause) {
    errors.push(resourceCatalogCopy.sourceListFailed(errorMessage(cause)))
  }
  const backendNeedsRestart =
    !api.readOfficialContentCatalog &&
    knownSources.some((source) => source.kind === 'bundled') &&
    !knownSources.some((source) => source.kind === 'official')
  const sources = knownSources
    .filter(
      (source) => source.kind !== 'bundled' && !(officialRegistry && source.kind === 'official')
    )
    .sort((left, right) => Number(right.kind === 'official') - Number(left.kind === 'official'))
  if (api.readOfficialContentCatalog && !officialRegistry) {
    const index = sources.findIndex((source) => source.kind === 'official')
    const fallback: KnownPackageRegistryView = {
      id: 'phi-packages',
      kind: 'official',
      path: 'phi-packages',
      label: 'Phi Packages',
      removable: false
    }
    if (index < 0) sources.unshift(fallback)
    else sources[index] = fallback
  }
  const results = await Promise.all(
    sources.map(async (source) => {
      const label = resourceSourceLabel(
        source.label ?? (source.kind === 'official' ? 'Phi Packages' : source.id)
      )
      try {
        if (source.status === 'unavailable' || source.error) {
          throw new Error(source.error ?? source.notice ?? resourceCatalogCopy.sourceUnavailable)
        }
        const registry = await api.readPackageRegistry(source.path)
        const status = registry.status ?? (source.status === 'cached' ? 'cached' : 'ready')
        return {
          registry: {
            ...registry,
            kind: source.kind === 'official' ? ('official' as const) : ('directory' as const),
            label,
            status
          },
          notice:
            registry.notice ??
            source.notice ??
            (status === 'cached' ? resourceCatalogCopy.cachedSource(label) : undefined)
        }
      } catch (cause) {
        return { error: `${label}: ${errorMessage(cause)}` }
      }
    })
  )
  return {
    registries: [
      ...(officialRegistry
        ? [
            {
              ...officialRegistry,
              kind: 'official' as const,
              label: officialRegistry.label ?? 'Phi Packages'
            }
          ]
        : []),
      ...results.flatMap((result) => (result.registry ? [result.registry] : []))
    ],
    errors: [
      ...errors,
      ...(backendNeedsRestart ? [resourceCatalogCopy.restartBackend] : []),
      ...results.flatMap((result) => (result.error ? [result.error] : []))
    ],
    notices: [
      ...notices,
      ...(officialRegistry?.notice ? [officialRegistry.notice] : []),
      ...(officialRegistry?.status === 'cached' && !officialRegistry.notice
        ? [
            resourceCatalogCopy.cachedSource(
              resourceSourceLabel(officialRegistry.label ?? 'Phi Packages')
            )
          ]
        : []),
      ...results.flatMap((result) => (result.notice ? [result.notice] : []))
    ]
  }
}

/** Source preference applies before version selection; custom sources retain their own packages. */
export function catalogPackages(
  registries: readonly (PackageRegistryView | null)[],
  type: PackageManagerType
): Array<{ entry: PackageRegistryEntryView; registry: PackageRegistryView }> {
  const selected = new Map<
    string,
    { entry: PackageRegistryEntryView; registry: PackageRegistryView }
  >()
  for (const registry of registries) {
    if (!registry) continue
    for (const entry of registry.packages) {
      if (entry.type !== type) continue
      const current = selected.get(entry.id)
      const preferred = registry.kind === 'official'
      const currentPreferred = current?.registry.kind === 'official'
      if (
        !current ||
        (preferred && !currentPreferred) ||
        (preferred === currentPreferred && semver.gt(entry.version, current.entry.version))
      ) {
        selected.set(entry.id, { entry, registry })
      }
    }
  }
  return [...selected.values()].sort((left, right) =>
    left.entry.title.localeCompare(right.entry.title)
  )
}

export function installCatalogPackage(
  api: {
    installPackage: (
      registryDir: string,
      type: PackageManagerType,
      id: string,
      version: string
    ) => Promise<InstalledPackageView[]>
  },
  registryDir: string,
  entry: PackageRegistryEntryView
): Promise<InstalledPackageView[]> {
  return api.installPackage(registryDir, entry.type, entry.id, entry.version)
}
