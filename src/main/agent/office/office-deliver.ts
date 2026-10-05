import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

import { createImmutableOfficeOutput } from './office-save-as-copy'
import type { OfficeDeliveryCheckResult } from './office-deliver-checks'
import { officeArtifactKind } from './office-document-kind'
import {
  assertOfficeDeliveryTargetMissing,
  resolveOfficeDeliveryTarget,
  type OfficeDeliveryDescriptor,
  type ResolvedOfficeDeliveryTarget
} from './office-deliver-target'
import {
  appendOfficeOutputRecord,
  isDeliveryRecord,
  loadOfficeOutputLog,
  persistOfficeOutputLog,
  type OfficeOutputLogState
} from './office-output-log'
import { resolveRecordedOfficeOutput } from './office-output-path'
import { persistOfficeOperationLog } from './office-operation-log'
import { OfficeOperationQueueCancelledError } from './office-operation-queue'
import {
  operationLogWithSaveStatus,
  performVerifiedOfficeSave,
  type OfficeSavedFileVerification
} from './office-save'
import { markOfficeSaveFailed, markOfficeSaved, markOfficeSaving } from './office-save-state'
import type { OfficeServiceDependencies, OwnedOfficeDocument } from './office-service-state'
import { OfficeSaveAsError } from './office-save-as-target'
import {
  OfficeTargetError,
  type OfficeRunTarget,
  type OfficeTargetRegistry
} from './office-targets'
import {
  createOfficeDeliveryRecord,
  deliveryRequestDigest,
  resultFromDeliveryRecord,
  validateDeliveryPresentation,
  type OfficeDeliveryOptions,
  type OfficeDeliveryResult
} from './office-deliver-output'

export type { OfficeDeliveryDescriptor } from './office-deliver-target'
export type { OfficeDeliveryOptions, OfficeDeliveryResult } from './office-deliver-output'

interface OfficeDeliverFlowState {
  readonly dependencies: OfficeServiceDependencies
  readonly targets: OfficeTargetRegistry
  readonly owned: ReadonlyMap<string, OwnedOfficeDocument>
  readonly closingArtifacts: ReadonlySet<string>
}

export class OfficeDeliverFlow {
  constructor(private readonly state: OfficeDeliverFlowState) {}

  async describe(
    runId: string,
    cwd: string,
    cwdRealPath: string,
    outputName: string | undefined,
    operationId: string
  ): Promise<OfficeDeliveryDescriptor> {
    const target = this.resolveTarget(runId)
    const owned = this.assertTarget(target)
    const runSignal = this.state.targets.signalForRun(runId)
    return owned.operations.run(
      async () => {
        this.assertTarget(target)
        assertDeliverable(owned)
        const resolved = await resolveOfficeDeliveryTarget({
          cwd,
          cwdRealPath,
          outputName,
          operationId,
          draftPath: owned.document.draftPath,
          kind: officeArtifactKind(owned.document as unknown as Record<string, unknown>),
          assertNotPrivate: this.state.dependencies.assertNotOfficeArtifactPath
        })
        return { fileName: resolved.fileName, kind: resolved.kind, outputPath: resolved.outputPath }
      },
      { owner: runId, signal: runSignal }
    )
  }

  async shouldBypassApproval(
    runId: string,
    cwd: string,
    cwdRealPath: string,
    outputName: string | undefined,
    operationId: string
  ): Promise<boolean> {
    const target = this.resolveTarget(runId)
    const owned = this.assertTarget(target)
    const signal = this.state.targets.signalForRun(runId)
    return owned.operations.run(
      async () => {
        await this.resolveDeliveryTarget(owned, cwd, cwdRealPath, outputName, operationId)
        try {
          const log = await this.loadOutputLog(owned)
          return log.outputs.some(
            (record) => isDeliveryRecord(record) && record.operationId === operationId
          )
        } catch {
          return true
        }
      },
      { owner: runId, signal }
    )
  }

  async deliver(
    runId: string,
    cwd: string,
    cwdRealPath: string,
    outputName: string | undefined,
    options: OfficeDeliveryOptions
  ): Promise<OfficeDeliveryResult> {
    if (options.remote)
      throw new OfficeSaveAsError('remote_not_supported', '远程项目暂不支持 Office 交付')
    const target = this.resolveTarget(runId)
    const owned = this.assertTarget(target)
    const signal = combinedSignal(this.state.targets.signalForRun(runId), options.signal)
    try {
      return await owned.operations.run(
        (queueSignal) =>
          this.runDelivery(
            target,
            owned,
            cwd,
            cwdRealPath,
            outputName,
            options,
            combinedSignal(signal, queueSignal)
          ),
        { owner: runId, signal }
      )
    } catch (error) {
      throw mappedDeliveryError(error)
    }
  }

  private async runDelivery(
    runTarget: OfficeRunTarget,
    owned: OwnedOfficeDocument,
    cwd: string,
    cwdRealPath: string,
    outputName: string | undefined,
    options: OfficeDeliveryOptions,
    signal: AbortSignal
  ): Promise<OfficeDeliveryResult> {
    this.assertTarget(runTarget)
    const target = await this.resolveDeliveryTarget(
      owned,
      cwd,
      cwdRealPath,
      outputName,
      options.operationId
    )
    const log = await this.loadOutputLog(owned)
    const requestDigest = deliveryRequestDigest(runTarget, target)
    const replay = await this.replay(log, owned, target, options, requestDigest)
    if (replay) return replay
    assertDeliverable(owned)
    assertOfficeDeliveryTargetMissing(target)
    if (options.authorize && !(await options.authorize())) throw approvalChangedError()
    this.assertTarget(runTarget)
    const revision = owned.contentRevision
    const verification = await this.flushDraft(owned, runTarget, signal)
    return this.createOutput(
      owned,
      target,
      log,
      options,
      requestDigest,
      revision,
      verification,
      signal
    )
  }

  private async createOutput(
    owned: OwnedOfficeDocument,
    target: ResolvedOfficeDeliveryTarget,
    log: OfficeOutputLogState,
    options: OfficeDeliveryOptions,
    requestDigest: string,
    revision: number,
    verification: OfficeSavedFileVerification,
    signal: AbortSignal
  ): Promise<OfficeDeliveryResult> {
    return createImmutableOfficeOutput(
      {
        binaryPath: owned.binaryPath,
        kind: target.kind,
        sourcePath: owned.document.draftPath,
        targetPath: target.absolutePath,
        expectedSha256: verification.sha256,
        signal
      },
      ({ sha256, size }) =>
        this.commitOutput(
          owned,
          target,
          log,
          options,
          requestDigest,
          revision,
          sha256,
          size,
          signal
        ),
      { verifyFile: (path) => this.verifyOutput(path, owned, signal) }
    )
  }

  private async commitOutput(
    owned: OwnedOfficeDocument,
    target: ResolvedOfficeDeliveryTarget,
    log: OfficeOutputLogState,
    options: OfficeDeliveryOptions,
    requestDigest: string,
    revision: number,
    sha256: string,
    size: number,
    signal: AbortSignal
  ): Promise<OfficeDeliveryResult> {
    const checked = await this.checkOutput(owned, target, revision, signal)
    const checks = Object.freeze([{ name: 'schema', status: 'passed' } as const, ...checked.checks])
    const record = createOfficeDeliveryRecord({
      target,
      operationId: options.operationId,
      requestDigest,
      revision,
      sha256,
      size,
      checks,
      warnings: checked.warnings,
      outputId: (this.state.dependencies.outputId ?? randomUUID)(),
      createdAt: (this.state.dependencies.now ?? (() => new Date()))().toISOString()
    })
    const result = resultFromDeliveryRecord(record, target.absolutePath)
    await validateDeliveryPresentation(options, result)
    const next = appendOfficeOutputRecord(log, record)
    await (this.state.dependencies.persistOutputLog ?? persistOfficeOutputLog)(
      owned.document.draftPath,
      next
    )
    return result
  }

  private resolveDeliveryTarget(
    owned: OwnedOfficeDocument,
    cwd: string,
    cwdRealPath: string,
    outputName: string | undefined,
    operationId: string
  ): Promise<ResolvedOfficeDeliveryTarget> {
    return resolveOfficeDeliveryTarget({
      cwd,
      cwdRealPath,
      outputName,
      operationId,
      draftPath: owned.document.draftPath,
      kind: officeArtifactKind(owned.document as unknown as Record<string, unknown>),
      assertNotPrivate: this.state.dependencies.assertNotOfficeArtifactPath
    })
  }

  private async replay(
    log: OfficeOutputLogState,
    owned: OwnedOfficeDocument,
    target: ResolvedOfficeDeliveryTarget,
    options: OfficeDeliveryOptions,
    requestDigest: string
  ): Promise<OfficeDeliveryResult | undefined> {
    const record = log.outputs.find(
      (entry) => isDeliveryRecord(entry) && entry.operationId === options.operationId
    )
    if (!record || !isDeliveryRecord(record)) return undefined
    if (record.requestDigest !== requestDigest) {
      throw new OfficeSaveAsError('operation_conflict', '操作编号已用于不同的 Office 交付请求')
    }
    const resolved = await resolveRecordedOfficeOutput(
      owned.document.draftPath,
      dirname(target.absolutePath),
      record.outputId,
      async () => log
    )
    const result = Object.freeze({
      ...resultFromDeliveryRecord(record, resolved.path),
      deduplicated: true as const
    })
    await validateDeliveryPresentation(options, result)
    return result
  }

  private async flushDraft(
    owned: OwnedOfficeDocument,
    target: OfficeRunTarget,
    signal: AbortSignal
  ): Promise<OfficeSavedFileVerification> {
    owned.saveStatus = markOfficeSaving(owned.saveStatus)
    try {
      const verified = await performVerifiedOfficeSave(this.state.dependencies, owned, signal)
      if (!verified) throw new Error('save verification unavailable')
      this.assertTarget(target)
      const savedAt = (this.state.dependencies.now ?? (() => new Date()))().toISOString()
      const status = markOfficeSaved(owned.saveStatus, {
        revision: owned.contentRevision,
        savedAt,
        sha256: verified.sha256
      })
      const next = operationLogWithSaveStatus(owned.operationLog, status, false)
      await (this.state.dependencies.persistOperationLog ?? persistOfficeOperationLog)(
        owned.document.draftPath,
        next
      )
      owned.operationLog = next
      owned.needsSave = false
      owned.saveStatus = status
      return verified
    } catch (error) {
      owned.needsSave = true
      owned.saveStatus = markOfficeSaveFailed(owned.saveStatus)
      throw error instanceof OfficeSaveAsError
        ? error
        : new OfficeSaveAsError('save_failed', 'Office 草稿刷盘失败')
    }
  }

  private async loadOutputLog(owned: OwnedOfficeDocument): Promise<OfficeOutputLogState> {
    try {
      return await (this.state.dependencies.loadOutputLog ?? loadOfficeOutputLog)(
        owned.document.draftPath
      )
    } catch {
      throw new OfficeSaveAsError('output_log_corrupt', 'Office 输出记录无法验证')
    }
  }

  private verifyOutput(
    path: string,
    owned: OwnedOfficeDocument,
    signal: AbortSignal
  ): Promise<OfficeSavedFileVerification> {
    const verify = this.state.dependencies.verifyOutputFile
    if (!verify) throw new OfficeSaveAsError('copy_verification_failed', '输出校验不可用')
    return verify(path, { binaryPath: owned.binaryPath, signal })
  }

  private checkOutput(
    owned: OwnedOfficeDocument,
    target: ResolvedOfficeDeliveryTarget,
    revision: number,
    signal: AbortSignal
  ): Promise<OfficeDeliveryCheckResult> {
    const check = this.state.dependencies.checkDeliveredOutput
    if (!check) throw new OfficeSaveAsError('delivery_check_failed', '输出内容检查不可用')
    const expectedPageCount = expectedPptxPageCount(owned, target.kind)
    return check({
      artifactId: owned.document.artifactId,
      binaryPath: owned.binaryPath,
      outputPath: target.absolutePath,
      kind: target.kind,
      revision,
      operationLog: owned.operationLog,
      signal,
      ...(expectedPageCount === undefined ? {} : { expectedPageCount })
    })
  }

  private resolveTarget(runId: string): OfficeRunTarget {
    try {
      return this.state.targets.resolveRunTarget(runId)
    } catch (error) {
      throw mappedTargetError(error)
    }
  }

  private assertTarget(target: OfficeRunTarget): OwnedOfficeDocument {
    const owned = this.state.owned.get(target.artifactId)
    if (!owned || this.state.closingArtifacts.has(target.artifactId)) {
      throw new OfficeSaveAsError('target_missing', '关联的 Office 文档已不存在或已关闭')
    }
    if (
      owned.document.sessionId !== target.sessionId ||
      owned.document.projectId !== target.projectId
    ) {
      throw new OfficeSaveAsError('session_mismatch', '关联的 Office 文档不属于当前会话或项目')
    }
    return owned
  }
}

function assertDeliverable(owned: OwnedOfficeDocument): void {
  if (owned.readOnly) {
    throw new OfficeSaveAsError('document_read_only', '只读文档不能生成交付文件')
  }
  if (owned.freezeState === 'unknown') {
    throw new OfficeSaveAsError('document_frozen', '写入结果待核对，不能生成交付文件')
  }
  if (owned.needsSave) {
    throw new OfficeSaveAsError('save_failed', '草稿有未保存修改，不能生成交付文件')
  }
}

function expectedPptxPageCount(
  owned: OwnedOfficeDocument,
  kind: ResolvedOfficeDeliveryTarget['kind']
): number | undefined {
  if (kind !== 'pptx' || owned.document.slideCount === undefined) return undefined
  const results = Object.values(owned.operationLog.operations)
    .filter((record) => record.status === 'succeeded' && record.receipt?.ok === true)
    .toSorted(
      (left, right) =>
        (right.receipt?.ok ? right.receipt.value.revision : -1) -
          (left.receipt?.ok ? left.receipt.value.revision : -1) ||
        right.createdAt.localeCompare(left.createdAt)
    )
    .flatMap((record) => (record.receipt?.ok ? [record.receipt.value] : []))
    .filter((result) => 'slideId' in result)
  if (results.length === 0 || results[0]!.previewConfirmed) return owned.document.slideCount
  return undefined
}

function mappedTargetError(error: unknown): OfficeSaveAsError {
  if (error instanceof OfficeTargetError) {
    return new OfficeSaveAsError(error.code as 'no_target', error.message)
  }
  if (error instanceof OfficeSaveAsError) return error
  return new OfficeSaveAsError('target_missing', '无法解析 Office 交付目标')
}
function approvalChangedError(): OfficeSaveAsError {
  return new OfficeSaveAsError('approval_changed', 'Office 交付审批已失效，未创建输出')
}
function combinedSignal(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const available = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (available.length === 0) return new AbortController().signal
  return available.length === 1 ? available[0]! : AbortSignal.any(available)
}

function mappedDeliveryError(error: unknown): unknown {
  if (error instanceof OfficeOperationQueueCancelledError) {
    return new OfficeSaveAsError('save_as_cancelled', 'Office 交付已取消')
  }
  return mappedTargetError(error)
}
