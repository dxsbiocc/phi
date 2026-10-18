import type { InstallerOptions, LocalRegistry, PackageRequest } from './installer-types'
import { addKnownRegistry } from './registries'
import { readRegistry } from './registry'
import {
  isOfficialConnectorRegistryDirectory,
  readOfficialConnectorRegistry
} from './official-connector-registry'
import {
  OFFICIAL_REGISTRY_ID,
  isOfficialRegistryDirectory,
  prepareOfficialPackageInstall,
  type OfficialRegistryOptions
} from './official-registry'
import {
  isOfficialWebsiteRegistryDirectory,
  readOfficialWebsiteRegistry,
  syncPreferredOfficialRegistry
} from './official-website-registry'

/** Resolve the fixed official source without persisting its cache as a user directory. */
export async function readContentRegistry(
  source: string,
  options: OfficialRegistryOptions = {}
): Promise<LocalRegistry> {
  if (isOfficialConnectorRegistryDirectory(source, options.agentDir)) {
    return readOfficialConnectorRegistry(source, options)
  }
  if (source === OFFICIAL_REGISTRY_ID || isOfficialRegistryDirectory(source, options.agentDir)) {
    return syncPreferredOfficialRegistry(options)
  }
  if (isOfficialWebsiteRegistryDirectory(source, options.agentDir)) {
    return readOfficialWebsiteRegistry(source, options)
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
