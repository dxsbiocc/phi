import type { OfficeImportFormat, OfficeRendererBridge } from '../../../../../shared/officeProtocol'

export type OfficeImportUiState =
  | { state: 'idle' }
  | { state: 'preparing'; requestId: string }
  | { state: 'error'; code: string; message: string }

interface OfficeImportControllerOptions {
  bridge: OfficeRendererBridge
  requestIdFactory: () => string
  onState: (state: OfficeImportUiState) => void
  onImported: (draftPath: string) => void
}

export interface OfficeImportController {
  submit: (sourcePath: string, format: OfficeImportFormat) => Promise<void>
  cancel: () => Promise<void>
  dispose: () => Promise<void>
}

export function officeImportFormatForPath(path: string): OfficeImportFormat | undefined {
  const normalized = path.toLowerCase()
  if (normalized.endsWith('.csv')) return 'csv'
  if (normalized.endsWith('.tsv') || normalized.endsWith('.tab')) return 'tsv'
  return undefined
}

export function createOfficeImportController(
  options: OfficeImportControllerOptions
): OfficeImportController {
  let activeRequest: { requestId: string; cancelled: boolean } | null = null

  const cancelActive = async (): Promise<void> => {
    if (!activeRequest) return
    const requestId = activeRequest.requestId
    activeRequest.cancelled = true
    activeRequest = null
    await options.bridge.cancelImport?.({ requestId })
  }
  const submit = async (sourcePath: string, format: OfficeImportFormat): Promise<void> => {
    if (activeRequest) return
    if (!options.bridge.importFile) {
      options.onState({ state: 'error', code: 'unavailable', message: 'Office 导入能力不可用' })
      return
    }
    const request = { requestId: options.requestIdFactory(), cancelled: false }
    activeRequest = request
    options.onState({ state: 'preparing', requestId: request.requestId })
    try {
      const result = await options.bridge.importFile({
        requestId: request.requestId,
        sourcePath,
        format
      })
      if (activeRequest !== request || request.cancelled) return
      activeRequest = null
      if (!result.ok) options.onState({ state: 'error', ...result.error })
      else if (result.value.state === 'ready') options.onImported(result.value.document.sourcePath)
      else if (result.value.state === 'error') {
        options.onState({
          state: 'error',
          code: result.value.code,
          message: result.value.message
        })
      }
    } catch {
      if (activeRequest !== request || request.cancelled) return
      activeRequest = null
      options.onState({
        state: 'error',
        code: 'unavailable',
        message: '无法导入为 Excel 草稿，请重试'
      })
    }
  }

  return { submit, cancel: cancelActive, dispose: cancelActive }
}
