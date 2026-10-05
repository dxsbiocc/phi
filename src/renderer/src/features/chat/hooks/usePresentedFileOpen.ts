import { useCallback, useState } from 'react'

import type { PresentedFile } from '../../../../../shared/presentedFileTypes'
import { resolvePresentedFileOpenPath } from '../lib/presentedOfficeFile'

export function usePresentedFileOpen(onOpenFile?: (path: string) => void): {
  openFile: (file: PresentedFile) => Promise<void>
  errorFor: (path: string) => string | undefined
} {
  const [errors, setErrors] = useState<Record<string, string>>({})
  const openFile = useCallback(
    async (file: PresentedFile): Promise<void> => {
      if (!onOpenFile) return
      try {
        const path = await resolvePresentedFileOpenPath(
          file,
          file.office ? window.api.office.resolveOutput : undefined
        )
        setErrors((current) => withoutKey(current, file.path))
        onOpenFile(path)
      } catch (error) {
        const message = error instanceof Error ? error.message : '交付文件入口已失效'
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
