import { useCallback, useEffect, useState } from 'react'
import type { PluginCatalogItem } from '../../../types'
import { retainSelectedCatalogId } from '../../../lib/catalogSelection'

export type PluginCatalogState = {
  plugins: PluginCatalogItem[]
  activePluginId: string | null
  isLoadingPlugins: boolean
  busyPluginSource: string | null
  pluginOperationError: string | null
  setActivePluginId: (id: string | null) => void
  refreshPlugins: () => Promise<void>
  installPlugin: (source: string) => Promise<void>
  removePlugin: (source: string) => Promise<void>
}

export function usePluginCatalog(): PluginCatalogState {
  const [plugins, setPlugins] = useState<PluginCatalogItem[]>([])
  const [activePluginId, setActivePluginId] = useState<string | null>(null)
  const [isLoadingPlugins, setIsLoadingPlugins] = useState(false)
  const [busyPluginSource, setBusyPluginSource] = useState<string | null>(null)
  const [pluginOperationError, setPluginOperationError] = useState<string | null>(null)

  const refreshPlugins = useCallback(async (): Promise<void> => {
    setIsLoadingPlugins(true)
    setPluginOperationError(null)
    try {
      const list = await window.api.listPlugins()
      setPlugins(list)
      setActivePluginId((current) => retainSelectedCatalogId(current, list))
    } finally {
      setIsLoadingPlugins(false)
    }
  }, [])

  const installPlugin = useCallback(async (source: string): Promise<void> => {
    setBusyPluginSource(source)
    setPluginOperationError(null)
    try {
      const list = await window.api.installPlugin(source)
      setPlugins(list)
    } catch (error) {
      setPluginOperationError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyPluginSource(null)
    }
  }, [])

  const removePlugin = useCallback(async (source: string): Promise<void> => {
    setBusyPluginSource(source)
    setPluginOperationError(null)
    try {
      const list = await window.api.removePlugin(source)
      setPlugins(list)
    } catch (error) {
      setPluginOperationError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyPluginSource(null)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshPlugins()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [refreshPlugins])

  return {
    plugins,
    activePluginId,
    isLoadingPlugins,
    busyPluginSource,
    pluginOperationError,
    setActivePluginId,
    refreshPlugins,
    installPlugin,
    removePlugin
  }
}
