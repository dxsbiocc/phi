import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import type { NotebookDocument, JsonObject } from '../../shared/notebookDocument'
import type {
  AnalysisKernelDiagnostics,
  AnalysisKernelLanguage,
  AnalysisKernelSummary
} from './analysis-kernels'
import type { JupyterServerConnection } from './analysis-jupyter-server'

export type AnalysisNotebookKernelState =
  'missing' | 'idle' | 'busy' | 'restarting' | 'disconnected' | 'error'

export interface AnalysisNotebookSessionStatus {
  projectCwd: string
  notebookPath: string
  kernelName?: string
  kernelDisplayName?: string
  sessionId?: string
  state: AnalysisNotebookKernelState
  message?: string
  startedAt?: string
  updatedAt?: string
}

export interface EnsureNotebookSessionInput {
  projectCwd: string
  notebookPath: string
  document: NotebookDocument
  kernels: AnalysisKernelDiagnostics
}

export type JupyterSessionCreateRequest = {
  projectCwd: string
  notebookPath: string
  notebookRelativePath: string
  notebookName: string
  kernelName: string
}

export type JupyterKernelExecutionState =
  'idle' | 'busy' | 'starting' | 'restarting' | 'dead' | 'unknown' | string

export type JupyterSessionRecord = {
  id: string
  kernelName: string
  executionState: JupyterKernelExecutionState
}

export interface JupyterSessionClient {
  createSession(
    connection: JupyterServerConnection,
    request: JupyterSessionCreateRequest
  ): Promise<JupyterSessionRecord>
  deleteSession(connection: JupyterServerConnection, sessionId: string): Promise<void>
}

type SessionRecord = {
  projectCwd: string
  notebookPath: string
  kernelName: string
  kernelDisplayName: string
  sessionId: string
  state: AnalysisNotebookKernelState
  startedAt: string
  updatedAt: string
  message?: string
}

type RawJupyterSession = {
  id?: unknown
  kernel?: {
    name?: unknown
    execution_state?: unknown
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function jsonObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function normalizeLanguage(language: string | undefined): AnalysisKernelLanguage | null {
  if (!language) return null
  const value = language.toLocaleLowerCase()
  if (value === 'python' || value.startsWith('python')) return 'python'
  if (value === 'r' || value === 'ir') return 'r'
  return 'other'
}

function notebookKernelSpec(document: NotebookDocument): {
  name?: string
  displayName?: string
  language?: AnalysisKernelLanguage | null
} {
  const kernelspec = jsonObject(document.metadata.kernelspec)
  const languageInfo = jsonObject(document.metadata.language_info)
  const rawLanguage =
    stringValue(kernelspec?.language) ?? stringValue(languageInfo?.name) ?? undefined
  return {
    name: stringValue(kernelspec?.name),
    displayName: stringValue(kernelspec?.display_name),
    language: normalizeLanguage(rawLanguage)
  }
}

function selectNotebookKernel(
  document: NotebookDocument,
  kernels: AnalysisKernelDiagnostics
): AnalysisKernelSummary | null {
  const requested = notebookKernelSpec(document)
  if (requested.name) {
    const exact = kernels.kernels.find((kernel) => kernel.name === requested.name)
    if (exact) return exact
  }
  if (requested.displayName) {
    const exactDisplay = kernels.kernels.find(
      (kernel) =>
        kernel.displayName.toLocaleLowerCase() === requested.displayName?.toLocaleLowerCase()
    )
    if (exactDisplay) return exactDisplay
  }
  if (requested.language) {
    return kernels.kernels.find((kernel) => kernel.language === requested.language) ?? null
  }
  if (kernels.preferredKernelName) {
    const preferred = kernels.kernels.find((kernel) => kernel.name === kernels.preferredKernelName)
    if (preferred) return preferred
  }
  return kernels.kernels[0] ?? null
}

function notebookRelativePath(projectCwd: string, notebookPath: string): string {
  const absolutePath = isAbsolute(notebookPath)
    ? resolve(notebookPath)
    : resolve(projectCwd, notebookPath)
  return relative(projectCwd, absolutePath).split(sep).join('/')
}

function sessionState(executionState: JupyterKernelExecutionState): AnalysisNotebookKernelState {
  if (executionState === 'idle') return 'idle'
  if (executionState === 'busy' || executionState === 'starting') return 'busy'
  if (executionState === 'restarting') return 'restarting'
  if (executionState === 'dead') return 'disconnected'
  if (executionState === 'unknown') return 'disconnected'
  return 'idle'
}

function publicStatus(record: SessionRecord): AnalysisNotebookSessionStatus {
  return {
    projectCwd: record.projectCwd,
    notebookPath: record.notebookPath,
    kernelName: record.kernelName,
    kernelDisplayName: record.kernelDisplayName,
    sessionId: record.sessionId,
    state: record.state,
    message: record.message,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt
  }
}

function headers(connection: JupyterServerConnection): Record<string, string> {
  const result: Record<string, string> = { 'content-type': 'application/json' }
  if (connection.token) result.authorization = `token ${connection.token}`
  return result
}

function sessionsUrl(connection: JupyterServerConnection): string {
  return new URL('/api/sessions', connection.url).toString()
}

function parseJupyterSession(
  payload: RawJupyterSession,
  fallbackKernelName: string
): JupyterSessionRecord {
  const id = stringValue(payload.id)
  if (!id) throw new Error('Jupyter Server did not return a session id')
  return {
    id,
    kernelName: stringValue(payload.kernel?.name) ?? fallbackKernelName,
    executionState: stringValue(payload.kernel?.execution_state) ?? 'unknown'
  }
}

export class FetchJupyterSessionClient implements JupyterSessionClient {
  async createSession(
    connection: JupyterServerConnection,
    request: JupyterSessionCreateRequest
  ): Promise<JupyterSessionRecord> {
    const response = await fetch(sessionsUrl(connection), {
      method: 'POST',
      headers: headers(connection),
      body: JSON.stringify({
        path: request.notebookRelativePath,
        type: 'notebook',
        name: request.notebookName,
        kernel: { name: request.kernelName }
      })
    })
    if (!response.ok) {
      throw new Error(`Jupyter session create failed: ${response.status} ${response.statusText}`)
    }
    return parseJupyterSession((await response.json()) as RawJupyterSession, request.kernelName)
  }

  async deleteSession(connection: JupyterServerConnection, sessionId: string): Promise<void> {
    const response = await fetch(new URL(`/api/sessions/${sessionId}`, connection.url).toString(), {
      method: 'DELETE',
      headers: headers(connection)
    })
    if (!response.ok && response.status !== 404) {
      throw new Error(`Jupyter session delete failed: ${response.status} ${response.statusText}`)
    }
  }
}

export class AnalysisNotebookSessionRegistry {
  private readonly records = new Map<string, SessionRecord>()
  private readonly getConnection: (projectCwd: string) => JupyterServerConnection | null
  private readonly client: JupyterSessionClient
  private readonly now: () => Date

  constructor(options: {
    getConnection: (projectCwd: string) => JupyterServerConnection | null
    client?: JupyterSessionClient
    now?: () => Date
  }) {
    this.getConnection = options.getConnection
    this.client = options.client ?? new FetchJupyterSessionClient()
    this.now = options.now ?? (() => new Date())
  }

  status(input: EnsureNotebookSessionInput): AnalysisNotebookSessionStatus {
    const key = this.key(input.projectCwd, input.notebookPath)
    const existing = this.records.get(key)
    if (existing) return publicStatus(existing)
    const kernel = selectNotebookKernel(input.document, input.kernels)
    if (!kernel) return this.missingStatus(input)
    if (!this.getConnection(input.projectCwd)) {
      return {
        projectCwd: input.projectCwd,
        notebookPath: input.notebookPath,
        kernelName: kernel.name,
        kernelDisplayName: kernel.displayName,
        state: 'disconnected',
        message: 'Jupyter Server 尚未就绪'
      }
    }
    return {
      projectCwd: input.projectCwd,
      notebookPath: input.notebookPath,
      kernelName: kernel.name,
      kernelDisplayName: kernel.displayName,
      state: 'disconnected',
      message: 'Notebook 尚未连接 kernel'
    }
  }

  async ensureSession(input: EnsureNotebookSessionInput): Promise<AnalysisNotebookSessionStatus> {
    const kernel = selectNotebookKernel(input.document, input.kernels)
    if (!kernel) return this.missingStatus(input)

    const key = this.key(input.projectCwd, input.notebookPath)
    const existing = this.records.get(key)
    if (existing && existing.kernelName === kernel.name) return publicStatus(existing)

    const connection = this.getConnection(input.projectCwd)
    if (!connection) {
      return {
        projectCwd: input.projectCwd,
        notebookPath: input.notebookPath,
        kernelName: kernel.name,
        kernelDisplayName: kernel.displayName,
        state: 'disconnected',
        message: 'Jupyter Server 尚未就绪'
      }
    }

    try {
      if (existing) {
        await this.client.deleteSession(connection, existing.sessionId)
        this.records.delete(key)
      }
      const created = await this.client.createSession(connection, {
        projectCwd: input.projectCwd,
        notebookPath: input.notebookPath,
        notebookRelativePath: notebookRelativePath(input.projectCwd, input.notebookPath),
        notebookName: basename(input.notebookPath),
        kernelName: kernel.name
      })
      const timestamp = this.now().toISOString()
      const record: SessionRecord = {
        projectCwd: input.projectCwd,
        notebookPath: input.notebookPath,
        kernelName: created.kernelName,
        kernelDisplayName: kernel.displayName,
        sessionId: created.id,
        state: sessionState(created.executionState),
        startedAt: timestamp,
        updatedAt: timestamp,
        message: 'Notebook kernel 已连接'
      }
      this.records.set(key, record)
      return publicStatus(record)
    } catch (error) {
      return {
        projectCwd: input.projectCwd,
        notebookPath: input.notebookPath,
        kernelName: kernel.name,
        kernelDisplayName: kernel.displayName,
        state: 'error',
        message: errorMessage(error),
        updatedAt: this.now().toISOString()
      }
    }
  }

  async closeSession(
    projectCwd: string,
    notebookPath: string
  ): Promise<AnalysisNotebookSessionStatus> {
    const key = this.key(projectCwd, notebookPath)
    const existing = this.records.get(key)
    if (!existing) {
      return {
        projectCwd,
        notebookPath,
        state: 'disconnected',
        message: 'Notebook kernel 未连接'
      }
    }

    const connection = this.getConnection(projectCwd)
    if (connection) {
      try {
        await this.client.deleteSession(connection, existing.sessionId)
      } catch (error) {
        return {
          ...publicStatus(existing),
          state: 'error',
          message: errorMessage(error),
          updatedAt: this.now().toISOString()
        }
      }
    }

    this.records.delete(key)
    return {
      projectCwd,
      notebookPath,
      kernelName: existing.kernelName,
      kernelDisplayName: existing.kernelDisplayName,
      state: 'disconnected',
      message: 'Notebook kernel 已断开',
      updatedAt: this.now().toISOString()
    }
  }

  async closeProject(projectCwd: string): Promise<void> {
    const entries = [...this.records.values()].filter((record) => record.projectCwd === projectCwd)
    await Promise.all(entries.map((record) => this.closeSession(projectCwd, record.notebookPath)))
  }

  private missingStatus(input: EnsureNotebookSessionInput): AnalysisNotebookSessionStatus {
    return {
      projectCwd: input.projectCwd,
      notebookPath: input.notebookPath,
      state: 'missing',
      message: '未找到匹配 notebook metadata 的 kernel'
    }
  }

  private key(projectCwd: string, notebookPath: string): string {
    return `${projectCwd}\0${notebookPath}`
  }
}
