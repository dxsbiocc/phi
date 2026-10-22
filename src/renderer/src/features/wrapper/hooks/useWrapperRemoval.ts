import { useCallback, useState } from 'react'

import type { SnackbarSeverity } from '../../../components/AppSnackbarCard'
import type { WrapperRemovalPreview } from '../../../../../shared/packageManagerTypes'
import { readableErrorMessage } from '../../../lib/sessionNotifications'
import { wrapperCopy } from '../lib/wrapperCopy'
import { useWrapperPackageRemoval } from './useWrapperPackageRemoval'

export interface WrapperRemovalFlow {
  /** The package the user asked to remove, once its consequences are known. */
  pending: WrapperRemovalPreview | null
  /** The package whose preview or removal is in flight, for row busy state. */
  busyId: string | null
  removing: boolean
  /** Why the preview or removal failed; only used when the caller has no snackbar. */
  error: string | null
  clearError: () => void
  /** Load what removing this package would do, then show the confirmation. */
  request: (id: string) => Promise<void>
  cancel: () => void
  /** Removes the pending package and its enabled dependents; true when it succeeded. */
  confirm: () => Promise<boolean>
}

/** Preview, confirm, then remove a wrapper package (and switch off enabled dependents). */
export function useWrapperRemoval(
  afterRemove: () => Promise<void> | void,
  onNotify?: (message: string, severity?: SnackbarSeverity) => void
): WrapperRemovalFlow {
  const [pending, setPending] = useState<WrapperRemovalPreview | null>(null)
  const [previewingId, setPreviewingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reportError = useCallback(
    (message: string): void => {
      if (onNotify) onNotify(message, 'error')
      else setError(message)
    },
    [onNotify]
  )
  const removal = useWrapperPackageRemoval(afterRemove, reportError)
  const { remove, isRemoving } = removal

  const request = useCallback(
    async (id: string): Promise<void> => {
      if (previewingId) return
      setPreviewingId(id)
      setError(null)
      try {
        setPending(await window.api.previewWrapperRemoval(id))
      } catch (cause) {
        reportError(readableErrorMessage(cause, wrapperCopy.removePackagePreviewFailed))
      } finally {
        setPreviewingId(null)
      }
    },
    [previewingId, reportError]
  )

  const cancel = useCallback((): void => {
    setPending(null)
    setError(null)
  }, [])

  const confirm = useCallback(async (): Promise<boolean> => {
    if (!pending) return false
    const target = pending
    const removed = await remove(target.id)
    if (!removed) return false
    setPending(null)
    if (onNotify) onNotify(wrapperCopy.removedPackage(target.name), 'success')
    return true
  }, [onNotify, pending, remove])

  const removing = Boolean(pending && isRemoving(pending.id))
  const busyId = previewingId ?? (removing && pending ? pending.id : null)
  const clearError = useCallback(() => setError(null), [])
  return { pending, busyId, removing, error, clearError, request, cancel, confirm }
}
