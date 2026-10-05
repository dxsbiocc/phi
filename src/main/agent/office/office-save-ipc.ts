import type {
  OfficeDocumentKind,
  OfficeResolvedOutput,
  OfficeRevealOutputInput,
  OfficeSaveAsResult,
  OfficeSaveResult
} from '../../../shared/officeProtocol'
import {
  validateOfficeSaveAsTarget,
  type ValidatedOfficeSaveAsTarget
} from './office-save-as-target'
import { officeKindAdapter } from './office-kind-adapters'

export interface OfficeSaveIpcService {
  saveDocument(artifactId: string, sessionId: string): Promise<OfficeSaveResult>
  saveAsDescriptor(
    artifactId: string,
    sessionId: string
  ): { readonly fileName: string; readonly kind?: OfficeDocumentKind }
  saveAsDocument(
    artifactId: string,
    sessionId: string,
    projectRoot: string,
    targetPath: string
  ): Promise<Extract<OfficeSaveAsResult, { status: 'saved' }>['output']>
  resolveOutputPath(
    artifactId: string,
    sessionId: string,
    projectRoot: string,
    outputId: string
  ): Promise<string>
}

interface OfficeSaveIpcContext {
  readonly sessionId: string
  readonly projectLocation?: { readonly kind: string }
  readonly outputRoot?: string
}

export interface OfficeSaveIpcDependencies {
  readonly service: OfficeSaveIpcService
  readonly resolveContext: () => OfficeSaveIpcContext | undefined
  readonly chooseSaveAsTarget?: (input: {
    readonly projectRoot: string
    readonly fileName: string
    readonly kind?: OfficeDocumentKind
  }) => Promise<string | null>
  readonly validateSaveAsTarget?: typeof validateOfficeSaveAsTarget
  readonly revealPath?: (path: string) => void
}

export class OfficeSaveIpcFlow {
  constructor(private readonly dependencies: OfficeSaveIpcDependencies) {}

  async save(input: unknown): Promise<OfficeSaveResult> {
    const artifactId = artifactInput(input)
    const context = this.dependencies.resolveContext()
    if (!artifactId || !context) throw invalidRequest('Office 保存请求无效')
    try {
      return await this.dependencies.service.saveDocument(artifactId, context.sessionId)
    } catch (error) {
      throw publicSaveError(error)
    }
  }

  async saveAs(input: unknown): Promise<OfficeSaveAsResult> {
    const artifactId = artifactInput(input)
    const context = this.dependencies.resolveContext()
    if (!artifactId || !context?.outputRoot) throw invalidRequest('Office 另存请求无效')
    if (context.projectLocation?.kind === 'ssh') {
      throw new OfficeSaveIpcError('remote_not_supported', '远程项目暂不支持 Office 另存')
    }
    const descriptor = this.dependencies.service.saveAsDescriptor(artifactId, context.sessionId)
    const targetPath = await this.dependencies.chooseSaveAsTarget?.({
      projectRoot: context.outputRoot,
      fileName: descriptor.fileName,
      kind: descriptor.kind
    })
    if (!targetPath) return { status: 'cancelled' }
    try {
      const target = await (this.dependencies.validateSaveAsTarget ?? validateOfficeSaveAsTarget)(
        context.outputRoot,
        targetPath,
        descriptor.kind ?? 'xlsx'
      )
      return {
        status: 'saved',
        output: await this.saveAsValidated(artifactId, context.sessionId, target)
      }
    } catch (error) {
      throw publicSaveAsError(error, descriptor.kind ?? 'xlsx')
    }
  }

  async revealOutput(input: unknown): Promise<boolean> {
    const parsed = revealOutputInput(input)
    const context = this.dependencies.resolveContext()
    if (!parsed || !context?.outputRoot || !this.dependencies.revealPath) {
      throw invalidRequest('Office 输出显示请求无效')
    }
    try {
      const path = await this.dependencies.service.resolveOutputPath(
        parsed.artifactId,
        context.sessionId,
        context.outputRoot,
        parsed.outputId
      )
      this.dependencies.revealPath(path)
      return true
    } catch (error) {
      throw publicSaveAsError(error)
    }
  }

  async resolveOutput(input: unknown): Promise<OfficeResolvedOutput> {
    const parsed = revealOutputInput(input)
    const context = this.dependencies.resolveContext()
    if (!parsed || !context?.outputRoot) {
      throw invalidRequest('Office 输出解析请求无效')
    }
    try {
      return {
        path: await this.dependencies.service.resolveOutputPath(
          parsed.artifactId,
          context.sessionId,
          context.outputRoot,
          parsed.outputId
        )
      }
    } catch (error) {
      throw publicSaveAsError(error)
    }
  }

  private saveAsValidated(
    artifactId: string,
    sessionId: string,
    target: ValidatedOfficeSaveAsTarget
  ): Promise<Extract<OfficeSaveAsResult, { status: 'saved' }>['output']> {
    return this.dependencies.service.saveAsDocument(
      artifactId,
      sessionId,
      target.projectRoot,
      target.targetPath
    )
  }
}

export class OfficeSaveIpcError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

function artifactInput(value: unknown): string | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'artifactId')) return undefined
  return validId(value.artifactId) ? value.artifactId : undefined
}

function revealOutputInput(value: unknown): OfficeRevealOutputInput | undefined {
  if (!isRecord(value)) return undefined
  if (Object.keys(value).some((key) => key !== 'artifactId' && key !== 'outputId')) return undefined
  return validId(value.artifactId) && validId(value.outputId)
    ? { artifactId: value.artifactId, outputId: value.outputId }
    : undefined
}

function publicSaveError(error: unknown): OfficeSaveIpcError {
  const code = (error as { code?: unknown }).code
  if (code === 'document_frozen') {
    return new OfficeSaveIpcError(code, '写入结果待核对，暂时不能保存草稿')
  }
  if (code === 'document_read_only') return new OfficeSaveIpcError(code, '只读文档不能保存草稿')
  if (code === 'target_not_found' || code === 'target_session_mismatch') {
    return new OfficeSaveIpcError(code, 'Office 草稿已关闭或不属于当前会话')
  }
  return new OfficeSaveIpcError('save_failed', 'Office 草稿保存失败，内容仍保留，可重试')
}

function publicSaveAsError(error: unknown, kind: OfficeDocumentKind = 'xlsx'): OfficeSaveIpcError {
  const code = (error as { code?: unknown }).code
  const messages: Record<string, string> = {
    target_exists: '目标文件已存在；Phi 不会覆盖已有文件',
    outside_project: '另存目标必须位于当前项目内',
    invalid_extension: `另存文件必须使用 ${officeKindAdapter(kind).extension} 扩展名`,
    invalid_name: '另存文件名无效',
    permission_denied: '没有权限写入另存目标',
    document_frozen: '写入结果待核对，不能另存输出',
    document_read_only: '只读文档不能另存输出',
    save_failed: '草稿刷盘失败，未创建成功输出',
    copy_verification_failed: '输出副本校验失败，未创建成功输出',
    output_log_corrupt: '输出记录无法验证，未创建成功输出',
    output_hash_mismatch: 'Office 输出已被更改，交付入口已失效',
    output_integrity_failed: 'Office 输出已被更改，交付入口已失效',
    save_as_cancelled: '另存操作已取消'
  }
  return new OfficeSaveIpcError(
    typeof code === 'string' && messages[code] ? code : 'copy_failed',
    typeof code === 'string' && messages[code] ? messages[code]! : '无法创建 Office 输出副本'
  )
}

function invalidRequest(message: string): OfficeSaveIpcError {
  return new OfficeSaveIpcError('invalid-request', message)
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
