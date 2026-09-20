import { useCallback, useEffect, useState } from 'react'
import type { WrapperCompositionManifest } from '../../../../../shared/wrapperCompositionManifestTypes'
import type { WrapperRun } from '../../../../../shared/wrapperTypes'

export type WrapperCatalogState = {
  catalog: WrapperCompositionManifest[]
  runs: WrapperRun[]
  selectedWrapperId: string | null
  isLoadingWrappers: boolean
  wrapperError: string | null
  setSelectedWrapperId: (id: string | null) => void
  refreshWrappers: () => Promise<void>
  /** Reloads only the run list — no loading flag, no catalog swap, so nothing but the run views re-render. */
  refreshRuns: () => Promise<void>
  cancelWrapperRun: (runId: string) => Promise<void>
  exportWrapperReproducibility: (runId: string) => Promise<void>
}

/**
 * Reads the agent's own composition catalog — the same bundled
 * `resources/wrappers/{modules,subworkflows,workflows}/**\/wrapper/wrapper.yaml`
 * scan the `wrapper_search`/`wrapper_run` agent tools use (see
 * `src/main/agent/wrappers/composition/discovery.ts`) — rather than the
 * legacy `~/.phi/wrappers/installed` catalog (`listWrapperCatalog`), which
 * nothing keeps in sync with it: that legacy catalog's bundled-install path
 * is dead (`BUNDLED_WRAPPER_PACKAGE_DIRS` is empty), so it would just show
 * nothing for every wrapper actually shipped today. There is currently no
 * "add custom wrapper" affordance here to match: a legacy custom install
 * writes a full `WrapperManifest`-shaped `wrapper.yaml`, which this
 * composition catalog can't parse, and — separately — discovery only scans
 * the bundled resources tree, not `~/.phi/wrappers/installed`, so a legacy
 * custom install was never reachable by the agent's own tools either.
 */
export function useWrapperCatalog(): WrapperCatalogState {
  const [catalog, setCatalog] = useState<WrapperCompositionManifest[]>([])
  const [runs, setRuns] = useState<WrapperRun[]>([])
  const [selectedWrapperId, setSelectedWrapperId] = useState<string | null>(null)
  const [isLoadingWrappers, setIsLoadingWrappers] = useState(true)
  const [wrapperError, setWrapperError] = useState<string | null>(null)

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
      setSelectedWrapperId((current) => current ?? catalogList[0]?.id ?? null)
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
    setSelectedWrapperId,
    refreshWrappers,
    refreshRuns,
    cancelWrapperRun,
    exportWrapperReproducibility
  }
}
