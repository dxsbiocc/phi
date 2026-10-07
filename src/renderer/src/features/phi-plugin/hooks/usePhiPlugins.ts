import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  EnvironmentBuild,
  EnvironmentBuildEstimate
} from '../../../../../shared/environmentBuildTypes'
import type {
  ManagedEnvironmentEntry,
  ManagedEnvironmentState
} from '../../../../../shared/environmentTypes'
import type { InstalledPackageView, PackageTrust } from '../../../../../shared/packageManagerTypes'
import type {
  PhiPluginListItem,
  PhiPluginMutationResult,
  PhiPluginUsedEnvironment
} from '../../../../../shared/phiPluginTypes'
import { formatPhiPluginProblems } from '../lib/phiPlugins'

type PhiPluginWithComponents = PhiPluginListItem

export type PhiPluginEnvironmentStatus = {
  name: string
  ref: string
  description?: string
  scope: PhiPluginUsedEnvironment['scope']
  skillNames: string[]
  agentNames: string[]
  warnings: string[]
  envId?: string
  state?: ManagedEnvironmentState
  estimate?: EnvironmentBuildEstimate
  build?: EnvironmentBuild
  error?: string
}

export type PhiPluginDisplayItem = PhiPluginWithComponents & {
  distribution: 'bundled' | 'registry' | 'local'
  trust: PackageTrust
  environmentStatuses: PhiPluginEnvironmentStatus[]
}

export type PhiPluginsState = {
  plugins: PhiPluginDisplayItem[]
  loading: boolean
  busyPluginId: string | null
  error: string | null
  notice: string | null
  refresh: () => Promise<void>
  installFromDirectory: (path: string, description: string) => Promise<boolean>
  setEnabled: (plugin: PhiPluginDisplayItem, enabled: boolean) => Promise<boolean>
  uninstall: (plugin: PhiPluginDisplayItem) => Promise<boolean>
  showError: (message: string) => void
  clearError: () => void
  clearNotice: () => void
}

function readableError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function ownsPluginEnvironment(environment: ManagedEnvironmentEntry, pluginId: string): boolean {
  return (
    environment.pluginId === pluginId ||
    environment.consumers.some(
      (consumer) => consumer.kind === 'plugin' && consumer.name === pluginId
    )
  )
}

function managedEntryForUsage(
  usage: PhiPluginUsedEnvironment,
  pluginId: string,
  environments: readonly ManagedEnvironmentEntry[]
): ManagedEnvironmentEntry | undefined {
  const candidates = environments.filter((environment) => environment.ref === usage.ref)
  if (usage.scope === 'builtin') {
    return candidates.find((entry) => entry.source === 'official')
  }
  if (usage.scope === 'project') {
    return candidates.find((entry) => entry.source === 'project')
  }
  if (usage.scope === 'private') {
    return candidates.find(
      (entry) => entry.source === 'plugin' && ownsPluginEnvironment(entry, pluginId)
    )
  }
  return undefined
}

function environmentUsagesForPlugin(
  plugin: PhiPluginWithComponents,
  environments: readonly ManagedEnvironmentEntry[]
): PhiPluginUsedEnvironment[] {
  const usages = [...(plugin.usedEnvironments ?? [])]
  for (const declaration of plugin.environments ?? []) {
    if (usages.some((usage) => usage.ref === declaration.ref)) continue
    usages.push({ ...declaration, scope: 'private', skillNames: [], agentNames: [] })
  }
  if (plugin.usedEnvironments !== undefined) return usages
  for (const entry of environments) {
    if (entry.source !== 'plugin' || !ownsPluginEnvironment(entry, plugin.id)) continue
    if (usages.some((usage) => usage.ref === entry.ref)) continue
    usages.push({
      ref: entry.ref,
      name: entry.label?.trim() || entry.ref.replace(/^plugin:/, ''),
      scope: 'private',
      skillNames: [],
      agentNames: []
    })
  }
  return usages
}

function environmentStatus(
  usage: PhiPluginUsedEnvironment,
  pluginId: string,
  environments: readonly ManagedEnvironmentEntry[],
  builds: readonly EnvironmentBuild[]
): PhiPluginEnvironmentStatus {
  const managed = managedEntryForUsage(usage, pluginId, environments)
  const build = builds.find((candidate) => candidate.envId === managed?.envId)
  return {
    name: managed?.label?.trim() || usage.name,
    ref: usage.ref,
    ...(managed?.description?.trim() || usage.description
      ? { description: managed?.description?.trim() || usage.description }
      : {}),
    scope: usage.scope,
    skillNames: usage.skillNames,
    agentNames: usage.agentNames,
    warnings: usage.warnings ?? [],
    ...(managed?.envId ? { envId: managed.envId } : {}),
    ...(managed?.state ? { state: managed.state } : {}),
    ...(managed?.estimate || build?.estimate
      ? { estimate: managed?.estimate ?? build?.estimate }
      : {}),
    ...(build ? { build } : {}),
    ...(managed?.error ? { error: managed.error } : {})
  }
}

export function managedEnvironmentsForPlugin(
  plugin: PhiPluginWithComponents,
  environments: readonly ManagedEnvironmentEntry[],
  builds: readonly EnvironmentBuild[]
): PhiPluginEnvironmentStatus[] {
  return environmentUsagesForPlugin(plugin, environments).map((usage) =>
    environmentStatus(usage, plugin.id, environments, builds)
  )
}

function withEnvironmentStatuses(
  plugins: readonly PhiPluginListItem[],
  environments: readonly ManagedEnvironmentEntry[],
  packages: readonly InstalledPackageView[],
  builds: readonly EnvironmentBuild[]
): PhiPluginDisplayItem[] {
  const registryPlugins = new Map(
    packages.filter((item) => item.type === 'plugin').map((item) => [item.id, item])
  )
  return plugins.map((plugin) => {
    const enriched = plugin as PhiPluginWithComponents
    const installedPackage = registryPlugins.get(plugin.id)
    return {
      ...enriched,
      distribution:
        plugin.source === 'bundled' ? 'bundled' : installedPackage ? 'registry' : 'local',
      trust: plugin.source === 'bundled' ? 'builtin' : (installedPackage?.trust ?? 'imported'),
      environmentStatuses: managedEnvironmentsForPlugin(enriched, environments, builds)
    }
  })
}

export function applyEnvironmentBuildToPlugins(
  plugins: readonly PhiPluginDisplayItem[],
  build: EnvironmentBuild
): PhiPluginDisplayItem[] {
  const state: ManagedEnvironmentState = build.state === 'cancelled' ? 'failed' : build.state
  return plugins.map((plugin) => {
    let changed = false
    const environmentStatuses = plugin.environmentStatuses.map((environment) => {
      if (environment.envId !== build.envId) return environment
      changed = true
      const next: PhiPluginEnvironmentStatus = {
        ...environment,
        state,
        estimate: build.estimate,
        build
      }
      if (state === 'failed') next.error = build.error ?? build.message
      else delete next.error
      return next
    })
    return changed ? { ...plugin, environmentStatuses } : plugin
  })
}

export function usePhiPlugins(): PhiPluginsState {
  const [plugins, setPlugins] = useState<PhiPluginDisplayItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busyPluginId, setBusyPluginId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const requestRef = useRef(0)

  const load = useCallback(async (clearFeedback: boolean): Promise<void> => {
    const request = ++requestRef.current
    setLoading(true)
    if (clearFeedback) {
      setError(null)
      setNotice(null)
    }
    try {
      const [installed, environments, packages, builds] = await Promise.all([
        window.api.listPhiPlugins(),
        window.api.listManagedEnvironments().catch((): ManagedEnvironmentEntry[] => []),
        window.api.listInstalledPackages().catch((): InstalledPackageView[] => []),
        typeof window.api.listEnvironmentBuilds === 'function'
          ? window.api.listEnvironmentBuilds().catch((): EnvironmentBuild[] => [])
          : Promise.resolve([] as EnvironmentBuild[])
      ])
      if (request !== requestRef.current) return
      setPlugins(withEnvironmentStatuses(installed, environments, packages, builds))
    } catch (cause) {
      if (request !== requestRef.current) return
      setError(`无法读取插件：${readableError(cause)}`)
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }, [])

  const refresh = useCallback(() => load(true), [load])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(false), 0)
    return () => {
      window.clearTimeout(timer)
      requestRef.current += 1
    }
  }, [load])

  useEffect(() => {
    if (typeof window.api.onEnvironmentBuildsChanged !== 'function') return undefined
    return window.api.onEnvironmentBuildsChanged((build) => {
      setPlugins((current) => applyEnvironmentBuildToPlugins(current, build))
    })
  }, [])

  const runMutation = useCallback(
    async ({
      busyId,
      action,
      failurePrefix,
      successMessage
    }: {
      busyId: string
      action: () => Promise<PhiPluginMutationResult>
      failurePrefix: string
      successMessage: string
    }): Promise<boolean> => {
      setBusyPluginId(busyId)
      setError(null)
      setNotice(null)
      let succeeded = false
      try {
        const result = await action()
        if (!result.ok) {
          setError(`${failurePrefix}：${formatPhiPluginProblems(result.problems)}`)
        } else {
          succeeded = true
          const warning = result.problems.length
            ? `\n${formatPhiPluginProblems(result.problems)}`
            : ''
          setNotice(`${successMessage}${warning}`)
        }
      } catch (cause) {
        setError(`${failurePrefix}：${readableError(cause)}`)
      } finally {
        await load(false)
        setBusyPluginId(null)
      }
      return succeeded
    },
    [load]
  )

  const installFromDirectory = useCallback(
    (path: string, description: string) =>
      runMutation({
        busyId: '__install__',
        action: () => window.api.installPhiPluginFromDirectory(path),
        failurePrefix: '插件安装失败',
        successMessage: `${description}完成。`
      }),
    [runMutation]
  )

  const setEnabled = useCallback(
    (plugin: PhiPluginDisplayItem, enabled: boolean) =>
      runMutation({
        busyId: plugin.id,
        action: () => window.api.setPhiPluginEnabled(plugin.id, enabled),
        failurePrefix: enabled ? '插件启用失败' : '插件停用失败',
        successMessage: `已${enabled ? '启用' : '停用'} ${plugin.title}。`
      }),
    [runMutation]
  )

  const uninstall = useCallback(
    (plugin: PhiPluginDisplayItem) =>
      runMutation({
        busyId: plugin.id,
        action: () => window.api.uninstallPhiPlugin(plugin.id),
        failurePrefix: '插件卸载失败',
        successMessage: `已卸载 ${plugin.title}。`
      }),
    [runMutation]
  )

  const showError = useCallback((message: string): void => {
    setNotice(null)
    setError(message)
  }, [])

  return {
    plugins,
    loading,
    busyPluginId,
    error,
    notice,
    refresh,
    installFromDirectory,
    setEnabled,
    uninstall,
    showError,
    clearError: () => setError(null),
    clearNotice: () => setNotice(null)
  }
}
