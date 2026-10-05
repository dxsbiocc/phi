import { useCallback, useMemo, useSyncExternalStore } from 'react'

import { officeDocumentRegistry } from '../lib/officeDocumentRegistry'
import type { OfficeComposerTarget } from '../lib/officePromptTarget'
import { officeDocumentHumanEdit } from '../lib/officeDocumentUi'

export function useOfficePromptTarget(
  sourcePath: string | null,
  label: string
): OfficeComposerTarget | null {
  const subscribe = useCallback(
    (listener: () => void) => officeDocumentRegistry.subscribe(sourcePath, listener),
    [sourcePath]
  )
  const getSnapshot = useCallback(() => officeDocumentRegistry.snapshot(sourcePath), [sourcePath])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return useMemo(() => {
    if (!snapshot) return null
    const humanEdit = officeDocumentHumanEdit(snapshot.document)
    return {
      artifactId: snapshot.document.artifactId,
      label,
      ...(humanEdit === 'none' ? { humanEdit } : {}),
      ...(humanEdit === 'cells' && snapshot.selection ? { selection: snapshot.selection } : {})
    }
  }, [snapshot, label])
}
