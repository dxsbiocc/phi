import type { OfficeReadCell, OfficeReadContext } from './office-read-contract'
import {
  persistOfficeOperationLog,
  pruneOfficeOperationLog,
  storedOperationRequest,
  type OfficeOperationLogState,
  type OfficeOperationReceipt,
  type OfficeOperationRecord,
  type OfficeReconcileConclusion,
  type OfficeReconcileSummary
} from './office-operation-log'
import type { OfficeServiceDependencies, OwnedOfficeDocument } from './office-service-state'
import { formulaFailure } from './office-formula-transaction'
import {
  OfficeWriteError,
  type OfficeInternalWriteOperation,
  type OfficeWriteContext,
  type OfficeWriteResult,
  type OfficeWriteSnapshot
} from './office-write-contract'
import { officeWriteStrategy } from './office-write-operation'
import { readOfficeDocxReconcileSnapshot } from './office-docx-reconcile'
import { readOfficePptxReconcileSnapshot } from './office-pptx-reconcile'
import { restoreOfficeSaveStatus } from './office-save-state'
import { markOfficeSaved, markOfficeUnsaved } from './office-save-state'
import {
  operationLogWithSaveStatus,
  performVerifiedOfficeSave,
  type OfficeSavedFileVerification
} from './office-save'

const MAX_RECONCILE_READ_TIMEOUT_MS = 30_000
const UNCERTAIN_CODES = new Set(['write_unknown', 'write_verification_failed'])

export interface OfficeReconcileResult {
  readonly conclusion: OfficeReconcileConclusion
  readonly message: string
  readonly revision: number
  readonly freezeState?: 'unknown'
  readonly needsSave?: boolean
  readonly editResult?: OfficeWriteResult
  readonly code?: 'reconcile_indeterminate'
}

interface ReconcileCandidate {
  readonly operationId: string
  readonly record: OfficeOperationRecord
}

export class OfficeReconcileFlow {
  constructor(
    private readonly service: OfficeServiceDependencies,
    private readonly assertActive: (owned: OwnedOfficeDocument) => void
  ) {}

  async reconcileOwned(
    owned: OwnedOfficeDocument,
    signal: AbortSignal
  ): Promise<OfficeReconcileResult> {
    this.ensureActive(owned)
    if (owned.operationLog.integrityError) throw corruptLogError()
    const candidates = findCandidates(owned.operationLog)
    if (candidates.length > 1) {
      return this.keepIndeterminate(owned, '存在多条未决写入，无法安全判断')
    }
    const candidate = candidates[0]
    if (!candidate) return this.resultWithoutCandidate(owned)
    if (!candidate.record.operation || !Object.hasOwn(candidate.record, 'before')) {
      return this.keepIndeterminate(owned, '缺少可信的写入前核对信息')
    }
    const request = storedOperationRequest(candidate.record.operation)
    if (request.baseRevision !== owned.contentRevision) {
      return this.keepIndeterminate(owned, '内容版本已变化，无法确认该次写入结果')
    }
    const strategy = officeWriteStrategy(request.operation)
    let before: OfficeWriteSnapshot
    try {
      before = strategy.restoreBefore(
        request.operation,
        candidate.record.before as NonNullable<OfficeOperationRecord['before']>
      )
    } catch {
      return this.keepIndeterminate(owned, '写入前核对信息无效')
    }
    const current = await this.readCurrent(owned, candidate, signal)
    if (!current.ok) return this.keepIndeterminate(owned, current.reason)
    const conclusion = strategy.classify(request.operation, before, current.value)
    if (conclusion === 'indeterminate') {
      return this.keepIndeterminate(owned, '当前值与写入前及预期值均不一致')
    }
    if (conclusion === 'applied' || conclusion === 'applied_no_change') {
      const invalid = await formulaFailure(request, current.value, (reference) =>
        this.readFormulaReference(owned, reference.sheet, reference.cell, signal)
      )
      if (invalid) return this.keepIndeterminate(owned, formulaReconcileReason(invalid.reason))
    }
    if (conclusion === 'not_applied' && owned.needsSave) {
      return this.keepIndeterminate(owned, '写入前内容已恢复，但保存状态仍无法确认')
    }
    if (conclusion === 'not_applied') return this.finishNotApplied(owned, candidate)
    return this.finishApplied(owned, candidate, conclusion, current.value, signal)
  }

  private async readCurrent(
    owned: OwnedOfficeDocument,
    candidate: ReconcileCandidate,
    signal: AbortSignal
  ): Promise<{ ok: true; value: OfficeWriteSnapshot } | { ok: false; reason: string }> {
    const request = storedOperationRequest(candidate.record.operation!)
    const operation = request.operation
    const strategy = officeWriteStrategy(operation)
    const timeoutMs = Math.max(
      1,
      Math.min(
        this.service.reconcileTimeoutMs ?? MAX_RECONCILE_READ_TIMEOUT_MS,
        MAX_RECONCILE_READ_TIMEOUT_MS
      )
    )
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = AbortSignal.any([signal, timeout])
    try {
      if (
        operation.type === 'add_paragraph' ||
        operation.type === 'set_paragraph_text' ||
        operation.type === 'add_slide' ||
        operation.type === 'set_slide_text'
      ) {
        const document = await this.readDocumentSnapshot(owned, operation, combined)
        this.ensureActive(owned)
        return { ok: true, value: document }
      }
      const value = await this.readWorkbookSnapshot(owned, operation, strategy, combined)
      this.ensureActive(owned)
      return { ok: true, value }
    } catch {
      if (signal.aborted) throw reconcileFailedError()
      return { ok: false, reason: timeout.aborted ? '核对读取超时' : '无法读取目标单元格' }
    }
  }

  private async readWorkbookSnapshot(
    owned: OwnedOfficeDocument,
    operation: Exclude<
      OfficeInternalWriteOperation,
      { type: 'add_paragraph' | 'set_paragraph_text' | 'add_slide' | 'set_slide_text' }
    >,
    strategy: ReturnType<typeof officeWriteStrategy>,
    signal: AbortSignal
  ): Promise<OfficeWriteSnapshot> {
    if (operation.type === 'add_sheet') {
      const reader = this.service.readWorkbookSnapshot
      if (!reader) throw new Error('missing workbook reader')
      return abortable(reader(writeContext(owned, signal), operation.name), signal)
    }
    const cells: OfficeReadCell[] = []
    let cursor: string | undefined
    do {
      const response = await abortable(
        this.service.readRange(
          readContext(owned, signal),
          cursor
            ? { cursor }
            : {
                sheet: operation.sheet,
                range: strategy.readRange(operation),
                maxCells:
                  operation.type === 'set_range' || operation.type === 'format_range'
                    ? operation.cellCount
                    : 1
              }
        ),
        signal
      )
      if (!('cells' in response)) throw new Error('invalid range response')
      cells.push(...response.cells)
      cursor = response.complete === false ? response.nextCursor : undefined
      if (response.complete === false && !cursor) throw new Error('missing range cursor')
    } while (cursor)
    return strategy.snapshot(operation, cells)
  }

  private async readDocumentSnapshot(
    owned: OwnedOfficeDocument,
    operation: Extract<
      OfficeInternalWriteOperation,
      { type: 'add_paragraph' | 'set_paragraph_text' | 'add_slide' | 'set_slide_text' }
    >,
    signal: AbortSignal
  ): Promise<OfficeWriteSnapshot> {
    if (operation.type === 'add_paragraph' || operation.type === 'set_paragraph_text') {
      return abortable(
        readOfficeDocxReconcileSnapshot(this.service, owned, operation, signal),
        signal
      )
    }
    return abortable(
      readOfficePptxReconcileSnapshot(this.service, owned, operation, signal),
      signal
    )
  }

  private async finishApplied(
    owned: OwnedOfficeDocument,
    candidate: ReconcileCandidate,
    conclusion: 'applied' | 'applied_no_change',
    current: OfficeWriteSnapshot,
    signal: AbortSignal
  ): Promise<OfficeReconcileResult> {
    const revision = conclusion === 'applied' ? owned.contentRevision + 1 : owned.contentRevision
    const verification = await this.trySave(owned, signal)
    const saved = verification !== false
    owned.needsSave = !saved
    owned.saveStatus = saved
      ? markOfficeSaved(owned.saveStatus, {
          revision,
          savedAt: (this.service.now ?? (() => new Date()))().toISOString(),
          ...(verification ? { sha256: verification.sha256 } : {})
        })
      : markOfficeUnsaved(owned.saveStatus)
    const result = reconciledEditResult(candidate.record, revision, saved, current)
    const receipt: OfficeOperationReceipt = saved
      ? { ok: true, value: result }
      : { ok: false, error: { code: 'save_failed', result } }
    const summary = reconcileSummary(conclusion, revision, saved)
    const next = operationLogWithSaveStatus(
      terminalState(owned.operationLog, candidate, receipt, summary, !saved),
      owned.saveStatus,
      !saved
    )
    await this.commit(owned, next)
    this.log(owned, conclusion)
    return publicResult(summary, result, !saved)
  }

  private async readFormulaReference(
    owned: OwnedOfficeDocument,
    sheet: string,
    cell: string,
    signal: AbortSignal
  ): Promise<{ readonly formula?: string }> {
    const response = await this.service.readRange(readContext(owned, signal), {
      sheet,
      range: cell,
      maxCells: 1
    })
    this.ensureActive(owned)
    if (!('cells' in response) || response.cells.length !== 1) throw new Error('missing cell')
    const formula = response.cells[0]?.formula
    return formula ? { formula } : {}
  }

  private async finishNotApplied(
    owned: OwnedOfficeDocument,
    candidate: ReconcileCandidate
  ): Promise<OfficeReconcileResult> {
    const summary = reconcileSummary('not_applied', owned.contentRevision)
    const next = operationLogWithSaveStatus(
      terminalState(
        owned.operationLog,
        candidate,
        { ok: false, error: { code: 'write_not_applied' } },
        summary,
        owned.needsSave
      ),
      owned.saveStatus,
      owned.needsSave
    )
    await this.commit(owned, next)
    this.log(owned, 'not_applied')
    return publicResult(summary, undefined, owned.needsSave)
  }

  private async keepIndeterminate(
    owned: OwnedOfficeDocument,
    reason: string
  ): Promise<OfficeReconcileResult> {
    const summary = reconcileSummary('indeterminate', owned.contentRevision, undefined, reason)
    const next: OfficeOperationLogState = {
      ...owned.operationLog,
      version: 2,
      freezeState: 'unknown',
      ...(owned.needsSave ? { needsSave: true } : {}),
      lastReconcile: summary
    }
    await this.commit(owned, next)
    this.log(owned, 'indeterminate')
    return publicResult(summary, undefined, owned.needsSave, true)
  }

  private resultWithoutCandidate(owned: OwnedOfficeDocument): OfficeReconcileResult {
    const summary = owned.operationLog.lastReconcile
    if (summary) {
      return publicResult(summary, undefined, owned.needsSave, owned.freezeState === 'unknown')
    }
    throw new OfficeWriteError('reconcile_failed', '该文档没有可核对的写入结果')
  }

  private async trySave(
    owned: OwnedOfficeDocument,
    signal: AbortSignal
  ): Promise<OfficeSavedFileVerification | undefined | false> {
    try {
      const verified = await performVerifiedOfficeSave(this.service, owned, signal)
      this.ensureActive(owned)
      return verified
    } catch {
      if (signal.aborted) throw reconcileFailedError()
      return false
    }
  }

  private async commit(owned: OwnedOfficeDocument, state: OfficeOperationLogState): Promise<void> {
    try {
      await (this.service.persistOperationLog ?? persistOfficeOperationLog)(
        owned.document.draftPath,
        state
      )
      this.ensureActive(owned)
    } catch {
      owned.freezeState = 'unknown'
      throw reconcileFailedError()
    }
    owned.operationLog = state
    owned.contentRevision = state.contentRevision
    owned.freezeState = state.freezeState
    owned.needsSave = state.needsSave === true
    owned.saveStatus = restoreOfficeSaveStatus({
      contentRevision: state.contentRevision,
      needsSave: state.needsSave === true,
      frozen: state.freezeState === 'unknown',
      persisted: state
    })
  }

  private log(owned: OwnedOfficeDocument, conclusion: OfficeReconcileConclusion): void {
    this.service.logOperationWarning?.('office_reconcile_completed', {
      artifactId: owned.document.artifactId,
      conclusion,
      operationCount: 1
    })
  }

  private ensureActive(owned: OwnedOfficeDocument): void {
    try {
      this.assertActive(owned)
    } catch {
      throw reconcileFailedError()
    }
  }
}

function findCandidates(state: OfficeOperationLogState): ReconcileCandidate[] {
  return Object.entries(state.operations).flatMap(([operationId, record]) => {
    if (record.status === 'in_flight') return [{ operationId, record }]
    if (record.receipt?.ok !== false) return []
    if (UNCERTAIN_CODES.has(record.receipt.error.code)) return [{ operationId, record }]
    return []
  })
}

function terminalState(
  state: OfficeOperationLogState,
  candidate: ReconcileCandidate,
  receipt: OfficeOperationReceipt,
  lastReconcile: OfficeReconcileSummary,
  needsSave: boolean
): OfficeOperationLogState {
  return pruneOfficeOperationLog({
    version: 2,
    contentRevision: lastReconcile.revision,
    operations: {
      ...state.operations,
      [candidate.operationId]: {
        digest: candidate.record.digest,
        createdAt: candidate.record.createdAt,
        status: receipt.ok ? 'succeeded' : 'failed',
        receipt,
        ...(candidate.record.source ? { source: candidate.record.source } : {})
      }
    },
    ...(needsSave ? { needsSave: true } : {}),
    lastReconcile
  })
}

function reconciledEditResult(
  record: OfficeOperationRecord,
  revision: number,
  saved: boolean,
  current: OfficeWriteSnapshot
): OfficeWriteResult {
  const request = storedOperationRequest(record.operation!)
  const strategy = officeWriteStrategy(request.operation)
  const before = strategy.restoreBefore(request.operation, record.before!)
  return Object.freeze({
    ...strategy.result(request, before, revision, saved, false, current),
    reconciled: true as const
  })
}

function reconcileSummary(
  conclusion: OfficeReconcileConclusion,
  revision: number,
  saved?: boolean,
  reason?: string
): OfficeReconcileSummary {
  return {
    conclusion,
    at: new Date().toISOString(),
    revision,
    ...(saved === undefined ? {} : { saved }),
    ...(reason ? { reason } : {})
  }
}

function publicResult(
  summary: OfficeReconcileSummary,
  editResult?: OfficeWriteResult,
  needsSave = false,
  frozen = false
): OfficeReconcileResult {
  return Object.freeze({
    conclusion: summary.conclusion,
    message: summary.reason ?? conclusionMessage(summary.conclusion),
    revision: summary.revision,
    ...(frozen ? { freezeState: 'unknown' as const } : {}),
    ...(summary.conclusion === 'indeterminate' ? { code: 'reconcile_indeterminate' as const } : {}),
    ...(needsSave ? { needsSave: true } : {}),
    ...(editResult ? { editResult } : {})
  })
}

function conclusionMessage(conclusion: OfficeReconcileConclusion): string {
  if (conclusion === 'applied') return '已核对：写入已生效'
  if (conclusion === 'applied_no_change') return '已核对：内容原本已是预期值'
  if (conclusion === 'not_applied') return '已核对：写入未生效，可使用新的操作重试'
  return '无法确认写入结果，文档继续冻结'
}

function formulaReconcileReason(reason: string): string {
  if (reason === 'circular_reference') return '公式包含循环引用，不能确认写入有效'
  if (reason === 'unsupported_function') return '公式函数暂不被计算引擎支持'
  return '公式计算结果未通过安全验证'
}

function readContext(owned: OwnedOfficeDocument, signal: AbortSignal): OfficeReadContext {
  return {
    artifactId: owned.document.artifactId,
    binaryPath: owned.binaryPath,
    draftPath: owned.document.draftPath,
    revision: owned.contentRevision,
    signal
  }
}

function writeContext(owned: OwnedOfficeDocument, signal: AbortSignal): OfficeWriteContext {
  return { binaryPath: owned.binaryPath, draftPath: owned.document.draftPath, signal }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

function corruptLogError(): OfficeWriteError {
  return new OfficeWriteError('reconcile_failed', '写入记录无法验证，不能自动核对')
}

function reconcileFailedError(): OfficeWriteError {
  return new OfficeWriteError('reconcile_failed', '核对未能可靠完成，文档继续冻结')
}
