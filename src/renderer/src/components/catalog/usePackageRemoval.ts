import { useCallback, useState } from 'react'

import { useBusyKeys } from './useBusyKeys'
import { errorMessage } from '../../../../shared/errorCodes'
import { readableErrorMessage } from '../../lib/sessionNotifications'

export interface PackageRemoval {
  /** Whether this package is being removed right now. */
  isRemoving: (id: string) => boolean
  /** Why the last removal failed, e.g. which installed packages still need it. */
  error: string | null
  clearError: () => void
  /** Resolves true only when the package was removed and the refresh finished. */
  remove: (id: string) => Promise<boolean>
}

/**
 * One removal flow for every catalog and sidebar that offers it; removals do not block each other.
 * With `onError`, the caller presents the failure (for example in the app snackbar) and `error`
 * stays null.
 */
export function usePackageRemoval(
  removePackage: (id: string) => Promise<unknown>,
  afterRemove: () => Promise<void> | void,
  onError?: (message: string) => void
): PackageRemoval {
  const busy = useBusyKeys()
  const [error, setError] = useState<string | null>(null)
  const { has, start, finish } = busy

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      if (has(id)) return false
      start(id)
      setError(null)
      try {
        await removePackage(id)
        await afterRemove()
        return true
      } catch (cause) {
        if (onError) onError(readableErrorMessage(cause, errorMessage(cause)))
        else setError(errorMessage(cause))
        return false
      } finally {
        finish(id)
      }
    },
    [afterRemove, finish, has, onError, removePackage, start]
  )
  const clearError = useCallback(() => setError(null), [])
  return { isRemoving: has, error, clearError, remove }
}
