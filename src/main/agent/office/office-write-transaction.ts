import {
  OfficeReadError,
  type OfficeReadCell,
  type OfficeReadContext,
  type OfficeReadResponse
} from './office-read'
import type { OfficeReconcileResult } from './office-reconcile'
import type { OfficeServiceDependencies, OwnedOfficeDocument } from './office-service-state'
import type { OfficeRunTarget } from './office-targets'
import {
  formulaFailure,
  formulaInvalidError,
  type OfficeFormulaFailure
} from './office-formula-transaction'
import { officeWriteStrategy, sameSnapshot } from './office-write-operation'
import { armOfficeWriteConfirmation } from './office-write-preview-confirmation'
import {
  OfficeWriteError,
  type OfficePreviewConfirmation,
  type OfficeWriteBefore,
  type OfficeWriteContext,
  type OfficeWriteRequest,
  type OfficeWriteResult,
  type OfficeWriteSnapshot
} from './office-write-contract'
import { assertOwnedOfficeDocumentWritable } from './office-service-guards'
import { operationLogWithSaveStatus, performVerifiedOfficeSave } from './office-save'
import { markOfficeEditing, markOfficeSaved, markOfficeUnsaved } from './office-save-state'

interface OfficeWriteTransactionDependencies {
  readonly service: OfficeServiceDependencies
  readonly assertTarget: (target: OfficeRunTarget) => OwnedOfficeDocument
  readonly reconcileUnknown: (
    owned: OwnedOfficeDocument,
    signal: AbortSignal
  ) => Promise<OfficeReconcileResult>
}

export class OfficeWriteTransaction {
  constructor(private readonly dependencies: OfficeWriteTransactionDependencies) {}

  async run(
    target: OfficeRunTarget,
    owned: OwnedOfficeDocument,
    request: OfficeWriteRequest,
    externalSignal: AbortSignal | undefined,
    queueSignal: AbortSignal,
    recordPrewrite: (before: OfficeWriteBefore) => Promise<void>
  ): Promise<OfficeWriteResult> {
    const previousSaveStatus = owned.saveStatus
    owned.saveStatus = markOfficeEditing(previousSaveStatus)
    try {
      return await this.runApply(
        target,
        owned,
        request,
        externalSignal,
        queueSignal,
        recordPrewrite
      )
    } catch (error) {
      if (!(error instanceof OfficeWriteError) || !isUnknownResult(error)) throw error
      const reconciled = await this.dependencies.reconcileUnknown(owned, queueSignal)
      if (reconciled.editResult) return reconciled.editResult
      if (reconciled.conclusion === 'not_applied') throw writeNotAppliedError()
      throw new OfficeWriteError('write_unknown', '写入结果无法确认，文档已冻结等待核对')
    } finally {
      if (owned.saveStatus.saveState === 'editing') {
        owned.saveStatus =
          owned.freezeState === 'unknown' ||
          owned.needsSave ||
          owned.contentRevision > owned.saveStatus.lastSavedRevision
            ? markOfficeUnsaved(owned.saveStatus)
            : previousSaveStatus
        owned.operationLog = operationLogWithSaveStatus(
          owned.operationLog,
          owned.saveStatus,
          owned.needsSave
        )
      }
    }
  }

  async readSnapshot(
    target: OfficeRunTarget,
    owned: OwnedOfficeDocument,
    request: OfficeWriteRequest,
    signal: AbortSignal,
    verifyAddedSheet = false
  ): Promise<OfficeWriteSnapshot> {
    const strategy = officeWriteStrategy(request.operation)
    if (request.operation.type === 'add_sheet') {
      const reader = this.dependencies.service.readWorkbookSnapshot
      if (!reader) throw new OfficeWriteError('write_failed', '工作表列表读取能力不可用')
      return reader(
        this.readContext(target, owned, signal),
        verifyAddedSheet ? request.operation.name : undefined
      )
    }
    const cells: OfficeReadCell[] = []
    let cursor: string | undefined
    do {
      const response = await this.readSnapshotPage(target, owned, request, signal, cursor)
      this.assertTarget(target)
      if (!('cells' in response)) throw mappedReadError(new Error('missing cells'))
      cells.push(...response.cells)
      cursor = response.complete === false ? response.nextCursor : undefined
      if (response.complete === false && !cursor) throw mappedReadError(new Error('missing cursor'))
    } while (cursor)
    return strategy.snapshot(request.operation, cells)
  }

  private async runApply(
    target: OfficeRunTarget,
    owned: OwnedOfficeDocument,
    request: OfficeWriteRequest,
    externalSignal: AbortSignal | undefined,
    queueSignal: AbortSignal,
    recordPrewrite: (before: OfficeWriteBefore) => Promise<void>
  ): Promise<OfficeWriteResult> {
    this.assertTransactionStart(target, owned, request.baseRevision, externalSignal)
    const signal = combinedSignal(externalSignal, queueSignal)
    const before = await this.readBeforeWrite(target, owned, request, externalSignal, signal)
    if (externalSignal?.aborted) throw cancelledError()
    const strategy = officeWriteStrategy(request.operation)
    strategy.assertBefore?.(request.operation, before)
    await recordPrewrite(strategy.before(request.operation, before))
    if (externalSignal?.aborted) throw cancelledError()
    const confirmation = armOfficeWriteConfirmation(
      this.dependencies.service,
      target.artifactId,
      request.operation
    )
    await this.applyOperation(target, owned, request, signal, confirmation)
    const verified = await this.verifyOperation(
      target,
      owned,
      request,
      before,
      queueSignal,
      confirmation
    )
    await this.rejectInvalidFormula(
      target,
      owned,
      request,
      before,
      verified,
      queueSignal,
      confirmation
    )
    owned.contentRevision += 1
    const saved = await this.save(target, owned, queueSignal)
    const previewConfirmed = await confirmation.promise.catch(() => false)
    this.assertTarget(target)
    return strategy.result(
      request,
      before,
      owned.contentRevision,
      saved,
      previewConfirmed,
      verified
    )
  }

  private async rejectInvalidFormula(
    target: OfficeRunTarget,
    owned: OwnedOfficeDocument,
    request: OfficeWriteRequest,
    before: OfficeWriteSnapshot,
    verified: OfficeWriteSnapshot,
    signal: AbortSignal,
    confirmation: OfficePreviewConfirmation
  ): Promise<void> {
    const failure = await formulaFailure(request, verified, (reference) =>
      this.readFormulaReference(target, owned, reference.sheet, reference.cell, signal)
    )
    if (!failure) return
    await this.restoreInvalidFormula(target, owned, request, before, failure, signal, confirmation)
  }

  private assertTransactionStart(
    target: OfficeRunTarget,
    owned: OwnedOfficeDocument,
    baseRevision: number,
    externalSignal?: AbortSignal
  ): void {
    this.assertTarget(target)
    assertOwnedOfficeDocumentWritable(owned)
    if (owned.contentRevision !== baseRevision) {
      throw new OfficeWriteError('revision_conflict', '文档已更新，请先重新读取后再修改', {
        currentRevision: owned.contentRevision
      })
    }
    if (externalSignal?.aborted) throw cancelledError()
  }

  private async readBeforeWrite(
    target: OfficeRunTarget,
    owned: OwnedOfficeDocument,
    request: OfficeWriteRequest,
    externalSignal: AbortSignal | undefined,
    signal: AbortSignal
  ): Promise<OfficeWriteSnapshot> {
    try {
      return await this.readSnapshot(target, owned, request, signal)
    } catch (error) {
      if (externalSignal?.aborted) throw cancelledError()
      throw error
    }
  }

  private async readSnapshotPage(
    target: OfficeRunTarget,
    owned: OwnedOfficeDocument,
    request: OfficeWriteRequest,
    signal: AbortSignal,
    cursor?: string
  ): Promise<OfficeReadResponse> {
    if (request.operation.type === 'add_sheet') {
      throw new OfficeWriteError('write_failed', '工作表列表必须通过工作簿读取器获取')
    }
    if (
      request.operation.type === 'add_paragraph' ||
      request.operation.type === 'set_paragraph_text' ||
      request.operation.type === 'add_slide' ||
      request.operation.type === 'set_slide_text'
    ) {
      throw new OfficeWriteError(
        'operation_not_supported_for_kind',
        'Word 操作不能通过表格事务读取'
      )
    }
    const strategy = officeWriteStrategy(request.operation)
    try {
      return await this.dependencies.service.readRange(
        this.readContext(target, owned, signal),
        cursor
          ? { cursor }
          : request.operation.type === 'set_range' || request.operation.type === 'format_range'
            ? {
                sheet: request.operation.sheet,
                range: strategy.readRange(request.operation),
                maxCells: request.operation.cellCount
              }
            : { sheet: request.operation.sheet, range: strategy.readRange(request.operation) }
      )
    } catch (error) {
      throw mappedReadError(error)
    }
  }

  private async readFormulaReference(
    target: OfficeRunTarget,
    owned: OwnedOfficeDocument,
    sheet: string,
    cell: string,
    signal: AbortSignal
  ): Promise<{ readonly formula?: string }> {
    const response = await this.dependencies.service.readRange(
      this.readContext(target, owned, signal),
      { sheet, range: cell, maxCells: 1 }
    )
    this.assertTarget(target)
    if (!('cells' in response) || response.cells.length !== 1) throw new Error('missing cell')
    const formula = response.cells[0]?.formula
    return formula ? { formula } : {}
  }

  private async applyOperation(
    target: OfficeRunTarget,
    owned: OwnedOfficeDocument,
    request: OfficeWriteRequest,
    signal: AbortSignal,
    confirmation: OfficePreviewConfirmation
  ): Promise<void> {
    try {
      const context = writeContext(owned, signal, confirmation.markDispatched)
      if (this.dependencies.service.applyWriteOperation) {
        await this.dependencies.service.applyWriteOperation(context, request.operation)
      } else if (request.operation.type === 'set_cell') {
        confirmation.markDispatched?.()
        await this.dependencies.service.applyCellValue(context, {
          sheet: request.operation.sheet,
          cell: request.operation.cell,
          value: request.operation.value,
          baseRevision: request.baseRevision
        })
      } else {
        throw new OfficeWriteError('write_failed', 'Office 范围写入能力不可用')
      }
      this.assertTarget(target)
    } catch (error) {
      confirmation.cancel()
      if (error instanceof OfficeWriteError && isTargetError(error)) throw error
      if (error instanceof OfficeWriteError && error.code === 'write_failed') {
        throw new OfficeWriteError('write_failed', 'Office 未能可靠完成写入')
      }
      if (error instanceof OfficeWriteError && error.code === 'range_too_large') throw error
      owned.freezeState = 'unknown'
      throw new OfficeWriteError('write_unknown', '写入结果无法确认，文档已冻结等待核对')
    }
  }

  private async verifyOperation(
    target: OfficeRunTarget,
    owned: OwnedOfficeDocument,
    request: OfficeWriteRequest,
    before: OfficeWriteSnapshot,
    signal: AbortSignal,
    confirmation: OfficePreviewConfirmation
  ): Promise<OfficeWriteSnapshot> {
    try {
      const current = await this.readSnapshot(target, owned, request, signal, true)
      const strategy = officeWriteStrategy(request.operation)
      const valid =
        strategy.verify?.(request.operation, before, current) ??
        (request.operation.type === 'set_formula'
          ? true
          : sameSnapshot(current, strategy.expected(request.operation, before)))
      if (!valid) throw new Error('mismatch')
      return current
    } catch (error) {
      confirmation.cancel()
      if (error instanceof OfficeWriteError && isTargetError(error)) throw error
      owned.freezeState = 'unknown'
      throw new OfficeWriteError(
        'write_verification_failed',
        '内容可能已写入，但读回校验失败，文档已冻结等待核对'
      )
    }
  }

  private async restoreInvalidFormula(
    target: OfficeRunTarget,
    owned: OwnedOfficeDocument,
    request: OfficeWriteRequest,
    before: OfficeWriteSnapshot,
    failure: OfficeFormulaFailure,
    signal: AbortSignal,
    confirmation: OfficePreviewConfirmation
  ): Promise<never> {
    confirmation.cancel()
    try {
      const restore = this.dependencies.service.restoreWriteOperation
      if (!restore || request.operation.type !== 'set_formula') throw new Error('unavailable')
      const strategy = officeWriteStrategy(request.operation)
      const evidence = strategy.before(request.operation, before)
      await restore(writeContext(owned, signal), request.operation, evidence)
      this.assertTarget(target)
      const restored = await this.readSnapshot(target, owned, request, signal)
      if (
        JSON.stringify(strategy.before(request.operation, restored)) !== JSON.stringify(evidence)
      ) {
        throw new Error('restore mismatch')
      }
      if (!(await this.save(target, owned, signal))) throw new Error('restore save failed')
      throw formulaInvalidError(request.operation, owned.contentRevision, failure)
    } catch (error) {
      if (error instanceof OfficeWriteError && error.code === 'formula_invalid') throw error
      owned.freezeState = 'unknown'
      throw new OfficeWriteError('write_unknown', '公式回退结果无法确认，文档已冻结等待核对')
    }
  }

  private async save(
    target: OfficeRunTarget,
    owned: OwnedOfficeDocument,
    signal: AbortSignal
  ): Promise<boolean> {
    try {
      const verified = await performVerifiedOfficeSave(this.dependencies.service, owned, signal)
      owned.needsSave = false
      owned.saveStatus = markOfficeSaved(owned.saveStatus, {
        revision: owned.contentRevision,
        savedAt: (this.dependencies.service.now ?? (() => new Date()))().toISOString(),
        ...(verified ? { sha256: verified.sha256 } : {})
      })
      owned.operationLog = operationLogWithSaveStatus(owned.operationLog, owned.saveStatus, false)
      this.assertTarget(target)
      return true
    } catch (error) {
      if (error instanceof OfficeWriteError && isTargetError(error)) throw error
      owned.needsSave = true
      owned.saveStatus = markOfficeUnsaved(owned.saveStatus)
      owned.operationLog = operationLogWithSaveStatus(owned.operationLog, owned.saveStatus, true)
      return false
    }
  }

  private assertTarget(target: OfficeRunTarget): OwnedOfficeDocument {
    try {
      return this.dependencies.assertTarget(target)
    } catch (error) {
      throw mappedTargetError(error)
    }
  }

  private readContext(
    target: OfficeRunTarget,
    owned: OwnedOfficeDocument,
    signal: AbortSignal
  ): OfficeReadContext {
    return {
      artifactId: target.artifactId,
      binaryPath: owned.binaryPath,
      draftPath: owned.document.draftPath,
      revision: owned.contentRevision,
      signal
    }
  }
}

function writeContext(
  owned: OwnedOfficeDocument,
  signal: AbortSignal,
  onSpawn?: () => void
): OfficeWriteContext {
  return {
    binaryPath: owned.binaryPath,
    draftPath: owned.document.draftPath,
    signal,
    ...(onSpawn ? { onSpawn } : {})
  }
}

function mappedTargetError(error: unknown): OfficeWriteError {
  if (error instanceof OfficeWriteError) return error
  return new OfficeWriteError('write_failed', '无法解析 Office 写入目标')
}

function mappedReadError(error: unknown): OfficeWriteError {
  if (error instanceof OfficeWriteError) return error
  if (error instanceof OfficeReadError && error.code === 'read_cancelled') {
    return cancelledError()
  }
  if (error instanceof OfficeReadError && error.code === 'invalid_sheet') {
    return new OfficeWriteError('invalid_sheet', error.message)
  }
  return new OfficeWriteError('write_failed', '无法读取待修改的 Office 单元格')
}

function combinedSignal(external: AbortSignal | undefined, queue: AbortSignal): AbortSignal {
  return external ? AbortSignal.any([external, queue]) : queue
}

function cancelledError(): OfficeWriteError {
  return new OfficeWriteError('write_cancelled', '写入已取消，文档未修改')
}

function isTargetError(error: OfficeWriteError): boolean {
  return ['no_target', 'target_missing', 'session_mismatch'].includes(error.code)
}

function isUnknownResult(error: OfficeWriteError): boolean {
  return error.code === 'write_unknown' || error.code === 'write_verification_failed'
}

function writeNotAppliedError(): OfficeWriteError {
  return new OfficeWriteError('write_not_applied', '已核对：写入未生效，可使用新的操作重试')
}
