import {
  completeOfficeOperation,
  officeOperationDigest,
  persistOfficeOperationLog,
  recordOfficeOperationPrewrite,
  startOfficeOperation,
  type OfficeOperationReceipt,
  type OfficeOperationRecord
} from './office-operation-log'
import type { OfficeServiceDependencies, OwnedOfficeDocument } from './office-service-state'
import {
  OfficeWriteError,
  type OfficeCellEditOptions,
  type OfficeWriteBefore,
  type OfficeWriteReceiptResult,
  type OfficeWriteRequest,
  type OfficeWriteResult
} from './office-write-contract'
import { restoreOfficeSaveStatus } from './office-save-state'

export class OfficeWriteIdempotency {
  constructor(private readonly service: OfficeServiceDependencies) {}

  async shouldBypassApproval(
    owned: OwnedOfficeDocument,
    input: OfficeWriteRequest,
    operationId: string
  ): Promise<boolean> {
    if (owned.operationLog.integrityError) return true
    const existing = owned.operationLog.operations[operationId]
    if (!existing) return false
    if (existing.digest !== officeOperationDigest(input)) return true
    if (existing.status === 'in_flight') {
      owned.freezeState = 'unknown'
      await this.recordFailure(
        owned,
        operationId,
        new OfficeWriteError('write_unknown', '上次写入结果无法确认，文档已冻结等待核对')
      )
      return true
    }
    if (!existing.receipt) throw operationLogCorruptError()
    return true
  }

  async run(
    owned: OwnedOfficeDocument,
    input: OfficeWriteRequest,
    options: OfficeCellEditOptions,
    execute: (
      recordPrewrite: (before: OfficeWriteBefore) => Promise<void>
    ) => Promise<OfficeWriteResult>,
    source?: 'human'
  ): Promise<OfficeWriteResult> {
    if (owned.operationLog.integrityError) throw operationLogCorruptError()
    const operationId = options.operationId!
    const digest = officeOperationDigest(input)
    const existing = owned.operationLog.operations[operationId]
    if (existing) return this.replay(owned, operationId, digest, existing)
    await this.recordInFlight(owned, operationId, digest, source)
    try {
      if (options.authorize && !(await options.authorize())) throw approvalChangedError()
      const result = await execute((before) =>
        this.recordPrewrite(owned, operationId, input, before)
      )
      return await this.recordSuccess(owned, operationId, result)
    } catch (error) {
      const failure =
        error instanceof OfficeWriteError
          ? error
          : new OfficeWriteError('write_failed', 'Office 未能可靠完成写入')
      await this.recordFailure(owned, operationId, failure)
      throw failure
    }
  }

  private async replay(
    owned: OwnedOfficeDocument,
    operationId: string,
    digest: string,
    existing: OfficeOperationRecord
  ): Promise<OfficeWriteResult> {
    if (existing.digest !== digest) throw operationConflictError()
    if (existing.status === 'in_flight') {
      owned.freezeState = 'unknown'
      const failure = new OfficeWriteError(
        'write_unknown',
        '上次写入结果无法确认，文档已冻结等待核对'
      )
      await this.recordFailure(owned, operationId, failure)
      throw failure
    }
    if (!existing.receipt) throw operationLogCorruptError()
    if (existing.receipt.ok) {
      return Object.freeze({ ...existing.receipt.value, deduplicated: true })
    }
    throw errorFromReceipt(existing.receipt)
  }

  private async recordInFlight(
    owned: OwnedOfficeDocument,
    operationId: string,
    digest: string,
    source?: 'human'
  ): Promise<void> {
    const next = startOfficeOperation(
      owned.operationLog,
      operationId,
      digest,
      new Date().toISOString(),
      source
    )
    try {
      await this.persist(owned, next)
      owned.operationLog = next
    } catch {
      throw new OfficeWriteError('write_failed', '无法可靠记录写入请求，未做任何修改')
    }
  }

  private async recordPrewrite(
    owned: OwnedOfficeDocument,
    operationId: string,
    input: OfficeWriteRequest,
    before: OfficeWriteBefore
  ): Promise<void> {
    const next = recordOfficeOperationPrewrite(owned.operationLog, operationId, input, before)
    try {
      await this.persist(owned, next)
      owned.operationLog = next
    } catch {
      throw new OfficeWriteError('write_failed', '无法可靠记录写入前状态，未做任何修改')
    }
  }

  private async recordSuccess(
    owned: OwnedOfficeDocument,
    operationId: string,
    result: OfficeWriteResult
  ): Promise<OfficeWriteResult> {
    const persisted = await this.recordTerminal(owned, operationId, { ok: true, value: result })
    if (persisted) return result
    const warned = Object.freeze({
      ...result,
      warnings: Object.freeze([...(result.warnings ?? []), 'operation_receipt_not_persisted'])
    })
    this.replaceMemoryReceipt(owned, operationId, { ok: true, value: warned })
    return warned
  }

  private async recordFailure(
    owned: OwnedOfficeDocument,
    operationId: string,
    error: OfficeWriteError
  ): Promise<void> {
    await this.recordTerminal(owned, operationId, receiptForError(error))
  }

  private async recordTerminal(
    owned: OwnedOfficeDocument,
    operationId: string,
    receipt: OfficeOperationReceipt
  ): Promise<boolean> {
    const next = completedState(owned, operationId, receipt)
    this.sync(owned, next)
    try {
      await this.persist(owned, next)
      return true
    } catch {
      this.sync(owned, { ...next, freezeState: 'unknown' })
      this.service.logOperationWarning?.('office_operation_receipt_persist_failed', {
        artifactId: owned.document.artifactId,
        operationId
      })
      return false
    }
  }

  private replaceMemoryReceipt(
    owned: OwnedOfficeDocument,
    operationId: string,
    receipt: OfficeOperationReceipt
  ): void {
    this.sync(
      owned,
      completeOfficeOperation(owned.operationLog, operationId, receipt, owned.contentRevision, {
        freeze: true,
        needsSave: owned.needsSave
      })
    )
  }

  private sync(owned: OwnedOfficeDocument, state: OwnedOfficeDocument['operationLog']): void {
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

  private persist(
    owned: OwnedOfficeDocument,
    state: OwnedOfficeDocument['operationLog']
  ): Promise<void> {
    const persist = this.service.persistOperationLog ?? persistOfficeOperationLog
    return persist(owned.document.draftPath, state)
  }
}

function completedState(
  owned: OwnedOfficeDocument,
  operationId: string,
  receipt: OfficeOperationReceipt
): OwnedOfficeDocument['operationLog'] {
  return completeOfficeOperation(owned.operationLog, operationId, receipt, owned.contentRevision, {
    freeze: owned.freezeState === 'unknown',
    needsSave: owned.needsSave
  })
}

function receiptForError(error: OfficeWriteError): OfficeOperationReceipt {
  const result =
    error.code === 'save_failed' || error.code === 'formula_invalid'
      ? error.details?.result
      : undefined
  const currentRevision = error.details?.currentRevision
  const sheetNames = error.details?.sheetNames
  return {
    ok: false,
    error: {
      code: error.code,
      ...(isWriteReceiptResult(result) ? { result } : {}),
      ...(typeof currentRevision === 'number' ? { currentRevision } : {}),
      ...(Array.isArray(sheetNames) && sheetNames.every((name) => typeof name === 'string')
        ? { sheetNames }
        : {})
    }
  }
}

function errorFromReceipt(
  receipt: Extract<OfficeOperationReceipt, { ok: false }>
): OfficeWriteError {
  const result = receipt.error.result
    ? Object.freeze({ ...receipt.error.result, deduplicated: true as const })
    : undefined
  return new OfficeWriteError(receipt.error.code, receiptErrorMessage(receipt.error.code), {
    ...(result ? { result } : {}),
    ...(receipt.error.currentRevision === undefined
      ? {}
      : { currentRevision: receipt.error.currentRevision }),
    ...(receipt.error.sheetNames ? { sheetNames: receipt.error.sheetNames } : {}),
    deduplicated: true
  })
}

function receiptErrorMessage(code: OfficeWriteError['code']): string {
  if (code === 'revision_conflict') return '文档已更新，请先重新读取后再修改'
  if (code === 'document_frozen') {
    return '该文档有待核对的写入结果，已尝试自动核对；请告知用户在右侧面板点击“重新核对”，不要重复写入'
  }
  if (code === 'write_unknown' || code === 'write_verification_failed') {
    return '写入结果无法确认，文档已冻结等待核对'
  }
  if (code === 'save_failed') return '内容已写入，但 Office 草稿保存失败'
  if (code === 'formula_invalid') return '公式无法可靠计算，已恢复写入前内容'
  if (code === 'write_not_applied') return '已核对该次写入未生效，可用新的调用重试'
  if (code === 'reconcile_indeterminate') return '核对后仍无法确认写入结果，文档继续冻结'
  if (code === 'reconcile_failed') return '核对未能可靠完成，文档继续冻结'
  if (code === 'write_cancelled') return '写入已取消，文档未修改'
  if (code === 'approval_changed') return '写入参数未获本次批准，未做任何修改'
  if (code === 'sheet_exists') return '工作表名称已存在，请改用其它名称'
  if (code === 'too_many_sheets') return '工作簿工作表数量已达上限'
  if (code === 'paragraph_not_found') return '目标段落不存在，请重新读取文档'
  if (code === 'paragraph_not_plain') return '目标段落包含复杂内容，不能安全修改'
  if (code === 'stale_target') return '目标文本已变化，请重新读取后再修改'
  if (code === 'operation_not_supported_for_kind') return '该操作不适用于当前文档类型'
  return 'Office 未能可靠写入该单元格'
}

function isWriteReceiptResult(value: unknown): value is OfficeWriteReceiptResult {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'applied' in value &&
    'revision' in value &&
    (('paraId' in value && 'path' in value) ||
      ('sheet' in value &&
        ('cell' in value || 'range' in value || ('path' in value && 'sheetNames' in value))))
  )
}

function approvalChangedError(): OfficeWriteError {
  return new OfficeWriteError('approval_changed', '写入参数未获本次批准，未做任何修改')
}

function operationConflictError(): OfficeWriteError {
  return new OfficeWriteError('operation_conflict', '操作编号已用于不同的写入请求，未做任何修改')
}

function operationLogCorruptError(): OfficeWriteError {
  return new OfficeWriteError('operation_log_corrupt', '写入记录无法验证，文档已冻结等待核对')
}
