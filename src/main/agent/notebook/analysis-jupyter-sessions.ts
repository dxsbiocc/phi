import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import type { NotebookDocument, JsonObject } from '../../../shared/notebookDocument'
import type {
  AnalysisKernelDiagnostics,
  AnalysisKernelLanguage,
  AnalysisKernelSummary
} from './analysis-kernels'
import type { JupyterServerConnection } from './analysis-jupyter-server'
import {
  jupyterAuthorizationHeader,
  jupyterConnectionIdentity,
  sanitizeJupyterConnectionError,
  type JupyterRuntimeBackend
} from './jupyter-runtime-backend'

export type { JupyterServerConnection } from './analysis-jupyter-server'

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

export interface AnalysisNotebookProjectSummary {
  activeSessionCount: number
  busySessionCount: number
  sessions: AnalysisNotebookSessionStatus[]
}

export interface AnalysisNotebookExecutionTarget {
  connection: JupyterServerConnection
  sessionId: string
  kernelId: string
  kernelName: string
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
  kernelId: string
  kernelName: string
  executionState: JupyterKernelExecutionState
}

/**
 * Prepares a managed kernel whose environment is not built: the build prompt, the build, and
 * the kernelspec. `ready: false` carries the gate's message (declined, failed, not ready).
 */
export type PrepareNotebookKernel = (
  kernel: AnalysisKernelSummary,
  input: EnsureNotebookSessionInput
) => Promise<{ ready: true } | { ready: false; message: string }>

export interface JupyterSessionClient {
  createSession(
    connection: JupyterServerConnection,
    request: JupyterSessionCreateRequest
  ): Promise<JupyterSessionRecord>
  deleteSession(connection: JupyterServerConnection, sessionId: string): Promise<void>
  interruptKernel(connection: JupyterServerConnection, kernelId: string): Promise<void>
}

type SessionRecord = {
  projectCwd: string
  notebookPath: string
  kernelName: string
  kernelDisplayName: string
  sessionId: string
  kernelId: string
  runtimeId: string
  state: AnalysisNotebookKernelState
  startedAt: string
  updatedAt: string
  message?: string
}

type RawJupyterSession = {
  id?: unknown
  kernel?: {
    id?: unknown
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

/**
 * An exact kernelspec name is an explicit choice and may name a host kernel. Every other
 * match (display name, language, preferred, first) considers only non-host kernels, so a host
 * kernel is never picked by default.
 */
export function selectNotebookKernel(
  document: NotebookDocument,
  kernels: AnalysisKernelDiagnostics
): AnalysisKernelSummary | null {
  const requested = notebookKernelSpec(document)
  if (requested.name) {
    const exact = kernels.kernels.find((kernel) => kernel.name === requested.name)
    if (exact) return exact
  }
  const defaults = kernels.kernels.filter((kernel) => kernel.source !== 'host')
  if (requested.displayName) {
    const exactDisplay = defaults.find(
      (kernel) =>
        kernel.displayName.toLocaleLowerCase() === requested.displayName?.toLocaleLowerCase()
    )
    if (exactDisplay) return exactDisplay
  }
  const preferred = kernels.preferredKernelName
    ? defaults.find((kernel) => kernel.name === kernels.preferredKernelName)
    : undefined
  if (requested.language) {
    if (preferred?.language === requested.language) return preferred
    return defaults.find((kernel) => kernel.language === requested.language) ?? null
  }
  if (preferred) return preferred
  return defaults[0] ?? null
}

function notBuiltMessage(kernel: AnalysisKernelSummary): string {
  const ref = kernel.environment?.ref ?? kernel.name
  return `environment ${ref} is not ready; the user must build it first`
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
  const authorization = jupyterAuthorizationHeader(connection)
  if (authorization) result.authorization = authorization
  return result
}

function sessionsUrl(connection: JupyterServerConnection): string {
  return new URL('/api/sessions', connection.url).toString()
}

type XsrfCredentials = { cookie: string; token: string }
export type JupyterFetch = typeof fetch

function responseSetCookies(response: Response): string[] {
  const withGetSetCookie = response.headers as Headers & { getSetCookie?: () => string[] }
  if (typeof withGetSetCookie.getSetCookie === 'function') {
    return withGetSetCookie.getSetCookie()
  }
  const single = response.headers.get('set-cookie')
  return single ? [single] : []
}

async function fetchXsrfCredentials(
  connection: JupyterServerConnection,
  fetchImpl: JupyterFetch
): Promise<XsrfCredentials> {
  // Jupyter Server rejects every state-changing request (session/kernel
  // create & delete) with 403 "'_xsrf' argument missing from POST" unless
  // the request carries a matching _xsrf cookie + header -- Tornado's CSRF
  // protection applies even when ServerApp.token is disabled. A plain GET
  // is what makes the server hand out that cookie in the first place.
  const response = await fetchImpl(new URL('/', connection.url).toString(), {
    method: 'GET',
    headers: headers(connection)
  })
  const xsrfCookie = responseSetCookies(response)
    .map((entry) => entry.split(';')[0]?.trim())
    .find((entry): entry is string => Boolean(entry?.startsWith('_xsrf=')))
  if (!xsrfCookie) {
    throw new Error('无法从 Jupyter Server 获取 _xsrf cookie')
  }
  return { cookie: xsrfCookie, token: xsrfCookie.slice('_xsrf='.length) }
}

function parseJupyterSession(
  payload: RawJupyterSession,
  fallbackKernelName: string
): JupyterSessionRecord {
  const id = stringValue(payload.id)
  if (!id) throw new Error('Jupyter Server did not return a session id')
  return {
    id,
    kernelId: stringValue(payload.kernel?.id) ?? id,
    kernelName: stringValue(payload.kernel?.name) ?? fallbackKernelName,
    executionState: stringValue(payload.kernel?.execution_state) ?? 'unknown'
  }
}

export class FetchJupyterSessionClient implements JupyterSessionClient {
  private readonly xsrfByConnection = new Map<string, Promise<XsrfCredentials>>()

  constructor(private readonly fetchImpl: JupyterFetch = fetch) {}

  private xsrfFor(
    connection: JupyterServerConnection,
    forceRefresh = false
  ): Promise<XsrfCredentials> {
    const identity = jupyterConnectionIdentity(connection)
    if (forceRefresh) {
      this.xsrfByConnection.delete(identity)
    }
    const cached = this.xsrfByConnection.get(identity)
    if (cached) return cached
    const pending = fetchXsrfCredentials(connection, this.fetchImpl).catch((error) => {
      this.xsrfByConnection.delete(identity)
      throw error
    })
    this.xsrfByConnection.set(identity, pending)
    return pending
  }

  private async requestWithXsrf(
    connection: JupyterServerConnection,
    url: string,
    init: { method: string; body?: string }
  ): Promise<Response> {
    const attempt = async (xsrf: XsrfCredentials): Promise<Response> =>
      this.fetchImpl(url, {
        method: init.method,
        headers: {
          ...headers(connection),
          cookie: xsrf.cookie,
          'x-xsrftoken': xsrf.token
        },
        body: init.body
      })

    const response = await attempt(await this.xsrfFor(connection))
    if (response.status !== 403) return response
    // The cached _xsrf token can go stale (e.g. the Jupyter Server process
    // was restarted with a fresh cookie secret) -- refresh once and retry
    // before surfacing a connection failure to the user.
    return attempt(await this.xsrfFor(connection, true))
  }

  async createSession(
    connection: JupyterServerConnection,
    request: JupyterSessionCreateRequest
  ): Promise<JupyterSessionRecord> {
    const response = await this.requestWithXsrf(connection, sessionsUrl(connection), {
      method: 'POST',
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
    const response = await this.requestWithXsrf(
      connection,
      new URL(`/api/sessions/${sessionId}`, connection.url).toString(),
      { method: 'DELETE' }
    )
    if (!response.ok && response.status !== 404) {
      throw new Error(`Jupyter session delete failed: ${response.status} ${response.statusText}`)
    }
  }

  async interruptKernel(connection: JupyterServerConnection, kernelId: string): Promise<void> {
    const response = await this.requestWithXsrf(
      connection,
      new URL(`/api/kernels/${encodeURIComponent(kernelId)}/interrupt`, connection.url).toString(),
      { method: 'POST' }
    )
    if (!response.ok) {
      throw new Error(`Jupyter kernel interrupt failed: ${response.status} ${response.statusText}`)
    }
  }
}

export class AnalysisNotebookSessionRegistry {
  private readonly records = new Map<string, SessionRecord>()
  private readonly pendingEnsures = new Map<string, Promise<AnalysisNotebookSessionStatus>>()
  private readonly getConnection: (projectCwd: string) => JupyterServerConnection | null
  private readonly client: JupyterSessionClient
  private readonly now: () => Date
  private readonly prepareKernel?: PrepareNotebookKernel
  private readonly runtimeBackend?: Pick<
    JupyterRuntimeBackend,
    'claimKernel' | 'releaseKernel' | 'touchActivity'
  >

  constructor(options: {
    getConnection?: (projectCwd: string) => JupyterServerConnection | null
    runtimeBackend?: Pick<
      JupyterRuntimeBackend,
      'connection' | 'claimKernel' | 'releaseKernel' | 'touchActivity'
    >
    client?: JupyterSessionClient
    now?: () => Date
    prepareKernel?: PrepareNotebookKernel
  }) {
    const backendConnection = options.runtimeBackend?.connection.bind(options.runtimeBackend)
    const getConnection = options.getConnection ?? backendConnection
    if (!getConnection) throw new Error('Notebook session registry 缺少 Jupyter runtime backend')
    this.getConnection = getConnection
    this.client = options.client ?? new FetchJupyterSessionClient()
    this.now = options.now ?? (() => new Date())
    this.runtimeBackend = options.runtimeBackend
    if (options.prepareKernel) this.prepareKernel = options.prepareKernel
  }

  status(input: EnsureNotebookSessionInput): AnalysisNotebookSessionStatus {
    const key = this.key(input.projectCwd, input.notebookPath)
    const existing = this.records.get(key)
    const connection = this.getConnection(input.projectCwd)
    if (existing && connection && this.matchesRuntime(existing, connection)) {
      return publicStatus(existing)
    }
    if (existing) this.removeRecord(key, existing)
    const kernel = selectNotebookKernel(input.document, input.kernels)
    if (!kernel) return this.missingStatus(input)
    if (kernel.status === 'not-built') {
      return this.notBuiltStatus(input, kernel, notBuiltMessage(kernel))
    }
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
    const key = this.key(input.projectCwd, input.notebookPath)
    const pending = this.pendingEnsures.get(key)
    if (pending) return pending
    const operation = this.ensureSessionOnce(input, key).finally(() => {
      if (this.pendingEnsures.get(key) === operation) this.pendingEnsures.delete(key)
    })
    this.pendingEnsures.set(key, operation)
    return operation
  }

  private async ensureSessionOnce(
    input: EnsureNotebookSessionInput,
    key: string
  ): Promise<AnalysisNotebookSessionStatus> {
    const kernel = selectNotebookKernel(input.document, input.kernels)
    if (!kernel) return this.missingStatus(input)
    const existing = this.records.get(key)
    const connection = this.getConnection(input.projectCwd)
    const sameRuntime = Boolean(existing && connection && this.matchesRuntime(existing, connection))
    if (
      existing &&
      sameRuntime &&
      existing.kernelName === kernel.name &&
      this.isHealthy(existing.state)
    ) {
      return publicStatus(existing)
    }
    const unavailable = await this.prepareSelectedKernel(input, kernel)
    if (unavailable) return unavailable
    if (!connection) return this.disconnectedStatus(input, kernel)
    return this.replaceSession(input, kernel, key, existing, connection, sameRuntime)
  }

  private async replaceSession(
    input: EnsureNotebookSessionInput,
    kernel: AnalysisKernelSummary,
    key: string,
    existing: SessionRecord | undefined,
    connection: JupyterServerConnection,
    sameRuntime: boolean
  ): Promise<AnalysisNotebookSessionStatus> {
    let claimed = false
    try {
      await this.deleteExistingSession(existing, connection, sameRuntime)
      if (existing) this.removeRecord(key, existing)
      this.runtimeBackend?.claimKernel?.(input.projectCwd, key)
      claimed = true
      const record = await this.createSessionRecord(input, kernel, connection)
      this.records.set(key, record)
      this.runtimeBackend?.touchActivity?.(input.projectCwd)
      return publicStatus(record)
    } catch (error) {
      if (claimed && !this.records.has(key)) {
        this.runtimeBackend?.releaseKernel?.(input.projectCwd, key)
      }
      return this.sessionErrorStatus(input, kernel, connection, error)
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
    if (connection && this.matchesRuntime(existing, connection)) {
      try {
        await this.client.deleteSession(connection, existing.sessionId)
      } catch (error) {
        return {
          ...publicStatus(existing),
          state: 'error',
          message: sanitizeJupyterConnectionError(error, connection),
          updatedAt: this.now().toISOString()
        }
      }
    }

    this.removeRecord(key, existing)
    this.runtimeBackend?.touchActivity?.(projectCwd)
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

  async interruptSession(
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
    if (!connection || !this.matchesRuntime(existing, connection)) {
      this.removeRecord(key, existing)
      existing.state = 'disconnected'
      existing.message = 'Jupyter Server 尚未就绪'
      existing.updatedAt = this.now().toISOString()
      return publicStatus(existing)
    }

    try {
      await this.client.interruptKernel(connection, existing.kernelId)
      this.runtimeBackend?.touchActivity?.(projectCwd)
      existing.state = 'idle'
      existing.message = 'Notebook kernel 停止请求已发送'
      existing.updatedAt = this.now().toISOString()
      return publicStatus(existing)
    } catch (error) {
      existing.state = 'error'
      existing.message = sanitizeJupyterConnectionError(error, connection)
      existing.updatedAt = this.now().toISOString()
      return publicStatus(existing)
    }
  }

  executionTarget(
    projectCwd: string,
    notebookPath: string
  ): AnalysisNotebookExecutionTarget | null {
    const record = this.records.get(this.key(projectCwd, notebookPath))
    const connection = this.getConnection(projectCwd)
    if (!record || !connection) return null
    if (!this.matchesRuntime(record, connection)) {
      this.removeRecord(this.key(projectCwd, notebookPath), record)
      return null
    }
    return {
      connection,
      sessionId: record.sessionId,
      kernelId: record.kernelId,
      kernelName: record.kernelName
    }
  }

  updateSessionState(
    projectCwd: string,
    notebookPath: string,
    state: AnalysisNotebookKernelState,
    message?: string
  ): AnalysisNotebookSessionStatus | null {
    const record = this.records.get(this.key(projectCwd, notebookPath))
    if (!record) return null
    record.state = state
    record.message = message
    record.updatedAt = this.now().toISOString()
    this.runtimeBackend?.touchActivity?.(projectCwd)
    return publicStatus(record)
  }

  projectSummary(projectCwd: string): AnalysisNotebookProjectSummary {
    const sessions = [...this.records.values()]
      .filter((record) => record.projectCwd === projectCwd)
      .map(publicStatus)
    return {
      activeSessionCount: sessions.length,
      busySessionCount: sessions.filter((session) => session.state === 'busy').length,
      sessions
    }
  }

  async closeProject(projectCwd: string): Promise<void> {
    const entries = [...this.records.values()].filter((record) => record.projectCwd === projectCwd)
    await Promise.all(entries.map((record) => this.closeSession(projectCwd, record.notebookPath)))
  }

  private async prepareSelectedKernel(
    input: EnsureNotebookSessionInput,
    kernel: AnalysisKernelSummary
  ): Promise<AnalysisNotebookSessionStatus | undefined> {
    if (kernel.status !== 'not-built') return undefined
    if (!this.prepareKernel) return this.notBuiltStatus(input, kernel, notBuiltMessage(kernel))
    try {
      const prepared = await this.prepareKernel(kernel, input)
      return prepared.ready ? undefined : this.notBuiltStatus(input, kernel, prepared.message)
    } catch (error) {
      return this.notBuiltStatus(input, kernel, errorMessage(error))
    }
  }

  private disconnectedStatus(
    input: EnsureNotebookSessionInput,
    kernel: AnalysisKernelSummary
  ): AnalysisNotebookSessionStatus {
    return {
      projectCwd: input.projectCwd,
      notebookPath: input.notebookPath,
      kernelName: kernel.name,
      kernelDisplayName: kernel.displayName,
      state: 'disconnected',
      message: 'Jupyter Server 尚未就绪'
    }
  }

  private async deleteExistingSession(
    existing: SessionRecord | undefined,
    connection: JupyterServerConnection,
    sameRuntime: boolean
  ): Promise<void> {
    if (!existing || !sameRuntime) return
    try {
      await this.client.deleteSession(connection, existing.sessionId)
    } catch (error) {
      if (this.runtimeBackend?.claimKernel) throw error
      // The old session may already be gone; stale cleanup must not block recreation.
    }
  }

  private async createSessionRecord(
    input: EnsureNotebookSessionInput,
    kernel: AnalysisKernelSummary,
    connection: JupyterServerConnection
  ): Promise<SessionRecord> {
    const created = await this.client.createSession(connection, {
      projectCwd: input.projectCwd,
      notebookPath: input.notebookPath,
      notebookRelativePath: notebookRelativePath(input.projectCwd, input.notebookPath),
      notebookName: basename(input.notebookPath),
      kernelName: kernel.name
    })
    const timestamp = this.now().toISOString()
    return {
      projectCwd: input.projectCwd,
      notebookPath: input.notebookPath,
      kernelName: created.kernelName,
      kernelDisplayName: kernel.displayName,
      sessionId: created.id,
      kernelId: created.kernelId,
      runtimeId: jupyterConnectionIdentity(connection),
      state: sessionState(created.executionState),
      startedAt: timestamp,
      updatedAt: timestamp,
      message: 'Notebook kernel 已连接'
    }
  }

  private sessionErrorStatus(
    input: EnsureNotebookSessionInput,
    kernel: AnalysisKernelSummary,
    connection: JupyterServerConnection,
    error: unknown
  ): AnalysisNotebookSessionStatus {
    return {
      projectCwd: input.projectCwd,
      notebookPath: input.notebookPath,
      kernelName: kernel.name,
      kernelDisplayName: kernel.displayName,
      state: 'error',
      message: sanitizeJupyterConnectionError(error, connection),
      updatedAt: this.now().toISOString()
    }
  }

  private isHealthy(state: AnalysisNotebookKernelState): boolean {
    return state === 'idle' || state === 'busy' || state === 'restarting'
  }

  private matchesRuntime(record: SessionRecord, connection: JupyterServerConnection): boolean {
    return record.runtimeId === jupyterConnectionIdentity(connection)
  }

  private notBuiltStatus(
    input: EnsureNotebookSessionInput,
    kernel: AnalysisKernelSummary,
    message: string
  ): AnalysisNotebookSessionStatus {
    return {
      projectCwd: input.projectCwd,
      notebookPath: input.notebookPath,
      kernelName: kernel.name,
      kernelDisplayName: kernel.displayName,
      state: 'missing',
      message
    }
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

  private removeRecord(key: string, record: SessionRecord): void {
    this.records.delete(key)
    this.runtimeBackend?.releaseKernel?.(record.projectCwd, key)
  }
}
