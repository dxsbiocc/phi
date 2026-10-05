import type {
  OfficeDocumentState,
  OfficePreviewDocument,
  OfficeReconcileConclusion,
  OfficeRendererBridge
} from '../../../../../shared/officeProtocol'

export type OfficeReconcileUiState =
  | { phase: 'idle' }
  | { phase: 'pending' }
  | { phase: 'result'; conclusion: OfficeReconcileConclusion; message: string }
  | { phase: 'error'; message: string }

interface OfficeReconcileControllerDependencies {
  bridge: OfficeRendererBridge
  onState: (state: OfficeReconcileUiState) => void
  onDocumentState: (state: OfficeDocumentState) => void
}

export interface OfficeReconcileController {
  reconcile: (document: OfficePreviewDocument) => Promise<void>
  dispose: () => void
}

export function createOfficeReconcileController(
  dependencies: OfficeReconcileControllerDependencies
): OfficeReconcileController {
  let active = true
  let running: Promise<void> | undefined

  const perform = async (document: OfficePreviewDocument): Promise<void> => {
    dependencies.onState({ phase: 'pending' })
    let result: Awaited<ReturnType<OfficeRendererBridge['reconcile']>>
    try {
      result = await dependencies.bridge.reconcile({ artifactId: document.artifactId })
    } catch {
      if (active) dependencies.onState({ phase: 'error', message: '核对失败，请重试' })
      return
    }
    if (!active) return
    if (!result.ok) {
      dependencies.onState({ phase: 'error', message: result.error.message })
      return
    }
    dependencies.onState({
      phase: 'result',
      conclusion: result.value.conclusion,
      message: result.value.message
    })
    try {
      const status = await dependencies.bridge.status({ sourcePath: document.sourcePath })
      if (
        active &&
        status.ok &&
        status.value?.state === 'ready' &&
        status.value.document.artifactId === document.artifactId
      ) {
        dependencies.onDocumentState(status.value)
      }
    } catch {
      // Polling will refresh the authoritative document flags after a transient status failure.
    }
  }

  return {
    reconcile: (document) => {
      running ??= perform(document).finally(() => {
        running = undefined
      })
      return running
    },
    dispose: () => {
      active = false
    }
  }
}
