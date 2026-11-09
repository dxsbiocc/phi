import { useCallback, useState, useSyncExternalStore } from 'react'

import {
  createConfirmationController,
  type ConfirmationOptions
} from '../lib/confirmationController'
import { ConfirmationPrompt } from './ConfirmationPrompt'

/**
 * Opens the shared confirmation dialog and resolves `true` only after the user
 * confirms. Closing through the backdrop, Escape, or Cancel resolves `false`.
 */
export function useConfirmation(): {
  confirm(options: ConfirmationOptions): Promise<boolean>
  confirmationDialog: React.JSX.Element | null
} {
  const [controller] = useState(createConfirmationController)
  const pending = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  )
  const confirm = useCallback(
    (options: ConfirmationOptions) => controller.request(options),
    [controller]
  )

  return {
    confirm,
    confirmationDialog: pending ? (
      <ConfirmationPrompt
        options={pending.options}
        onSettle={(confirmed) => controller.settle(confirmed, pending)}
      />
    ) : null
  }
}
