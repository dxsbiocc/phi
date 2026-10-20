import { useCallback, useState } from 'react'

import { useBusyKeys } from './useBusyKeys'
import { errorMessage } from '../../../../shared/errorCodes'

export interface PackageRemoval {
  /** Whether this package is being removed right now. */
  isRemoving: (id: string) => boolean
  /** Why the last removal failed, e.g. which installed packages still need it. */
  error: string | null
  clearError: () => void
  remove: (id: string) => Promise<void>
}

/** One removal flow for every catalog and sidebar that offers it; removals do not block each other. */
export function usePackageRemoval(
  removePackage: (id: string) => Promise<unknown>,
  afterRemove: () => Promise<void> | void
): PackageRemoval {
  const busy = useBusyKeys()
  const [error, setError] = useState<string | null>(null)
  const { has, start, finish } = busy

  const remove = useCallback(
    async (id: string): Promise<void> => {
      if (has(id)) return
      start(id)
      setError(null)
      try {
        await removePackage(id)
        await afterRemove()
      } catch (cause) {
        setError(errorMessage(cause))
      } finally {
        finish(id)
      }
    },
    [afterRemove, finish, has, removePackage, start]
  )
  const clearError = useCallback(() => setError(null), [])
  return { isRemoving: has, error, clearError, remove }
}
