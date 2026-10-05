import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import type {
  OfficeExportFormat,
  OfficePreviewDocument
} from '../../../../../shared/officeProtocol'
import { getRendererApi } from '../../../lib/rendererApi'
import {
  createOfficeExportController,
  officeExportAvailable,
  type OfficeExportUiState
} from '../lib/officeExportController'
import { officeDocumentRegistry } from '../lib/officeDocumentRegistry'

export interface OfficeExportHookState {
  available: boolean
  activeSheet?: string
  state: OfficeExportUiState
  exportSheet: (format: OfficeExportFormat) => Promise<void>
  cancel: () => Promise<void>
  revealOutput: () => Promise<void>
}

interface OfficeExportStateEntry {
  artifactId: string | null
  state: OfficeExportUiState
}

let fallbackRequestSequence = 0

function defaultRequestIdFactory(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `office-export-${globalThis.crypto.randomUUID()}`
  }
  fallbackRequestSequence += 1
  return `office-export-${Date.now()}-${fallbackRequestSequence}`
}

function useActiveOfficeSheet(path: string | null): string | undefined {
  const subscribe = useCallback(
    (listener: () => void) => officeDocumentRegistry.subscribe(path, listener),
    [path]
  )
  const snapshot = useCallback(() => officeDocumentRegistry.activeSheet(path), [path])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

function useVisibleExportState(
  entry: OfficeExportStateEntry,
  artifactId: string | null
): OfficeExportUiState {
  return useMemo(
    () => (entry.artifactId === artifactId ? entry.state : { phase: 'idle' }),
    [artifactId, entry]
  )
}

export function useOfficeExport(
  document: OfficePreviewDocument | null,
  registryPath: string | null = document?.sourcePath ?? null
): OfficeExportHookState {
  const bridge = getRendererApi().office
  const artifactId = document?.artifactId ?? null
  const activeSheet = useActiveOfficeSheet(registryPath)
  const [entry, setEntry] = useState<OfficeExportStateEntry>({
    artifactId,
    state: { phase: 'idle' }
  })
  const controller = useMemo(
    () =>
      createOfficeExportController({
        bridge,
        requestIdFactory: defaultRequestIdFactory,
        onState: (state) => setEntry({ artifactId, state })
      }),
    [artifactId, bridge]
  )
  useEffect(
    () => () => {
      void controller.dispose().catch(() => undefined)
    },
    [controller]
  )
  const state = useVisibleExportState(entry, artifactId)
  return {
    available: officeExportAvailable(bridge),
    activeSheet,
    state,
    exportSheet: useCallback(
      (format) =>
        document && activeSheet
          ? controller.exportSheet(document, activeSheet, format)
          : Promise.resolve(),
      [activeSheet, controller, document]
    ),
    cancel: useCallback(() => controller.cancel(), [controller]),
    revealOutput: useCallback(
      () =>
        document && state.phase === 'success'
          ? controller.reveal(document, state.output)
          : Promise.resolve(),
      [controller, document, state]
    )
  }
}
