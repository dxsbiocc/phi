import type { OfficeReconcileResult } from './office-reconcile'
import { operationLogWithSaveStatus, performVerifiedOfficeSave } from './office-save'
import { assertOwnedOfficeDocumentWritable } from './office-service-guards'
import type { OfficeServiceDependencies, OwnedOfficeDocument } from './office-service-state'
import { markOfficeEditing, markOfficeSaved, markOfficeUnsaved } from './office-save-state'
import type { OfficeRunTarget } from './office-targets'
import { officeWriteStrategy } from './office-write-operation'
import {
  OfficeWriteError,
  type OfficeInternalWriteOperation,
  type OfficePreviewConfirmation,
  type OfficeWriteBefore,
  type OfficeWriteContext,
  type OfficeWriteRequest,
  type OfficeWriteResult,
  type OfficeWriteSnapshot
} from './office-write-contract'

export interface OfficeDocumentTransactionAdapter<
  Operation extends OfficeInternalWriteOperation,
  Before extends OfficeWriteBefore,
  Receipt
> {
  readonly label: string
  requireOperation(request: OfficeWriteRequest): Operation
  expectedText(operation: Operation): string
  read(
    service: OfficeServiceDependencies,
    context: OfficeWriteContext
  ): Promise<OfficeWriteSnapshot>
  apply(
    service: OfficeServiceDependencies,
    context: OfficeWriteContext,
    operation: Operation,
    before: OfficeWriteSnapshot
  ): Promise<Receipt>
  restore(
    service: OfficeServiceDependencies,
    context: OfficeWriteContext,
    operation: Operation,
    before: Before,
    receipt: Receipt
  ): Promise<void>
}

export interface OfficeDocumentTransactionDependencies {
  readonly service: OfficeServiceDependencies
  readonly assertTarget: (target: OfficeRunTarget) => OwnedOfficeDocument
  readonly reconcileUnknown: (
    owned: OwnedOfficeDocument,
    signal: AbortSignal
  ) => Promise<OfficeReconcileResult>
}

export class OfficeDocumentTransaction<
  Operation extends OfficeInternalWriteOperation,
  Before extends OfficeWriteBefore,
  Receipt
> {
  constructor(
    private readonly dependencies: OfficeDocumentTransactionDependencies,
    private readonly adapter: OfficeDocumentTransactionAdapter<Operation, Before, Receipt>
  ) {}

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
      if (!(error instanceof OfficeWriteError) || !isUnknown(error)) throw error
      const reconciled = await this.dependencies.reconcileUnknown(owned, queueSignal)
      if (reconciled.editResult) return reconciled.editResult
      if (reconciled.conclusion === 'not_applied') throw writeNotAppliedError()
      throw new OfficeWriteError('write_unknown', '写入结果无法确认，文档已冻结等待核对')
    } finally {
      this.finishEditing(owned, previousSaveStatus)
    }
  }

  async readSnapshot(
    target: OfficeRunTarget,
    owned: OwnedOfficeDocument,
    signal: AbortSignal
  ): Promise<OfficeWriteSnapshot> {
    const snapshot = await this.adapter.read(this.dependencies.service, writeContext(owned, signal))
    this.assertTarget(target)
    return snapshot
  }

  private async runApply(
    target: OfficeRunTarget,
    owned: OwnedOfficeDocument,
    request: OfficeWriteRequest,
    externalSignal: AbortSignal | undefined,
    queueSignal: AbortSignal,
    recordPrewrite: (before: OfficeWriteBefore) => Promise<void>
  ): Promise<OfficeWriteResult> {
    const operation = this.adapter.requireOperation(request)
    this.assertStart(target, owned, request.baseRevision, externalSignal)
    const signal = externalSignal ? AbortSignal.any([externalSignal, queueSignal]) : queueSignal
    const before = await this.readSnapshot(target, owned, signal)
    const strategy = officeWriteStrategy(operation)
    strategy.assertBefore?.(operation, before)
    const evidence = strategy.before(operation, before)
    await recordPrewrite(evidence)
    if (externalSignal?.aborted) throw cancelledError()
    const confirmation = this.armConfirmation(
      target.artifactId,
      this.adapter.expectedText(operation)
    )
    let receipt: Receipt
    try {
      receipt = await this.adapter.apply(
        this.dependencies.service,
        writeContext(owned, signal, confirmation.markDispatched),
        operation,
        before
      )
    } catch (error) {
      confirmation.cancel()
      throw this.mapApplyError(owned, error)
    }
    const current = await this.verifyOrRollback(
      target,
      owned,
      operation,
      evidence as Before,
      receipt,
      before,
      signal,
      confirmation
    )
    owned.contentRevision += 1
    const saved = await this.save(target, owned, queueSignal)
    const previewConfirmed = await confirmation.promise.catch(() => false)
    this.assertTarget(target)
    return strategy.result(request, before, owned.contentRevision, saved, previewConfirmed, current)
  }

  private async verifyOrRollback(
    target: OfficeRunTarget,
    owned: OwnedOfficeDocument,
    operation: Operation,
    beforeEvidence: Before,
    receipt: Receipt,
    before: OfficeWriteSnapshot,
    signal: AbortSignal,
    confirmation: OfficePreviewConfirmation
  ): Promise<OfficeWriteSnapshot> {
    try {
      const current = await this.readSnapshot(target, owned, signal)
      const conclusion = officeWriteStrategy(operation).classify(operation, before, current)
      if (conclusion !== 'applied' && conclusion !== 'applied_no_change')
        throw new Error('mismatch')
      return current
    } catch (error) {
      confirmation.cancel()
      if (error instanceof OfficeWriteError && isTargetError(error)) throw error
      await this.rollback(target, owned, operation, beforeEvidence, receipt, before, signal)
      throw new OfficeWriteError(
        'write_failed',
        `${this.adapter.label}修改未通过读回校验，已恢复写入前内容`
      )
    }
  }

  private async rollback(
    target: OfficeRunTarget,
    owned: OwnedOfficeDocument,
    operation: Operation,
    beforeEvidence: Before,
    receipt: Receipt,
    before: OfficeWriteSnapshot,
    signal: AbortSignal
  ): Promise<void> {
    try {
      await this.adapter.restore(
        this.dependencies.service,
        writeContext(owned, signal),
        operation,
        beforeEvidence,
        receipt
      )
      const restored = await this.readSnapshot(target, owned, signal)
      const conclusion = officeWriteStrategy(operation).classify(operation, before, restored)
      if (conclusion !== 'not_applied' && conclusion !== 'applied_no_change')
        throw new Error('mismatch')
      if (!(await this.save(target, owned, signal))) throw new Error('save failed')
    } catch {
      owned.freezeState = 'unknown'
      throw new OfficeWriteError(
        'write_unknown',
        `${this.adapter.label}回滚结果无法确认，文档已冻结等待核对`
      )
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

  private assertStart(
    target: OfficeRunTarget,
    owned: OwnedOfficeDocument,
    revision: number,
    signal?: AbortSignal
  ): void {
    this.assertTarget(target)
    assertOwnedOfficeDocumentWritable(owned)
    if (owned.contentRevision !== revision) {
      throw new OfficeWriteError('revision_conflict', '文档已更新，请先重新读取后再修改', {
        currentRevision: owned.contentRevision
      })
    }
    if (signal?.aborted) throw cancelledError()
  }

  private assertTarget(target: OfficeRunTarget): OwnedOfficeDocument {
    try {
      return this.dependencies.assertTarget(target)
    } catch (error) {
      if (error instanceof OfficeWriteError) throw error
      throw new OfficeWriteError('write_failed', '无法解析 Office 写入目标')
    }
  }

  private armConfirmation(artifactId: string, text: string): OfficePreviewConfirmation {
    return (
      this.dependencies.service.armDocumentPreviewConfirmation?.(artifactId, text) ?? {
        promise: Promise.resolve(false),
        cancel: () => undefined
      }
    )
  }

  private mapApplyError(owned: OwnedOfficeDocument, error: unknown): OfficeWriteError {
    if (error instanceof OfficeWriteError && !isUnknown(error)) return error
    owned.freezeState = 'unknown'
    return error instanceof OfficeWriteError
      ? error
      : new OfficeWriteError(
          'write_unknown',
          `${this.adapter.label}写入结果无法确认，文档已冻结等待核对`
        )
  }

  private finishEditing(
    owned: OwnedOfficeDocument,
    previous: OwnedOfficeDocument['saveStatus']
  ): void {
    if (owned.saveStatus.saveState !== 'editing') return
    owned.saveStatus =
      owned.freezeState === 'unknown' ||
      owned.needsSave ||
      owned.contentRevision > owned.saveStatus.lastSavedRevision
        ? markOfficeUnsaved(owned.saveStatus)
        : previous
    owned.operationLog = operationLogWithSaveStatus(
      owned.operationLog,
      owned.saveStatus,
      owned.needsSave
    )
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

function isUnknown(error: OfficeWriteError): boolean {
  return error.code === 'write_unknown' || error.code === 'write_verification_failed'
}

function isTargetError(error: OfficeWriteError): boolean {
  return ['no_target', 'target_missing', 'session_mismatch'].includes(error.code)
}

function cancelledError(): OfficeWriteError {
  return new OfficeWriteError('write_cancelled', '写入已取消，文档未修改')
}

function writeNotAppliedError(): OfficeWriteError {
  return new OfficeWriteError('write_not_applied', '已核对：写入未生效，可使用新的操作重试')
}
