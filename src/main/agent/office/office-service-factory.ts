import { writeAppLog } from '../app-logger'
import { OfficeBatchWriter } from './office-batch-writer'
import { OfficeCellWriter } from './office-cell-writer'
import {
  assertOfficeSourcePathIsNotPrivate,
  createBlankOfficeDraft,
  createOfficeDraft,
  MAX_OFFICE_PARAGRAPHS,
  MAX_OFFICE_SLIDES,
  OfficeFileError,
  removeBlankOfficeDraft,
  removeCreatedOfficeDraft,
  validateRegisteredOfficeDraft
} from './office-files'
import { OfficeImportWorkbookDriver } from './office-import-driver'
import { createImportedOfficeDraft } from './office-import-files'
import { OfficeDraftRegistry } from './office-draft-registry'
import {
  officeArtifactKind,
  officeDocumentKindFromPath,
  parseOfficeDocumentKind
} from './office-document-kind'
import {
  checkRegisteredOfficeDraftIntegrity,
  officeDraftFileHash,
  recordConfirmedOfficeDraftHashAfterClose
} from './office-draft-integrity'
import { cleanupStaleOfficeProcesses } from './office-stale-process'
import { officeKindAdapter } from './office-kind-adapters'
import { loadOfficeOperationLog, persistOfficeOperationLog } from './office-operation-log'
import { clearOfficePreviewSelection } from './office-preview'
import {
  adoptCreatedOfficeResident,
  closeOfficeResident,
  createBlankOfficeWorkbook,
  forceTerminateTransientOfficeProcesses,
  inspectOfficeDocument,
  inspectResidentOfficeDocument,
  isOfficeProcessAlive,
  releaseTransientOfficeResident,
  startOfficeResident
} from './office-process'
import { OfficeRangeReader } from './office-read'
import { OfficeDocxReader } from './office-docx-read'
import { OfficeDocxWriter } from './office-docx-write'
import { OfficePptxReader } from './office-pptx-read'
import { OfficePptxWriter } from './office-pptx-write'
import { OfficeSheetReader } from './office-sheet-driver'
import { detectOfficeRuntime } from './office-runtime'
import { resolveOfficeSelection } from './office-selection-resolver'
import { OfficeService } from './office-service'
import { verifySavedOfficeFile } from './office-save-verification'
import { OfficePreviewProcessManager } from './office-watch'
import type { OfficeService as OfficeServiceType } from './office-service'
import { runOfficeDeliveryChecks } from './office-deliver-checks'

export interface CreateOfficeServiceOptions {
  readonly runOfficeCli?: typeof import('./office-driver').runOfficeCli
}

export function createOfficeService(options: CreateOfficeServiceOptions = {}): OfficeService {
  const reader = new OfficeRangeReader({ run: options.runOfficeCli })
  const docxReader = new OfficeDocxReader({ run: options.runOfficeCli })
  const docxWriter = new OfficeDocxWriter({ run: options.runOfficeCli })
  const pptxReader = new OfficePptxReader({ run: options.runOfficeCli })
  const pptxWriter = new OfficePptxWriter({ run: options.runOfficeCli })
  const writer = new OfficeCellWriter({ run: options.runOfficeCli })
  const batchWriter = new OfficeBatchWriter({ run: options.runOfficeCli })
  const sheetReader = new OfficeSheetReader({ run: options.runOfficeCli })
  const importDriver = new OfficeImportWorkbookDriver({ run: options.runOfficeCli })
  const serviceRef: { current?: OfficeServiceType } = {}
  const registry = new OfficeDraftRegistry({
    warn: (metadata) => writeAppLog({ event: metadata.event, level: 'warn', metadata })
  })
  const previews = new OfficePreviewProcessManager(
    undefined,
    (artifactId, selection) => {
      serviceRef.current?.publishPreviewSelection(artifactId, selection)
    },
    {
      apply: async (edit) => {
        await serviceRef.current!.applyHumanCellEdit(
          edit.artifactId,
          { sheet: edit.sheet, cell: edit.cell, text: edit.text },
          { operationId: edit.operationId }
        )
      },
      access: (artifactId) => serviceRef.current?.humanEditAccess(artifactId) ?? 'frozen',
      rejected: (artifactId, code) => serviceRef.current?.recordHumanEditRejection(artifactId, code)
    },
    (artifactId, slideCount) => serviceRef.current?.publishPreviewSlideCount(artifactId, slideCount)
  )
  const service = new OfficeService({
    detectRuntime: detectOfficeRuntime,
    prepareDraft: async (request, binaryPath) => {
      const kind = officeDocumentKindFromPath(request.sourcePath)
      const artifact = await createOfficeDraft(request, {
        validatePackage: officeKindAdapter(kind).assertPackage,
        inspectDocument: (draftPath, documentKind) =>
          inspectOfficeDocument(binaryPath, draftPath, documentKind)
      })
      registry.invalidate(request.sessionId)
      return artifact
    },
    prepareBlankDraft: (request, binaryPath) => {
      const kind = parseOfficeDocumentKind(request.kind)
      return createBlankOfficeDraft(request, {
        createWorkbook: async (draftPath) => {
          await createBlankOfficeWorkbook(binaryPath, draftPath)
          if (kind === 'xlsx') return
          try {
            const inspection = await inspectResidentOfficeDocument(binaryPath, draftPath, kind)
            if (
              kind === 'pptx' &&
              'slides' in inspection &&
              inspection.slides > MAX_OFFICE_SLIDES
            ) {
              throw new OfficeFileError(
                'document_too_large',
                'PowerPoint 演示文稿超过 200 张幻灯片上限'
              )
            }
          } catch (error) {
            await releaseTransientOfficeResident(binaryPath, draftPath)
            throw error
          }
        }
      })
    },
    prepareImportedDraft: async (request, binaryPath, control) => {
      const artifact = await createImportedOfficeDraft(
        request,
        {
          importWorkbook: (input, execution) => importDriver.prepare(binaryPath, input, execution),
          releaseWorkbook: (draftPath) => releaseTransientOfficeResident(binaryPath, draftPath)
        },
        control
      )
      registry.invalidate(request.sessionId)
      return artifact
    },
    forceTerminateImportedDraft: (draftPath, knownPids) =>
      forceTerminateTransientOfficeProcesses(draftPath, knownPids),
    startDocument: startOfficeResident,
    adoptCreatedDocument: adoptCreatedOfficeResident,
    startPreview: (binaryPath, artifact) => previews.start(binaryPath, artifact),
    stopPreview: (document) => previews.stop(document),
    closeDocument: (binaryPath, artifact) =>
      closeOfficeResident(binaryPath, artifact, artifact.residentPid),
    isProcessAlive: isOfficeProcessAlive,
    recoverDocument: async (owned, state) => {
      await previews.stopForRecovery(owned.document)
      let process = { residentPid: owned.document.residentPid }
      if (!state.residentAlive) {
        await cleanupStaleOfficeProcesses(owned.binaryPath, owned.document.draftPath)
        process = await startOfficeResident(owned.binaryPath, owned.document)
      }
      const preview = await previews.start(owned.binaryPath, owned.document)
      return { ...process, ...preview }
    },
    removeBlankDraft: removeBlankOfficeDraft,
    removeCreatedDraft: removeCreatedOfficeDraft,
    validateRegisteredDraft: (artifact) =>
      validateRegisteredOfficeDraft(artifact, artifact.sessionId).then(() => undefined),
    prepareRegisteredDraftForOpen: async (binaryPath, artifact) => {
      const confirmedHashBeforeClose = await officeDraftFileHash(artifact.draftPath).catch(
        () => undefined
      )
      const cleaned = await cleanupStaleOfficeProcesses(binaryPath, artifact.draftPath)
      const integrity = await checkRegisteredOfficeDraftIntegrity(artifact, artifact.sessionId, {
        ...(cleaned.cleanedPids.length > 0 && confirmedHashBeforeClose
          ? { confirmedHashBeforeClose }
          : {})
      })
      const kind = officeArtifactKind(artifact as unknown as Record<string, unknown>)
      if (kind !== 'xlsx') {
        const inspection = await inspectOfficeDocument(binaryPath, artifact.draftPath, kind)
        if (
          kind === 'docx' &&
          (!('paragraphs' in inspection) || inspection.paragraphs > MAX_OFFICE_PARAGRAPHS)
        ) {
          throw new OfficeFileError('document_too_large', 'Word 文档超过 5,000 段上限')
        }
        if (
          kind === 'pptx' &&
          (!('slides' in inspection) || inspection.slides > MAX_OFFICE_SLIDES)
        ) {
          throw new OfficeFileError(
            'document_too_large',
            'PowerPoint 演示文稿超过 200 张幻灯片上限'
          )
        }
      }
      return integrity
    },
    recordClosedDraftHash: (artifact) =>
      recordConfirmedOfficeDraftHashAfterClose(artifact.draftPath),
    resolveRegisteredDraft: (request) => registry.resolve(request),
    resolveRegisteredDraftByArtifactId: (sessionId, artifactId) =>
      registry.findByArtifactId(sessionId, artifactId),
    assertNotOfficeArtifactPath: assertOfficeSourcePathIsNotPrivate,
    resolveSelection: (binaryPath, draftPath) => resolveOfficeSelection(binaryPath, draftPath),
    clearSelection: clearOfficePreviewSelection,
    readRange: (context, params) => reader.read(context, params),
    readExportRange: (context, sheet, range) => reader.readExactRange(context, sheet, range),
    readParagraphs: (context, params) => docxReader.read(context, params),
    readSlides: (context, params) => pptxReader.read(context, params),
    readWorkbookSnapshot: (context, addedSheet) => sheetReader.read(context, addedSheet),
    applyCellValue: (context, params) => writer.apply(context, params),
    applyWriteOperation: (context, operation) =>
      operation.type === 'set_cell'
        ? writer.apply(context, {
            sheet: operation.sheet,
            cell: operation.cell,
            value: operation.value,
            baseRevision: 0
          })
        : batchWriter.apply(context, operation),
    restoreWriteOperation: (context, operation, before) =>
      batchWriter.restore(context, operation, before),
    readDocxSnapshot: (context) => docxWriter.read(context),
    applyDocxOperation: (context, operation, snapshot) =>
      docxWriter.apply(context, operation, snapshot),
    restoreDocxOperation: (context, operation, before, receipt) =>
      docxWriter.restore(context, operation, before, receipt),
    readPptxSnapshot: (context) => pptxWriter.read(context),
    applyPptxOperation: (context, operation, snapshot) =>
      pptxWriter.apply(context, operation, snapshot),
    restorePptxOperation: (context, operation, before, receipt) =>
      pptxWriter.restore(context, operation, before, receipt),
    saveDraft: (context) => writer.save(context),
    verifySavedDraft: (context) => verifySavedOfficeFile(context, { run: options.runOfficeCli }),
    verifyOutputFile: (path, context) =>
      verifySavedOfficeFile(
        { binaryPath: context.binaryPath, draftPath: path, signal: context.signal },
        { run: options.runOfficeCli, releaseResident: true }
      ),
    checkDeliveredOutput: (input) =>
      runOfficeDeliveryChecks(input, {
        readRange: (context, params) => reader.read(context, params),
        readDocxSnapshot: (context) => docxWriter.read(context),
        readPptxSnapshot: (context) => pptxWriter.read(context),
        releaseTransient: releaseTransientOfficeResident
      }),
    armPreviewConfirmation: (artifactId, sheet, cell) =>
      previews.armCellPatchConfirmation(artifactId, sheet, cell),
    armPreviewConfirmationSet: (artifactId, sheet, cells) =>
      previews.armCellPatchSetConfirmation(artifactId, sheet, cells),
    armSheetPreviewConfirmation: (artifactId, sheet) =>
      previews.armSheetConfirmation(artifactId, sheet),
    armDocumentPreviewConfirmation: (artifactId, text) =>
      previews.armDocumentTextConfirmation(artifactId, text),
    publishConfirmedWrite: (artifactId, operation) =>
      previews.publishConfirmedWrite(artifactId, operation),
    setPreviewPreferences: (artifactId, preferences) =>
      previews.setPreviewPreferences(artifactId, preferences),
    loadOperationLog: loadOfficeOperationLog,
    persistOperationLog: persistOfficeOperationLog,
    logOperationWarning: (event, metadata) =>
      writeAppLog({ event, level: 'warn', metadata: { ...metadata } })
  })
  serviceRef.current = service
  return service
}
