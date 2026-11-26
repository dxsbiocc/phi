import type {
  ManagedEnvironmentCheckResult,
  ManagedEnvironmentCleanResult,
  ManagedEnvironmentEntry,
  ManagedEnvironmentRemoveOptions,
  ManagedEnvironmentRemoveResult,
  ManagedEnvironmentTrimCacheResult
} from '../../../../../shared/environmentTypes'

export type ManagedEnvironmentRendererApi = {
  listManagedEnvironments: (
    projectCwd?: string,
    includeDynamic?: boolean
  ) => Promise<ManagedEnvironmentEntry[]>
  buildManagedEnvironment: (
    ref: string,
    projectCwd?: string,
    pluginId?: string
  ) => Promise<{ envId: string }>
  rebuildManagedEnvironment: (envId: string) => Promise<void>
  checkManagedEnvironment: (envId: string) => Promise<ManagedEnvironmentCheckResult>
  removeManagedEnvironment: (
    envId: string,
    options?: ManagedEnvironmentRemoveOptions
  ) => Promise<ManagedEnvironmentRemoveResult>
  cleanManagedEnvironments: () => Promise<ManagedEnvironmentCleanResult>
  trimManagedEnvironmentCache: () => Promise<ManagedEnvironmentTrimCacheResult>
}

const GLOBAL_ENVIRONMENT_SCOPE = '<global>'
const managedEnvironmentCache = new Map<string, ManagedEnvironmentEntry[]>()
const managedEnvironmentRefreshes = new Map<string, Promise<ManagedEnvironmentEntry[]>>()

function cacheKey(projectCwd?: string): string {
  return projectCwd?.trim() || GLOBAL_ENVIRONMENT_SCOPE
}

export function readManagedEnvironmentCache(
  projectCwd?: string
): readonly ManagedEnvironmentEntry[] | undefined {
  return managedEnvironmentCache.get(cacheKey(projectCwd))
}

export function writeManagedEnvironmentCache(
  projectCwd: string | undefined,
  environments: readonly ManagedEnvironmentEntry[]
): void {
  managedEnvironmentCache.set(cacheKey(projectCwd), [...environments])
}

export async function refreshManagedEnvironmentCache(
  projectCwd: string | undefined,
  loader: () => Promise<ManagedEnvironmentEntry[]>,
  options: { force?: boolean; scope?: string } = {}
): Promise<ManagedEnvironmentEntry[]> {
  const key = cacheKey(projectCwd)
  const refreshKey = `${key}\0${options.scope ?? 'default'}`
  const pending = managedEnvironmentRefreshes.get(refreshKey)
  if (pending && !options.force) return pending
  if (pending && options.force) {
    await pending.catch(() => undefined)
  }

  const refresh = loader()
    .then((environments) => {
      writeManagedEnvironmentCache(projectCwd, environments)
      return environments
    })
    .finally(() => {
      if (managedEnvironmentRefreshes.get(refreshKey) === refresh) {
        managedEnvironmentRefreshes.delete(refreshKey)
      }
    })
  managedEnvironmentRefreshes.set(refreshKey, refresh)
  return refresh
}

export function clearManagedEnvironmentCache(): void {
  managedEnvironmentCache.clear()
  managedEnvironmentRefreshes.clear()
}
