// Owns registration and request orchestration for the analysis notebook IPC domain.
// Receives live notebook, Jupyter, and generation collaborators from main-process assembly.
// It does not own application lifecycle, window state, or collaborator construction.
import type { IpcMain } from 'electron'
import { IPC } from '../../shared/ipcChannels'
import { errorMessage } from '../../shared/errorCodes'
import { updateNotebookCell, type NotebookDocument } from '../../shared/notebookDocument'
import { notebookCellMetadataWithExecutionDuration } from '../../shared/notebookExecutionMetadata'
import { type SaveProjectNotebookInput } from '../agent/notebook/analysis-notebook-files'
import {
  emptyNotebookRegistry,
  initializeProjectAnalysis,
  listProjectNotebooks
} from '../agent/notebook/analysis-notebooks'
import type { AnalysisNotebookFileWatcher } from '../agent/notebook/analysis-notebook-watch'
import type { JupyterServerRegistry } from '../agent/notebook/analysis-jupyter-server'
import type { AnalysisNotebookExecutor } from '../agent/notebook/analysis-jupyter-execution'
import {
  emptyAnalysisRuntimeStatus,
  emptyNotebookCompletionResult,
  isPythonNotebookDocument,
  stoppedJupyterStatus,
  type AnalysisNotebookOperations,
  type AnalysisWorkspaceContext
} from '../agent/notebook/analysis-notebook-operations'
import {
  completeNotebookPythonStaticCompletion,
  mergeNotebookCompletionResults
} from '../agent/notebook/analysis-notebook-completion'
import { formatNotebookCellSource } from '../agent/notebook/analysis-notebook-formatting'
import type { AnalysisNotebookCodeGenerator } from '../agent/notebook/analysis-notebook-code-generator'
import type { AnalysisNotebookCodeGenerationInput } from '../agent/notebook/notebook-code-generation'
import { detectConfiguredAnalysisKernels } from '../agent/environment'

export interface AnalysisIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  notebooks: {
    resolveWorkspaceByCwd: (cwd?: string) => AnalysisWorkspaceContext | null
    operations: AnalysisNotebookOperations
    activePathByProjectCwd: Map<string, string>
  }
  jupyter: {
    getCurrentCwd: () => string
    isRemoteAnalysisCwd: (cwd: string) => boolean
    serverRegistry: Pick<JupyterServerRegistry, 'status' | 'start' | 'stop'>
    executor: Pick<AnalysisNotebookExecutor, 'completeCode' | 'executeCell'>
    fileWatcher: Pick<AnalysisNotebookFileWatcher, 'unwatchProject'>
    ensureServerReady: (projectCwd: string) => Promise<void>
  }
  generation: Pick<AnalysisNotebookCodeGenerator, 'listJobs' | 'generate'>
}

export function registerAnalysisIpc(options: AnalysisIpcOptions): void {
  registerNotebookOpenIpc(options)
  registerNotebookSaveIpc(options)
  registerNotebookRemovalIpc(options)
  registerJupyterIpc(options)
  registerNotebookSessionIpc(options)
  registerNotebookCompletionIpc(options)
  registerNotebookFormattingIpc(options)
  registerNotebookGenerationIpc(options)
  registerNotebookExecutionIpc(options)
}

function registerNotebookOpenIpc(options: AnalysisIpcOptions): void {
  options.ipcMain.handle(IPC.analysis.listNotebooks, async (_, cwd?: string) => {
    const workspace = options.notebooks.resolveWorkspaceByCwd(cwd)
    if (!workspace) {
      return emptyNotebookRegistry('选择一个项目或当前 workspace 后显示 notebooks')
    }
    const remote = options.notebooks.operations.remoteBackendFor(workspace)
    const registry = remote
      ? await remote.workspace.list()
      : listProjectNotebooks(workspace.workingDirectory)
    return {
      projectCwd: workspace.workingDirectory,
      projectName: workspace.name,
      ...registry
    }
  })
  options.ipcMain.handle(IPC.analysis.initializeProject, async (_, cwd: string) => {
    const workspace = options.notebooks.resolveWorkspaceByCwd(cwd)
    if (!workspace) {
      throw new Error('请选择一个已添加的项目或当前 workspace')
    }
    return (
      options.notebooks.operations.remoteBackendFor(workspace)?.initializeProject() ??
      initializeProjectAnalysis(workspace.workingDirectory)
    )
  })
  options.ipcMain.handle(
    IPC.analysis.refreshNotebook,
    async (_, cwd: string, notebookPath: string) => {
      const workspace = options.notebooks.resolveWorkspaceByCwd(cwd)
      if (!workspace) {
        throw new Error('请选择一个已添加的项目或当前 workspace')
      }
      // Revalidation reads disk without replacing the tool draft or active path.
      return options.notebooks.operations.openFile(workspace, notebookPath, true)
    }
  )
  options.ipcMain.handle(
    IPC.analysis.openNotebook,
    async (_, cwd: string, notebookPath: string) => {
      const workspace = options.notebooks.resolveWorkspaceByCwd(cwd)
      if (!workspace) {
        throw new Error('请选择一个已添加的项目或当前 workspace')
      }
      const file = await options.notebooks.operations.openFile(workspace, notebookPath, true)
      options.notebooks.activePathByProjectCwd.set(workspace.workingDirectory, file.path)
      options.notebooks.operations.syncDraft(
        workspace,
        file,
        file.document,
        file.savedRevision,
        true
      )
      return file
    }
  )
}

function registerNotebookSaveIpc(options: AnalysisIpcOptions): void {
  options.ipcMain.handle(
    IPC.analysis.saveNotebook,
    async (_, cwd: string, input: SaveProjectNotebookInput) => {
      const workspace = options.notebooks.resolveWorkspaceByCwd(cwd)
      if (!workspace) {
        throw new Error('请选择一个已添加的项目或当前 workspace')
      }
      const file = await options.notebooks.operations.saveFile(workspace, input)
      options.notebooks.activePathByProjectCwd.set(workspace.workingDirectory, file.path)
      options.notebooks.operations.syncDraft(
        workspace,
        file,
        file.document,
        file.savedRevision,
        true
      )
      return file
    }
  )
  options.ipcMain.handle(
    IPC.analysis.syncNotebookDraft,
    async (
      _,
      cwd: string,
      notebookPath: string,
      document: NotebookDocument,
      savedRevision?: string
    ) => {
      const workspace = options.notebooks.resolveWorkspaceByCwd(cwd)
      if (!workspace) {
        throw new Error('请选择一个已添加的项目或当前 workspace')
      }
      const file = await options.notebooks.operations.openFile(workspace, notebookPath)
      options.notebooks.activePathByProjectCwd.set(workspace.workingDirectory, file.path)
      return options.notebooks.operations.syncDraft(
        workspace,
        file,
        document,
        savedRevision ?? file.savedRevision
      )
    }
  )
  options.ipcMain.handle(
    IPC.analysis.createNotebook,
    async (_, cwd: string, relativePath?: string) => {
      const workspace = options.notebooks.resolveWorkspaceByCwd(cwd)
      if (!workspace) {
        throw new Error('请选择一个已添加的项目或当前 workspace')
      }
      const file = await options.notebooks.operations.createFile(workspace, relativePath)
      options.notebooks.activePathByProjectCwd.set(workspace.workingDirectory, file.path)
      return file
    }
  )
}

function registerNotebookRemovalIpc(options: AnalysisIpcOptions): void {
  options.ipcMain.handle(
    IPC.analysis.closeNotebook,
    async (_, cwd: string, notebookPath: string) => {
      const workspace = options.notebooks.resolveWorkspaceByCwd(cwd)
      if (!workspace) {
        throw new Error('请选择一个已添加的项目或当前 workspace')
      }
      const closed = await options.notebooks.operations.closeFile(workspace, notebookPath)
      if (
        options.notebooks.activePathByProjectCwd.get(workspace.workingDirectory) === closed.path
      ) {
        options.notebooks.activePathByProjectCwd.delete(workspace.workingDirectory)
      }
      return closed
    }
  )
  options.ipcMain.handle(
    IPC.analysis.deleteNotebook,
    async (_, cwd: string, notebookPath: string) => {
      const workspace = options.notebooks.resolveWorkspaceByCwd(cwd)
      if (!workspace) {
        throw new Error('请选择一个已添加的项目或当前 workspace')
      }
      const deleted = await options.notebooks.operations.deleteFile(workspace, notebookPath)
      if (
        options.notebooks.activePathByProjectCwd.get(workspace.workingDirectory) === deleted.path
      ) {
        options.notebooks.activePathByProjectCwd.delete(workspace.workingDirectory)
      }
      return deleted
    }
  )
}

function registerJupyterIpc(options: AnalysisIpcOptions): void {
  options.ipcMain.handle(IPC.analysis.listKernels, async (_, cwd?: string) => {
    const workspace = options.notebooks.resolveWorkspaceByCwd(cwd)
    if (workspace) return options.notebooks.operations.kernels(workspace)
    const targetCwd = cwd ?? options.jupyter.getCurrentCwd()
    if (options.jupyter.isRemoteAnalysisCwd(targetCwd)) {
      throw new Error('远程 Notebook 会话或后端不可用；没有探测或回退到本机 Jupyter kernel。')
    }
    return detectConfiguredAnalysisKernels()
  })
  options.ipcMain.handle(IPC.analysis.jupyterStatus, async (_, cwd: string) => {
    const workspace = options.notebooks.resolveWorkspaceByCwd(cwd)
    if (!workspace) {
      return stoppedJupyterStatus(cwd, '请选择一个已添加的项目或当前 workspace')
    }
    return (
      options.notebooks.operations.remoteBackendFor(workspace)?.controller.status() ??
      options.jupyter.serverRegistry.status(workspace.workingDirectory)
    )
  })
  options.ipcMain.handle(IPC.analysis.jupyterRuntimeStatus, async (_, cwd: string) => {
    const workspace = options.notebooks.resolveWorkspaceByCwd(cwd)
    if (!workspace) {
      return emptyAnalysisRuntimeStatus(cwd, '请选择一个已添加的项目或当前 workspace')
    }
    const remote = options.notebooks.operations.remoteBackendFor(workspace)
    const sessions = options.notebooks.operations.sessions(workspace)
    return {
      server:
        remote?.controller.status() ??
        options.jupyter.serverRegistry.status(workspace.workingDirectory),
      notebooks: sessions.projectSummary(workspace.workingDirectory)
    }
  })
  options.ipcMain.handle(IPC.analysis.startJupyter, async (_, cwd: string) => {
    const workspace = options.notebooks.resolveWorkspaceByCwd(cwd)
    if (!workspace) {
      throw new Error('请选择一个已添加的项目或当前 workspace')
    }
    return (
      options.notebooks.operations.remoteBackendFor(workspace)?.controller.start() ??
      options.jupyter.serverRegistry.start(workspace.workingDirectory)
    )
  })
  options.ipcMain.handle(
    IPC.analysis.stopJupyter,
    async (_, cwd: string, handlerOptions?: { abandonUnconfirmed?: boolean }) => {
      const workspace = options.notebooks.resolveWorkspaceByCwd(cwd)
      if (!workspace) {
        throw new Error('请选择一个已添加的项目或当前 workspace')
      }
      const remote = options.notebooks.operations.remoteBackendFor(workspace)
      const sessions = options.notebooks.operations.sessions(workspace)
      await sessions.closeProject(workspace.workingDirectory)
      if (remote) {
        const status = await remote.controller.stop({
          abandonUnconfirmed: handlerOptions?.abandonUnconfirmed === true
        })
        await sessions.closeProject(workspace.workingDirectory)
        return status
      }
      options.jupyter.fileWatcher.unwatchProject(workspace.workingDirectory)
      return options.jupyter.serverRegistry.stop(workspace.workingDirectory)
    }
  )
}

function registerNotebookSessionIpc(options: AnalysisIpcOptions): void {
  options.ipcMain.handle(
    IPC.analysis.notebookSessionStatus,
    async (_, cwd: string, notebookPath: string, document: NotebookDocument) => {
      const workspace = options.notebooks.resolveWorkspaceByCwd(cwd)
      if (!workspace) {
        throw new Error('请选择一个已添加的项目或当前 workspace')
      }
      const file = await options.notebooks.operations.openFile(workspace, notebookPath)
      return options.notebooks.operations.sessions(workspace).status({
        projectCwd: workspace.workingDirectory,
        notebookPath: file.path,
        document,
        kernels: options.notebooks.operations.kernels(workspace)
      })
    }
  )
  options.ipcMain.handle(
    IPC.analysis.ensureNotebookSession,
    async (_, cwd: string, notebookPath: string, document: NotebookDocument) => {
      const workspace = options.notebooks.resolveWorkspaceByCwd(cwd)
      if (!workspace) {
        throw new Error('请选择一个已添加的项目或当前 workspace')
      }
      const file = await options.notebooks.operations.openFile(workspace, notebookPath)
      return options.notebooks.operations.sessions(workspace).ensureSession({
        projectCwd: workspace.workingDirectory,
        notebookPath: file.path,
        document,
        kernels: options.notebooks.operations.kernels(workspace)
      })
    }
  )
  options.ipcMain.handle(
    IPC.analysis.closeNotebookSession,
    async (_, cwd: string, notebookPath: string) => {
      const workspace = options.notebooks.resolveWorkspaceByCwd(cwd)
      if (!workspace) {
        throw new Error('请选择一个已添加的项目或当前 workspace')
      }
      const file = await options.notebooks.operations.openFile(workspace, notebookPath)
      return options.notebooks.operations
        .sessions(workspace)
        .closeSession(workspace.workingDirectory, file.path)
    }
  )
  options.ipcMain.handle(
    IPC.analysis.interruptNotebookExecution,
    async (_, cwd: string, notebookPath: string) => {
      const workspace = options.notebooks.resolveWorkspaceByCwd(cwd)
      if (!workspace) {
        throw new Error('请选择一个已添加的项目或当前 workspace')
      }
      const file = await options.notebooks.operations.openFile(workspace, notebookPath)
      return options.notebooks.operations
        .sessions(workspace)
        .interruptSession(workspace.workingDirectory, file.path)
    }
  )
}

function registerNotebookCompletionIpc(options: AnalysisIpcOptions): void {
  options.ipcMain.handle(
    IPC.analysis.completeNotebookCell,
    async (
      _,
      cwd: string,
      input: {
        path: string
        document: NotebookDocument
        cellId: string
        source: string
        cursorPosition: number
      }
    ) => {
      const workspace = options.notebooks.resolveWorkspaceByCwd(cwd)
      if (!workspace) {
        throw new Error('请选择一个已添加的项目或当前 workspace')
      }
      const remote = options.notebooks.operations.remoteBackendFor(workspace)
      const file = await options.notebooks.operations.openFile(workspace, input.path)
      const cell = input.document.cells.find((item) => item.id === input.cellId)
      const cursorPosition = Number.isFinite(input.cursorPosition)
        ? Math.max(0, Math.min(input.cursorPosition, input.source.length))
        : 0
      if (!cell || cell.cellType !== 'code') {
        return emptyNotebookCompletionResult(cursorPosition, 'Notebook cell is not a code cell')
      }

      const staticCompletion =
        !remote && isPythonNotebookDocument(input.document)
          ? completeNotebookPythonStaticCompletion({
              projectCwd: workspace.workingDirectory,
              source: input.source,
              cursorPosition
            })
          : null
      const target = options.notebooks.operations
        .sessions(workspace)
        .executionTarget(workspace.workingDirectory, file.path)
      if (!target) {
        return (
          staticCompletion ??
          emptyNotebookCompletionResult(cursorPosition, 'Notebook kernel is not connected')
        )
      }

      try {
        const kernelCompletion = await options.jupyter.executor.completeCode({
          connection: target.connection,
          sessionId: target.sessionId,
          kernelId: target.kernelId,
          code: input.source,
          cursorPosition
        })
        return mergeNotebookCompletionResults(kernelCompletion, staticCompletion)
      } catch (error) {
        return (
          staticCompletion ?? emptyNotebookCompletionResult(cursorPosition, errorMessage(error))
        )
      }
    }
  )
}

function registerNotebookFormattingIpc(options: AnalysisIpcOptions): void {
  options.ipcMain.handle(
    IPC.analysis.formatNotebookCell,
    async (
      _,
      cwd: string,
      input: {
        path: string
        document: NotebookDocument
        cellId: string
        source: string
        language?: string
        lineLength?: number
      }
    ) => {
      const workspace = options.notebooks.resolveWorkspaceByCwd(cwd)
      if (!workspace) {
        throw new Error('请选择一个已添加的项目或当前 workspace')
      }
      await options.notebooks.operations.openFile(workspace, input.path)
      const cell = input.document.cells.find((item) => item.id === input.cellId)
      if (!cell || cell.cellType !== 'code') {
        return {
          source: input.source,
          changed: false,
          formatter: 'none' as const,
          message: 'Notebook cell is not a code cell'
        }
      }

      if (options.notebooks.operations.remoteBackendFor(workspace)) {
        throw new Error(
          '远程 Notebook 暂不支持桌面端本机 formatter；请在登录节点环境中格式化。没有回退到本机执行。'
        )
      }

      return formatNotebookCellSource({
        projectCwd: workspace.workingDirectory,
        source: input.source,
        language: input.language,
        lineLength: input.lineLength
      })
    }
  )
}

function registerNotebookGenerationIpc(options: AnalysisIpcOptions): void {
  options.ipcMain.handle(IPC.analysis.listNotebookAiGenerationJobs, () =>
    options.generation.listJobs()
  )
  options.ipcMain.handle(
    IPC.analysis.generateNotebookCode,
    async (
      event,
      cwd: string,
      notebookPath: string,
      document: NotebookDocument,
      input: AnalysisNotebookCodeGenerationInput
    ) =>
      options.generation.generate(cwd, notebookPath, document, input, (progress) => {
        event.sender.send(IPC.analysis.notebookCodeGenerationProgress, progress)
      })
  )
}

function registerNotebookExecutionIpc(options: AnalysisIpcOptions): void {
  options.ipcMain.handle(
    IPC.analysis.executeNotebookCell,
    async (_, cwd: string, notebookPath: string, document: NotebookDocument, cellId: string) => {
      const workspace = options.notebooks.resolveWorkspaceByCwd(cwd)
      if (!workspace) {
        throw new Error('请选择一个已添加的项目或当前 workspace')
      }
      const remote = options.notebooks.operations.remoteBackendFor(workspace)
      const file = await options.notebooks.operations.openFile(workspace, notebookPath)
      const kernels = options.notebooks.operations.kernels(workspace)
      const sessions = options.notebooks.operations.sessions(workspace)
      let sessionStatus = await sessions.ensureSession({
        projectCwd: workspace.workingDirectory,
        notebookPath: file.path,
        document,
        kernels
      })
      let target = sessions.executionTarget(workspace.workingDirectory, file.path)
      if (!target) {
        if (remote) remote.controller.requireReady()
        else await options.jupyter.ensureServerReady(workspace.workingDirectory)
        sessionStatus = await sessions.ensureSession({
          projectCwd: workspace.workingDirectory,
          notebookPath: file.path,
          document,
          kernels
        })
        target = sessions.executionTarget(workspace.workingDirectory, file.path)
      }
      if (!target) {
        throw new Error(sessionStatus.message ?? '请先连接 notebook kernel')
      }

      const cell = document.cells.find((item) => item.id === cellId)
      if (!cell) {
        throw new Error(`Notebook cell not found: ${cellId}`)
      }

      sessions.updateSessionState(
        workspace.workingDirectory,
        file.path,
        'busy',
        'Notebook kernel 正在执行'
      )
      try {
        const execution = await options.jupyter.executor.executeCell({
          connection: target.connection,
          sessionId: target.sessionId,
          kernelId: target.kernelId,
          cell
        })
        const nextDocument = updateNotebookCell(document, cellId, {
          executionCount: execution.executionCount,
          outputs: execution.outputs,
          metadata: notebookCellMetadataWithExecutionDuration(cell.metadata, execution)
        })
        options.notebooks.operations.syncDraft(workspace, file, nextDocument)
        const nextSessionStatus =
          sessions.updateSessionState(
            workspace.workingDirectory,
            file.path,
            'idle',
            execution.state === 'error' ? 'Cell 执行出错，kernel 仍可继续使用' : 'Cell 执行完成'
          ) ?? sessionStatus
        return {
          ...execution,
          document: nextDocument,
          sessionStatus: nextSessionStatus
        }
      } catch (error) {
        sessions.updateSessionState(
          workspace.workingDirectory,
          file.path,
          'error',
          errorMessage(error)
        )
        throw error
      }
    }
  )
}
