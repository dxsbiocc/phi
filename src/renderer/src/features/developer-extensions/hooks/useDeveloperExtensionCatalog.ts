import { useCallback, useEffect, useState } from 'react'
import type { PluginCatalogItem } from '../../../types'
import { retainSelectedCatalogId } from '../../../lib/catalogSelection'

export type DeveloperExtensionCatalogState = {
  extensions: PluginCatalogItem[]
  activeExtensionId: string | null
  isLoadingExtensions: boolean
  busyExtensionSource: string | null
  extensionOperationError: string | null
  setActiveExtensionId: (id: string | null) => void
  refreshExtensions: () => Promise<void>
  installExtension: (source: string) => Promise<void>
  removeExtension: (source: string) => Promise<void>
}

export function useDeveloperExtensionCatalog(): DeveloperExtensionCatalogState {
  const [extensions, setExtensions] = useState<PluginCatalogItem[]>([])
  const [activeExtensionId, setActiveExtensionId] = useState<string | null>(null)
  const [isLoadingExtensions, setIsLoadingExtensions] = useState(false)
  const [busyExtensionSource, setBusyExtensionSource] = useState<string | null>(null)
  const [extensionOperationError, setExtensionOperationError] = useState<string | null>(null)

  const refreshExtensions = useCallback(async (): Promise<void> => {
    setIsLoadingExtensions(true)
    setExtensionOperationError(null)
    try {
      const list = await window.api.listPlugins()
      setExtensions(list)
      setActiveExtensionId((current) => retainSelectedCatalogId(current, list))
    } finally {
      setIsLoadingExtensions(false)
    }
  }, [])

  const installExtension = useCallback(async (source: string): Promise<void> => {
    setBusyExtensionSource(source)
    setExtensionOperationError(null)
    try {
      const list = await window.api.installPlugin(source)
      setExtensions(list)
    } catch (error) {
      setExtensionOperationError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyExtensionSource(null)
    }
  }, [])

  const removeExtension = useCallback(async (source: string): Promise<void> => {
    setBusyExtensionSource(source)
    setExtensionOperationError(null)
    try {
      const list = await window.api.removePlugin(source)
      setExtensions(list)
    } catch (error) {
      setExtensionOperationError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyExtensionSource(null)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshExtensions()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [refreshExtensions])

  return {
    extensions,
    activeExtensionId,
    isLoadingExtensions,
    busyExtensionSource,
    extensionOperationError,
    setActiveExtensionId,
    refreshExtensions,
    installExtension,
    removeExtension
  }
}
