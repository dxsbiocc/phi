import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  ManagedEnvironmentEntry,
  ManagedEnvironmentState
} from '../../../../../shared/environmentTypes'
import type { InstalledPackageView, PackageTrust } from '../../../../../shared/packageManagerTypes'
import type {
  PhiPluginListItem,
  PhiPluginMutationResult
} from '../../../../../shared/phiPluginTypes'
import { formatPhiPluginProblems } from '../lib/phiPlugins'

type PhiPluginWithComponents = PhiPluginListItem & {
  agents?: string[]
  skills?: string[]
  scriptTools?: string[]
  environments?: Array<{ name: string; ref: string }>
}

export type PhiPluginEnvironmentStatus = {
  name: string
  ref: string
  envId?: string
  state?: ManagedEnvironmentState
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

function managedEnvironmentsForPlugin(
  plugin: PhiPluginWithComponents,
  environments: readonly ManagedEnvironmentEntry[]
): PhiPluginEnvironmentStatus[] {
  const declarations = plugin.environments ?? []
  const managed = environments.filter(
    (environment) =>
      environment.source === 'plugin' &&
      environment.consumers.some(
        (consumer) => consumer.kind === 'plugin' && consumer.name === plugin.id
      )
  )
  const statuses: PhiPluginEnvironmentStatus[] = managed.map((environment) => {
    const declaration = declarations.find((item) => item.ref === environment.ref)
    return {
      name:
        declaration?.name ?? environment.label?.trim() ?? environment.ref.replace(/^plugin:/, ''),
      ref: environment.ref,
      envId: environment.envId,
      state: environment.state,
      ...(environment.error ? { error: environment.error } : {})
    }
  })

  for (const declaration of declarations) {
    if (statuses.some((status) => status.ref === declaration.ref)) continue
    statuses.push({ name: declaration.name, ref: declaration.ref })
  }

  return statuses
}

function withEnvironmentStatuses(
  plugins: readonly PhiPluginListItem[],
  environments: readonly ManagedEnvironmentEntry[],
  packages: readonly InstalledPackageView[]
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
      environmentStatuses: managedEnvironmentsForPlugin(enriched, environments)
    }
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
      const [installed, environments, packages] = await Promise.all([
        window.api.listPhiPlugins(),
        window.api.listManagedEnvironments().catch((): ManagedEnvironmentEntry[] => []),
        window.api.listInstalledPackages().catch((): InstalledPackageView[] => [])
      ])
      if (request !== requestRef.current) return
      setPlugins(withEnvironmentStatuses(installed, environments, packages))
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
