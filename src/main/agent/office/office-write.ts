import { basename } from 'node:path'

import { OfficeReadError } from './office-read'
import { OfficeOperationQueueCancelledError } from './office-operation-queue'
import type { OfficeReconcileResult } from './office-reconcile'
import type { OfficeServiceDependencies, OwnedOfficeDocument } from './office-service-state'
import { OfficeTargetError, type OfficeRunTarget } from './office-targets'
import { OfficeWriteIdempotency } from './office-write-idempotency'
import { cellWriteRequest, officeWriteStrategy, rangeWriteRequest } from './office-write-operation'
import {
  OfficeWriteError,
  type OfficeCellEditDescription,
  type OfficeCellEditOptions,
  type OfficeCellEditParams,
  type OfficeCellEditResult,
  type OfficeDescribeCellEditParams,
  type OfficeRangeEditDescription,
  type OfficeRangeEditParams,
  type OfficeRangeEditResult,
  type OfficeWriteDescription,
  type OfficeWriteBefore,
  type OfficeWriteRequest,
  type OfficeWriteResult
} from './office-write-contract'
import { OfficeWriteTransaction } from './office-write-transaction'
import { OfficeDocxTransaction } from './office-docx-transaction'
import { OfficePptxTransaction } from './office-pptx-transaction'
import { officeArtifactKind } from './office-document-kind'
import { clearCellWriteRequest } from './office-clear-operation'
import { formulaWriteRequest } from './office-formula-operation'
import { assertOwnedOfficeDocumentWritable } from './office-service-guards'
import type { OfficeHumanWriteOperation } from './office-human-edit-translate'

interface OfficeWriteFlowDependencies {
  readonly service: OfficeServiceDependencies
  readonly resolveTarget: (runId: string) => OfficeRunTarget
  readonly signalForRun: (runId: string) => AbortSignal | undefined
  readonly assertTarget: (target: OfficeRunTarget) => OwnedOfficeDocument
  readonly reconcileUnknown: (
    owned: OwnedOfficeDocument,
    signal: AbortSignal
  ) => Promise<OfficeReconcileResult>
}

export class OfficeWriteFlow {
  private readonly idempotency: OfficeWriteIdempotency
  private readonly transaction: OfficeWriteTransaction
  private readonly docxTransaction: OfficeDocxTransaction
  private readonly pptxTransaction: OfficePptxTransaction

  constructor(private readonly dependencies: OfficeWriteFlowDependencies) {
    this.idempotency = new OfficeWriteIdempotency(dependencies.service)
    this.transaction = new OfficeWriteTransaction({
      service: dependencies.service,
      assertTarget: dependencies.assertTarget,
      reconcileUnknown: dependencies.reconcileUnknown
    })
    this.docxTransaction = new OfficeDocxTransaction({
      service: dependencies.service,
      assertTarget: dependencies.assertTarget,
      reconcileUnknown: dependencies.reconcileUnknown
    })
    this.pptxTransaction = new OfficePptxTransaction({
      service: dependencies.service,
      assertTarget: dependencies.assertTarget,
      reconcileUnknown: dependencies.reconcileUnknown
    })
  }

  apply(
    runId: string,
    params: OfficeCellEditParams,
    options: OfficeCellEditOptions = {}
  ): Promise<OfficeCellEditResult> {
    return this.applyRequest(
      runId,
      cellWriteRequest(params),
      options
    ) as Promise<OfficeCellEditResult>
  }

  applyRange(
    runId: string,
    params: OfficeRangeEditParams,
    options: OfficeCellEditOptions = {}
  ): Promise<OfficeRangeEditResult> {
    return this.applyRequest(
      runId,
      rangeWriteRequest(params),
      options
    ) as Promise<OfficeRangeEditResult>
  }

  async applyRequest(
    runId: string,
    request: OfficeWriteRequest,
    options: OfficeCellEditOptions = {}
  ): Promise<OfficeWriteResult> {
    assertOperationId(options.operationId)
    const target = this.resolveTarget(runId)
    const owned = this.assertTarget(target)
    assertOperationKind(owned, request)
    try {
      return await owned.operations.run(
        (signal) => this.runIdempotentApply(target, owned, request, options, signal),
        { owner: runId, signal: options.signal }
      )
    } catch (error) {
      if (error instanceof OfficeWriteError) throw error
      throw mappedTargetError(error)
    }
  }

  async applyHuman(
    owned: OwnedOfficeDocument,
    operation: OfficeHumanWriteOperation,
    options: OfficeCellEditOptions
  ): Promise<OfficeWriteResult> {
    assertOperationId(options.operationId)
    try {
      return await owned.operations.run((signal) => {
        const request = humanWriteRequest(operation, owned.contentRevision)
        const target = humanTarget(owned, options.operationId!)
        return this.runIdempotentApply(target, owned, request, options, signal, 'human')
      })
    } catch (error) {
      if (error instanceof OfficeWriteError) throw error
      throw mappedTargetError(error)
    }
  }

  shouldBypassApproval(
    runId: string,
    params: OfficeCellEditParams,
    operationId: string
  ): Promise<boolean> {
    return this.shouldBypassRequestApproval(runId, cellWriteRequest(params), operationId)
  }

  async shouldBypassRequestApproval(
    runId: string,
    request: OfficeWriteRequest,
    operationId: string
  ): Promise<boolean> {
    assertOperationId(operationId)
    const target = this.resolveTarget(runId)
    const owned = this.assertTarget(target)
    assertOperationKind(owned, request)
    try {
      return await owned.operations.run(
        () => {
          this.assertTarget(target)
          return this.idempotency.shouldBypassApproval(owned, request, operationId)
        },
        { owner: runId, signal: this.dependencies.signalForRun(runId) }
      )
    } catch (error) {
      if (error instanceof OfficeWriteError) throw error
      throw mappedTargetError(error)
    }
  }

  describe(
    runId: string,
    params: OfficeDescribeCellEditParams
  ): Promise<OfficeCellEditDescription> {
    return this.describeRequest(
      runId,
      cellWriteRequest({ ...params, baseRevision: 0 })
    ) as Promise<OfficeCellEditDescription>
  }

  describeRange(runId: string, params: OfficeRangeEditParams): Promise<OfficeRangeEditDescription> {
    return this.describeRequest(
      runId,
      rangeWriteRequest(params)
    ) as Promise<OfficeRangeEditDescription>
  }

  async describeRequest(
    runId: string,
    request: OfficeWriteRequest
  ): Promise<OfficeWriteDescription> {
    const target = this.resolveTarget(runId)
    const owned = this.assertTarget(target)
    assertOperationKind(owned, request)
    assertOwnedOfficeDocumentWritable(owned)
    try {
      return await owned.operations.run(
        async (signal) => {
          this.assertTarget(target)
          assertOwnedOfficeDocumentWritable(owned)
          const kind = officeWriteStrategy(request.operation).documentKind
          const before =
            kind === 'docx'
              ? await this.docxTransaction.readSnapshot(target, owned, signal)
              : kind === 'pptx'
                ? await this.pptxTransaction.readSnapshot(target, owned, signal)
                : await this.transaction.readSnapshot(target, owned, request, signal)
          this.assertTarget(target)
          return officeWriteStrategy(request.operation).describe(
            request,
            before,
            basename(owned.document.sourcePath ?? owned.document.draftPath),
            owned.contentRevision
          )
        },
        { owner: runId, signal: this.dependencies.signalForRun(runId) }
      )
    } catch (error) {
      throw mappedReadError(error)
    }
  }

  private async runIdempotentApply(
    target: OfficeRunTarget,
    owned: OwnedOfficeDocument,
    request: OfficeWriteRequest,
    options: OfficeCellEditOptions,
    queueSignal: AbortSignal,
    source?: 'human'
  ): Promise<OfficeWriteResult> {
    this.assertTarget(target)
    const result = await this.idempotency.run(
      owned,
      request,
      options,
      async (recordPrewrite) => {
        assertOwnedOfficeDocumentWritable(owned)
        if (options.signal?.aborted) throw cancelledError()
        const result = await this.runOperationTransaction(
          target,
          owned,
          request,
          options.signal,
          queueSignal,
          recordPrewrite
        )
        if (!result.saved) throw saveFailedError(result)
        return result
      },
      source
    )
    if (
      source !== 'human' &&
      result.deduplicated !== true &&
      result.saved &&
      result.previewConfirmed &&
      owned.freezeState !== 'unknown'
    ) {
      try {
        this.dependencies.service.publishConfirmedWrite?.(
          owned.document.artifactId,
          request.operation
        )
      } catch {
        // Preview decoration is best-effort and must never change a confirmed write receipt.
      }
    }
    return result
  }

  private runOperationTransaction(
    target: OfficeRunTarget,
    owned: OwnedOfficeDocument,
    request: OfficeWriteRequest,
    signal: AbortSignal | undefined,
    queueSignal: AbortSignal,
    recordPrewrite: (before: OfficeWriteBefore) => Promise<void>
  ): Promise<OfficeWriteResult> {
    const kind = officeWriteStrategy(request.operation).documentKind
    const transaction =
      kind === 'docx'
        ? this.docxTransaction
        : kind === 'pptx'
          ? this.pptxTransaction
          : this.transaction
    return transaction.run(target, owned, request, signal, queueSignal, recordPrewrite)
  }

  private resolveTarget(runId: string): OfficeRunTarget {
    try {
      return this.dependencies.resolveTarget(runId)
    } catch (error) {
      throw mappedTargetError(error)
    }
  }

  private assertTarget(target: OfficeRunTarget): OwnedOfficeDocument {
    try {
      return this.dependencies.assertTarget(target)
    } catch (error) {
      throw mappedTargetError(error)
    }
  }
}

function assertOperationKind(owned: OwnedOfficeDocument, request: OfficeWriteRequest): void {
  const actual = officeArtifactKind(owned.document as unknown as Record<string, unknown>)
  const expected = officeWriteStrategy(request.operation).documentKind ?? 'xlsx'
  if (actual !== expected) {
    throw new OfficeWriteError('operation_not_supported_for_kind', '该写入操作不适用于当前文档类型')
  }
}

function humanWriteRequest(
  operation: OfficeHumanWriteOperation,
  baseRevision: number
): OfficeWriteRequest {
  if (operation.type === 'clear_cell') {
    return clearCellWriteRequest({
      sheet: operation.sheet,
      cell: operation.cell,
      baseRevision
    })
  }
  if (operation.type === 'set_formula') {
    return formulaWriteRequest({
      sheet: operation.sheet,
      cell: operation.cell,
      formula: operation.formula,
      baseRevision
    })
  }
  return cellWriteRequest({
    sheet: operation.sheet,
    cell: operation.cell,
    value: operation.value,
    baseRevision
  })
}

function humanTarget(owned: OwnedOfficeDocument, operationId: string): OfficeRunTarget {
  return Object.freeze({
    runId: `human:${operationId}`,
    artifactId: owned.document.artifactId,
    sessionId: owned.document.sessionId,
    projectId: owned.document.projectId
  })
}

function assertOperationId(operationId: string | undefined): asserts operationId is string {
  if (!operationId || operationId.length > 200) {
    throw new OfficeWriteError('missing_operation_id', '写入请求缺少可信操作编号，未做任何修改')
  }
}

function mappedTargetError(error: unknown): OfficeWriteError {
  if (error instanceof OfficeOperationQueueCancelledError) return cancelledError()
  if (error instanceof OfficeTargetError) {
    if (['no_target', 'target_missing', 'session_mismatch'].includes(error.code)) {
      return new OfficeWriteError(error.code as 'no_target', error.message)
    }
  }
  if (error instanceof OfficeWriteError) return error
  return new OfficeWriteError('write_failed', '无法解析 Office 写入目标')
}

function mappedReadError(error: unknown): OfficeWriteError {
  if (error instanceof OfficeWriteError) return error
  if (
    error instanceof OfficeOperationQueueCancelledError ||
    (error instanceof OfficeReadError && error.code === 'read_cancelled')
  ) {
    return cancelledError()
  }
  if (error instanceof OfficeReadError && error.code === 'invalid_sheet') {
    return new OfficeWriteError('invalid_sheet', error.message)
  }
  return new OfficeWriteError('write_failed', '无法读取待修改的 Office 单元格')
}

function cancelledError(): OfficeWriteError {
  return new OfficeWriteError('write_cancelled', '写入已取消，文档未修改')
}

function saveFailedError(result: OfficeWriteResult): OfficeWriteError {
  return new OfficeWriteError('save_failed', '内容已写入，但 Office 草稿保存失败', { result })
}

export * from './office-write-contract'
export * from './office-write-operation'
export { OfficeBatchWriter } from './office-batch-writer'
export { OfficeCellWriter } from './office-cell-writer'
