import { type OfficeBlankArtifact } from './office-files'
import { OfficeServiceCleanup } from './office-service-cleanup'
import { OfficeCreationFlow } from './office-service-create'
import { OfficeOpeningFlow } from './office-service-open'
import {
  OfficeServiceError,
  type OfficeDocumentStatus,
  type OfficeOpenRequest,
  type OfficeServiceDependencies,
  type OwnedOfficeDocument,
  type PendingOfficeCleanup
} from './office-service-state'
import { OfficeTargetError, OfficeTargetRegistry, type OfficeRunTarget } from './office-targets'
import type { OfficeSelectionSummary } from '../../../shared/officeProtocol'
import {
  OfficeServiceSelectionFacade,
  type OfficeServiceSelectionEvent
} from './office-service-selection'
import { type OfficeReadParams } from './office-read'
import type { OfficeDocumentReadResponse } from './office-docx-read'
import { OfficeWriteFlow } from './office-write'
import { officeArtifactKind } from './office-document-kind'
import type {
  OfficeCellEditDescription,
  OfficeCellEditOptions,
  OfficeCellEditParams,
  OfficeCellEditResult,
  OfficeDescribeCellEditParams,
  OfficeRangeEditDescription,
  OfficeRangeEditParams,
  OfficeRangeEditResult,
  OfficeWriteDescription,
  OfficeWriteRequest,
  OfficeWriteResult
} from './office-write-contract'
import { OfficeReconcileFlow, type OfficeReconcileResult } from './office-reconcile'
import { assertOwnedOfficeDocumentActive, readyOfficeDocumentStatus } from './office-service-guards'
import { OfficeServiceReadFlow } from './office-service-read'
import { OfficeServiceReadyFlow } from './office-service-ready'
import type { OfficeHumanCellTextInput } from './office-human-edit-translate'
import type { OfficeHumanEditAccess } from './office-human-edit'
import { OfficeServiceWriteFacade } from './office-service-write'
import { OfficeServiceReconcileFacade } from './office-service-reconcile'
import { OfficeServiceSaveFacade } from './office-service-save'
import { OfficeDocumentLifecycle } from './office-document-lifecycle'
import { OfficeResidentHealth } from './office-resident-health'
import { OfficeServiceShutdown, type OfficeDisposeOptions } from './office-service-shutdown'
import { OfficeDeliverFlow } from './office-deliver'
import { OfficeServiceCreationFacade } from './office-service-creation-facade'

export type {
  OfficeCreateRequest,
  OfficeCreateStatus,
  OfficeDocumentStatus,
  OfficeImportRequest,
  OfficeImportStatus,
  OfficeOpenRequest,
  OfficePreviewOwnership,
  OfficeProcessOwnership,
  OfficeServiceDependencies
} from './office-service-state'

export class OfficeService {
  private readonly statuses = new Map<string, OfficeDocumentStatus>()
  private readonly owned = new Map<string, OwnedOfficeDocument>()
  private readonly registeredBlank = new Map<string, OfficeBlankArtifact>()
  private readonly pendingCleanup = new Map<string, PendingOfficeCleanup>()
  private readonly closingArtifacts = new Set<string>()
  private readonly targets = new OfficeTargetRegistry()
  private readonly selection: OfficeServiceSelectionFacade
  private readonly cleanup: OfficeServiceCleanup
  private readonly lifecycle: OfficeDocumentLifecycle
  private readonly health: OfficeResidentHealth
  private readonly shutdown: OfficeServiceShutdown
  private readonly creation: OfficeCreationFlow
  private readonly opening: OfficeOpeningFlow
  private readonly writing: OfficeWriteFlow
  private readonly reconciling: OfficeReconcileFlow
  private readonly reading: OfficeServiceReadFlow
  private readonly readying: OfficeServiceReadyFlow
  private readonly writeFacade: OfficeServiceWriteFacade
  private readonly reconcileFacade: OfficeServiceReconcileFacade
  readonly saveDocument: OfficeServiceSaveFacade['saveDocument']
  readonly saveAsDescriptor: OfficeServiceSaveFacade['saveAsDescriptor']
  readonly saveAsDocument: OfficeServiceSaveFacade['saveAsDocument']
  readonly resolveOutputPath: OfficeServiceSaveFacade['resolveOutputPath']
  readonly exportDescriptor: OfficeServiceSaveFacade['exportDescriptor']
  readonly exportSheet: OfficeServiceSaveFacade['exportSheet']
  readonly describeDelivery: OfficeDeliverFlow['describe']
  readonly shouldBypassDeliverApproval: OfficeDeliverFlow['shouldBypassApproval']
  readonly deliverDocument: OfficeDeliverFlow['deliver']
  readonly setPreviewPreferences: OfficeServiceSelectionFacade['setPreviewPreferences']
  readonly statusForCreate: OfficeServiceCreationFacade['statusForCreate']
  readonly statusForImport: OfficeServiceCreationFacade['statusForImport']
  readonly create: OfficeServiceCreationFacade['create']
  readonly importDocument: OfficeServiceCreationFacade['importDocument']
  readonly cancelCreate: OfficeServiceCreationFacade['cancelCreate']
  readonly cancelImport: OfficeServiceCreationFacade['cancelImport']

  constructor(private readonly dependencies: OfficeServiceDependencies) {
    this.reconciling = new OfficeReconcileFlow(dependencies, (owned) =>
      assertOwnedOfficeDocumentActive(this.owned, this.closingArtifacts, owned)
    )
    this.writing = new OfficeWriteFlow({
      service: dependencies,
      resolveTarget: (runId) => this.targets.resolveRunTarget(runId),
      signalForRun: (runId) => this.targets.signalForRun(runId),
      assertTarget: (target) => this.assertWriteTarget(target),
      reconcileUnknown: (owned, signal) => this.reconciling.reconcileOwned(owned, signal)
    })
    this.writeFacade = new OfficeServiceWriteFacade({
      writing: this.writing,
      targets: this.targets,
      owned: this.owned,
      closingArtifacts: this.closingArtifacts
    })
    this.reconcileFacade = new OfficeServiceReconcileFacade(
      this.reconciling,
      this.owned,
      this.closingArtifacts
    )
    const saving = new OfficeServiceSaveFacade({
      dependencies,
      owned: this.owned,
      closingArtifacts: this.closingArtifacts
    })
    this.saveDocument = saving.saveDocument.bind(saving)
    this.saveAsDescriptor = saving.saveAsDescriptor.bind(saving)
    this.saveAsDocument = saving.saveAsDocument.bind(saving)
    this.resolveOutputPath = saving.resolveOutputPath.bind(saving)
    this.exportDescriptor = saving.exportDescriptor.bind(saving)
    this.exportSheet = saving.exportSheet.bind(saving)
    const delivering = new OfficeDeliverFlow({
      dependencies,
      targets: this.targets,
      owned: this.owned,
      closingArtifacts: this.closingArtifacts
    })
    this.describeDelivery = delivering.describe.bind(delivering)
    this.shouldBypassDeliverApproval = delivering.shouldBypassApproval.bind(delivering)
    this.deliverDocument = delivering.deliver.bind(delivering)
    this.selection = new OfficeServiceSelectionFacade({
      dependencies,
      owned: this.owned,
      closingArtifacts: this.closingArtifacts
    })
    this.setPreviewPreferences = this.selection.setPreviewPreferences.bind(this.selection)
    this.reading = new OfficeServiceReadFlow({
      dependencies,
      targets: this.targets,
      owned: this.owned,
      closingArtifacts: this.closingArtifacts
    })
    this.cleanup = new OfficeServiceCleanup(dependencies, {
      statuses: this.statuses,
      owned: this.owned,
      pendingCleanup: this.pendingCleanup
    })
    this.lifecycle = new OfficeDocumentLifecycle({
      dependencies,
      owned: this.owned,
      statuses: this.statuses,
      closingArtifacts: this.closingArtifacts,
      targets: this.targets,
      cleanup: this.cleanup,
      liveDocumentCount: () => this.liveDocumentCount()
    })
    this.health = new OfficeResidentHealth({
      isAlive: dependencies.isProcessAlive,
      recover: dependencies.recoverDocument
    })
    this.readying = new OfficeServiceReadyFlow({
      dependencies,
      reconciler: this.reconciling,
      owned: this.owned,
      statuses: this.statuses,
      registeredBlank: this.registeredBlank,
      health: this.health,
      onOperationQueued: (artifactId) => this.lifecycle.operationQueued(artifactId),
      onQueueIdle: (artifactId) => this.lifecycle.onQueueIdle(artifactId)
    })
    this.opening = new OfficeOpeningFlow(
      dependencies,
      this.cleanup,
      {
        statuses: this.statuses,
        owned: this.owned,
        registeredBlank: this.registeredBlank,
        pendingCleanup: this.pendingCleanup
      },
      () => this.lifecycle.ensureCapacity(),
      (key, binaryPath, artifact, process, preview, references, restoreKind, integrity) =>
        this.readying.remember(
          key,
          binaryPath,
          artifact,
          process,
          preview,
          references,
          restoreKind,
          integrity
        )
    )
    this.creation = new OfficeCreationFlow(
      dependencies,
      this.cleanup,
      {
        statuses: this.statuses,
        owned: this.owned,
        registeredBlank: this.registeredBlank
      },
      (reservationsToExclude) => this.lifecycle.ensureCapacity(reservationsToExclude),
      (key, binaryPath, artifact, process, preview, references) =>
        this.readying.remember(key, binaryPath, artifact, process, preview, references)
    )
    const creating = new OfficeServiceCreationFacade({
      creation: this.creation,
      owned: this.owned,
      closingArtifacts: this.closingArtifacts,
      targets: this.targets
    })
    this.statusForCreate = creating.statusForCreate.bind(creating)
    this.statusForImport = creating.statusForImport.bind(creating)
    this.create = creating.create.bind(creating)
    this.importDocument = creating.importDocument.bind(creating)
    this.cancelCreate = creating.cancelCreate.bind(creating)
    this.cancelImport = creating.cancelImport.bind(creating)
    this.shutdown = new OfficeServiceShutdown({
      creation: this.creation,
      opening: this.opening,
      cleanup: this.cleanup,
      owned: this.owned,
      closingArtifacts: this.closingArtifacts,
      targets: this.targets,
      selection: this.selection,
      forgetRegisteredBlankSession: (sessionId) => {
        for (const [key, artifact] of this.registeredBlank) {
          if (artifact.sessionId === sessionId) this.registeredBlank.delete(key)
        }
      }
    })
  }

  statusForSource(sessionId: string, sourcePath: string): OfficeDocumentStatus | undefined {
    const status = this.opening.statusFor(sessionId, sourcePath)
    if (status?.state !== 'ready') return status
    const owned = this.owned.get(status.document.artifactId)
    return owned ? readyOfficeDocumentStatus(owned) : status
  }
  ownsPreviewUrl(url: string): boolean {
    return this.lifecycle.ownsPreviewUrl(url)
  }
  bindRunTarget(target: OfficeRunTarget): void {
    const owned = this.assertBindableTarget(target)
    this.targets.bindRunTarget(target)
    this.lifecycle.runBound(owned)
  }

  async bindPromptTarget(target: OfficeRunTarget, includeSelection: boolean): Promise<void> {
    const owned = this.assertBindableTarget(target)
    if (!includeSelection) {
      this.targets.bindRunTarget(target)
      return
    }
    if (officeArtifactKind(owned.document as unknown as Record<string, unknown>) !== 'xlsx') {
      throw new OfficeServiceError('selection_unavailable', 'Word 文档不支持单元格选区')
    }
    const selection = await this.dependencies.resolveSelection(
      owned.binaryPath,
      owned.document.draftPath
    )
    this.assertBindableTarget(target)
    if (!selection) {
      throw new OfficeServiceError(
        'selection_unavailable',
        '无法读取当前选区，请重新选择或清除选区'
      )
    }
    this.targets.bindRunTarget({ ...target, selection })
  }
  resolveRunTarget(runId: string, expectedSessionId?: string): OfficeRunTarget {
    return this.targets.resolveRunTarget(runId, expectedSessionId)
  }
  clearRunTarget(runId: string): boolean {
    return this.lifecycle.clearRun(runId)
  }
  abortRun(runId: string): boolean {
    return this.targets.abortRun(runId)
  }
  async readRange(runId: string, params: OfficeReadParams): Promise<OfficeDocumentReadResponse> {
    return this.reading.readRange(runId, params)
  }
  async applyCellEdit(
    runId: string,
    params: OfficeCellEditParams,
    options: OfficeCellEditOptions = {}
  ): Promise<OfficeCellEditResult> {
    return this.writeFacade.applyCell(runId, params, options)
  }
  async applyRangeEdit(
    runId: string,
    params: OfficeRangeEditParams,
    options: OfficeCellEditOptions = {}
  ): Promise<OfficeRangeEditResult> {
    return this.writeFacade.applyRange(runId, params, options)
  }
  async applyWriteRequest(
    runId: string,
    request: OfficeWriteRequest,
    options: OfficeCellEditOptions = {}
  ): Promise<OfficeWriteResult> {
    return this.writeFacade.applyRequest(runId, request, options)
  }
  async applyHumanCellEdit(
    artifactId: string,
    input: OfficeHumanCellTextInput,
    options: Pick<OfficeCellEditOptions, 'operationId'>
  ): Promise<OfficeWriteResult> {
    return this.writeFacade.applyHuman(artifactId, input, options)
  }
  humanEditAccess(artifactId: string): OfficeHumanEditAccess {
    return this.writeFacade.access(artifactId)
  }
  recordHumanEditRejection(artifactId: string, code: string): void {
    this.writeFacade.recordRejection(artifactId, code)
  }
  shouldBypassCellEditApproval(
    runId: string,
    params: OfficeCellEditParams,
    operationId: string
  ): Promise<boolean> {
    return this.writing.shouldBypassApproval(runId, params, operationId)
  }

  shouldBypassWriteApproval(
    runId: string,
    request: OfficeWriteRequest,
    operationId: string
  ): Promise<boolean> {
    return this.writing.shouldBypassRequestApproval(runId, request, operationId)
  }

  assertWritable(artifactId: string): void {
    this.reconcileFacade.assertWritable(artifactId)
  }
  assertDeliverable(artifactId: string): void {
    this.reconcileFacade.assertDeliverable(artifactId)
  }
  async reconcile(artifactId: string, sessionId: string): Promise<OfficeReconcileResult> {
    return this.reconcileFacade.reconcile(artifactId, sessionId)
  }

  describeCellEdit(
    runId: string,
    params: OfficeDescribeCellEditParams
  ): Promise<OfficeCellEditDescription> {
    return this.writing.describe(runId, params)
  }

  describeRangeEdit(
    runId: string,
    params: OfficeRangeEditParams
  ): Promise<OfficeRangeEditDescription> {
    return this.writing.describeRange(runId, params)
  }

  describeWriteRequest(
    runId: string,
    request: OfficeWriteRequest
  ): Promise<OfficeWriteDescription> {
    return this.writing.describeRequest(runId, request)
  }

  onSelection(listener: (event: OfficeServiceSelectionEvent) => void): () => void {
    return this.selection.on(listener)
  }

  publishPreviewSelection(artifactId: string, selection: OfficeSelectionSummary | null): void {
    this.selection.publish(artifactId, selection)
  }

  publishPreviewSlideCount(artifactId: string, slideCount: number): void {
    if (!Number.isSafeInteger(slideCount) || slideCount < 0) return
    const owned = this.owned.get(artifactId)
    if (!owned) return
    if (officeArtifactKind(owned.document as unknown as Record<string, unknown>) !== 'pptx') return
    owned.document = { ...owned.document, slideCount }
    this.statuses.set(owned.key, readyOfficeDocumentStatus(owned))
  }

  clearSelection(artifactId: string, sessionId: string): Promise<boolean> {
    return this.selection.clear(artifactId, sessionId)
  }

  async close(artifactId: string, sessionId: string): Promise<boolean> {
    return this.lifecycle.closePanel(artifactId, sessionId)
  }

  async dispose(options?: OfficeDisposeOptions): Promise<void> {
    await this.shutdown.dispose(options)
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.shutdown.closeSession(sessionId)
  }

  async open(request: OfficeOpenRequest): Promise<OfficeDocumentStatus> {
    return this.opening.open(request)
  }

  private liveDocumentCount(): number {
    const documents = [...this.statuses.values()].filter(
      (status) => status.state === 'preparing' || status.state === 'ready'
    ).length
    return documents + this.creation.liveDocumentCount() + this.pendingCleanup.size
  }

  private assertBindableTarget(target: OfficeRunTarget): OwnedOfficeDocument {
    const owned = this.owned.get(target.artifactId)
    if (!owned || this.closingArtifacts.has(target.artifactId)) {
      throw new OfficeServiceError('target_not_found', '关联的 Office 文档已不存在或已关闭')
    }
    if (owned.document.sessionId !== target.sessionId) {
      throw new OfficeServiceError('target_session_mismatch', '关联的 Office 文档不属于当前会话')
    }
    return owned
  }

  private assertWriteTarget(target: OfficeRunTarget): OwnedOfficeDocument {
    const owned = this.owned.get(target.artifactId)
    if (!owned || this.closingArtifacts.has(target.artifactId)) {
      throw new OfficeTargetError('target_missing')
    }
    if (
      owned.document.sessionId !== target.sessionId ||
      owned.document.projectId !== target.projectId
    ) {
      throw new OfficeTargetError('session_mismatch')
    }
    return owned
  }
}
export { createOfficeService, type CreateOfficeServiceOptions } from './office-service-factory'
export type { OfficeServiceSelectionEvent } from './office-service-selection'
