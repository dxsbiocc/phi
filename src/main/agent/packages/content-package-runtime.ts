import type { EnvironmentBuilds } from '../content/environment-builds'
import { errorMessage } from '../../../shared/errorCodes'
import {
  loadKnownRegistryIndexes,
  listPackageUpdates,
  type KnownRegistryListOptions,
  type LoadedKnownRegistries,
  type PackageUpdate
} from './installer'
import type { InstallerOptions, LocalRegistry } from './installer-types'
import type { PackageType } from './manifest'
import { syncOfficialConnectorRegistry } from './official-connector-registry'
import type { OfficialRegistryOptions } from './official-registry'
import { syncPreferredOfficialRegistry } from './official-website-registry'

export interface ContentPackageRuntimeOperations {
  loadKnownRegistryIndexes: (options: KnownRegistryListOptions) => Promise<LoadedKnownRegistries>
  syncOfficialConnectorRegistry: (options: OfficialRegistryOptions) => Promise<LocalRegistry>
  syncPreferredOfficialRegistry: (options: OfficialRegistryOptions) => Promise<LocalRegistry>
  listPackageUpdates: typeof listPackageUpdates
}

const defaultOperations: ContentPackageRuntimeOperations = {
  loadKnownRegistryIndexes,
  syncOfficialConnectorRegistry,
  syncPreferredOfficialRegistry,
  listPackageUpdates
}

export interface ContentPackageRuntimeDeps {
  getAgentDir: () => string
  getAppVersion: () => string
  registryFetch: typeof fetch
  environmentBuilds: Pick<EnvironmentBuilds, 'start'>
  configuredStdioTools: NonNullable<InstallerOptions['verifyMcpStdio']>
  replaceCachedPackageUpdates: (updates: PackageUpdate[]) => void
  getCachedPackageUpdates: () => PackageUpdate[]
  operations?: ContentPackageRuntimeOperations
}

export interface ContentPackageRuntime {
  officialContentSourceOptions: () => {
    agentDir: string
    appVersion: string
    fetch: typeof fetch
    buildMcpEnvironment: NonNullable<InstallerOptions['buildMcpEnvironment']>
    verifyMcpStdio: NonNullable<InstallerOptions['verifyMcpStdio']>
  }
  knownContentSourceOptions: (
    type?: PackageType,
    forceRefresh?: boolean
  ) => {
    agentDir: string
    loadOfficialRegistry: () => Promise<LocalRegistry>
  }
  loadPackageRegistries: (
    type?: PackageType,
    forceRefresh?: boolean
  ) => Promise<LoadedKnownRegistries>
  refreshCachedPackageUpdates: () => Promise<PackageUpdate[]>
}

export function packageUpdateViews(updates: readonly PackageUpdate[]): PackageUpdate[] {
  return [...updates]
}

function createContentSourceOptions(
  deps: ContentPackageRuntimeDeps,
  operations: ContentPackageRuntimeOperations
): Pick<ContentPackageRuntime, 'officialContentSourceOptions' | 'knownContentSourceOptions'> {
  function officialContentSourceOptions(): ReturnType<
    ContentPackageRuntime['officialContentSourceOptions']
  > {
    return {
      agentDir: deps.getAgentDir(),
      appVersion: deps.getAppVersion(),
      fetch: deps.registryFetch,
      buildMcpEnvironment: (descriptor) =>
        deps.environmentBuilds.start(descriptor, {
          ref: descriptor.ref,
          requestedBy: { mcp: descriptor.owner ?? descriptor.spec.name }
        }),
      verifyMcpStdio: (request) => deps.configuredStdioTools(request)
    }
  }

  function knownContentSourceOptions(
    type?: PackageType,
    forceRefresh = false
  ): ReturnType<ContentPackageRuntime['knownContentSourceOptions']> {
    return {
      agentDir: deps.getAgentDir(),
      loadOfficialRegistry: () =>
        (type === 'mcp'
          ? operations.syncOfficialConnectorRegistry
          : operations.syncPreferredOfficialRegistry)({
          ...officialContentSourceOptions(),
          forceRefresh
        })
    }
  }

  return { officialContentSourceOptions, knownContentSourceOptions }
}

export function createContentPackageRuntime(
  deps: ContentPackageRuntimeDeps
): ContentPackageRuntime {
  const operations = deps.operations ?? defaultOperations
  const { officialContentSourceOptions, knownContentSourceOptions } = createContentSourceOptions(
    deps,
    operations
  )

  async function loadPackageRegistries(
    type?: PackageType,
    forceRefresh = false
  ): Promise<LoadedKnownRegistries> {
    const loaded = await operations.loadKnownRegistryIndexes(
      knownContentSourceOptions(type ?? 'mcp', forceRefresh)
    )
    if (type) return loaded
    try {
      const website = await operations.syncPreferredOfficialRegistry({
        ...officialContentSourceOptions(),
        forceRefresh
      })
      return {
        ...loaded,
        registries: [
          ...loaded.registries,
          { ...website, packages: website.packages.filter((entry) => entry.type !== 'mcp') }
        ]
      }
    } catch (error) {
      return {
        ...loaded,
        errors: [...loaded.errors, `Phi 官网其他模块：${errorMessage(error)}`]
      }
    }
  }

  async function refreshCachedPackageUpdates(): Promise<PackageUpdate[]> {
    const loaded = await loadPackageRegistries()
    deps.replaceCachedPackageUpdates(
      operations.listPackageUpdates(loaded.registries, {
        agentDir: deps.getAgentDir(),
        appVersion: deps.getAppVersion()
      })
    )
    return deps.getCachedPackageUpdates()
  }

  return {
    officialContentSourceOptions,
    knownContentSourceOptions,
    loadPackageRegistries,
    refreshCachedPackageUpdates
  }
}
