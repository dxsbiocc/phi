import type {
  OfficeExportFormat,
  OfficeExportOutputSummary,
  OfficePreviewDocument,
  OfficeRendererBridge
} from '../../../../../shared/officeProtocol'

export type OfficeExportUiState =
  | { phase: 'idle' }
  | {
      phase: 'pending'
      requestId: string
      format: OfficeExportFormat
      sheet: string
      cancelMessage?: string
    }
  | { phase: 'success'; output: OfficeExportOutputSummary }
  | { phase: 'error'; code: string; message: string }

export function officeExportAvailable(
  bridge: Pick<OfficeRendererBridge, 'enabled' | 'exportSheet' | 'cancelExport'>
): boolean {
  return bridge.enabled && Boolean(bridge.exportSheet && bridge.cancelExport)
}

interface OfficeExportControllerOptions {
  bridge: Pick<OfficeRendererBridge, 'exportSheet' | 'cancelExport' | 'revealOutput'>
  requestIdFactory: () => string
  onState: (state: OfficeExportUiState) => void
}

interface ActiveExportRequest {
  requestId: string
  format: OfficeExportFormat
  sheet: string
  cancelled: boolean
}

export interface OfficeExportController {
  exportSheet: (
    document: OfficePreviewDocument,
    sheet: string,
    format: OfficeExportFormat
  ) => Promise<void>
  cancel: () => Promise<void>
  reveal: (document: OfficePreviewDocument, output: OfficeExportOutputSummary) => Promise<void>
  dispose: () => Promise<void>
}

class OfficeExportControllerImpl implements OfficeExportController {
  private activeRequest?: ActiveExportRequest
  private disposed = false

  constructor(private readonly options: OfficeExportControllerOptions) {}

  async exportSheet(
    document: OfficePreviewDocument,
    sheet: string,
    format: OfficeExportFormat
  ): Promise<void> {
    if (this.activeRequest || this.disposed) return
    if (!this.options.bridge.exportSheet) {
      this.publishError('unavailable', 'Office 导出能力不可用')
      return
    }
    const request = { requestId: this.options.requestIdFactory(), format, sheet, cancelled: false }
    this.activeRequest = request
    this.options.onState({ phase: 'pending', requestId: request.requestId, format, sheet })
    try {
      const result = await this.options.bridge.exportSheet({
        requestId: request.requestId,
        artifactId: document.artifactId,
        sheet,
        format
      })
      if (!this.isCurrent(request)) return
      this.activeRequest = undefined
      if (!result.ok) this.publishError(result.error.code, result.error.message)
      else if (result.value.status === 'cancelled') this.options.onState({ phase: 'idle' })
      else this.options.onState({ phase: 'success', output: result.value.output })
    } catch {
      if (!this.isCurrent(request)) return
      this.activeRequest = undefined
      this.publishError('unavailable', '无法导出当前工作表，请重试')
    }
  }

  cancel(): Promise<void> {
    return this.cancelRequest(true)
  }

  async reveal(document: OfficePreviewDocument, output: OfficeExportOutputSummary): Promise<void> {
    try {
      const result = await this.options.bridge.revealOutput({
        artifactId: document.artifactId,
        outputId: output.outputId
      })
      if (!result.ok) this.publishError(result.error.code, result.error.message)
    } catch {
      this.publishError('unavailable', '无法在文件夹中显示导出文件')
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.cancelRequest(false)
  }

  private async cancelRequest(reportState: boolean): Promise<void> {
    const request = this.activeRequest
    if (!request) return
    try {
      const result = await this.options.bridge.cancelExport?.({ requestId: request.requestId })
      if (this.activeRequest !== request) return
      if (!reportState || this.disposed) return
      if (!result) this.publishCancelPending(request, 'Office 导出取消能力不可用，正在等待最终结果')
      else if (!result.ok) this.publishCancelPending(request, result.error.message)
      else if (!result.value)
        this.publishCancelPending(request, '导出已进入提交阶段，正在等待最终结果')
      else this.finishCancellation(request)
    } catch {
      if (reportState && !this.disposed && this.activeRequest === request) {
        this.publishCancelPending(request, '取消导出失败，正在等待最终结果')
      }
    }
  }

  private finishCancellation(request: ActiveExportRequest): void {
    request.cancelled = true
    this.activeRequest = undefined
    this.options.onState({ phase: 'idle' })
  }

  private publishCancelPending(request: ActiveExportRequest, cancelMessage: string): void {
    this.options.onState({
      phase: 'pending',
      requestId: request.requestId,
      format: request.format,
      sheet: request.sheet,
      cancelMessage
    })
  }

  private isCurrent(request: ActiveExportRequest): boolean {
    return !this.disposed && !request.cancelled && this.activeRequest === request
  }

  private publishError(code: string, message: string): void {
    if (!this.disposed) this.options.onState({ phase: 'error', code, message })
  }
}

export function createOfficeExportController(
  options: OfficeExportControllerOptions
): OfficeExportController {
  return new OfficeExportControllerImpl(options)
}
