import type { OfficeDocumentKind, OfficeRendererBridge } from '../../../../../shared/officeProtocol'
import { officeDocumentCopy } from './officeDocumentUi'

export type OfficeCreateUiState =
  | { state: 'idle' }
  | { state: 'preparing'; requestId: string }
  | { state: 'error'; code: string; message: string }

interface OfficeCreateControllerOptions {
  bridge: OfficeRendererBridge
  requestIdFactory: () => string
  onState: (state: OfficeCreateUiState) => void
  onCreated: (draftPath: string) => void
}

export interface OfficeCreateController {
  submit: (name?: string, kind?: OfficeDocumentKind) => Promise<void>
  cancel: () => Promise<void>
  dispose: () => Promise<void>
}

export function createOfficeCreateController(
  options: OfficeCreateControllerOptions
): OfficeCreateController {
  let activeRequest: { requestId: string; cancelled: boolean } | null = null

  const reportFailure = (code: string, message: string): void => {
    options.onState({ state: 'error', code, message })
  }
  const cancelActive = async (): Promise<void> => {
    if (!activeRequest) return
    const requestId = activeRequest.requestId
    activeRequest.cancelled = true
    activeRequest = null
    await options.bridge.cancelCreate({ requestId })
  }
  const submit = async (name?: string, kind?: OfficeDocumentKind): Promise<void> => {
    if (activeRequest) return
    const request = { requestId: options.requestIdFactory(), cancelled: false }
    activeRequest = request
    options.onState({ state: 'preparing', requestId: request.requestId })
    try {
      const result = await options.bridge.create({
        requestId: request.requestId,
        name,
        ...(kind ? { kind } : {})
      })
      if (activeRequest !== request || request.cancelled) return
      activeRequest = null
      if (!result.ok) reportFailure(result.error.code, result.error.message)
      else if (result.value.state === 'ready') options.onCreated(result.value.document.sourcePath)
      else if (result.value.state === 'error')
        reportFailure(result.value.code, result.value.message)
    } catch {
      if (activeRequest !== request || request.cancelled) return
      activeRequest = null
      reportFailure(
        'unavailable',
        `无法创建空白 ${officeDocumentCopy(kind ?? 'xlsx').productName}，请重试`
      )
    }
  }

  return { submit, cancel: cancelActive, dispose: cancelActive }
}
