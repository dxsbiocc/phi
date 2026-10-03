import { useCallback, useEffect, useState } from 'react'
import type { WrapperCompositionCatalogItem } from '../../../../../shared/wrapperCompositionManifestTypes'
import type { WrapperRun } from '../../../../../shared/wrapperTypes'
import { retainSelectedCatalogId } from '../../../lib/catalogSelection'

export type WrapperCatalogState = {
  catalog: WrapperCompositionCatalogItem[]
  runs: WrapperRun[]
  selectedWrapperId: string | null
  isLoadingWrappers: boolean
  wrapperError: string | null
  packageEnablementBusy: boolean
  setSelectedWrapperId: (id: string | null) => void
  refreshWrappers: () => Promise<void>
  /** Reloads only the run list — no loading flag, no catalog swap, so nothing but the run views re-render. */
  refreshRuns: () => Promise<void>
  cancelWrapperRun: (runId: string) => Promise<void>
  exportWrapperReproducibility: (runId: string) => Promise<void>
  setPackageEnabled: (packageId: string, enabled: boolean) => Promise<void>
}

/**
 * Reads package-aware composition entries from the assembled wrapper tree
 * plus user-authored entries under `wrappers/custom/`. Disabled entries stay
 * in this renderer catalog with a reason, while agent tools receive only the
 * available subset from the same discovery layer.
 */
export function useWrapperCatalog(): WrapperCatalogState {
  const [catalog, setCatalog] = useState<WrapperCompositionCatalogItem[]>([])
  const [runs, setRuns] = useState<WrapperRun[]>([])
  const [selectedWrapperId, setSelectedWrapperId] = useState<string | null>(null)
  const [isLoadingWrappers, setIsLoadingWrappers] = useState(true)
  const [wrapperError, setWrapperError] = useState<string | null>(null)
  const [packageEnablementBusy, setPackageEnablementBusy] = useState(false)

  const refreshWrappers = useCallback(async (): Promise<void> => {
    setIsLoadingWrappers(true)
    setWrapperError(null)
    try {
      const [catalogList, runList] = await Promise.all([
        window.api.listWrapperCompositionCatalog(),
        window.api.listWrapperRuns()
      ])
      setCatalog(catalogList)
      setRuns(runList)
      setSelectedWrapperId((current) => retainSelectedCatalogId(current, catalogList))
    } catch (err) {
      setWrapperError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoadingWrappers(false)
    }
  }, [])

  const refreshRuns = useCallback(async (): Promise<void> => {
    try {
      setRuns(await window.api.listWrapperRuns())
    } catch {
      // A failed quiet refresh keeps the runs already shown.
    }
  }, [])

  const exportWrapperReproducibility = useCallback(async (runId: string): Promise<void> => {
    try {
      await window.api.exportWrapperReproducibility(runId)
    } catch (err) {
      setWrapperError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const cancelWrapperRun = useCallback(async (runId: string): Promise<void> => {
    try {
      await window.api.cancelWrapperRun(runId)
    } catch (err) {
      setWrapperError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const setPackageEnabled = useCallback(
    async (packageId: string, enabled: boolean): Promise<void> => {
      setPackageEnablementBusy(true)
      setWrapperError(null)
      try {
        await window.api.setEnablement(`wrapper:${packageId}`, enabled, { type: 'global' })
        await refreshWrappers()
      } catch (err) {
        setWrapperError(err instanceof Error ? err.message : String(err))
      } finally {
        setPackageEnablementBusy(false)
      }
    },
    [refreshWrappers]
  )

  useEffect(() => {
    void Promise.resolve().then(() => refreshWrappers())
  }, [refreshWrappers])

  // Background runs change on their own (progress, finish, cancel): reload just the
  // run list when the main process says so, coalescing a burst into one reload.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = window.api.onWrapperRunsChanged(() => {
      if (timer) return
      timer = setTimeout(() => {
        timer = undefined
        window.api
          .listWrapperRuns()
          .then(setRuns)
          .catch(() => undefined)
      }, 300)
    })
    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [])

  return {
    catalog,
    runs,
    selectedWrapperId,
    isLoadingWrappers,
    wrapperError,
    packageEnablementBusy,
    setSelectedWrapperId,
    refreshWrappers,
    refreshRuns,
    cancelWrapperRun,
    exportWrapperReproducibility,
    setPackageEnabled
  }
}
