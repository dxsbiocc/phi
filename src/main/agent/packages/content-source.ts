import type { InstallerOptions, LocalRegistry, PackageRequest } from './installer-types'
import { addKnownRegistry } from './registries'
import { readRegistry } from './registry'
import {
  OFFICIAL_REGISTRY_ID,
  isOfficialRegistryDirectory,
  prepareOfficialPackageInstall,
  syncOfficialRegistry,
  type OfficialRegistryOptions
} from './official-registry'

/** Resolve the fixed official source without persisting its cache as a user directory. */
export async function readContentRegistry(
  source: string,
  options: OfficialRegistryOptions = {}
): Promise<LocalRegistry> {
  if (source === OFFICIAL_REGISTRY_ID || isOfficialRegistryDirectory(source, options.agentDir)) {
    return syncOfficialRegistry(options)
  }
  const registry = readRegistry(source)
  addKnownRegistry(registry.dir, options)
  return registry
}

/** Fetch only the selected official dependency closure before the existing installer runs. */
export async function prepareContentPackageInstall(
  registry: LocalRegistry,
  request: PackageRequest,
  options: OfficialRegistryOptions & Pick<InstallerOptions, 'appVersion'> = {}
): Promise<LocalRegistry> {
  return registry.id === OFFICIAL_REGISTRY_ID && registry.trust === 'official'
    ? prepareOfficialPackageInstall(registry, request, options)
    : registry
}
