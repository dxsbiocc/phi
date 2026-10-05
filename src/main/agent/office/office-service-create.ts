import type {
  OfficeBlankArtifact,
  OfficeCreatedArtifact,
  OfficeImportedArtifact
} from './office-files'
import type { OfficeRuntimeStatus } from './office-runtime'
import { rmSync } from 'node:fs'
import type { OfficeServiceCleanup } from './office-service-cleanup'
import {
  OfficeServiceError,
  creationError,
  creationKey,
  importError,
  importKey,
  runtimeMessage,
  sourceKey,
  type DraftCreationControl,
  type OfficeCreateRequest,
  type OfficeCreateStatus,
  type OfficeDocumentStatus,
  type OfficeImportRequest,
  type OfficeImportStatus,
  type OfficePreviewOwnership,
  type OfficeProcessOwnership,
  type OfficeServiceDependencies,
  type OwnedOfficeDocument
} from './office-service-state'

interface OfficeCreationHostState {
  statuses: Map<string, OfficeDocumentStatus>
  owned: Map<string, OwnedOfficeDocument>
  registeredBlank: Map<string, OfficeBlankArtifact>
}

interface ImportedDocumentStartup {
  artifact?: OfficeImportedArtifact
  process?: OfficeProcessOwnership
  preview?: OfficePreviewOwnership
  previewAttempted: boolean
}

interface StartedImportedDocument {
  artifact: OfficeImportedArtifact
  process: OfficeProcessOwnership
  preview: OfficePreviewOwnership
}

type RememberReady = (
  key: string,
  binaryPath: string,
  artifact: OfficeCreatedArtifact,
  process: OfficeProcessOwnership,
  preview: OfficePreviewOwnership,
  references: number
) => Promise<OfficeDocumentStatus>

export class OfficeCreationFlow {
  private readonly statuses = new Map<string, OfficeCreateStatus>()
  private readonly importStatuses = new Map<string, OfficeImportStatus>()
  private readonly controls = new Map<string, DraftCreationControl<OfficeCreateStatus>>()
  private readonly importControls = new Map<string, DraftCreationControl<OfficeImportStatus>>()

  constructor(
    private readonly dependencies: OfficeServiceDependencies,
    private readonly cleanup: OfficeServiceCleanup,
    private readonly hostState: OfficeCreationHostState,
    private readonly ensureCapacity: (reservationsToExclude?: number) => Promise<void> | undefined,
    private readonly rememberReady: RememberReady
  ) {}

  statusFor(sessionId: string, requestId: string): OfficeCreateStatus | undefined {
    return this.statuses.get(creationKey(sessionId, requestId))
  }

  importStatusFor(sessionId: string, requestId: string): OfficeImportStatus | undefined {
    return this.importStatuses.get(importKey(sessionId, requestId))
  }

  liveDocumentCount(): number {
    return [...this.statuses.values(), ...this.importStatuses.values()].filter(
      (status) => status.state === 'preparing'
    ).length
  }

  async cancelMatching(
    predicate: (control: { sessionId: string; cancelled: boolean }) => boolean
  ): Promise<void> {
    const controls = [...this.controls.values(), ...this.importControls.values()].filter(predicate)
    controls.forEach((control) => {
      control.cancelled = true
      control.abort?.abort()
    })
    await Promise.allSettled(controls.flatMap((control) => control.promise ?? []))
  }

  async create(request: OfficeCreateRequest): Promise<OfficeCreateStatus> {
    const key = creationKey(request.sessionId, request.requestId)
    const existing = this.statuses.get(key)
    if (existing?.state === 'preparing') {
      const pending = this.controls.get(key)?.promise
      if (pending) return pending
    }
    if (existing) {
      return {
        state: 'error',
        requestId: request.requestId,
        code: 'duplicate-request',
        message: 'Office 创建请求编号已使用'
      }
    }
    try {
      const capacity = this.ensureCapacity()
      if (capacity) await capacity
    } catch (error) {
      const rejected = creationError(request.requestId, error)
      this.statuses.set(key, rejected)
      return rejected
    }
    this.statuses.set(key, {
      state: 'preparing',
      requestId: request.requestId
    })
    const control: DraftCreationControl<OfficeCreateStatus> = {
      sessionId: request.sessionId,
      cancelled: false
    }
    const promise = this.createNew(key, request, control).finally(() => this.controls.delete(key))
    control.promise = promise
    this.controls.set(key, control)
    return promise
  }

  async importDocument(request: OfficeImportRequest): Promise<OfficeImportStatus> {
    const key = importKey(request.sessionId, request.requestId)
    const existing = this.importStatuses.get(key)
    if (existing?.state === 'preparing') {
      const pending = this.importControls.get(key)?.promise
      if (pending) return pending
    }
    if (existing) {
      return {
        state: 'error',
        requestId: request.requestId,
        code: 'duplicate-request',
        message: 'Office 导入请求编号已使用'
      }
    }
    this.importStatuses.set(key, { state: 'preparing', requestId: request.requestId })
    const control: DraftCreationControl<OfficeImportStatus> = {
      sessionId: request.sessionId,
      cancelled: false,
      abort: new AbortController(),
      processPids: new Set<number>()
    }
    const promise = this.importWithCapacity(key, request, control).finally(() =>
      this.importControls.delete(key)
    )
    control.promise = promise
    this.importControls.set(key, control)
    return promise
  }

  private async importWithCapacity(
    key: string,
    request: OfficeImportRequest,
    control: DraftCreationControl<OfficeImportStatus>
  ): Promise<OfficeImportStatus> {
    try {
      const capacity = this.ensureCapacity(1)
      if (capacity) await capacity
      if (control.cancelled) throw this.cancelledImport()
      return await this.importNew(key, request, control)
    } catch (error) {
      const failed = importError(request.requestId, error)
      this.importStatuses.set(key, failed)
      return failed
    }
  }

  async cancel(requestId: string, sessionId: string): Promise<boolean> {
    const key = creationKey(sessionId, requestId)
    const control = this.controls.get(key)
    let cancelledPreparing = false
    if (control) {
      control.cancelled = true
      control.abort?.abort()
      await control.promise
      cancelledPreparing = true
    }
    const status = this.statuses.get(key)
    if (status?.state !== 'ready') return cancelledPreparing
    const owned = this.hostState.owned.get(status.document.artifactId)
    if (!owned || owned.panelReferences > 0) return false
    owned.operations.cancel()
    if (!owned.operations.idle) await owned.operations.drain()
    this.hostState.owned.delete(status.document.artifactId)
    this.hostState.statuses.delete(owned.key)
    this.statuses.delete(key)
    this.hostState.registeredBlank.delete(owned.key)
    await this.cleanup.cleanupOwnedArtifact(
      owned.binaryPath,
      status.document,
      { residentPid: status.document.residentPid },
      status.document
    )
    return true
  }

  async cancelImport(requestId: string, sessionId: string): Promise<boolean> {
    const key = importKey(sessionId, requestId)
    const control = this.importControls.get(key)
    let cancelledPreparing = false
    if (control) {
      control.cancelled = true
      control.abort?.abort()
      await control.promise
      cancelledPreparing = true
    }
    const status = this.importStatuses.get(key)
    if (status?.state !== 'ready') return cancelledPreparing
    const owned = this.hostState.owned.get(status.document.artifactId)
    if (!owned || owned.panelReferences > 0) return false
    owned.operations.cancel()
    if (!owned.operations.idle) await owned.operations.drain()
    this.hostState.owned.delete(status.document.artifactId)
    this.hostState.statuses.delete(owned.key)
    this.importStatuses.delete(key)
    await this.cleanup.cleanupOwnedArtifact(
      owned.binaryPath,
      status.document,
      { residentPid: status.document.residentPid },
      status.document
    )
    return true
  }

  private async createNew(
    key: string,
    request: OfficeCreateRequest,
    control: DraftCreationControl<OfficeCreateStatus>
  ): Promise<OfficeCreateStatus> {
    let artifact: OfficeBlankArtifact | undefined
    let process: OfficeProcessOwnership | undefined
    let preview: OfficePreviewOwnership | undefined
    let previewAttempted = false
    let runtime: Extract<OfficeRuntimeStatus, { state: 'available' }> | undefined
    try {
      const detected = await this.dependencies.detectRuntime()
      if (detected.state !== 'available') {
        throw new OfficeServiceError(detected.state, runtimeMessage(detected))
      }
      runtime = detected
      if (control.cancelled) throw this.cancelledCreate()
      artifact = await this.dependencies.prepareBlankDraft(request, runtime.binaryPath)
      await this.dependencies.validateRegisteredDraft(artifact)
      if (control.cancelled) throw this.cancelledCreate()
      process = await this.dependencies.adoptCreatedDocument(runtime.binaryPath, artifact)
      if (control.cancelled) throw this.cancelledCreate()
      previewAttempted = true
      preview = await this.dependencies.startPreview(runtime.binaryPath, artifact)
      if (control.cancelled) throw this.cancelledCreate()
      const ready = (await this.rememberReady(
        sourceKey(request.sessionId, artifact.draftPath),
        runtime.binaryPath,
        artifact,
        process,
        preview,
        0
      )) as OfficeCreateStatus
      this.statuses.set(key, ready)
      return ready
    } catch (error) {
      let reported = error
      if (runtime && artifact) {
        try {
          await this.cleanup.cleanupOwnedArtifact(
            runtime.binaryPath,
            artifact,
            process,
            preview,
            previewAttempted,
            true
          )
        } catch (cleanupError) {
          reported = cleanupError
        }
      }
      const failed = creationError(request.requestId, reported)
      this.statuses.set(key, failed)
      return failed
    }
  }

  private async importNew(
    key: string,
    request: OfficeImportRequest,
    control: DraftCreationControl<OfficeImportStatus>
  ): Promise<OfficeImportStatus> {
    const startup: ImportedDocumentStartup = { previewAttempted: false }
    let runtime: Extract<OfficeRuntimeStatus, { state: 'available' }> | undefined
    try {
      const detected = await this.dependencies.detectRuntime()
      if (detected.state !== 'available') {
        throw new OfficeServiceError(detected.state, runtimeMessage(detected))
      }
      runtime = detected
      if (control.cancelled) throw this.cancelledImport()
      const { artifact, process, preview } = await this.startImportedDocument(
        request,
        runtime.binaryPath,
        control,
        startup
      )
      const ready = (await this.rememberReady(
        sourceKey(request.sessionId, artifact.draftPath),
        runtime.binaryPath,
        artifact,
        process,
        preview,
        0
      )) as OfficeImportStatus
      control.registered = true
      this.importStatuses.set(key, ready)
      return ready
    } catch (error) {
      const cleanupError = runtime
        ? await this.cleanupImportedStartup(runtime.binaryPath, startup)
        : undefined
      const reported = cleanupError ?? error
      const failed = importError(request.requestId, reported)
      this.importStatuses.set(key, failed)
      return failed
    }
  }

  private async startImportedDocument(
    request: OfficeImportRequest,
    binaryPath: string,
    control: DraftCreationControl<OfficeImportStatus>,
    startup: ImportedDocumentStartup
  ): Promise<StartedImportedDocument> {
    if (!this.dependencies.prepareImportedDraft) {
      throw new OfficeServiceError('import-unavailable', 'Office 导入能力不可用')
    }
    startup.artifact = await this.dependencies.prepareImportedDraft(request, binaryPath, {
      signal: control.abort?.signal,
      onResidentPid: (pid) => control.processPids?.add(pid),
      onArtifactDir: (artifactDir) => {
        control.artifactDir = artifactDir
      },
      onDraftPath: (draftPath) => {
        control.draftPath = draftPath
      }
    })
    await this.dependencies.validateRegisteredDraft(startup.artifact)
    if (control.cancelled) throw this.cancelledImport()
    startup.process = await this.dependencies.adoptCreatedDocument(binaryPath, startup.artifact)
    control.processPids?.add(startup.process.residentPid)
    if (control.cancelled) throw this.cancelledImport()
    startup.previewAttempted = true
    startup.preview = await this.dependencies.startPreview(binaryPath, startup.artifact)
    control.processPids?.add(startup.preview.watchPid)
    if (control.cancelled) throw this.cancelledImport()
    return { artifact: startup.artifact, process: startup.process, preview: startup.preview }
  }

  private async cleanupImportedStartup(
    binaryPath: string,
    startup: ImportedDocumentStartup
  ): Promise<unknown | undefined> {
    if (!startup.artifact) return undefined
    try {
      await this.cleanup.cleanupOwnedArtifact(
        binaryPath,
        startup.artifact,
        startup.process,
        startup.preview,
        startup.previewAttempted,
        true
      )
      return undefined
    } catch (error) {
      return error
    }
  }

  private cancelledCreate(): OfficeServiceError {
    return new OfficeServiceError('create-cancelled', '已取消创建空白 Office 草稿')
  }

  private cancelledImport(): OfficeServiceError {
    return new OfficeServiceError('import-cancelled', '已取消 CSV/TSV 导入')
  }

  async forceCleanupActiveImports(
    kill: (pid: number, signal: NodeJS.Signals) => void = signalImportProcess,
    remove: (path: string) => void = removeImportArtifactDirectory
  ): Promise<void> {
    const cleanups = [...this.importControls.values()].map(async (control) => {
      control.cancelled = true
      control.abort?.abort()
      const pids = [...(control.processPids ?? [])]
      if (control.draftPath && this.dependencies.forceTerminateImportedDraft) {
        await this.dependencies.forceTerminateImportedDraft(control.draftPath, pids).catch(() => {
          pids.forEach((pid) => kill(pid, 'SIGKILL'))
        })
      } else {
        pids.forEach((pid) => kill(pid, 'SIGTERM'))
      }
      if (control.artifactDir && control.registered !== true) remove(control.artifactDir)
    })
    await Promise.allSettled(cleanups)
  }
}

function signalImportProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // The process already exited after its AbortSignal fired.
  }
}

function removeImportArtifactDirectory(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // Startup registry ignores unregistered directories; async cleanup may still finish.
  }
}
