import {
  deleteNotebookCell,
  insertNotebookCell,
  updateNotebookCell,
  type JsonObject,
  type NotebookCell,
  type NotebookCellType,
  type NotebookDocument
} from '../../../shared/notebookDocument'
import { detectConfiguredAnalysisKernels } from '../environment/index'
import { AnalysisNotebookExecutor } from './analysis-jupyter-execution'
import { AnalysisNotebookSessionRegistry } from './analysis-jupyter-sessions'
import { openProjectNotebook, type AnalysisNotebookFile } from './analysis-notebook-files'
import { createLocalNotebookWorkspace, type NotebookWorkspace } from './notebook-workspace'
import type { NotebookToolRequest } from './notebook-tools'

type NotebookWorkspaceRef = {
  workingDirectory: string
  name?: string
}

type NotebookWorkspaceState = {
  file: AnalysisNotebookFile
  document: NotebookDocument
  savedRevision: string
}

type NotebookExecution = Awaited<ReturnType<AnalysisNotebookExecutor['executeCell']>>
type NotebookExecutionTarget = NonNullable<
  ReturnType<AnalysisNotebookSessionRegistry['executionTarget']>
>
type NotebookSessionStatus = Awaited<ReturnType<AnalysisNotebookSessionRegistry['ensureSession']>>

export type NotebookDraftChangeSource = 'agent' | 'renderer'

export type NotebookDraftChange = {
  source: NotebookDraftChangeSource
  projectCwd: string
  path: string
  relativePath: string
  document: NotebookDocument
  savedRevision: string
  contentHash?: string
  changeKind?: 'synced' | 'inserted' | 'updated' | 'deleted' | 'executed' | 'saved'
  changedCellId?: string
  focusCellId?: string
}

type NotebookDraftChangeMetadata = Pick<
  NotebookDraftChange,
  'changeKind' | 'changedCellId' | 'focusCellId'
>

type NotebookToolResult = {
  summary: string
  kind: string
  [key: string]: unknown
}

type ConstructorOptions = {
  resolveWorkspaceByCwd: (cwd: string) => NotebookWorkspaceRef | null | undefined
  resolveNotebookWorkspaceByCwd?: (cwd: string) => NotebookWorkspace | null | undefined
  resolveKernelsByCwd?: (cwd: string) => ReturnType<typeof detectConfiguredAnalysisKernels>
  ensureJupyterServerReady: (projectCwd: string) => Promise<void>
  notebookSessionRegistry: AnalysisNotebookSessionRegistry
  notebookExecutor: AnalysisNotebookExecutor
  onDraftChanged?: (change: NotebookDraftChange) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim()) return value
  throw new Error(`缺少必填参数: ${name}`)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function optionalIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined
}

function optionalCellNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('cellNumber 必须是从 1 开始的数字')
  }
  const cellNumber = Math.trunc(value)
  if (cellNumber < 1) {
    throw new Error('cellNumber 必须从 1 开始')
  }
  return cellNumber
}

function cellTypeValue(value: unknown): NotebookCellType {
  if (value === 'markdown' || value === 'raw' || value === 'code') return value
  return 'code'
}

function truncate(value: string, maxLength = 1200): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 1)}…`
}

function outputSummary(cell: NotebookCell): string[] {
  return cell.outputs
    .map((output) => {
      if (output.outputType === 'stream') return truncate(output.text ?? '', 600)
      if (output.outputType === 'error') {
        return truncate(`${output.ename ?? 'Error'}: ${output.evalue ?? ''}`, 600)
      }
      const data = output.data['text/plain']
      if (typeof data === 'string') return truncate(data, 600)
      if (Array.isArray(data))
        return truncate(data.filter((item) => typeof item === 'string').join(''), 600)
      return output.outputType
    })
    .filter((text) => text.length > 0)
}

function cellNumberForIndex(index: number): number {
  return index + 1
}

function cellLabel(index: number): string {
  return `Cell ${cellNumberForIndex(index)}`
}

function summarizeCell(
  cell: NotebookCell,
  index: number,
  includeOutputs: boolean
): Record<string, unknown> {
  return {
    cellNumber: cellNumberForIndex(index),
    id: cell.id,
    cellType: cell.cellType,
    executionCount: cell.executionCount,
    source: cell.source,
    ...(includeOutputs ? { outputs: outputSummary(cell) } : {})
  }
}

function notebookCellMetadataWithExecutionDuration(
  metadata: JsonObject,
  execution: { startedAt: string; completedAt: string }
): JsonObject {
  const startedAt = Date.parse(execution.startedAt)
  const completedAt = Date.parse(execution.completedAt)
  const durationMs =
    Number.isFinite(startedAt) && Number.isFinite(completedAt)
      ? Math.max(0, completedAt - startedAt)
      : 0
  const phiMetadata =
    metadata.phi && typeof metadata.phi === 'object' && !Array.isArray(metadata.phi)
      ? (metadata.phi as JsonObject)
      : {}
  return {
    ...metadata,
    phi: {
      ...phiMetadata,
      executionStartedAt: execution.startedAt,
      executionCompletedAt: execution.completedAt,
      executionDurationMs: durationMs
    }
  }
}

export class AnalysisNotebookToolExecutor {
  private readonly resolveWorkspaceByCwd: ConstructorOptions['resolveWorkspaceByCwd']
  private readonly resolveNotebookWorkspaceByCwd?: ConstructorOptions['resolveNotebookWorkspaceByCwd']
  private readonly resolveKernelsByCwd: NonNullable<ConstructorOptions['resolveKernelsByCwd']>
  private readonly ensureJupyterServerReady: ConstructorOptions['ensureJupyterServerReady']
  private readonly notebookSessionRegistry: AnalysisNotebookSessionRegistry
  private readonly notebookExecutor: AnalysisNotebookExecutor
  private readonly onDraftChanged?: ConstructorOptions['onDraftChanged']
  private readonly states = new Map<string, NotebookWorkspaceState>()
  private readonly aliases = new Map<string, string>()
  private readonly localWorkspaces = new Map<string, NotebookWorkspace>()

  constructor(options: ConstructorOptions) {
    this.resolveWorkspaceByCwd = options.resolveWorkspaceByCwd
    this.resolveNotebookWorkspaceByCwd = options.resolveNotebookWorkspaceByCwd
    this.resolveKernelsByCwd = options.resolveKernelsByCwd ?? detectConfiguredAnalysisKernels
    this.ensureJupyterServerReady = options.ensureJupyterServerReady
    this.notebookSessionRegistry = options.notebookSessionRegistry
    this.notebookExecutor = options.notebookExecutor
    this.onDraftChanged = options.onDraftChanged
  }

  async execute(request: NotebookToolRequest): Promise<NotebookToolResult> {
    const project = this.workspaceForCwd(request.cwd)
    const params = isRecord(request.params) ? request.params : {}
    switch (request.action) {
      case 'list':
        return this.list(project)
      case 'read':
        return this.read(project, params)
      case 'insert_cell':
        return this.insertCell(project, params)
      case 'update_cell':
        return this.updateCell(project, params)
      case 'delete_cell':
        return this.deleteCell(project, params)
      case 'run_cell':
        return this.runCell(project, params)
      case 'save':
        return this.save(project, params)
      default:
        return assertNever(request.action)
    }
  }

  syncDraft(input: {
    cwd: string
    path: string
    file?: AnalysisNotebookFile
    document: NotebookDocument
    savedRevision?: string
    refreshFileBasis?: boolean
    source?: NotebookDraftChangeSource
  }): NotebookDraftChange {
    const project = this.workspaceForCwd(input.cwd)
    const existing = this.existingStateFor(project, input.path)
    const state =
      existing ??
      (input.file
        ? this.storeState(project, input.path, input.file)
        : this.localStateForSync(project, input.path))
    if (input.file && input.refreshFileBasis) state.file = input.file
    state.document = input.document
    if (input.savedRevision) state.savedRevision = input.savedRevision
    return this.emitDraftChanged(project, state, input.source ?? 'renderer', {
      changeKind: 'synced'
    })
  }

  private workspaceForCwd(cwd: string): NotebookWorkspaceRef {
    const workspace = this.resolveWorkspaceByCwd(cwd)
    if (!workspace) throw new Error('请选择一个已添加的项目或当前 workspace')
    return workspace
  }

  private aliasKey(projectCwd: string, notebookPath: string): string {
    return `${projectCwd}\0${notebookPath}`
  }

  private stateKey(projectCwd: string, notebookPath: string): string {
    return `${projectCwd}\0${notebookPath}`
  }

  private existingStateFor(
    project: NotebookWorkspaceRef,
    notebookPath: string
  ): NotebookWorkspaceState | undefined {
    const alias = this.aliases.get(this.aliasKey(project.workingDirectory, notebookPath))
    if (alias) {
      const existing = this.states.get(alias)
      if (existing) return existing
    }
    return undefined
  }

  private storeState(
    project: NotebookWorkspaceRef,
    notebookPath: string,
    file: AnalysisNotebookFile
  ): NotebookWorkspaceState {
    const key = this.stateKey(project.workingDirectory, file.path)
    const existing = this.states.get(key)
    if (existing) {
      this.aliases.set(this.aliasKey(project.workingDirectory, notebookPath), key)
      return existing
    }
    const state = { file, document: file.document, savedRevision: file.savedRevision }
    this.states.set(key, state)
    for (const alias of [notebookPath, file.path, file.relativePath]) {
      this.aliases.set(this.aliasKey(project.workingDirectory, alias), key)
    }
    return state
  }

  private async stateFor(
    project: NotebookWorkspaceRef,
    notebookPath: string
  ): Promise<NotebookWorkspaceState> {
    const existing = this.existingStateFor(project, notebookPath)
    if (existing) return existing
    const file = await this.notebookWorkspace(project).open(notebookPath)
    return this.storeState(project, notebookPath, file)
  }

  private localStateForSync(
    project: NotebookWorkspaceRef,
    notebookPath: string
  ): NotebookWorkspaceState {
    const existing = this.existingStateFor(project, notebookPath)
    if (existing) return existing
    if (this.resolveNotebookWorkspaceByCwd?.(project.workingDirectory)) {
      throw new Error('请先打开 notebook 后再同步草稿')
    }
    const file = openProjectNotebook(project.workingDirectory, notebookPath)
    return this.storeState(project, notebookPath, file)
  }

  private notebookWorkspace(project: NotebookWorkspaceRef): NotebookWorkspace {
    const injected = this.resolveNotebookWorkspaceByCwd?.(project.workingDirectory)
    if (injected) return injected
    let workspace = this.localWorkspaces.get(project.workingDirectory)
    if (!workspace) {
      workspace = createLocalNotebookWorkspace(project.workingDirectory)
      this.localWorkspaces.set(project.workingDirectory, workspace)
    }
    return workspace
  }

  private async list(project: NotebookWorkspaceRef): Promise<NotebookToolResult> {
    const registry = await this.notebookWorkspace(project).list()
    return {
      kind: 'notebook_list',
      summary:
        registry.notebooks.length > 0
          ? `找到 ${registry.notebooks.length} 个 notebook。`
          : '当前项目没有找到 .ipynb notebook。',
      projectCwd: project.workingDirectory,
      truncated: registry.truncated,
      notebooks: registry.notebooks.map((notebook) => ({
        path: notebook.path,
        relativePath: notebook.relativePath,
        name: notebook.name,
        modifiedAt: notebook.modifiedAt
      }))
    }
  }

  private async read(
    project: NotebookWorkspaceRef,
    params: Record<string, unknown>
  ): Promise<NotebookToolResult> {
    const state = await this.stateFor(project, stringValue(params.path, 'path'))
    const includeOutputs = optionalBoolean(params.includeOutputs, true)
    return {
      kind: 'notebook_document',
      summary: `${state.file.relativePath}: ${state.document.cells.length} 个 cell，当前草稿 revision ${state.document.revision}。`,
      path: state.file.path,
      relativePath: state.file.relativePath,
      revision: state.document.revision,
      savedRevision: state.savedRevision,
      cells: state.document.cells.map((cell, index) => summarizeCell(cell, index, includeOutputs))
    }
  }

  private async insertCell(
    project: NotebookWorkspaceRef,
    params: Record<string, unknown>
  ): Promise<NotebookToolResult> {
    const state = await this.stateFor(project, stringValue(params.path, 'path'))
    const beforeCellId = optionalString(params.beforeCellId)
    const afterCellId = optionalString(params.afterCellId)
    const cellNumber = optionalCellNumber(params.cellNumber)
    let index =
      cellNumber !== undefined
        ? cellNumber - 1
        : (optionalIndex(params.index) ?? state.document.cells.length)
    if (beforeCellId) {
      index = state.document.cells.findIndex((cell) => cell.id === beforeCellId)
      if (index < 0) throw new Error(`Notebook cell not found: ${beforeCellId}`)
    } else if (afterCellId) {
      index = state.document.cells.findIndex((cell) => cell.id === afterCellId)
      if (index < 0) throw new Error(`Notebook cell not found: ${afterCellId}`)
      index += 1
    }

    const boundedIndex = Math.max(0, Math.min(index, state.document.cells.length))
    state.document = insertNotebookCell(state.document, index, {
      cellType: cellTypeValue(params.cellType),
      source: stringValue(params.source, 'source')
    })
    const cell = state.document.cells[boundedIndex]
    this.emitDraftChanged(project, state, 'agent', {
      changeKind: 'inserted',
      changedCellId: cell.id,
      focusCellId: cell.id
    })
    return {
      kind: 'notebook_cell_inserted',
      summary: `已在 ${state.file.relativePath} 插入 ${cell.cellType} ${cellLabel(boundedIndex)}。`,
      path: state.file.path,
      relativePath: state.file.relativePath,
      revision: state.document.revision,
      cellNumber: cellNumberForIndex(boundedIndex),
      cell: summarizeCell(cell, boundedIndex, false)
    }
  }

  private async updateCell(
    project: NotebookWorkspaceRef,
    params: Record<string, unknown>
  ): Promise<NotebookToolResult> {
    const state = await this.stateFor(project, stringValue(params.path, 'path'))
    const cellId = stringValue(params.cellId, 'cellId')
    const patch: Parameters<typeof updateNotebookCell>[2] = {
      source: stringValue(params.source, 'source')
    }
    if (params.cellType !== undefined) patch.cellType = cellTypeValue(params.cellType)
    state.document = updateNotebookCell(state.document, cellId, patch)
    const cell = state.document.cells.find((item) => item.id === cellId)
    const cellIndex = cell ? state.document.cells.indexOf(cell) : -1
    this.emitDraftChanged(project, state, 'agent', {
      changeKind: 'updated',
      changedCellId: cellId,
      focusCellId: cell?.id
    })
    return {
      kind: 'notebook_cell_updated',
      summary: `已更新 ${state.file.relativePath} 的 ${
        cellIndex >= 0 ? cellLabel(cellIndex) : `cell: ${cellId}`
      }。`,
      path: state.file.path,
      relativePath: state.file.relativePath,
      revision: state.document.revision,
      ...(cellIndex >= 0 ? { cellNumber: cellNumberForIndex(cellIndex) } : {}),
      cell: cell && cellIndex >= 0 ? summarizeCell(cell, cellIndex, false) : undefined
    }
  }

  private async deleteCell(
    project: NotebookWorkspaceRef,
    params: Record<string, unknown>
  ): Promise<NotebookToolResult> {
    const state = await this.stateFor(project, stringValue(params.path, 'path'))
    const cellId = stringValue(params.cellId, 'cellId')
    const cellIndex = state.document.cells.findIndex((item) => item.id === cellId)
    if (cellIndex < 0) throw new Error(`Notebook cell not found: ${cellId}`)
    state.document = deleteNotebookCell(state.document, cellId)
    this.emitDraftChanged(project, state, 'agent', {
      changeKind: 'deleted',
      changedCellId: cellId
    })
    return {
      kind: 'notebook_cell_deleted',
      summary: `已删除 ${state.file.relativePath} 的 ${cellLabel(cellIndex)}。`,
      path: state.file.path,
      relativePath: state.file.relativePath,
      revision: state.document.revision,
      cellNumber: cellNumberForIndex(cellIndex),
      cellId
    }
  }

  private async runCell(
    project: NotebookWorkspaceRef,
    params: Record<string, unknown>
  ): Promise<NotebookToolResult> {
    const state = await this.stateFor(project, stringValue(params.path, 'path'))
    const cellId = stringValue(params.cellId, 'cellId')
    const cell = state.document.cells.find((item) => item.id === cellId)
    if (!cell) throw new Error(`Notebook cell not found: ${cellId}`)
    if (cell.cellType !== 'code') throw new Error('只能运行 code cell')

    const { sessionStatus, target } = await this.resolveExecutionTarget(project, state)
    this.notebookSessionRegistry.updateSessionState(
      project.workingDirectory,
      state.file.path,
      'busy',
      'Notebook kernel 正在执行'
    )
    try {
      return await this.executeCodeCell(project, state, cellId, cell, target, sessionStatus)
    } catch (error) {
      this.notebookSessionRegistry.updateSessionState(
        project.workingDirectory,
        state.file.path,
        'error',
        error instanceof Error ? error.message : String(error)
      )
      throw error
    }
  }

  private async resolveExecutionTarget(
    project: NotebookWorkspaceRef,
    state: NotebookWorkspaceState
  ): Promise<{ sessionStatus: NotebookSessionStatus; target: NotebookExecutionTarget }> {
    const kernels = this.resolveKernelsByCwd(project.workingDirectory)
    let sessionStatus = await this.notebookSessionRegistry.ensureSession({
      projectCwd: project.workingDirectory,
      notebookPath: state.file.path,
      document: state.document,
      kernels
    })
    let target = this.notebookSessionRegistry.executionTarget(
      project.workingDirectory,
      state.file.path
    )
    if (!target) {
      await this.ensureJupyterServerReady(project.workingDirectory)
      sessionStatus = await this.notebookSessionRegistry.ensureSession({
        projectCwd: project.workingDirectory,
        notebookPath: state.file.path,
        document: state.document,
        kernels
      })
      target = this.notebookSessionRegistry.executionTarget(
        project.workingDirectory,
        state.file.path
      )
    }
    if (!target) throw new Error(sessionStatus.message ?? '请先连接 notebook kernel')
    return { sessionStatus, target }
  }

  private async executeCodeCell(
    project: NotebookWorkspaceRef,
    state: NotebookWorkspaceState,
    cellId: string,
    cell: NotebookCell,
    target: NotebookExecutionTarget,
    sessionStatus: NotebookSessionStatus
  ): Promise<NotebookToolResult> {
    const execution = await this.notebookExecutor.executeCell({
      connection: target.connection,
      sessionId: target.sessionId,
      kernelId: target.kernelId,
      cell
    })
    state.document = updateNotebookCell(state.document, cellId, {
      executionCount: execution.executionCount,
      outputs: execution.outputs,
      metadata: notebookCellMetadataWithExecutionDuration(cell.metadata, execution)
    })
    this.emitDraftChanged(project, state, 'agent', {
      changeKind: 'executed',
      changedCellId: cellId,
      focusCellId: cellId
    })
    return this.executedCellResult(project, state, cellId, cell, execution, sessionStatus)
  }

  private executedCellResult(
    project: NotebookWorkspaceRef,
    state: NotebookWorkspaceState,
    cellId: string,
    fallbackCell: NotebookCell,
    execution: NotebookExecution,
    sessionStatus: NotebookSessionStatus
  ): NotebookToolResult {
    const nextStatus =
      this.notebookSessionRegistry.updateSessionState(
        project.workingDirectory,
        state.file.path,
        execution.state === 'error' ? 'error' : 'idle',
        execution.state === 'error' ? 'Cell 执行出错' : 'Cell 执行完成'
      ) ?? sessionStatus
    const cell = state.document.cells.find((item) => item.id === cellId) ?? fallbackCell
    const index = state.document.cells.indexOf(cell)
    return {
      kind: 'notebook_cell_executed',
      summary: `已运行 ${state.file.relativePath} 的 ${
        index >= 0 ? cellLabel(index) : `cell: ${cellId}`
      }，状态 ${execution.state}。`,
      path: state.file.path,
      relativePath: state.file.relativePath,
      revision: state.document.revision,
      cellId,
      ...(index >= 0
        ? { cellNumber: cellNumberForIndex(index), cell: summarizeCell(cell, index, false) }
        : {}),
      execution: {
        state: execution.state,
        executionCount: execution.executionCount,
        startedAt: execution.startedAt,
        completedAt: execution.completedAt,
        outputs: outputSummary(cell)
      },
      sessionStatus: nextStatus
    }
  }

  private async save(
    project: NotebookWorkspaceRef,
    params: Record<string, unknown>
  ): Promise<NotebookToolResult> {
    const state = await this.stateFor(project, stringValue(params.path, 'path'))
    const saved = await this.notebookWorkspace(project).save({
      path: state.file.path,
      document: state.document,
      expectedRevision: state.savedRevision,
      ...(state.file.contentHash ? { expectedHash: state.file.contentHash } : {})
    })
    state.file = saved
    state.document = saved.document
    state.savedRevision = saved.savedRevision
    this.emitDraftChanged(project, state, 'agent', { changeKind: 'saved' })
    return {
      kind: 'notebook_saved',
      summary: `已保存 ${saved.relativePath}。`,
      path: saved.path,
      relativePath: saved.relativePath,
      revision: saved.document.revision,
      savedRevision: saved.savedRevision
    }
  }

  private emitDraftChanged(
    project: NotebookWorkspaceRef,
    state: NotebookWorkspaceState,
    source: NotebookDraftChangeSource,
    metadata: NotebookDraftChangeMetadata = {}
  ): NotebookDraftChange {
    const change: NotebookDraftChange = {
      source,
      projectCwd: project.workingDirectory,
      path: state.file.path,
      relativePath: state.file.relativePath,
      document: state.document,
      savedRevision: state.savedRevision,
      ...(state.file.contentHash ? { contentHash: state.file.contentHash } : {}),
      ...metadata
    }
    this.onDraftChanged?.(change)
    return change
  }
}

function assertNever(action: never): never {
  throw new Error(`Unknown notebook tool action: ${action}`)
}
