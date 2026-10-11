import { useCallback, useState } from 'react'

export interface WrapperPackageRemoval {
  /** The package being removed, if any. */
  removingId: string | null
  /** Why the last removal failed, e.g. which enabled packages still need it. */
  error: string | null
  clearError: () => void
  remove: (id: string) => Promise<void>
}

/** One removal flow for every place that offers it (sidebar, catalog). */
export function useWrapperPackageRemoval(
  afterRemove: () => Promise<void> | void
): WrapperPackageRemoval {
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const remove = useCallback(
    async (id: string): Promise<void> => {
      if (removingId) return
      setRemovingId(id)
      setError(null)
      try {
        await window.api.removeWrapperPackage(id)
        await afterRemove()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setRemovingId(null)
      }
    },
    [afterRemove, removingId]
  )
  const clearError = useCallback(() => setError(null), [])
  return { removingId, error, clearError, remove }
}
