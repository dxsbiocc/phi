import type { OfficeArtifact } from './office-files'
import {
  OfficeServiceError,
  type OfficeDocumentStatus,
  type OfficePreviewOwnership,
  type OfficeProcessOwnership,
  type OfficeServiceDependencies,
  type OwnedOfficeDocument,
  type PendingOfficeCleanup
} from './office-service-state'

interface OfficeCleanupState {
  statuses: Map<string, OfficeDocumentStatus>
  owned: Map<string, OwnedOfficeDocument>
  pendingCleanup: Map<string, PendingOfficeCleanup>
}

export class OfficeServiceCleanup {
  constructor(
    private readonly dependencies: OfficeServiceDependencies,
    private readonly state: OfficeCleanupState
  ) {}

  async finish(operations: readonly Promise<void>[]): Promise<void> {
    const results = await Promise.allSettled(operations)
    const failure = results.find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }

  async releaseEntries(entries: readonly OwnedOfficeDocument[]): Promise<void> {
    const results = await Promise.allSettled(entries.map((entry) => this.releaseOwned(entry)))
    results.forEach((result, index) => {
      if (result.status !== 'fulfilled') return
      const entry = entries[index]
      this.state.owned.delete(entry.document.artifactId)
      this.state.statuses.delete(entry.key)
    })
    const failure = results.find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }

  async releaseOwned(owned: {
    binaryPath: string
    document: OfficeArtifact & OfficeProcessOwnership & OfficePreviewOwnership
  }): Promise<void> {
    await this.dependencies.stopPreview(owned.document)
    await this.dependencies.closeDocument(owned.binaryPath, owned.document)
    await this.dependencies.recordClosedDraftHash?.(owned.document)
  }

  async cleanupOwnedArtifact(
    binaryPath: string,
    artifact: OfficeArtifact,
    process: OfficeProcessOwnership | undefined,
    preview: OfficePreviewOwnership | undefined,
    previewAttempted = preview !== undefined,
    removeDraft = true
  ): Promise<void> {
    const record: PendingOfficeCleanup = {
      binaryPath,
      artifact,
      process,
      preview,
      removeDraft,
      previewStopped: !previewAttempted,
      residentClosed: false
    }
    this.state.pendingCleanup.set(artifact.artifactId, record)
    await this.resumePending(record)
  }

  async retryPending(predicate: (record: PendingOfficeCleanup) => boolean): Promise<void> {
    const records = [...this.state.pendingCleanup.values()].filter(predicate)
    const results = await Promise.allSettled(records.map((record) => this.resumePending(record)))
    const failure = results.find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }

  async resumePending(record: PendingOfficeCleanup): Promise<void> {
    let failure: unknown
    if (!record.previewStopped) {
      try {
        await this.dependencies.stopPreview({ ...record.artifact, ...record.preview })
        record.previewStopped = true
      } catch (error) {
        failure = error
      }
    }
    if (!failure && !record.residentClosed) {
      try {
        await this.dependencies.closeDocument(record.binaryPath, {
          ...record.artifact,
          residentPid: record.process?.residentPid ?? 0
        })
        record.residentClosed = true
      } catch (error) {
        failure ??= error
      }
    }
    if (!failure && record.previewStopped && record.residentClosed) {
      if (
        record.removeDraft &&
        (record.artifact.origin === 'blank' || record.artifact.origin === 'import')
      ) {
        if (record.artifact.origin === 'blank') {
          await this.dependencies.removeBlankDraft(record.artifact)
        } else if (this.dependencies.removeCreatedDraft) {
          await this.dependencies.removeCreatedDraft(record.artifact)
        } else {
          throw new OfficeServiceError('cleanup-failed', '导入的 Office 草稿清理能力不可用')
        }
      }
      this.state.pendingCleanup.delete(record.artifact.artifactId)
      return
    }
    throw new OfficeServiceError(
      'cleanup-failed',
      record.removeDraft ? '空白 Office 草稿清理失败' : 'Office 资源清理失败'
    )
  }
}
