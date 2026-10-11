import { useCallback, useState } from 'react'

export interface PackageRemoval {
  /** The package being removed, if any. */
  removingId: string | null
  /** Why the last removal failed, e.g. which installed packages still need it. */
  error: string | null
  clearError: () => void
  remove: (id: string) => Promise<void>
}

/** One removal flow for every catalog and sidebar that offers it. */
export function usePackageRemoval(
  removePackage: (id: string) => Promise<unknown>,
  afterRemove: () => Promise<void> | void
): PackageRemoval {
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const remove = useCallback(
    async (id: string): Promise<void> => {
      if (removingId) return
      setRemovingId(id)
      setError(null)
      try {
        await removePackage(id)
        await afterRemove()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setRemovingId(null)
      }
    },
    [afterRemove, removePackage, removingId]
  )
  const clearError = useCallback(() => setError(null), [])
  return { removingId, error, clearError, remove }
}
