import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  OfficeDocumentState,
  OfficePreviewDocument
} from '../../../../../shared/officeProtocol'
import { getRendererApi } from '../../../lib/rendererApi'
import {
  createOfficeReconcileController,
  type OfficeReconcileUiState
} from '../lib/officeReconcileController'

export interface OfficeReconciliationHookState {
  state: OfficeReconcileUiState
  reconcile: () => Promise<void>
}

interface ReconciliationStateEntry {
  artifactId: string | null
  state: OfficeReconcileUiState
}

export function useOfficeReconciliation(
  document: OfficePreviewDocument | null,
  onDocumentState: (state: OfficeDocumentState) => void
): OfficeReconciliationHookState {
  const artifactId = document?.artifactId ?? null
  const [entry, setEntry] = useState<ReconciliationStateEntry>({
    artifactId,
    state: { phase: 'idle' }
  })
  const controller = useMemo(
    () =>
      createOfficeReconcileController({
        bridge: getRendererApi().office,
        onState: (state) => setEntry({ artifactId, state }),
        onDocumentState
      }),
    [artifactId, onDocumentState]
  )

  useEffect(() => () => controller.dispose(), [controller])

  const reconcile = useCallback(
    () => (document ? controller.reconcile(document) : Promise.resolve()),
    [controller, document]
  )
  return {
    state: entry.artifactId === artifactId ? entry.state : { phase: 'idle' },
    reconcile
  }
}
