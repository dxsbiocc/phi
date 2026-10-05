import { createHash, randomUUID } from 'node:crypto'
import { basename, parse } from 'node:path'

import type { OfficeExportOutputSummary } from '../../../shared/officeProtocol'
import { officeArtifactKind } from './office-document-kind'
import { serializeOfficeDelimited } from './office-export-csv'
import { OfficeExportError, type OfficeExportFormat } from './office-export-contract'
import { createOfficeDelimitedOutput } from './office-export-output'
import { OfficeExportSheetReader } from './office-export-reader'
import { assertOfficeExportTargetStable, validateOfficeExportTarget } from './office-export-target'
import {
  appendOfficeOutputRecord,
  isExportRecord,
  loadOfficeOutputLog,
  persistOfficeOutputLog,
  type OfficeExportOutputRecord,
  type OfficeOutputLogState
} from './office-output-log'
import { resolveRecordedOfficeOutput } from './office-output-path'
import { flushOwnedOfficeDocumentForOutput } from './office-output-save'
import { validOfficeSheetName, type OfficeReadContext } from './office-read-contract'
import { OfficeSaveAsError } from './office-save-as-target'
import {
  assertOwnedOfficeDocumentActive,
  assertOwnedOfficeDocumentDeliverable,
  requireOwnedOfficeDocument
} from './office-service-guards'
import type { OfficeServiceDependencies, OwnedOfficeDocument } from './office-service-state'

export interface OfficeExportDescriptor {
  readonly fileName: string
  readonly format: OfficeExportFormat
  readonly sheet: string
}

export interface OfficeExportRequest {
  readonly artifactId: string
  readonly sessionId: string
  readonly projectRoot: string
  readonly targetPath: string
  readonly requestId: string
  readonly sheet: string
  readonly format: OfficeExportFormat
  readonly signal?: AbortSignal
  readonly beginCommit?: () => void
}

interface OfficeExportFlowState {
  readonly dependencies: OfficeServiceDependencies
  readonly owned: ReadonlyMap<string, OwnedOfficeDocument>
  readonly closingArtifacts: ReadonlySet<string>
}

export class OfficeExportFlow {
  private readonly reader: OfficeExportSheetReader

  constructor(private readonly state: OfficeExportFlowState) {
    this.reader = new OfficeExportSheetReader({
      read: state.dependencies.readRange,
      ...(state.dependencies.readExportRange
        ? { readExactRange: state.dependencies.readExportRange }
        : {})
    })
  }

  descriptor(
    artifactId: string,
    sessionId: string,
    sheet: string,
    format: OfficeExportFormat
  ): OfficeExportDescriptor {
    const owned = this.requireXlsx(artifactId, sessionId)
    assertExportIdentity('descriptor', sheet, format)
    return { fileName: exportFileName(owned.document.draftPath, sheet, format), format, sheet }
  }

  async exportSheet(request: OfficeExportRequest): Promise<OfficeExportOutputSummary> {
    assertExportIdentity(request.requestId, request.sheet, request.format)
    const owned = this.requireXlsx(request.artifactId, request.sessionId)
    try {
      return await owned.operations.run(
        (queueSignal) => this.run(owned, request, combinedSignal(queueSignal, request.signal)),
        {
          owner: `export:${request.requestId}`,
          ...(request.signal ? { signal: request.signal } : {})
        }
      )
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (
        request.signal?.aborted ||
        code === 'operation_cancelled' ||
        code === 'save_as_cancelled'
      ) {
        throw new OfficeExportError('export_cancelled', '导出操作已取消')
      }
      throw error
    }
  }

  private async run(
    owned: OwnedOfficeDocument,
    request: OfficeExportRequest,
    signal: AbortSignal
  ): Promise<OfficeExportOutputSummary> {
    const digest = requestDigest(request)
    const log = await this.loadLog(owned)
    const replay = await this.replay(log, owned, request, digest)
    if (replay) return replay
    this.assertExportable(owned, request.sessionId)
    const target = await validateOfficeExportTarget(
      request.projectRoot,
      request.targetPath,
      request.format,
      this.state.dependencies.assertNotOfficeArtifactPath
    )
    await this.flush(owned, request.sessionId, signal)
    const revision = owned.contentRevision
    const sheet = await this.reader.read(readContext(owned, revision, signal), request.sheet)
    this.assertRevision(owned, sheet.revision, revision)
    const serialized = serializeOfficeDelimited(sheet, request.format)
    return createOfficeDelimitedOutput(
      {
        targetPath: target.targetPath,
        bytes: serialized.bytes,
        signal,
        assertTargetStable: () => assertOfficeExportTargetStable(target),
        ...(request.beginCommit ? { beginCommit: request.beginCommit } : {})
      },
      async ({ sha256, size }) => {
        const record = exportRecord(this.state.dependencies, request, target.outputPath, {
          digest,
          revision,
          sha256,
          size,
          rows: serialized.rows,
          columns: serialized.columns
        })
        await this.persistRecord(owned, log, record)
        return outputSummary(record, target.fileName)
      }
    )
  }

  private requireXlsx(artifactId: string, sessionId: string): OwnedOfficeDocument {
    const owned = requireOwnedOfficeDocument(
      this.state.owned,
      this.state.closingArtifacts,
      artifactId,
      sessionId
    )
    if (
      officeArtifactKind(owned.document as unknown as Readonly<Record<string, unknown>>) !== 'xlsx'
    ) {
      throw new OfficeExportError('unsupported_document_kind', '只有 Excel 工作簿可以导出 CSV/TSV')
    }
    return owned
  }

  private assertExportable(owned: OwnedOfficeDocument, sessionId: string): void {
    assertOwnedOfficeDocumentActive(this.state.owned, this.state.closingArtifacts, owned, sessionId)
    if (owned.readOnly) throw new OfficeSaveAsError('document_read_only', '只读文档不能导出')
    if (owned.document.previewState === 'preview_failed') {
      throw new OfficeExportError('export_failed', '预览不可用时不能确认当前工作表')
    }
    try {
      assertOwnedOfficeDocumentDeliverable(owned)
    } catch {
      if (owned.freezeState === 'unknown') {
        throw new OfficeSaveAsError('document_frozen', '写入结果待核对，不能导出')
      }
      throw new OfficeSaveAsError('save_failed', '草稿有未保存修改，请先保存草稿')
    }
  }

  private flush(
    owned: OwnedOfficeDocument,
    sessionId: string,
    signal: AbortSignal
  ): ReturnType<typeof flushOwnedOfficeDocumentForOutput> {
    return flushOwnedOfficeDocumentForOutput({
      dependencies: this.state.dependencies,
      owned,
      signal,
      assertActive: () =>
        assertOwnedOfficeDocumentActive(
          this.state.owned,
          this.state.closingArtifacts,
          owned,
          sessionId
        )
    })
  }

  private async loadLog(owned: OwnedOfficeDocument): Promise<OfficeOutputLogState> {
    try {
      return await (this.state.dependencies.loadOutputLog ?? loadOfficeOutputLog)(
        owned.document.draftPath
      )
    } catch {
      throw new OfficeSaveAsError('output_log_corrupt', 'Office 输出记录无法验证')
    }
  }

  private async replay(
    log: OfficeOutputLogState,
    owned: OwnedOfficeDocument,
    request: OfficeExportRequest,
    digest: string
  ): Promise<OfficeExportOutputSummary | undefined> {
    const record = log.outputs.find(
      (entry): entry is OfficeExportOutputRecord =>
        isExportRecord(entry) && entry.requestId === request.requestId
    )
    if (!record) return undefined
    if (record.requestDigest !== digest) {
      throw new OfficeSaveAsError('operation_conflict', '相同导出请求编号对应了不同内容')
    }
    const resolved = await resolveRecordedOfficeOutput(
      owned.document.draftPath,
      request.projectRoot,
      record.outputId,
      async () => log
    )
    return { ...outputSummary(record, basename(resolved.path)), deduplicated: true }
  }

  private assertRevision(owned: OwnedOfficeDocument, actual: number, expected: number): void {
    if (actual !== expected || owned.contentRevision !== expected) {
      throw new OfficeExportError('revision_changed', '读取期间工作簿版本发生变化，请重新导出')
    }
  }

  private async persistRecord(
    owned: OwnedOfficeDocument,
    log: OfficeOutputLogState,
    record: OfficeExportOutputRecord
  ): Promise<void> {
    const next = appendOfficeOutputRecord(log, record)
    await (this.state.dependencies.persistOutputLog ?? persistOfficeOutputLog)(
      owned.document.draftPath,
      next
    )
  }
}

function combinedSignal(queueSignal: AbortSignal, requestSignal?: AbortSignal): AbortSignal {
  return requestSignal ? AbortSignal.any([queueSignal, requestSignal]) : queueSignal
}

function readContext(
  owned: OwnedOfficeDocument,
  revision: number,
  signal: AbortSignal
): OfficeReadContext {
  return {
    artifactId: owned.document.artifactId,
    binaryPath: owned.binaryPath,
    draftPath: owned.document.draftPath,
    revision,
    signal
  }
}

function requestDigest(request: OfficeExportRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        artifactId: request.artifactId,
        sheet: request.sheet,
        format: request.format
      })
    )
    .digest('hex')
}

function exportRecord(
  dependencies: OfficeServiceDependencies,
  request: OfficeExportRequest,
  outputPath: string,
  result: {
    digest: string
    revision: number
    sha256: string
    size: number
    rows: number
    columns: number
  }
): OfficeExportOutputRecord {
  return {
    outputId: (dependencies.outputId ?? randomUUID)(),
    outputPath,
    revision: result.revision,
    sha256: result.sha256,
    size: result.size,
    createdAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    source: 'draft',
    requestId: request.requestId,
    requestDigest: result.digest,
    format: request.format,
    sheet: request.sheet,
    rows: result.rows,
    columns: result.columns
  }
}

function outputSummary(
  record: OfficeExportOutputRecord,
  fileName: string
): OfficeExportOutputSummary {
  return {
    outputId: record.outputId,
    outputPath: record.outputPath,
    fileName,
    revision: record.revision,
    sha256: record.sha256,
    size: record.size,
    createdAt: record.createdAt,
    source: record.source,
    format: record.format,
    sheet: record.sheet,
    rows: record.rows,
    columns: record.columns
  }
}

function exportFileName(path: string, sheet: string, format: OfficeExportFormat): string {
  const stem = sanitizeName(parse(basename(path)).name) || 'Office'
  const safeSheet = sanitizeName(sheet) || 'Sheet'
  const suffix = `-${safeSheet}.${format}`
  const maximum = Math.max(1, 128 - [...suffix].length)
  return `${[...stem].slice(0, maximum).join('')}${suffix}`
}

function sanitizeName(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, '_')
    .replace(/^\.+|\.+$/gu, '')
    .trim()
}

function assertExportIdentity(requestId: string, sheet: string, format: OfficeExportFormat): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(requestId)) {
    throw new OfficeExportError('invalid_export', '导出请求编号无效')
  }
  if (!validOfficeSheetName(sheet)) {
    throw new OfficeExportError('invalid_sheet', '工作表名称无效')
  }
  if (format !== 'csv' && format !== 'tsv') {
    throw new OfficeExportError('invalid_export', '导出格式无效')
  }
}
