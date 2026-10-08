import semver from 'semver'
import type {
  InstalledPackageView,
  KnownPackageRegistryView,
  PackageManagerType,
  PackageRegistryEntryView,
  PackageRegistryView
} from '../../../shared/packageManagerTypes'

type ContentCatalogApi = {
  listPackageRegistries: () => Promise<KnownPackageRegistryView[]>
  readPackageRegistry: (path: string) => Promise<PackageRegistryView>
}

export interface ContentCatalogResult {
  registries: PackageRegistryView[]
  errors: string[]
  notices: string[]
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Load the official source first; a failed source remains visible as feedback. */
export async function loadContentCatalog(api: ContentCatalogApi): Promise<ContentCatalogResult> {
  const sources = (await api.listPackageRegistries())
    .filter((source) => source.kind !== 'bundled')
    .sort((left, right) => Number(right.kind === 'official') - Number(left.kind === 'official'))
  const results = await Promise.all(
    sources.map(async (source) => {
      const label = source.label ?? (source.kind === 'official' ? 'Phi Packages' : source.id)
      try {
        if (source.status === 'unavailable' || source.error) {
          throw new Error(source.error ?? source.notice ?? '软件源暂时不可用')
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
            (status === 'cached' ? `${label}：正在使用离线缓存。` : undefined)
        }
      } catch (cause) {
        return { error: `${label}：${message(cause)}` }
      }
    })
  )
  return {
    registries: results.flatMap((result) => (result.registry ? [result.registry] : [])),
    errors: results.flatMap((result) => (result.error ? [result.error] : [])),
    notices: results.flatMap((result) => (result.notice ? [result.notice] : []))
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
