import { useCallback, useEffect, useMemo, useState } from 'react'

import type { OfficePreviewDocument } from '../../../../../shared/officeProtocol'
import { getRendererApi } from '../../../lib/rendererApi'
import {
  createOfficeSaveAsController,
  type OfficeSaveAsUiState
} from '../lib/officeSaveAsController'

export interface OfficeSaveAsHookState {
  state: OfficeSaveAsUiState
  saveAs: () => Promise<void>
  revealOutput: () => Promise<void>
}

export function useOfficeSaveAs(document: OfficePreviewDocument | null): OfficeSaveAsHookState {
  const artifactId = document?.artifactId ?? null
  const [entry, setEntry] = useState<{
    artifactId: string | null
    state: OfficeSaveAsUiState
  }>({ artifactId, state: { phase: 'idle' } })
  const controller = useMemo(
    () =>
      createOfficeSaveAsController({
        bridge: getRendererApi().office,
        onState: (state) => setEntry({ artifactId, state })
      }),
    [artifactId]
  )
  useEffect(() => () => controller.dispose(), [controller])
  return {
    state: entry.artifactId === artifactId ? entry.state : { phase: 'idle' },
    saveAs: useCallback(
      () => (document ? controller.saveAs(document) : Promise.resolve()),
      [controller, document]
    ),
    revealOutput: useCallback(() => {
      if (!document || entry.state.phase !== 'success') return Promise.resolve()
      return controller.reveal(document, entry.state.output)
    }, [controller, document, entry.state])
  }
}
