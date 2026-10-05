import type {
  OfficeCancelExportInput,
  OfficeExportFormat,
  OfficeExportInput,
  OfficeExportOutputSummary,
  OfficeExportResult,
  OfficeIpcResult
} from '../../../shared/officeProtocol'
import type { OfficeExportDescriptor, OfficeExportRequest } from './office-export'
import { validOfficeSheetName } from './office-read-contract'

interface OfficeExportSenderLike {
  isDestroyed(): boolean
  mainFrame: unknown
}

export interface OfficeExportIpcEventLike {
  sender: OfficeExportSenderLike
  senderFrame: unknown
}

export interface OfficeExportIpcMainLike {
  handle(
    channel: string,
    listener: (event: OfficeExportIpcEventLike, ...args: unknown[]) => unknown
  ): void
}

interface OfficeExportIpcService {
  exportDescriptor(
    artifactId: string,
    sessionId: string,
    sheet: string,
    format: OfficeExportFormat
  ): OfficeExportDescriptor
  exportSheet(request: OfficeExportRequest): Promise<OfficeExportOutputSummary>
}

interface OfficeExportIpcContext {
  readonly sessionId: string
  readonly outputRoot?: string
  readonly projectLocation?: { readonly kind: string }
}

interface OfficeExportIpcDependencies {
  readonly service: OfficeExportIpcService
  readonly getTrustedRenderer: () => OfficeExportSenderLike | null
  readonly resolveContext: () => OfficeExportIpcContext | undefined
  readonly chooseExportTarget: (input: {
    readonly projectRoot: string
    readonly fileName: string
    readonly format: OfficeExportFormat
  }) => Promise<string | null>
}

interface ActiveOfficeExport {
  readonly controller: AbortController
  committing: boolean
}

export class OfficeExportIpcFlow {
  private readonly active = new Map<string, ActiveOfficeExport>()

  constructor(private readonly dependencies: OfficeExportIpcDependencies) {}

  exportSheet(
    event: OfficeExportIpcEventLike,
    input: unknown
  ): Promise<OfficeIpcResult<OfficeExportResult>> {
    return this.run(event, async () => {
      const parsed = exportInput(input)
      const context = this.dependencies.resolveContext()
      if (!parsed || !context?.outputRoot) throw invalidRequest()
      if (context.projectLocation?.kind === 'ssh') {
        throw new OfficeExportIpcError('remote_not_supported', '远程项目暂不支持 Office 导出')
      }
      if (this.active.has(parsed.requestId)) {
        throw new OfficeExportIpcError('invalid_export', '同一导出请求正在进行中')
      }
      return this.start(parsed, context as OfficeExportIpcContext & { readonly outputRoot: string })
    })
  }

  cancel(event: OfficeExportIpcEventLike, input: unknown): Promise<OfficeIpcResult<boolean>> {
    return this.run(event, () => {
      const requestId = cancelInput(input)
      if (!requestId) throw invalidRequest('Office 取消导出请求无效')
      const active = this.active.get(requestId)
      if (!active || active.committing) return false
      active.controller.abort()
      return true
    })
  }

  private async start(
    input: OfficeExportInput,
    context: OfficeExportIpcContext & { readonly outputRoot: string }
  ): Promise<OfficeExportResult> {
    const controller = new AbortController()
    const active = { controller, committing: false }
    this.active.set(input.requestId, active)
    try {
      const descriptor = this.dependencies.service.exportDescriptor(
        input.artifactId,
        context.sessionId,
        input.sheet,
        input.format
      )
      const targetPath = await this.dependencies.chooseExportTarget({
        projectRoot: context.outputRoot,
        fileName: descriptor.fileName,
        format: input.format
      })
      if (!targetPath) return { status: 'cancelled' }
      const output = await this.dependencies.service.exportSheet({
        ...input,
        sessionId: context.sessionId,
        projectRoot: context.outputRoot,
        targetPath,
        signal: controller.signal,
        beginCommit: () => {
          active.committing = true
        }
      })
      return { status: 'saved', output }
    } finally {
      if (this.active.get(input.requestId) === active) this.active.delete(input.requestId)
    }
  }

  private async run<T>(
    event: OfficeExportIpcEventLike,
    operation: () => T | Promise<T>
  ): Promise<OfficeIpcResult<T>> {
    try {
      this.assertTrusted(event)
      return { ok: true, value: await operation() }
    } catch (error) {
      const mapped = publicExportError(error)
      return { ok: false, error: { code: mapped.code, message: mapped.message } }
    }
  }

  private assertTrusted(event: OfficeExportIpcEventLike): void {
    const trusted = this.dependencies.getTrustedRenderer()
    if (
      !trusted ||
      event.sender !== trusted ||
      event.sender.isDestroyed() ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      throw new OfficeExportIpcError('unauthorized', 'Office 导出调用方未获授权')
    }
  }
}

export class OfficeExportIpcError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export function registerOfficeExportRendererIpc(
  ipcMain: OfficeExportIpcMainLike,
  flow: OfficeExportIpcFlow,
  options: { enabled?: boolean } = {}
): void {
  if (options.enabled === false) return
  ipcMain.handle('office:export', (event, ...args) =>
    args.length === 1
      ? flow.exportSheet(event, args[0] as OfficeExportInput)
      : flow.exportSheet(event, null)
  )
  ipcMain.handle('office:cancelExport', (event, ...args) =>
    args.length === 1
      ? flow.cancel(event, args[0] as OfficeCancelExportInput)
      : flow.cancel(event, null)
  )
}

function exportInput(value: unknown): OfficeExportInput | undefined {
  if (!isRecord(value)) return undefined
  const allowed = new Set(['requestId', 'artifactId', 'sheet', 'format'])
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined
  if (!validId(value.requestId) || !validId(value.artifactId)) return undefined
  if (typeof value.sheet !== 'string' || !validOfficeSheetName(value.sheet)) return undefined
  if (value.format !== 'csv' && value.format !== 'tsv') return undefined
  return {
    requestId: value.requestId,
    artifactId: value.artifactId,
    sheet: value.sheet,
    format: value.format
  }
}

function cancelInput(value: unknown): string | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'requestId')) return undefined
  return validId(value.requestId) ? value.requestId : undefined
}

function publicExportError(error: unknown): OfficeExportIpcError {
  if (error instanceof OfficeExportIpcError) return error
  const code = (error as { code?: unknown }).code
  const messages: Record<string, string> = {
    target_exists: '目标文件已存在；Phi 不会覆盖已有文件',
    outside_project: '导出目标必须位于当前项目内',
    invalid_extension: '导出文件扩展名与所选格式不一致',
    invalid_name: '导出文件名无效',
    unsafe_path: '导出目标路径不安全',
    permission_denied: '没有权限写入导出目标',
    document_frozen: '写入结果待核对，不能导出',
    document_read_only: '只读文档不能导出',
    save_failed: '草稿刷盘失败，未创建导出文件',
    output_log_corrupt: '输出记录无法验证，未创建导出文件',
    output_integrity_failed: '已有导出文件已被更改，不能重放结果',
    export_too_large: '当前工作表超过导出上限',
    computed_value_unavailable: '公式没有可用的计算结果，未导出公式文本',
    revision_changed: '读取期间工作簿版本发生变化，请重新导出',
    export_cancelled: 'Office 导出已取消',
    export_verification_failed: '导出文件回读校验失败',
    unsupported_document_kind: '只有 Excel 工作簿可以导出 CSV/TSV',
    invalid_sheet: '当前工作表不存在或名称无效',
    operation_conflict: '相同导出请求编号对应了不同内容'
  }
  const value = typeof code === 'string' && messages[code] ? code : 'export_failed'
  return new OfficeExportIpcError(value, messages[value] ?? 'Office 工作表导出失败')
}

function invalidRequest(message = 'Office 导出请求无效'): OfficeExportIpcError {
  return new OfficeExportIpcError('invalid-request', message)
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
