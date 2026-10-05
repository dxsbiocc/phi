import type { OfficeArtifact, OfficeBlankArtifact } from './office-files'
import { loadOfficeOperationLog } from './office-operation-log'
import { OfficeDocumentOperationQueue } from './office-operation-queue'
import type { OfficeReconcileFlow } from './office-reconcile'
import { readyOfficeDocumentStatus } from './office-service-guards'
import type {
  OfficeDocumentStatus,
  OfficePreviewOwnership,
  OfficeProcessOwnership,
  OfficeServiceDependencies,
  OfficeRestoreNotice,
  OwnedOfficeDocument
} from './office-service-state'
import { restoreOfficeSaveStatus } from './office-save-state'
import type { OfficeDraftIntegrityResult } from './office-draft-integrity'
import type { OfficeResidentHealth } from './office-resident-health'
import { officeArtifactKind } from './office-document-kind'

interface OfficeServiceReadyState {
  readonly dependencies: OfficeServiceDependencies
  readonly reconciler: OfficeReconcileFlow
  readonly owned: Map<string, OwnedOfficeDocument>
  readonly statuses: Map<string, OfficeDocumentStatus>
  readonly registeredBlank: Map<string, OfficeBlankArtifact>
  readonly onOperationQueued: (artifactId: string) => void
  readonly onQueueIdle: (artifactId: string) => void
  readonly health: OfficeResidentHealth
}

function restoredNotice(
  restoreKind: 'recovered' | 'source_changed' | undefined,
  integrity: OfficeDraftIntegrityResult | undefined,
  operationLog: Awaited<ReturnType<typeof loadOfficeOperationLog>>,
  saveState: ReturnType<typeof restoreOfficeSaveStatus>,
  artifact: OfficeArtifact
): OfficeRestoreNotice | undefined {
  if (integrity?.issue === 'draft_hash_mismatch') return { kind: 'draft_hash_mismatch' } as const
  if (integrity?.issue === 'operation_log_corrupt')
    return { kind: 'operation_log_corrupt' } as const
  if (restoreKind === 'source_changed') return { kind: 'source_changed' } as const
  if (restoreKind !== 'recovered') return undefined
  if (
    operationLog.contentRevision === 0 &&
    officeArtifactKind(artifact as unknown as Record<string, unknown>) === 'xlsx'
  ) {
    return undefined
  }
  return {
    kind: 'recovered' as const,
    hasUnsavedChanges:
      operationLog.needsSave === true ||
      saveState.saveState !== 'saved' ||
      saveState.lastSavedRevision < operationLog.contentRevision
  }
}

export class OfficeServiceReadyFlow {
  constructor(private readonly state: OfficeServiceReadyState) {}

  async remember(
    key: string,
    binaryPath: string,
    artifact: OfficeArtifact,
    process: OfficeProcessOwnership,
    preview: OfficePreviewOwnership,
    references = 1,
    restoreKind?: 'recovered' | 'source_changed',
    integrity?: OfficeDraftIntegrityResult
  ): Promise<OfficeDocumentStatus> {
    const operationLog =
      integrity?.operationLog ??
      (await (this.state.dependencies.loadOperationLog ?? loadOfficeOperationLog)(
        artifact.draftPath
      ))
    const document = { ...artifact, ...process, ...preview }
    const saveStatus = restoreOfficeSaveStatus({
      contentRevision: operationLog.contentRevision,
      needsSave: operationLog.needsSave === true,
      frozen: operationLog.freezeState === 'unknown',
      persisted: operationLog
    })
    const restoreNotice = restoredNotice(restoreKind, integrity, operationLog, saveStatus, artifact)
    const operations = new OfficeDocumentOperationQueue({
      onEnqueue: () => this.state.onOperationQueued(artifact.artifactId),
      beforeStart: (signal) => {
        const current = this.state.owned.get(artifact.artifactId)
        return current ? this.state.health.ensure(current, signal) : Promise.resolve()
      },
      onIdle: () => this.state.onQueueIdle(artifact.artifactId)
    })
    const owned: OwnedOfficeDocument = {
      key,
      binaryPath,
      panelReferences: references,
      lastActivityAt: (this.state.dependencies.now ?? (() => new Date()))().getTime(),
      contentRevision: operationLog.contentRevision,
      ...(operationLog.freezeState ? { freezeState: operationLog.freezeState } : {}),
      needsSave: operationLog.needsSave === true,
      saveStatus,
      readOnly: artifact.readOnly === true,
      operationLog,
      ...(restoreNotice ? { restoreNotice } : {}),
      operations,
      document
    }
    this.state.owned.set(artifact.artifactId, owned)
    if (artifact.origin === 'blank') this.state.registeredBlank.set(key, artifact)
    const ready = readyOfficeDocumentStatus(owned)
    this.state.statuses.set(key, ready)
    await this.reconcilePending(owned)
    return readyOfficeDocumentStatus(owned)
  }

  private async reconcilePending(owned: OwnedOfficeDocument): Promise<void> {
    if (
      owned.operationLog.integrityError ||
      !Object.values(owned.operationLog.operations).some((entry) => entry.status === 'in_flight')
    ) {
      return
    }
    await owned.operations
      .run((signal) => this.state.reconciler.reconcileOwned(owned, signal))
      .catch(() => undefined)
  }
}
