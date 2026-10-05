import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  OfficeDocumentState,
  OfficePreviewDocument
} from '../../../../../shared/officeProtocol'
import { getRendererApi } from '../../../lib/rendererApi'
import { createOfficeSaveController, type OfficeSaveUiState } from '../lib/officeSaveController'

export interface OfficeSaveHookState {
  state: OfficeSaveUiState
  save: () => Promise<void>
}

export function useOfficeSave(
  document: OfficePreviewDocument | null,
  onDocumentState: (state: OfficeDocumentState) => void
): OfficeSaveHookState {
  const artifactId = document?.artifactId ?? null
  const [entry, setEntry] = useState<{ artifactId: string | null; state: OfficeSaveUiState }>({
    artifactId,
    state: { phase: 'idle' }
  })
  const controller = useMemo(
    () =>
      createOfficeSaveController({
        bridge: getRendererApi().office,
        onState: (state) => setEntry({ artifactId, state }),
        onDocumentState
      }),
    [artifactId, onDocumentState]
  )
  useEffect(() => () => controller.dispose(), [controller])
  return {
    state: entry.artifactId === artifactId ? entry.state : { phase: 'idle' },
    save: useCallback(
      () => (document ? controller.save(document) : Promise.resolve()),
      [controller, document]
    )
  }
}
