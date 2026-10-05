import type {
  OfficeCancelCreateInput,
  OfficeCancelImportInput,
  OfficeClearSelectionInput,
  OfficeCloseInput,
  OfficeCreateInput,
  OfficeCreateState,
  OfficeDocumentState,
  OfficeIpcResult,
  OfficeImportInput,
  OfficeImportState,
  OfficeOpenInput,
  OfficeReconcileInput,
  OfficeReconcileResult,
  OfficeResolvedOutput,
  OfficeSaveInput,
  OfficeSaveAsInput,
  OfficeSaveAsResult,
  OfficeSaveResult,
  OfficeRevealOutputInput,
  OfficeSelectionEvent,
  OfficeStatusInput,
  OfficePreviewPreferencesInput
} from '../../../shared/officeProtocol'
import type {
  OfficeCreateRequest,
  OfficeCreateStatus,
  OfficeDocumentStatus,
  OfficeImportRequest,
  OfficeImportStatus,
  OfficeOpenRequest
} from './office-service'
import {
  OfficeSaveIpcError,
  OfficeSaveIpcFlow,
  type OfficeSaveIpcDependencies,
  type OfficeSaveIpcService
} from './office-save-ipc'
import {
  cancelCreateInput,
  cancelImportInput,
  clearSelectionInput,
  closeInput,
  createInput,
  importInput,
  openInput,
  publicCreation,
  publicDocument,
  publicImport,
  previewPreferencesInput,
  requiredString
} from './office-ipc-contract'

interface OfficeSenderLike {
  isDestroyed(): boolean
  mainFrame: unknown
  send(channel: string, payload: unknown): void
}

export interface OfficeIpcEventLike {
  sender: OfficeSenderLike
  senderFrame: unknown
}

export interface OfficeIpcMainLike {
  handle(
    channel: string,
    listener: (event: OfficeIpcEventLike, ...args: unknown[]) => unknown
  ): void
}

interface OfficeIpcService extends OfficeSaveIpcService {
  open(request: OfficeOpenRequest): Promise<OfficeDocumentStatus>
  create(request: OfficeCreateRequest): Promise<OfficeCreateStatus>
  cancelCreate(requestId: string, sessionId: string): Promise<boolean>
  importDocument?(request: OfficeImportRequest): Promise<OfficeImportStatus>
  cancelImport?(requestId: string, sessionId: string): Promise<boolean>
  clearSelection(artifactId: string, sessionId: string): Promise<boolean>
  reconcile(artifactId: string, sessionId: string): Promise<OfficeReconcileResult>
  close(artifactId: string, sessionId: string): Promise<boolean>
  statusForSource(sessionId: string, sourcePath: string): OfficeDocumentStatus | undefined
  setPreviewPreferences(
    artifactId: string,
    sessionId: string,
    preferences: Pick<OfficePreviewPreferencesInput, 'visible' | 'followAi'>
  ): boolean
  onSelection(
    listener: (event: {
      artifactId: string
      sessionId: string
      selection: OfficeSelectionEvent['selection']
    }) => void
  ): () => void
}

interface OfficeIpcDependencies extends Omit<
  OfficeSaveIpcDependencies,
  'service' | 'resolveContext'
> {
  service: OfficeIpcService
  getTrustedRenderer: () => OfficeSenderLike | null
  resolveContext: () =>
    (Omit<OfficeOpenRequest, 'sourcePath'> & { outputRoot?: string }) | undefined
}

export class OfficeIpcCoordinator {
  private selectionEventsStarted = false
  private readonly saving: OfficeSaveIpcFlow

  constructor(private readonly dependencies: OfficeIpcDependencies) {
    this.saving = new OfficeSaveIpcFlow(dependencies)
  }

  async open(
    event: OfficeIpcEventLike,
    input: unknown
  ): Promise<OfficeIpcResult<OfficeDocumentState>> {
    return this.run(event, async () => {
      const parsed = openInput(input)
      const context = this.dependencies.resolveContext()
      if (!parsed || !context) throw new OfficeIpcError('invalid-request', 'Office 预览请求无效')
      return publicDocument(await this.dependencies.service.open({ ...context, ...parsed }))
    })
  }
  async create(
    event: OfficeIpcEventLike,
    input: unknown
  ): Promise<OfficeIpcResult<OfficeCreateState>> {
    return this.run(event, async () => {
      const parsed = createInput(input)
      const context = this.dependencies.resolveContext()
      if (!parsed || !context) throw new OfficeIpcError('invalid-request', 'Office 创建请求无效')
      return publicCreation(
        await this.dependencies.service.create({
          sessionId: context.sessionId,
          projectId: context.projectId,
          ...(context.projectLocation ? { projectLocation: context.projectLocation } : {}),
          ...parsed
        })
      )
    })
  }
  async cancelCreate(event: OfficeIpcEventLike, input: unknown): Promise<OfficeIpcResult<boolean>> {
    return this.run(event, async () => {
      const parsed = cancelCreateInput(input)
      const context = this.dependencies.resolveContext()
      if (!parsed || !context) {
        throw new OfficeIpcError('invalid-request', 'Office 取消创建请求无效')
      }
      return this.dependencies.service.cancelCreate(parsed.requestId, context.sessionId)
    })
  }
  async importFile(
    event: OfficeIpcEventLike,
    input: unknown
  ): Promise<OfficeIpcResult<OfficeImportState>> {
    return this.run(event, async () => {
      const parsed = importInput(input)
      const context = this.dependencies.resolveContext()
      if (!parsed || !context) throw new OfficeIpcError('invalid-request', 'Office 导入请求无效')
      if (!this.dependencies.service.importDocument) {
        throw new OfficeIpcError('unavailable', 'Office 导入能力不可用')
      }
      return publicImport(
        await this.dependencies.service.importDocument({
          sessionId: context.sessionId,
          projectId: context.projectId,
          ...(context.projectLocation ? { projectLocation: context.projectLocation } : {}),
          allowRoots: context.allowRoots,
          ...parsed
        })
      )
    })
  }
  async cancelImport(event: OfficeIpcEventLike, input: unknown): Promise<OfficeIpcResult<boolean>> {
    return this.run(event, async () => {
      const parsed = cancelImportInput(input)
      const context = this.dependencies.resolveContext()
      if (!parsed || !context) {
        throw new OfficeIpcError('invalid-request', 'Office 取消导入请求无效')
      }
      if (!this.dependencies.service.cancelImport) {
        throw new OfficeIpcError('unavailable', 'Office 导入能力不可用')
      }
      return this.dependencies.service.cancelImport(parsed.requestId, context.sessionId)
    })
  }
  async close(event: OfficeIpcEventLike, input: unknown): Promise<OfficeIpcResult<boolean>> {
    return this.run(event, async () => {
      const parsed = closeInput(input)
      if (!parsed) throw new OfficeIpcError('invalid-request', 'Office 关闭请求无效')
      return this.dependencies.service.close(parsed.artifactId, parsed.sessionId)
    })
  }
  async clearSelection(
    event: OfficeIpcEventLike,
    input: unknown
  ): Promise<OfficeIpcResult<boolean>> {
    return this.run(event, async () => {
      const parsed = clearSelectionInput(input)
      const context = this.dependencies.resolveContext()
      if (!parsed || !context) {
        throw new OfficeIpcError('invalid-request', 'Office 清除选区请求无效')
      }
      return this.dependencies.service.clearSelection(parsed.artifactId, context.sessionId)
    })
  }
  async reconcile(
    event: OfficeIpcEventLike,
    input: unknown
  ): Promise<OfficeIpcResult<OfficeReconcileResult>> {
    return this.run(event, async () => {
      const parsed = clearSelectionInput(input)
      const context = this.dependencies.resolveContext()
      if (!parsed || !context) throw new OfficeIpcError('invalid-request', 'Office 核对请求无效')
      try {
        return await this.dependencies.service.reconcile(parsed.artifactId, context.sessionId)
      } catch (error) {
        const value = error as { code?: unknown; message?: unknown }
        if (
          typeof value.code === 'string' &&
          ['reconcile_indeterminate', 'reconcile_failed'].includes(value.code)
        ) {
          throw new OfficeIpcError(
            value.code,
            typeof value.message === 'string' ? value.message : '核对未能可靠完成'
          )
        }
        throw error
      }
    })
  }
  save(event: OfficeIpcEventLike, input: unknown): Promise<OfficeIpcResult<OfficeSaveResult>> {
    return this.run(event, () => this.saving.save(input))
  }
  saveAs(event: OfficeIpcEventLike, input: unknown): Promise<OfficeIpcResult<OfficeSaveAsResult>> {
    return this.run(event, () => this.saving.saveAs(input))
  }
  revealOutput(event: OfficeIpcEventLike, input: unknown): Promise<OfficeIpcResult<boolean>> {
    return this.run(event, () => this.saving.revealOutput(input))
  }
  resolveOutput(
    event: OfficeIpcEventLike,
    input: unknown
  ): Promise<OfficeIpcResult<OfficeResolvedOutput>> {
    return this.run(event, () => this.saving.resolveOutput(input))
  }

  startSelectionEvents(): void {
    if (this.selectionEventsStarted) return
    this.selectionEventsStarted = true
    this.dependencies.service.onSelection((event) => this.forwardSelection(event))
  }

  async status(
    event: OfficeIpcEventLike,
    input: unknown
  ): Promise<OfficeIpcResult<OfficeDocumentState | null>> {
    return this.run(event, () => {
      const sourcePath = requiredString(input, 'sourcePath')
      const context = this.dependencies.resolveContext()
      if (!sourcePath || !context)
        throw new OfficeIpcError('invalid-request', 'Office 状态请求无效')
      const status = this.dependencies.service.statusForSource(context.sessionId, sourcePath)
      return status ? publicDocument(status) : null
    })
  }

  async setPreviewPreferences(
    event: OfficeIpcEventLike,
    input: unknown
  ): Promise<OfficeIpcResult<boolean>> {
    return this.run(event, () => {
      const parsed = previewPreferencesInput(input)
      const context = this.dependencies.resolveContext()
      if (!parsed || !context) {
        throw new OfficeIpcError('invalid-request', 'Office 预览偏好请求无效')
      }
      return this.dependencies.service.setPreviewPreferences(parsed.artifactId, context.sessionId, {
        visible: parsed.visible,
        followAi: parsed.followAi
      })
    })
  }

  private async run<T>(
    event: OfficeIpcEventLike,
    operation: () => T | Promise<T>
  ): Promise<OfficeIpcResult<T>> {
    try {
      this.assertTrustedRenderer(event)
      return { ok: true, value: await operation() }
    } catch (error) {
      const known = error instanceof OfficeIpcError || error instanceof OfficeSaveIpcError
      return {
        ok: false,
        error: {
          code: known ? error.code : 'unavailable',
          message: known ? error.message : 'Office 实时预览暂不可用'
        }
      }
    }
  }

  private assertTrustedRenderer(event: OfficeIpcEventLike): void {
    const trusted = this.dependencies.getTrustedRenderer()
    if (
      !trusted ||
      event.sender !== trusted ||
      event.sender.isDestroyed() ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      throw new OfficeIpcError('unauthorized', 'Office 预览调用方未获授权')
    }
  }

  private forwardSelection(event: {
    artifactId: string
    sessionId: string
    selection: OfficeSelectionEvent['selection']
  }): void {
    const context = this.dependencies.resolveContext()
    if (!context || context.sessionId !== event.sessionId) return
    try {
      const renderer = this.dependencies.getTrustedRenderer()
      if (!renderer || renderer.isDestroyed()) return
      renderer.send('office:selection', {
        artifactId: event.artifactId,
        selection: event.selection
      } satisfies OfficeSelectionEvent)
    } catch {
      // A closing renderer must not interrupt Office process cleanup.
    }
  }
}

class OfficeIpcError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export function registerOfficeRendererIpc(
  ipcMain: OfficeIpcMainLike,
  coordinator: OfficeIpcCoordinator,
  options: { enabled?: boolean } = {}
): void {
  if (options.enabled === false) return
  coordinator.startSelectionEvents()
  ipcMain.handle('office:create', (event, ...args) =>
    args.length === 1
      ? coordinator.create(event, args[0] as OfficeCreateInput)
      : coordinator.create(event, null)
  )
  ipcMain.handle('office:cancelCreate', (event, ...args) =>
    args.length === 1
      ? coordinator.cancelCreate(event, args[0] as OfficeCancelCreateInput)
      : coordinator.cancelCreate(event, null)
  )
  ipcMain.handle('office:import', (event, ...args) =>
    args.length === 1
      ? coordinator.importFile(event, args[0] as OfficeImportInput)
      : coordinator.importFile(event, null)
  )
  ipcMain.handle('office:cancelImport', (event, ...args) =>
    args.length === 1
      ? coordinator.cancelImport(event, args[0] as OfficeCancelImportInput)
      : coordinator.cancelImport(event, null)
  )
  ipcMain.handle('office:open', (event, ...args) =>
    args.length === 1
      ? coordinator.open(event, args[0] as OfficeOpenInput)
      : coordinator.open(event, null)
  )
  ipcMain.handle('office:close', (event, ...args) =>
    args.length === 1
      ? coordinator.close(event, args[0] as OfficeCloseInput)
      : coordinator.close(event, null)
  )
  ipcMain.handle('office:clearSelection', (event, ...args) =>
    args.length === 1
      ? coordinator.clearSelection(event, args[0] as OfficeClearSelectionInput)
      : coordinator.clearSelection(event, null)
  )
  ipcMain.handle('office:reconcile', (event, ...args) =>
    args.length === 1
      ? coordinator.reconcile(event, args[0] as OfficeReconcileInput)
      : coordinator.reconcile(event, null)
  )
  ipcMain.handle('office:save', (event, ...args) =>
    args.length === 1
      ? coordinator.save(event, args[0] as OfficeSaveInput)
      : coordinator.save(event, null)
  )
  ipcMain.handle('office:saveAs', (event, ...args) =>
    args.length === 1
      ? coordinator.saveAs(event, args[0] as OfficeSaveAsInput)
      : coordinator.saveAs(event, null)
  )
  ipcMain.handle('office:revealOutput', (event, ...args) =>
    args.length === 1
      ? coordinator.revealOutput(event, args[0] as OfficeRevealOutputInput)
      : coordinator.revealOutput(event, null)
  )
  ipcMain.handle('office:resolveOutput', (event, ...args) =>
    args.length === 1
      ? coordinator.resolveOutput(event, args[0] as OfficeRevealOutputInput)
      : coordinator.resolveOutput(event, null)
  )
  ipcMain.handle('office:status', (event, ...args) =>
    args.length === 1
      ? coordinator.status(event, args[0] as OfficeStatusInput)
      : coordinator.status(event, null)
  )
  ipcMain.handle('office:setPreviewPreferences', (event, ...args) =>
    args.length === 1
      ? coordinator.setPreviewPreferences(event, args[0])
      : coordinator.setPreviewPreferences(event, null)
  )
}
