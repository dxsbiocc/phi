import type {
  OfficeDocumentState,
  OfficePreviewDocument,
  OfficeRendererBridge
} from '../../../../../shared/officeProtocol'

export type OfficeSaveUiState =
  | { phase: 'idle' }
  | { phase: 'pending' }
  | { phase: 'success' }
  | { phase: 'error'; message: string }

interface OfficeSaveControllerDependencies {
  bridge: Pick<OfficeRendererBridge, 'save' | 'status'>
  onState: (state: OfficeSaveUiState) => void
  onDocumentState: (state: OfficeDocumentState) => void
}

export interface OfficeSaveController {
  save: (document: OfficePreviewDocument) => Promise<void>
  dispose: () => void
}

export function createOfficeSaveController(
  dependencies: OfficeSaveControllerDependencies
): OfficeSaveController {
  let active = true
  let running: Promise<void> | undefined
  const perform = async (document: OfficePreviewDocument): Promise<void> => {
    dependencies.onState({ phase: 'pending' })
    try {
      const result = await dependencies.bridge.save({ artifactId: document.artifactId })
      if (!active) return
      if (!result.ok) {
        dependencies.onState({ phase: 'error', message: result.error.message })
        return
      }
      dependencies.onState({ phase: 'success' })
      await refreshDocument(dependencies, document, () => active)
    } catch {
      if (active) dependencies.onState({ phase: 'error', message: '草稿保存失败，内容仍保留' })
    }
  }
  return {
    save: (document) => {
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

async function refreshDocument(
  dependencies: OfficeSaveControllerDependencies,
  document: OfficePreviewDocument,
  active: () => boolean
): Promise<void> {
  try {
    const status = await dependencies.bridge.status({ sourcePath: document.sourcePath })
    if (
      active() &&
      status.ok &&
      status.value?.state === 'ready' &&
      status.value.document.artifactId === document.artifactId
    ) {
      dependencies.onDocumentState(status.value)
    }
  } catch {
    // The existing status poll will publish the authoritative state after a transient failure.
  }
}
