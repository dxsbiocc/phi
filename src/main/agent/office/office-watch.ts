import type { OfficeArtifact } from './office-files'
import { startOfficePreviewGateway, type OfficePreviewGateway } from './office-preview'
import type { OfficePreviewOwnership } from './office-service'
import type { OfficeSelectionSummary } from '../../../shared/officeProtocol'
import type { OfficeCellPatch } from './office-selection-events'
import { OfficeSheetTabConfirmationManager } from './office-sheet-preview-confirmation'
import type { OfficePreviewConfirmation } from './office-write-contract'
import type { OfficeHumanCellEdit, OfficeHumanEditAccess } from './office-human-edit'
import { inspectStartedOfficeDocxPreview } from './office-docx-preview-check'
import {
  inspectStartedOfficePptxPreview,
  readOfficePptxSlideCount
} from './office-pptx-preview-check'
import { officeArtifactKind } from './office-document-kind'
import { OfficeDocumentTextConfirmationManager } from './office-document-preview-confirmation'
import { OfficeCellPreviewConfirmationManager } from './office-cell-preview-confirmation'
import { officeHighlightTarget } from './office-highlight'
import type { OfficeWriteOperation } from './office-write-contract'

import {
  assertOfficeWatchCleanupResult,
  availableOfficePreviewPort,
  isOwnedLoopbackListener,
  OfficeWatchError,
  startOfficeWatchProcess,
  type WatchProcessHandle
} from './office-watch-process'

export { assertOfficeWatchCleanupResult, isOwnedLoopbackListener, OfficeWatchError }

export { previewHtmlHasSheetTab } from './office-sheet-preview-confirmation'

const WATCH_RETRY_COUNT = 3
const PREVIEW_CONFIRMATION_TIMEOUT_MS = 3_000

interface WatchHandle extends WatchProcessHandle {
  gateway?: OfficePreviewGateway
  previewPreferences: OfficePreviewPreferences
}

export interface OfficePreviewPreferences {
  readonly visible: boolean
  readonly followAi: boolean
}

export interface OfficePreviewProcessManagerDependencies {
  availablePort: () => Promise<number>
  startWatch: (
    binaryPath: string,
    artifact: OfficeArtifact,
    port: number
  ) => Promise<WatchProcessHandle>
  startGateway: typeof startOfficePreviewGateway
  previewConfirmationTimeoutMs?: number
  loadPreviewHtml?: (url: string) => Promise<string>
  inspectDocxPreview?: (binaryPath: string, draftPath: string) => Promise<readonly string[]>
  inspectPptxPreview?: (binaryPath: string, draftPath: string) => Promise<number>
}

export interface OfficePreviewHumanEditing {
  apply: (edit: OfficeHumanCellEdit) => Promise<void>
  access: (artifactId: string) => OfficeHumanEditAccess
  rejected: (artifactId: string, code: string) => void
}

export class OfficePreviewProcessManager {
  private readonly handles = new Map<string, WatchHandle>()
  private readonly presentationRefreshGenerations = new Map<string, number>()
  private readonly cellConfirmations: OfficeCellPreviewConfirmationManager
  private readonly sheetConfirmations: OfficeSheetTabConfirmationManager
  private readonly documentConfirmations: OfficeDocumentTextConfirmationManager

  constructor(
    private readonly dependencies: OfficePreviewProcessManagerDependencies = {
      availablePort: availableOfficePreviewPort,
      startWatch: startOfficeWatchProcess,
      startGateway: startOfficePreviewGateway
    },
    private readonly onSelection: (
      artifactId: string,
      selection: OfficeSelectionSummary | null
    ) => void = () => undefined,
    private readonly humanEditing?: OfficePreviewHumanEditing,
    private readonly onPresentationSlideCount: (
      artifactId: string,
      slideCount: number
    ) => void = () => undefined
  ) {
    this.sheetConfirmations = new OfficeSheetTabConfirmationManager(
      dependencies.previewConfirmationTimeoutMs ?? PREVIEW_CONFIRMATION_TIMEOUT_MS,
      dependencies.loadPreviewHtml
    )
    this.documentConfirmations = new OfficeDocumentTextConfirmationManager(
      dependencies.previewConfirmationTimeoutMs ?? PREVIEW_CONFIRMATION_TIMEOUT_MS,
      dependencies.loadPreviewHtml
    )
    this.cellConfirmations = new OfficeCellPreviewConfirmationManager(
      dependencies.previewConfirmationTimeoutMs ?? PREVIEW_CONFIRMATION_TIMEOUT_MS
    )
  }

  async start(binaryPath: string, artifact: OfficeArtifact): Promise<OfficePreviewOwnership> {
    const kind = officeArtifactKind(artifact as unknown as Record<string, unknown>)
    for (let attempt = 0; attempt < WATCH_RETRY_COUNT; attempt += 1) {
      const port = await this.dependencies.availablePort()
      let handle: WatchHandle | undefined
      try {
        handle = {
          ...(await this.dependencies.startWatch(binaryPath, artifact, port)),
          previewPreferences: { visible: false, followAi: true }
        }
        this.handles.set(artifact.artifactId, handle)
        const gateway = await this.dependencies.startGateway({
          artifactId: artifact.artifactId,
          kind,
          upstreamPort: port,
          onSelection: (selection) => {
            if (this.handles.get(artifact.artifactId) === handle) {
              this.onSelection(artifact.artifactId, selection)
            }
          },
          onCellPatch: (patch) => {
            if (this.handles.get(artifact.artifactId) === handle) {
              this.publishCellPatch(artifact.artifactId, patch)
            }
          },
          onFullRefresh: (version) => {
            if (this.handles.get(artifact.artifactId) === handle) {
              this.publishFullRefresh(artifact.artifactId, version)
            }
          },
          onDocumentPatch: (version) => {
            if (this.handles.get(artifact.artifactId) === handle) {
              this.publishDocumentPatch(artifact.artifactId, version)
            }
          },
          ...(kind === 'pptx'
            ? {
                onPresentationChange: (version, slideCountChanged) => {
                  if (this.handles.get(artifact.artifactId) !== handle) return
                  this.publishPresentationChange(
                    binaryPath,
                    artifact,
                    handle!,
                    version,
                    slideCountChanged
                  )
                }
              }
            : {}),
          ...(this.humanEditing && kind === 'xlsx'
            ? {
                onHumanCellEdit: async (edit: OfficeHumanCellEdit) => {
                  if (this.handles.get(artifact.artifactId) !== handle) {
                    throw new OfficeWatchError('watch-failed', 'Office 预览已失效')
                  }
                  await this.humanEditing!.apply(edit)
                },
                humanEditAccess: () =>
                  this.handles.get(artifact.artifactId) === handle
                    ? this.humanEditing!.access(artifact.artifactId)
                    : ('frozen' as const),
                onHumanEditRejected: (code: string) => {
                  if (this.handles.get(artifact.artifactId) === handle) {
                    this.humanEditing!.rejected(artifact.artifactId, code)
                  }
                }
              }
            : {})
        })
        handle.gateway = gateway
        const previewHealth = await this.checkPreviewHealth(binaryPath, artifact, gateway.url)
        return {
          watchPid: handle.pid,
          watchPort: port,
          gatewayPort: gateway.port,
          previewUrl: gateway.url,
          ...previewHealth
        }
      } catch (error) {
        if (handle) await this.stopHandle(handle)
        if (!(error instanceof OfficeWatchError) || error.code !== 'port-conflict') throw error
      }
    }
    throw new OfficeWatchError('port-conflict', 'Office watch 端口冲突，请重试')
  }

  private async checkPreviewHealth(
    binaryPath: string,
    artifact: OfficeArtifact,
    previewUrl: string
  ): Promise<Pick<OfficePreviewOwnership, 'previewState' | 'previewError' | 'slideCount'>> {
    const kind = officeArtifactKind(artifact as unknown as Record<string, unknown>)
    if (kind === 'xlsx') return {}
    const health =
      kind === 'docx'
        ? await inspectStartedOfficeDocxPreview(binaryPath, artifact.draftPath, previewUrl, {
            inspect: this.dependencies.inspectDocxPreview,
            loadHtml: this.dependencies.loadPreviewHtml
          })
        : await inspectStartedOfficePptxPreview(binaryPath, artifact.draftPath, previewUrl, {
            inspect: this.dependencies.inspectPptxPreview,
            loadHtml: this.dependencies.loadPreviewHtml
          })
    if (health.previewState === 'ready') {
      if (kind === 'docx') this.cellConfirmations.establishBaseline(artifact.artifactId, 0)
      this.documentConfirmations.establishBaseline(artifact.artifactId, 0)
    }
    return health
  }

  private async refreshPresentationSlideCount(
    binaryPath: string,
    artifact: OfficeArtifact,
    handle: WatchHandle,
    generation: number
  ): Promise<boolean> {
    try {
      const inspect = this.dependencies.inspectPptxPreview ?? readOfficePptxSlideCount
      const slideCount = await inspect(binaryPath, artifact.draftPath)
      if (this.handles.get(artifact.artifactId) !== handle) return false
      if (this.presentationRefreshGenerations.get(artifact.artifactId) !== generation) return false
      this.onPresentationSlideCount(artifact.artifactId, slideCount)
      return true
    } catch {
      // A transient refresh failure must not tear down an otherwise healthy preview.
      return false
    }
  }
  private publishPresentationChange(
    binaryPath: string,
    artifact: OfficeArtifact,
    handle: WatchHandle,
    version: number,
    slideCountChanged: boolean
  ): void {
    if (!slideCountChanged) {
      this.publishDocumentPatch(artifact.artifactId, version)
      return
    }
    const generation = (this.presentationRefreshGenerations.get(artifact.artifactId) ?? 0) + 1
    this.presentationRefreshGenerations.set(artifact.artifactId, generation)
    void this.refreshPresentationSlideCount(binaryPath, artifact, handle, generation).then(
      (published) => {
        if (published) this.publishDocumentPatch(artifact.artifactId, version)
      }
    )
  }
  async stop(document: OfficeArtifact & Partial<OfficePreviewOwnership>): Promise<void> {
    const handle = this.handles.get(document.artifactId)
    if (!handle) return
    if (document.watchPid !== undefined && handle.pid !== document.watchPid) return
    if (document.watchPort !== undefined && handle.port !== document.watchPort) return
    await this.stopHandle(handle)
  }
  async stopForRecovery(document: OfficeArtifact & Partial<OfficePreviewOwnership>): Promise<void> {
    const handle = this.handles.get(document.artifactId)
    if (!handle) return
    this.cellConfirmations.clear(handle.artifact.artifactId)
    this.sheetConfirmations.clear(handle.artifact.artifactId)
    this.documentConfirmations.clear(handle.artifact.artifactId)
    this.presentationRefreshGenerations.delete(handle.artifact.artifactId)
    const gateway = handle.gateway
    handle.gateway = undefined
    const results = await Promise.allSettled([gateway?.close() ?? Promise.resolve(), handle.stop()])
    this.handles.delete(handle.artifact.artifactId)
    const gatewayFailure = results[0]
    if (gatewayFailure?.status === 'rejected') throw gatewayFailure.reason
  }

  armCellPatchConfirmation(
    artifactId: string,
    sheet: string,
    cell: string
  ): OfficePreviewConfirmation {
    return this.armCellPatchSetConfirmation(artifactId, sheet, [cell])
  }

  armCellPatchSetConfirmation(
    artifactId: string,
    sheet: string,
    cells: readonly string[]
  ): OfficePreviewConfirmation {
    if (!this.handles.has(artifactId)) {
      return { promise: Promise.resolve(false), cancel: () => undefined }
    }
    return this.cellConfirmations.arm(artifactId, sheet, cells)
  }

  armSheetConfirmation(artifactId: string, sheet: string): OfficePreviewConfirmation {
    const handle = this.handles.get(artifactId)
    if (!handle?.gateway) return { promise: Promise.resolve(false), cancel: () => undefined }
    return this.sheetConfirmations.arm(artifactId, handle.gateway.url, sheet)
  }

  armDocumentTextConfirmation(artifactId: string, text: string): OfficePreviewConfirmation {
    const handle = this.handles.get(artifactId)
    if (!handle?.gateway) return { promise: Promise.resolve(false), cancel: () => undefined }
    return this.documentConfirmations.arm(artifactId, handle.gateway.url, text)
  }

  setPreviewPreferences(artifactId: string, preferences: OfficePreviewPreferences): boolean {
    const handle = this.handles.get(artifactId)
    if (
      !handle?.gateway ||
      officeArtifactKind(handle.artifact as unknown as Record<string, unknown>) !== 'xlsx'
    ) {
      return false
    }
    handle.previewPreferences = Object.freeze({ ...preferences })
    return true
  }

  publishConfirmedWrite(artifactId: string, operation: OfficeWriteOperation): boolean {
    const handle = this.handles.get(artifactId)
    if (
      !handle?.gateway ||
      officeArtifactKind(handle.artifact as unknown as Record<string, unknown>) !== 'xlsx'
    ) {
      return false
    }
    const target = officeHighlightTarget(operation)
    if (!target) return false
    const preferences = handle.previewPreferences
    return (
      handle.gateway.publishHighlight?.(target, preferences.visible && preferences.followAi) ??
      false
    )
  }

  private publishCellPatch(artifactId: string, patch: OfficeCellPatch): void {
    this.cellConfirmations.publishPatch(artifactId, patch)
  }

  private publishFullRefresh(artifactId: string, version: number): void {
    this.cellConfirmations.publishFull(artifactId, version)
    this.sheetConfirmations.publishFull(artifactId, version)
    this.documentConfirmations.publish(artifactId, version)
  }

  private publishDocumentPatch(artifactId: string, version: number): void {
    this.documentConfirmations.publish(artifactId, version)
  }

  private async stopHandle(handle: WatchHandle): Promise<void> {
    this.cellConfirmations.clear(handle.artifact.artifactId)
    this.sheetConfirmations.clear(handle.artifact.artifactId)
    this.documentConfirmations.clear(handle.artifact.artifactId)
    this.presentationRefreshGenerations.delete(handle.artifact.artifactId)
    if (handle.gateway) {
      await handle.gateway.close()
      handle.gateway = undefined
    }
    await handle.stop()
    this.handles.delete(handle.artifact.artifactId)
  }
}
