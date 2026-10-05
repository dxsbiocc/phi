import type {
  OfficeOutputSummary,
  OfficePreviewDocument,
  OfficeRendererBridge
} from '../../../../../shared/officeProtocol'

export type OfficeSaveAsUiState =
  | { phase: 'idle' }
  | { phase: 'pending' }
  | { phase: 'success'; output: OfficeOutputSummary }
  | { phase: 'error'; message: string }

interface OfficeSaveAsControllerDependencies {
  bridge: Pick<OfficeRendererBridge, 'saveAs' | 'revealOutput'>
  onState: (state: OfficeSaveAsUiState) => void
}

export interface OfficeSaveAsController {
  saveAs: (document: OfficePreviewDocument) => Promise<void>
  reveal: (document: OfficePreviewDocument, output: OfficeOutputSummary) => Promise<void>
  dispose: () => void
}

export function createOfficeSaveAsController(
  dependencies: OfficeSaveAsControllerDependencies
): OfficeSaveAsController {
  let active = true
  let running: Promise<void> | undefined
  const perform = async (document: OfficePreviewDocument): Promise<void> => {
    dependencies.onState({ phase: 'pending' })
    try {
      const result = await dependencies.bridge.saveAs({ artifactId: document.artifactId })
      if (!active) return
      if (!result.ok) {
        dependencies.onState({ phase: 'error', message: result.error.message })
      } else if (result.value.status === 'cancelled') {
        dependencies.onState({ phase: 'idle' })
      } else {
        dependencies.onState({ phase: 'success', output: result.value.output })
      }
    } catch {
      if (active) dependencies.onState({ phase: 'error', message: '无法创建 Office 输出副本' })
    }
  }
  return {
    saveAs: (document) => {
      running ??= perform(document).finally(() => {
        running = undefined
      })
      return running
    },
    reveal: async (document, output) => {
      try {
        const result = await dependencies.bridge.revealOutput({
          artifactId: document.artifactId,
          outputId: output.outputId
        })
        if (active && !result.ok) {
          dependencies.onState({ phase: 'error', message: result.error.message })
        }
      } catch {
        if (active) dependencies.onState({ phase: 'error', message: '无法在文件夹中显示输出文件' })
      }
    },
    dispose: () => {
      active = false
    }
  }
}
