import type { NotebookDocument } from '../../../shared/notebookDocument'
import { detectConfiguredAnalysisKernels } from '../environment'
import type { Project } from '../projects'
import {
  closeProjectNotebook,
  createProjectNotebook,
  deleteProjectNotebook,
  openProjectNotebook,
  saveProjectNotebook,
  type SaveProjectNotebookInput
} from './analysis-notebook-files'
import type { AnalysisNotebookFileWatcher } from './analysis-notebook-watch'
import type { JupyterKernelCompletionResult } from './analysis-jupyter-execution'
import type { AnalysisNotebookSessionRegistry } from './analysis-jupyter-sessions'
import type { AnalysisNotebookToolExecutor } from './notebook-tool-executor'
import {
  remoteNotebookFileChange,
  type RemoteAnalysisNotebookBackend
} from './remote-analysis-notebook-backend'

export type AnalysisWorkspaceContext = {
  workingDirectory: string
  name: string
  project: Project | null
  remoteSessionId?: string
}

export class AnalysisNotebookOperations {
  constructor(
    private readonly options: {
      remoteNotebookBackend: (project: Project, sessionId: string) => RemoteAnalysisNotebookBackend
      notebookSessionRegistry: AnalysisNotebookSessionRegistry
      notebookToolExecutor: AnalysisNotebookToolExecutor
      notebookFileWatcher: AnalysisNotebookFileWatcher
      notifyAnalysisNotebookFileChanged: (change: unknown) => void
    }
  ) {}

  remoteBackendFor(workspace: AnalysisWorkspaceContext): RemoteAnalysisNotebookBackend | null {
    if (workspace.project?.location?.kind !== 'ssh') return null
    if (!workspace.remoteSessionId) {
      throw new Error('远程 Notebook 会话身份缺失；没有回退到本机执行。')
    }
    return this.options.remoteNotebookBackend(workspace.project, workspace.remoteSessionId)
  }

  sessions(workspace: AnalysisWorkspaceContext): AnalysisNotebookSessionRegistry {
    return this.remoteBackendFor(workspace)?.sessions ?? this.options.notebookSessionRegistry
  }

  kernels(workspace: AnalysisWorkspaceContext): ReturnType<typeof detectConfiguredAnalysisKernels> {
    return this.remoteBackendFor(workspace)?.kernels() ?? detectConfiguredAnalysisKernels()
  }

  async openFile(
    workspace: AnalysisWorkspaceContext,
    notebookPath: string,
    watch = false
  ): Promise<Awaited<ReturnType<RemoteAnalysisNotebookBackend['workspace']['open']>>> {
    const remote = this.remoteBackendFor(workspace)
    if (!remote) {
      return watch
        ? this.options.notebookFileWatcher.watch(workspace.workingDirectory, notebookPath)
        : openProjectNotebook(workspace.workingDirectory, notebookPath)
    }
    return remote.open(
      notebookPath,
      watch
        ? (event) =>
            this.options.notifyAnalysisNotebookFileChanged(
              remoteNotebookFileChange(remote.projectCwd, event)
            )
        : undefined
    )
  }

  syncDraft(
    workspace: AnalysisWorkspaceContext,
    file: Awaited<ReturnType<AnalysisNotebookOperations['openFile']>>,
    document: NotebookDocument = file.document,
    savedRevision: string = file.savedRevision,
    refreshFileBasis = false
  ): ReturnType<AnalysisNotebookToolExecutor['syncDraft']> {
    const tools = this.remoteBackendFor(workspace)?.tools ?? this.options.notebookToolExecutor
    return tools.syncDraft({
      cwd: workspace.workingDirectory,
      path: file.path,
      file,
      document,
      savedRevision,
      refreshFileBasis,
      source: 'renderer'
    })
  }

  async saveFile(
    workspace: AnalysisWorkspaceContext,
    input: SaveProjectNotebookInput
  ): Promise<Awaited<ReturnType<RemoteAnalysisNotebookBackend['save']>>> {
    const remote = this.remoteBackendFor(workspace)
    const file = remote
      ? await remote.save(input)
      : saveProjectNotebook(workspace.workingDirectory, input)
    if (!remote) this.options.notebookFileWatcher.noteLocalWrite(workspace.workingDirectory, file)
    return file
  }

  async createFile(
    workspace: AnalysisWorkspaceContext,
    relativePath?: string
  ): Promise<Awaited<ReturnType<RemoteAnalysisNotebookBackend['workspace']['create']>>> {
    const remote = this.remoteBackendFor(workspace)
    if (!remote) {
      const file = createProjectNotebook(workspace.workingDirectory, relativePath)
      this.options.notebookFileWatcher.watchFile(workspace.workingDirectory, file)
      return file
    }
    const created = await remote.workspace.create(relativePath)
    return remote.open(created.path, (event) =>
      this.options.notifyAnalysisNotebookFileChanged(
        remoteNotebookFileChange(remote.projectCwd, event)
      )
    )
  }

  async closeFile(
    workspace: AnalysisWorkspaceContext,
    notebookPath: string
  ): Promise<{ path: string }> {
    const remote = this.remoteBackendFor(workspace)
    if (remote) return remote.close(notebookPath)
    const file = openProjectNotebook(workspace.workingDirectory, notebookPath)
    await this.options.notebookSessionRegistry.closeSession(workspace.workingDirectory, file.path)
    this.options.notebookFileWatcher.unwatchFile(workspace.workingDirectory, file)
    return closeProjectNotebook(workspace.workingDirectory, notebookPath)
  }

  async deleteFile(
    workspace: AnalysisWorkspaceContext,
    notebookPath: string
  ): Promise<{ path: string; relativePath: string }> {
    const remote = this.remoteBackendFor(workspace)
    if (remote) return remote.delete(notebookPath)
    const file = openProjectNotebook(workspace.workingDirectory, notebookPath)
    await this.options.notebookSessionRegistry.closeSession(workspace.workingDirectory, file.path)
    this.options.notebookFileWatcher.unwatchFile(workspace.workingDirectory, file)
    return deleteProjectNotebook(workspace.workingDirectory, notebookPath)
  }
}

export function emptyNotebookCompletionResult(
  cursorPosition: number,
  message?: string
): JupyterKernelCompletionResult {
  const position = Number.isFinite(cursorPosition) ? Math.max(0, cursorPosition) : 0
  return {
    matches: [],
    cursorStart: position,
    cursorEnd: position,
    metadata: {},
    status: 'error' as const,
    message
  }
}

export function stoppedJupyterStatus(
  projectCwd: string | undefined,
  message?: string
): {
  projectCwd: string
  state: 'stopped'
  hasEndpoint: false
  message?: string
} {
  return {
    projectCwd: projectCwd ?? '',
    state: 'stopped' as const,
    hasEndpoint: false,
    ...(message ? { message } : {})
  }
}

export function emptyAnalysisRuntimeStatus(
  projectCwd: string | undefined,
  message?: string
): {
  server: ReturnType<typeof stoppedJupyterStatus>
  notebooks: {
    activeSessionCount: number
    busySessionCount: number
    sessions: unknown[]
  }
} {
  return {
    server: stoppedJupyterStatus(projectCwd, message),
    notebooks: {
      activeSessionCount: 0,
      busySessionCount: 0,
      sessions: []
    }
  }
}

function notebookDocumentLanguage(document: NotebookDocument): string {
  const kernelspec = document.metadata.kernelspec
  if (kernelspec && typeof kernelspec === 'object' && !Array.isArray(kernelspec)) {
    const spec = kernelspec as Record<string, unknown>
    if (typeof spec.language === 'string') return spec.language
    if (typeof spec.name === 'string') return spec.name
    if (typeof spec.display_name === 'string') return spec.display_name
  }
  return ''
}

export function isPythonNotebookDocument(document: NotebookDocument): boolean {
  return notebookDocumentLanguage(document).toLocaleLowerCase().includes('python')
}
