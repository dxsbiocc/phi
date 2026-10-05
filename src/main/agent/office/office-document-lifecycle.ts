import { MAX_ACTIVE_OFFICE_DOCUMENTS } from './office-runtime'
import type { OfficeServiceCleanup } from './office-service-cleanup'
import {
  OfficeServiceError,
  type OfficeDocumentStatus,
  type OfficeServiceDependencies,
  type OwnedOfficeDocument
} from './office-service-state'
import type { OfficeTargetRegistry } from './office-targets'

export interface OfficeDocumentKeepAliveState {
  readonly panelReferences: number
  readonly runReferences: number
  readonly queueIdle: boolean
}

interface OfficeDocumentLifecycleState {
  readonly dependencies: OfficeServiceDependencies
  readonly owned: Map<string, OwnedOfficeDocument>
  readonly statuses: Map<string, OfficeDocumentStatus>
  readonly closingArtifacts: Set<string>
  readonly targets: OfficeTargetRegistry
  readonly cleanup: OfficeServiceCleanup
  readonly liveDocumentCount: () => number
}

export function hasOfficeDocumentKeepAlive(state: OfficeDocumentKeepAliveState): boolean {
  return state.panelReferences > 0 || state.runReferences > 0 || !state.queueIdle
}

export class OfficeDocumentLifecycle {
  constructor(private readonly state: OfficeDocumentLifecycleState) {}

  ownsPreviewUrl(url: string): boolean {
    const owned = [...this.state.owned.values()].find((entry) => entry.document.previewUrl === url)
    if (owned) this.touch(owned)
    return owned !== undefined
  }

  runBound(owned: OwnedOfficeDocument): void {
    this.touch(owned)
  }

  clearRun(runId: string): boolean {
    const artifactId = this.state.targets.artifactIdForRun(runId)
    const cleared = this.state.targets.clearRunTarget(runId)
    if (artifactId) this.scheduleRelease(artifactId)
    return cleared
  }

  async closePanel(artifactId: string, sessionId: string): Promise<boolean> {
    const owned = this.state.owned.get(artifactId)
    if (!owned || owned.document.sessionId !== sessionId) return false
    if (owned.panelReferences > 0) owned.panelReferences -= 1
    this.touch(owned)
    await this.releaseIfIdle(artifactId)
    return true
  }

  onQueueIdle(artifactId: string): void {
    this.scheduleRelease(artifactId)
  }

  operationQueued(artifactId: string): void {
    const owned = this.state.owned.get(artifactId)
    if (owned) this.touch(owned)
  }

  ensureCapacity(reservationsToExclude = 0): Promise<void> | undefined {
    if (this.state.liveDocumentCount() - reservationsToExclude < MAX_ACTIVE_OFFICE_DOCUMENTS) {
      return undefined
    }
    return this.reclaimForCapacity(reservationsToExclude)
  }

  private async reclaimForCapacity(reservationsToExclude: number): Promise<void> {
    const candidate = this.reclaimCandidate()
    if (!candidate) throw this.resourceLimitError()
    await this.release(candidate)
    this.state.dependencies.logOperationWarning?.('office_resource_reclaimed', {
      count: 1,
      activeCount: this.state.liveDocumentCount()
    })
    if (this.state.liveDocumentCount() - reservationsToExclude >= MAX_ACTIVE_OFFICE_DOCUMENTS) {
      throw this.resourceLimitError()
    }
  }

  private scheduleRelease(artifactId: string): void {
    void this.releaseIfIdle(artifactId).catch(() => {
      this.state.dependencies.logOperationWarning?.('office_idle_release_failed', { count: 1 })
    })
  }

  private async releaseIfIdle(artifactId: string): Promise<void> {
    const owned = this.state.owned.get(artifactId)
    if (!owned || this.state.closingArtifacts.has(artifactId)) return
    if (hasOfficeDocumentKeepAlive(this.keepAliveState(owned))) return
    await this.release(owned)
  }

  private async release(owned: OwnedOfficeDocument): Promise<void> {
    const artifactId = owned.document.artifactId
    if (this.state.closingArtifacts.has(artifactId)) return
    this.state.closingArtifacts.add(artifactId)
    this.state.targets.markArtifactReleased(artifactId)
    await this.state.cleanup.releaseOwned(owned)
    this.state.owned.delete(artifactId)
    this.state.statuses.delete(owned.key)
    this.state.closingArtifacts.delete(artifactId)
  }

  private reclaimCandidate(): OwnedOfficeDocument | undefined {
    return [...this.state.owned.values()]
      .filter((owned) => this.reclaimable(owned))
      .sort((left, right) => left.lastActivityAt - right.lastActivityAt)[0]
  }

  private reclaimable(owned: OwnedOfficeDocument): boolean {
    return (
      !this.state.closingArtifacts.has(owned.document.artifactId) &&
      !hasOfficeDocumentKeepAlive(this.keepAliveState(owned)) &&
      owned.freezeState !== 'unknown' &&
      !owned.needsSave &&
      owned.saveStatus.saveState === 'saved'
    )
  }

  private keepAliveState(owned: OwnedOfficeDocument): OfficeDocumentKeepAliveState {
    return {
      panelReferences: owned.panelReferences,
      runReferences: this.state.targets.runReferenceCount(owned.document.artifactId),
      queueIdle: owned.operations.idle
    }
  }

  private resourceLimitError(): OfficeServiceError {
    const reasons = this.blockerReasons()
    return new OfficeServiceError(
      'resource-limit',
      `最多可同时存活 ${MAX_ACTIVE_OFFICE_DOCUMENTS} 个 Office 文档；当前占用：${reasons}`
    )
  }

  private blockerReasons(): string {
    const entries = [...this.state.owned.values()]
    const panel = entries.filter((entry) => entry.panelReferences > 0).length
    const background = entries.filter(
      (entry) =>
        this.state.targets.runReferenceCount(entry.document.artifactId) > 0 ||
        !entry.operations.idle
    ).length
    const reconcile = entries.filter((entry) => entry.freezeState === 'unknown').length
    const unsaved = entries.filter(
      (entry) => entry.needsSave || entry.saveStatus.saveState !== 'saved'
    ).length
    const preparing = Math.max(0, this.state.liveDocumentCount() - entries.length)
    const categories = [
      panel ? `面板打开 ${panel}` : '',
      background ? `后台任务进行中 ${background}` : '',
      reconcile ? `待核对 ${reconcile}` : '',
      unsaved ? `待保存 ${unsaved}` : '',
      preparing ? `正在准备 ${preparing}` : ''
    ].filter(Boolean)
    return categories.join('、') || '资源正在清理'
  }

  private touch(owned: OwnedOfficeDocument): void {
    owned.lastActivityAt = (this.state.dependencies.now ?? (() => new Date()))().getTime()
  }
}
