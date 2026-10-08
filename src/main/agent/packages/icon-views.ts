import type { PackageRegistryView } from '../../../shared/packageManagerTypes'
import { registerResourceIconAsset } from '../resource-icons'
import type { LocalRegistry } from './installer-types'

/** Register verified sidecars without loading image bytes for the whole catalog. */
export function packageRegistryIconView(registry: LocalRegistry): PackageRegistryView {
  return {
    ...registry,
    packages: registry.packages.map((entry) => ({
      ...entry,
      ...(entry.iconAsset ? { icon: registerResourceIconAsset(registry.dir, entry.iconAsset) } : {})
    }))
  }
}
