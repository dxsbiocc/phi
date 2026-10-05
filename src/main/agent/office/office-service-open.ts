import type { OfficeArtifact, OfficeBlankArtifact } from './office-files'
import type { OfficeDraftIntegrityResult } from './office-draft-integrity'
import type { OfficeRuntimeStatus } from './office-runtime'
import type { OfficeServiceCleanup } from './office-service-cleanup'
import {
  OfficeServiceError,
  operationError,
  runtimeMessage,
  sourceKey,
  type OfficeDocumentStatus,
  type OfficeOpenRequest,
  type OfficePreviewOwnership,
  type OfficeProcessOwnership,
  type OfficeServiceDependencies,
  type OwnedOfficeDocument,
  type PendingOfficeCleanup
} from './office-service-state'

interface OfficeOpeningHostState {
  statuses: Map<string, OfficeDocumentStatus>
  owned: Map<string, OwnedOfficeDocument>
  registeredBlank: Map<string, OfficeBlankArtifact>
  pendingCleanup: Map<string, PendingOfficeCleanup>
}

interface ResolvedOpening {
  readonly key: string
  readonly registered?: OfficeArtifact
  readonly registeredMatch?: 'draft' | 'source'
  readonly sourceChanged: boolean
}

type RememberReady = (
  key: string,
  binaryPath: string,
  artifact: OfficeArtifact,
  process: OfficeProcessOwnership,
  preview: OfficePreviewOwnership,
  references?: number,
  restoreKind?: 'recovered' | 'source_changed',
  integrity?: OfficeDraftIntegrityResult
) => Promise<OfficeDocumentStatus>

export class OfficeOpeningFlow {
  private readonly openings = new Map<string, Promise<OfficeDocumentStatus>>()
  private readonly aliases = new Map<string, string>()

  constructor(
    private readonly dependencies: OfficeServiceDependencies,
    private readonly cleanup: OfficeServiceCleanup,
    private readonly hostState: OfficeOpeningHostState,
    private readonly ensureCapacity: () => Promise<void> | undefined,
    private readonly rememberReady: RememberReady
  ) {}

  statusFor(sessionId: string, sourcePath: string): OfficeDocumentStatus | undefined {
    const requestedKey = sourceKey(sessionId, sourcePath)
    return this.hostState.statuses.get(this.aliases.get(requestedKey) ?? requestedKey)
  }

  async waitForPending(): Promise<void> {
    await Promise.allSettled([...this.openings.values()])
  }

  open(request: OfficeOpenRequest): Promise<OfficeDocumentStatus> {
    const requestedKey = sourceKey(request.sessionId, request.sourcePath)
    const remembered = this.hostState.registeredBlank.get(requestedKey)
    if (remembered) {
      return this.openResolved(request, requestedKey, {
        key: requestedKey,
        registered: remembered,
        registeredMatch: 'draft',
        sourceChanged: false
      })
    }
    if (!this.dependencies.resolveRegisteredDraft) {
      return this.openResolved(request, requestedKey, {
        key: requestedKey,
        sourceChanged: false
      })
    }
    return this.resolveAndOpen(request, requestedKey)
  }

  private async resolveAndOpen(
    request: OfficeOpenRequest,
    requestedKey: string
  ): Promise<OfficeDocumentStatus> {
    try {
      const resolved = await this.resolveOpening(request)
      return this.openResolved(request, requestedKey, resolved)
    } catch (error) {
      const failed = operationError(request.sourcePath, error)
      this.hostState.statuses.set(requestedKey, failed)
      return failed
    }
  }

  private async openResolved(
    request: OfficeOpenRequest,
    requestedKey: string,
    resolved: ResolvedOpening
  ): Promise<OfficeDocumentStatus> {
    const { key, registered } = resolved
    this.aliases.set(requestedKey, key)
    const reused = this.reuseOwnedRegistered(request, requestedKey, resolved)
    if (reused) return reused
    const current = this.hostState.statuses.get(key)
    if (current?.state === 'ready') {
      return this.reuseRegisteredDraft(request, current)
    }
    const existing = this.openings.get(key)
    if (existing) {
      return existing.then((status) => {
        if (status.state === 'ready') this.addReference(status.document.artifactId)
        return status
      })
    }
    try {
      const capacity = this.ensureCapacity()
      if (capacity) await capacity
    } catch (error) {
      const rejected = operationError(request.sourcePath, error)
      this.hostState.statuses.set(key, rejected)
      return rejected
    }
    if (registered) {
      const opening = this.reopenRegisteredDraft(key, request, registered).finally(() =>
        this.openings.delete(key)
      )
      this.openings.set(key, opening)
      return opening
    }
    const opening = this.openNew(key, request, resolved.sourceChanged).finally(() =>
      this.openings.delete(key)
    )
    this.openings.set(key, opening)
    return opening
  }

  private reuseOwnedRegistered(
    request: OfficeOpenRequest,
    requestedKey: string,
    resolved: ResolvedOpening
  ): OfficeDocumentStatus | Promise<OfficeDocumentStatus> | undefined {
    if (!resolved.registered) return undefined
    const owned = this.hostState.owned.get(resolved.registered.artifactId)
    if (!owned) return undefined
    this.aliases.set(requestedKey, owned.key)
    const status = this.hostState.statuses.get(owned.key)
    if (status?.state === 'ready' && resolved.registeredMatch === 'draft') {
      return this.reuseRegisteredDraft(request, status)
    }
    if (!status) return undefined
    owned.panelReferences += 1
    owned.lastActivityAt = (this.dependencies.now ?? (() => new Date()))().getTime()
    return status
  }

  private async resolveOpening(request: OfficeOpenRequest): Promise<ResolvedOpening> {
    const result = await this.dependencies.resolveRegisteredDraft!(request)
    const baseKey = sourceKey(request.sessionId, result.normalizedSourcePath)
    if (result.kind === 'registered') {
      return {
        key: `${baseKey}\0${result.artifact.artifactId}`,
        registered: result.artifact,
        registeredMatch: result.match,
        sourceChanged: false
      }
    }
    if (result.kind === 'source_changed') {
      return {
        key: `${baseKey}\0source:${result.currentSourceHash ?? 'unavailable'}`,
        sourceChanged: true
      }
    }
    return { key: baseKey, sourceChanged: false }
  }

  private async reuseRegisteredDraft(
    request: OfficeOpenRequest,
    current: Extract<OfficeDocumentStatus, { state: 'ready' }>
  ): Promise<OfficeDocumentStatus> {
    try {
      if (
        current.document.sourcePath === request.sourcePath &&
        current.document.sessionId === request.sessionId &&
        current.document.projectId === request.projectId
      ) {
        this.addReference(current.document.artifactId)
        return current
      }
      if (
        current.document.draftPath !== request.sourcePath ||
        current.document.sessionId !== request.sessionId ||
        current.document.projectId !== request.projectId
      ) {
        throw new OfficeServiceError('unregistered-draft', 'Office 草稿登记身份不匹配')
      }
      await this.dependencies.validateRegisteredDraft(current.document)
      this.addReference(current.document.artifactId)
      return current
    } catch (error) {
      return operationError(request.sourcePath, error)
    }
  }

  private addReference(artifactId: string): void {
    const owned = this.hostState.owned.get(artifactId)
    if (owned) {
      owned.panelReferences += 1
      owned.lastActivityAt = (this.dependencies.now ?? (() => new Date()))().getTime()
    }
  }

  private async openNew(
    key: string,
    request: OfficeOpenRequest,
    sourceChanged: boolean
  ): Promise<OfficeDocumentStatus> {
    this.hostState.statuses.set(key, { state: 'preparing', sourcePath: request.sourcePath })
    try {
      await this.dependencies.assertNotOfficeArtifactPath(request.sourcePath)
    } catch (error) {
      const failed = operationError(request.sourcePath, error)
      this.hostState.statuses.set(key, failed)
      return failed
    }
    let runtime: OfficeRuntimeStatus
    try {
      runtime = await this.dependencies.detectRuntime()
    } catch (error) {
      const failed: OfficeDocumentStatus = {
        state: 'error',
        sourcePath: request.sourcePath,
        code: 'runtime-probe-failed',
        message: error instanceof Error ? error.message : 'Office 运行环境检查失败'
      }
      this.hostState.statuses.set(key, failed)
      return failed
    }
    if (runtime.state !== 'available') {
      const failed: OfficeDocumentStatus = {
        state: 'error',
        sourcePath: request.sourcePath,
        code: runtime.state,
        message: runtimeMessage(runtime)
      }
      this.hostState.statuses.set(key, failed)
      return failed
    }
    let artifact: OfficeArtifact | undefined
    let process: OfficeProcessOwnership | undefined
    let previewAttempted = false
    try {
      artifact = await this.dependencies.prepareDraft(request, runtime.binaryPath)
      process = await this.dependencies.startDocument(runtime.binaryPath, artifact)
      previewAttempted = true
      const preview = await this.dependencies.startPreview(runtime.binaryPath, artifact)
      return await this.rememberReady(
        key,
        runtime.binaryPath,
        artifact,
        process,
        preview,
        1,
        sourceChanged ? 'source_changed' : undefined
      )
    } catch (error) {
      let reported = error
      if (artifact && process) {
        try {
          await this.cleanup.cleanupOwnedArtifact(
            runtime.binaryPath,
            artifact,
            process,
            undefined,
            previewAttempted,
            false
          )
        } catch (cleanupError) {
          reported = cleanupError
        }
      }
      const failed = operationError(request.sourcePath, reported)
      this.hostState.statuses.set(key, failed)
      return failed
    }
  }

  private async reopenRegisteredDraft(
    key: string,
    request: OfficeOpenRequest,
    artifact: OfficeArtifact
  ): Promise<OfficeDocumentStatus> {
    this.hostState.statuses.set(key, { state: 'preparing', sourcePath: request.sourcePath })
    let runtime: OfficeRuntimeStatus | undefined
    let process: OfficeProcessOwnership | undefined
    let integrity: OfficeDraftIntegrityResult | undefined
    let previewAttempted = false
    try {
      const pending = this.hostState.pendingCleanup.get(artifact.artifactId)
      if (pending) await this.cleanup.resumePending(pending)
      runtime = await this.dependencies.detectRuntime()
      if (runtime.state !== 'available') {
        throw new OfficeServiceError(runtime.state, runtimeMessage(runtime))
      }
      if (this.dependencies.prepareRegisteredDraftForOpen) {
        integrity = await this.dependencies.prepareRegisteredDraftForOpen(
          runtime.binaryPath,
          artifact
        )
      } else {
        await this.dependencies.validateRegisteredDraft(artifact)
      }
      process = await this.dependencies.startDocument(runtime.binaryPath, artifact)
      previewAttempted = true
      const preview = await this.dependencies.startPreview(runtime.binaryPath, artifact)
      return await this.rememberReady(
        key,
        runtime.binaryPath,
        artifact,
        process,
        preview,
        1,
        'recovered',
        integrity
      )
    } catch (error) {
      let reported = error
      if (runtime?.state === 'available' && process) {
        try {
          await this.cleanup.cleanupOwnedArtifact(
            runtime.binaryPath,
            artifact,
            process,
            undefined,
            previewAttempted,
            false
          )
        } catch (cleanupError) {
          reported = cleanupError
        }
      }
      const failed = operationError(request.sourcePath, reported)
      this.hostState.statuses.set(key, failed)
      return failed
    }
  }
}
