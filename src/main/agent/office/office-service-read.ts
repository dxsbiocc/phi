import { OfficeReadError, type OfficeReadParams, type OfficeReadResponse } from './office-read'
import type { OfficeDocumentReadResponse } from './office-docx-read'
import { officeArtifactKind } from './office-document-kind'
import {
  OfficeOperationQueueCancelledError,
  OfficeOperationQueueError
} from './office-operation-queue'
import type { OfficeServiceDependencies, OwnedOfficeDocument } from './office-service-state'
import {
  OfficeTargetError,
  type OfficeRunTarget,
  type OfficeTargetRegistry
} from './office-targets'

interface OfficeServiceReadState {
  readonly dependencies: OfficeServiceDependencies
  readonly targets: OfficeTargetRegistry
  readonly owned: ReadonlyMap<string, OwnedOfficeDocument>
  readonly closingArtifacts: ReadonlySet<string>
}

export class OfficeServiceReadFlow {
  constructor(private readonly state: OfficeServiceReadState) {}

  async readRange(runId: string, params: OfficeReadParams): Promise<OfficeDocumentReadResponse> {
    const target = this.resolveTarget(runId)
    const owned = this.assertTarget(target)
    const runSignal = this.state.targets.signalForRun(runId)
    try {
      return await owned.operations.run(
        async (queueSignal) => {
          if (runSignal?.aborted) throw cancelledReadError()
          const signal = runSignal ? AbortSignal.any([queueSignal, runSignal]) : queueSignal
          this.assertTarget(target)
          try {
            const context = {
              artifactId: target.artifactId,
              binaryPath: owned.binaryPath,
              draftPath: owned.document.draftPath,
              revision: owned.contentRevision,
              selection: target.selection,
              signal
            }
            const kind = officeArtifactKind(owned.document as unknown as Record<string, unknown>)
            const result =
              kind === 'docx'
                ? await this.readParagraphs(context, params)
                : kind === 'pptx'
                  ? await this.readSlides(context, params)
                  : await this.readSpreadsheet(context, params)
            this.assertTarget(target)
            return result
          } catch (error) {
            this.assertTarget(target)
            if (runSignal?.aborted) throw cancelledReadError()
            if (error instanceof OfficeReadError) throw error
            throw new OfficeReadError('read_failed', '无法读取 Office 内容，请稍后重试')
          }
        },
        { owner: runId, signal: runSignal }
      )
    } catch (error) {
      this.assertTarget(target)
      if (error instanceof OfficeReadError) throw error
      if (error instanceof OfficeOperationQueueError) {
        throw new OfficeReadError('workbook_busy', error.message)
      }
      if (error instanceof OfficeOperationQueueCancelledError) {
        throw new OfficeReadError('read_cancelled', error.message)
      }
      throw new OfficeReadError('read_failed', '无法读取 Office 内容，请稍后重试')
    }
  }

  private readParagraphs(
    context: Parameters<OfficeServiceDependencies['readRange']>[0],
    params: OfficeReadParams
  ): Promise<OfficeDocumentReadResponse> {
    const read = this.state.dependencies.readParagraphs
    if (!read) throw new OfficeReadError('read_failed', 'Word 段落读取能力不可用')
    return read(context, params)
  }

  private readSpreadsheet(
    context: Parameters<OfficeServiceDependencies['readRange']>[0],
    params: OfficeReadParams
  ): Promise<OfficeReadResponse> {
    if (params.from !== undefined || params.limit !== undefined) {
      throw new OfficeReadError('invalid_arguments', '表格读取不接受 from 或 limit')
    }
    return this.state.dependencies.readRange(context, params)
  }

  private readSlides(
    context: Parameters<OfficeServiceDependencies['readRange']>[0],
    params: OfficeReadParams
  ): Promise<OfficeDocumentReadResponse> {
    const read = this.state.dependencies.readSlides
    if (!read) throw new OfficeReadError('read_failed', 'PowerPoint 文本读取能力不可用')
    return read(context, params)
  }

  private resolveTarget(runId: string): OfficeRunTarget {
    try {
      return this.state.targets.resolveRunTarget(runId)
    } catch (error) {
      if (
        error instanceof OfficeTargetError &&
        ['no_target', 'target_missing', 'session_mismatch'].includes(error.code)
      ) {
        throw new OfficeReadError(error.code as 'no_target', error.message)
      }
      throw new OfficeReadError('read_failed', '无法解析 Office 读取目标')
    }
  }

  private assertTarget(target: OfficeRunTarget): OwnedOfficeDocument {
    const owned = this.state.owned.get(target.artifactId)
    if (!owned || this.state.closingArtifacts.has(target.artifactId)) {
      throw new OfficeReadError('target_missing', '关联的 Office 文档已不存在或已关闭')
    }
    if (
      owned.document.sessionId !== target.sessionId ||
      owned.document.projectId !== target.projectId
    ) {
      throw new OfficeReadError('session_mismatch', '关联的 Office 文档不属于当前会话或项目')
    }
    return owned
  }
}

function cancelledReadError(): OfficeReadError {
  return new OfficeReadError('read_cancelled', '读取已取消')
}
