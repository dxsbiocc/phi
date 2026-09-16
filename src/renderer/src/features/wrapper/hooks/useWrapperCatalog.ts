import { useCallback, useEffect, useState } from 'react'
import type { WrapperCatalogEntry } from '../../../../../shared/wrapperCatalogTypes'
import type { WrapperRun } from '../../../../../shared/wrapperTypes'

export type WrapperCatalogState = {
  catalog: WrapperCatalogEntry[]
  runs: WrapperRun[]
  selectedWrapperId: string | null
  isLoadingWrappers: boolean
  wrapperError: string | null
  isAddingWrapper: boolean
  setSelectedWrapperId: (id: string | null) => void
  refreshWrappers: () => Promise<void>
  addCustomWrapper: () => Promise<void>
  exportWrapperReproducibility: (runId: string) => Promise<void>
}

export function useWrapperCatalog(): WrapperCatalogState {
  const [catalog, setCatalog] = useState<WrapperCatalogEntry[]>([])
  const [runs, setRuns] = useState<WrapperRun[]>([])
  const [selectedWrapperId, setSelectedWrapperId] = useState<string | null>(null)
  const [isLoadingWrappers, setIsLoadingWrappers] = useState(true)
  const [wrapperError, setWrapperError] = useState<string | null>(null)
  const [isAddingWrapper, setIsAddingWrapper] = useState(false)

  const refreshWrappers = useCallback(async (): Promise<void> => {
    setIsLoadingWrappers(true)
    setWrapperError(null)
    try {
      const [catalogList, runList] = await Promise.all([
        window.api.listWrapperCatalog(),
        window.api.listWrapperRuns()
      ])
      setCatalog(catalogList)
      setRuns(runList)
      setSelectedWrapperId((current) => current ?? catalogList[0]?.manifest.id ?? null)
    } catch (err) {
      setWrapperError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoadingWrappers(false)
    }
  }, [])

  const addCustomWrapper = useCallback(async (): Promise<void> => {
    setIsAddingWrapper(true)
    setWrapperError(null)
    try {
      const sourceDir = await window.api.pickProjectDirectory()
      if (!sourceDir) return
      const entry = await window.api.addCustomWrapper(sourceDir)
      await refreshWrappers()
      setSelectedWrapperId(entry.manifest.id)
    } catch (err) {
      setWrapperError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsAddingWrapper(false)
    }
  }, [refreshWrappers])

  const exportWrapperReproducibility = useCallback(async (runId: string): Promise<void> => {
    try {
      await window.api.exportWrapperReproducibility(runId)
    } catch (err) {
      setWrapperError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void Promise.resolve().then(() => refreshWrappers())
  }, [refreshWrappers])

  return {
    catalog,
    runs,
    selectedWrapperId,
    isLoadingWrappers,
    wrapperError,
    isAddingWrapper,
    setSelectedWrapperId,
    refreshWrappers,
    addCustomWrapper,
    exportWrapperReproducibility
  }
}
