import { chatCopy } from '../lib/chatCopy'
import { useCallback, useState } from 'react'

import type { PresentedFile } from '../../../../../shared/presentedFileTypes'

export function usePresentedFileOpen(onOpenFile?: (path: string) => void): {
  openFile: (file: PresentedFile) => Promise<void>
  errorFor: (path: string) => string | undefined
} {
  const [errors, setErrors] = useState<Record<string, string>>({})
  const openFile = useCallback(
    async (file: PresentedFile): Promise<void> => {
      if (!onOpenFile) return
      try {
        setErrors((current) => withoutKey(current, file.path))
        onOpenFile(file.path)
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : chatCopy.deliveredFileReferenceIsNoLongerAvailable
        setErrors((current) => ({ ...current, [file.path]: message }))
      }
    },
    [onOpenFile]
  )
  return { openFile, errorFor: (path) => errors[path] }
}

function withoutKey(value: Record<string, string>, key: string): Record<string, string> {
  if (!Object.hasOwn(value, key)) return value
  return Object.fromEntries(Object.entries(value).filter(([entry]) => entry !== key))
}
