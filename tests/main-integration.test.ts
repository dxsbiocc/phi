import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import { formatDiagnostics } from '../src/main/agent/diagnostics'
import * as notebookCodeGeneration from '../src/main/agent/notebook/notebook-code-generation'
import * as lifecycle from '../src/main/agent/session/session-lifecycle'
import * as notebookDocument from '../src/shared/notebookDocument'
import * as sessionTitle from '../src/shared/sessionTitle'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

type PromptOptions = {
  preflightResult?: (accepted: boolean) => void
  expandPromptTemplates?: boolean
  synthetic?: boolean
  userInitiated?: boolean
  skipCompactionCheck?: boolean
}
class FakeSession {
  readonly messages: unknown[] = []
  readonly listeners: Array<(event: unknown) => void> = []
  readonly log: string[] = []
  readonly promptTexts: string[] = []
  readonly promptOptions: PromptOptions[] = []
  model?: { provider: string; id: string }
  thinkingLevel?: string
  preflight = Promise.resolve()
  abortGate = Promise.resolve()
  readonly finish = deferred<void>()
  toolEvents: unknown[] = []
  hold = false
  started = false
  disposed = false
  skipFinalAssistantMessage = false
  promptError?: Error
  materializedSessionFile?: string
  constructor(public sessionFile: string | undefined) {}
  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.push(listener)
    return () => undefined
  }
  async prompt(text: string, options?: PromptOptions): Promise<void> {
    this.promptTexts.push(text)
    this.promptOptions.push(options ?? {})
    await this.preflight
    options?.preflightResult?.(true)
    this.started = true
    this.log.push('started')
    for (const event of this.toolEvents) {
      this.listeners.forEach((listener) => listener(event))
    }
    this.sessionFile ??= this.materializedSessionFile
    if (this.promptError) throw this.promptError
    if (this.hold) await this.finish.promise
    if (!this.skipFinalAssistantMessage) {
      this.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'done' }] })
    }
    this.log.push('saved')
  }
  async abort(): Promise<void> {
    this.log.push('abort')
    await this.abortGate
    if (this.started) this.finish.resolve()
  }
  dispose(): void {
    this.log.push('dispose')
    this.disposed = true
  }
  async setModel(model: { provider: string; id: string }): Promise<void> {
    this.model = model
  }
  setThinkingLevel(level: string): void {
    this.thinkingLevel = level
  }
}

type Handler = (_event: unknown, ...args: unknown[]) => unknown
async function harness(factory?: (cwd: string, file: string) => Promise<FakeSession>): Promise<{
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  sessions: FakeSession[]
  deleted: string[]
  events: Array<{ channel: string; data: unknown }>
  approvalOptions: Array<Record<string, unknown>>
  runnerEvents: Array<Record<string, unknown>>
  createdPhiSessions: Array<Record<string, unknown>>
  createdAgentOptions: Array<Record<string, unknown>>
  resourceLoaderOptions: Array<Record<string, unknown>>
  updatedProjectDefaults: Array<Record<string, unknown>>
  updatedSessionManifests: Array<{ sessionId: string; patch: Record<string, unknown> }>
  appendedSessionEvents: Array<Record<string, unknown>>
  persistedToolOutputs: Array<Record<string, unknown>>
  revealedPaths: string[]
  openedPaths: string[]
  previewReadRequests: Array<{ filePath: string; length: number }>
  appLogs: Array<Record<string, unknown>>
  acknowledgedSessions: Array<{ file: string; cwd: string }>
  jupyterServerCalls: Array<{ action: string; cwd: string }>
  notebookSessionCalls: Array<{ action: string; cwd: string; path?: string }>
  notebookExecutionCalls: Array<{
    cellId: string
    source: string
    kernelId: string
    cursorPosition?: number
  }>
  notebookFormatCalls: Array<{
    projectCwd: string
    source: string
    language?: string
    lineLength?: number
  }>
  openDialogOptions: Array<Record<string, unknown>>
  operationLog: Array<Record<string, unknown>>
  setOpenDialogResult: (result: { canceled: boolean; filePaths: string[] }) => void
  copiedText: () => string
}> {
  const handlers = new Map<string, Handler>()
  const sessions: FakeSession[] = []
  const deleted: string[] = []
  const events: Array<{ channel: string; data: unknown }> = []
  const approvalOptions: Array<Record<string, unknown>> = []
  const runnerEvents: Array<Record<string, unknown>> = []
  const createdPhiSessions: Array<Record<string, unknown>> = []
  const createdAgentOptions: Array<Record<string, unknown>> = []
  const resourceLoaderOptions: Array<Record<string, unknown>> = []
  const updatedProjectDefaults: Array<Record<string, unknown>> = []
  const updatedSessionManifests: Array<{ sessionId: string; patch: Record<string, unknown> }> = []
  const appendedSessionEvents: Array<Record<string, unknown>> = []
  const persistedToolOutputs: Array<Record<string, unknown>> = []
  const revealedPaths: string[] = []
  const openedPaths: string[] = []
  const previewReadRequests: Array<{ filePath: string; length: number }> = []
  const appLogs: Array<Record<string, unknown>> = []
  const acknowledgedSessions: Array<{ file: string; cwd: string }> = []
  const jupyterServerCalls: Array<{ action: string; cwd: string }> = []
  const notebookSessionCalls: Array<{ action: string; cwd: string; path?: string }> = []
  const notebookExecutionCalls: Array<{
    cellId: string
    source: string
    kernelId: string
    cursorPosition?: number
  }> = []
  const notebookFormatCalls: Array<{
    projectCwd: string
    source: string
    language?: string
    lineLength?: number
  }> = []
  const openDialogOptions: Array<Record<string, unknown>> = []
  const operationLog: Array<Record<string, unknown>> = []
  let openDialogResult: { canceled: boolean; filePaths: string[] } = {
    canceled: true,
    filePaths: []
  }
  const previewFiles = new Map<string, Buffer>([
    ['/projects/current/src/App.tsx', Buffer.from('export const app = true\n')],
    ['/projects/current/README.md', Buffer.from('# Project\n')],
    ['/projects/current/qc-demo.csv', Buffer.from('sample_id,value_a\nS001,1.75\n')],
    ['/projects/current/notebooks/eda.ipynb', Buffer.from('{"nbformat":4,"cells":[]}')],
    ['/projects/current/large.txt', Buffer.alloc(320010, 'a')],
    ['/projects/current/plot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    [
      '/projects/current/large-plot.png',
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(2 * 1024 * 1024, 0xff)
      ])
    ],
    ['/projects/current/report.pdf', Buffer.from('%PDF-1.7\n')],
    ['/projects/other/secret.txt', Buffer.from('secret\n')],
    ['/isolated/sessions/session-1/tool-outputs/out.txt', Buffer.from('saved output\n')],
    ['/projects/current/binary.dat', Buffer.from([0, 1, 2])]
  ])
  const previewDirectories = new Map<string, Array<{ name: string; kind: 'directory' | 'file' }>>([
    [
      '/projects/current',
      [
        { name: 'src', kind: 'directory' },
        { name: 'README.md', kind: 'file' },
        { name: 'large.txt', kind: 'file' }
      ]
    ],
    ['/projects/current/src', [{ name: 'App.tsx', kind: 'file' }]],
    ['/isolated', [{ name: 'sessions', kind: 'directory' }]],
    ['/isolated/sessions', [{ name: 'session-1', kind: 'directory' }]],
    ['/isolated/sessions/session-1', [{ name: 'tool-outputs', kind: 'directory' }]],
    ['/isolated/sessions/session-1/tool-outputs', [{ name: 'out.txt', kind: 'file' }]]
  ])
  const previewRealpaths = new Map<string, string>([
    ['/projects/current/link-out.txt', '/projects/other/secret.txt']
  ])
  const previewFileDescriptors = new Map<number, { path: string; content: Buffer }>()
  let nextPreviewFileDescriptor = 100
  let copiedText = ''
  const runtimeSessionCwds = new Map<string, string>()
  const noop = (): undefined => undefined
  let phiSessionCounter = 0
  class RunnerRegistry {
    readonly maxActiveRuns: number
    runs = new Map<
      string,
      {
        controller: AbortController
        done: Promise<void>
        runId: string
        startedAt: string
        status: 'running' | 'needs_approval'
      }
    >()
    constructor(options: { maxActiveRuns?: number } = {}) {
      this.maxActiveRuns = options.maxActiveRuns ?? 4
    }
    startRun(input: {
      sessionId: string
      runId: string
      execute: (context: { signal: AbortSignal }) => Promise<void>
      getRecordedFailure?: () => string | null | undefined
    }): { done: Promise<void> } {
      if (this.runs.has(input.sessionId)) throw new Error('会话正在运行')
      if (this.runs.size >= this.maxActiveRuns) throw new Error('运行中的会话已达上限')
      const controller = new AbortController()
      const run = {
        controller,
        runId: input.runId,
        startedAt: '2026-09-05T00:00:00.000Z',
        status: 'running' as const,
        done: Promise.resolve()
          .then(() => input.execute({ signal: controller.signal }))
          .then(() => {
            const recordedFailure = input.getRecordedFailure?.()
            if (recordedFailure) {
              appendedSessionEvents.push({
                sessionId: input.sessionId,
                event: {
                  type: 'run_failed',
                  runId: input.runId,
                  errorMessage: recordedFailure
                }
              })
              runnerEvents.push({
                type: 'recorded_failure',
                sessionId: input.sessionId,
                runId: input.runId,
                errorMessage: recordedFailure
              })
            }
          })
          .finally(() => {
            this.runs.delete(input.sessionId)
          })
      }
      this.runs.set(input.sessionId, run)
      return run
    }
    getActiveRun(sessionId: string): {
      sessionId: string
      runId: string
      startedAt: string
      status: 'running' | 'needs_approval'
    } | null {
      const run = this.runs.get(sessionId)
      return run
        ? {
            sessionId,
            runId: run.runId,
            startedAt: run.startedAt,
            status: run.status
          }
        : null
    }
    stopRun(sessionId: string): void {
      this.runs.get(sessionId)?.controller.abort()
    }
    stopAll(): void {
      runnerEvents.push({ type: 'stop_all' })
      for (const run of this.runs.values()) {
        run.controller.abort()
      }
    }
    markNeedsApproval(
      sessionId: string,
      approvalId: string,
      metadata?: Record<string, unknown>
    ): void {
      const run = this.runs.get(sessionId)
      if (run) run.status = 'needs_approval'
      runnerEvents.push({ type: 'approval_requested', sessionId, approvalId, metadata })
    }
    markApprovalApproved(sessionId: string, approvalId: string): void {
      const run = this.runs.get(sessionId)
      if (run) run.status = 'running'
      runnerEvents.push({ type: 'approval_approved', sessionId, approvalId })
    }
    markApprovalDenied(sessionId: string, approvalId: string): void {
      runnerEvents.push({ type: 'approval_denied', sessionId, approvalId })
    }
    markApprovalCancelled(sessionId: string, approvalId: string): void {
      runnerEvents.push({ type: 'approval_cancelled', sessionId, approvalId })
    }
  }
  class Window extends EventEmitter {
    static windows: Window[] = []
    webContents = {
      send: (channel: string, data: unknown): void => {
        operationLog.push({ type: 'webContents.send', channel, data })
        events.push({ channel, data })
      },
      setWindowOpenHandler: noop,
      setBackgroundThrottling: noop,
      isDestroyed: (): boolean => false
    }
    constructor() {
      super()
      Window.windows.push(this)
    }
    static getAllWindows(): Window[] {
      return Window.windows
    }
    static getFocusedWindow(): Window | null {
      return Window.windows[0] ?? null
    }
    isDestroyed(): boolean {
      return false
    }
    close(): void {
      this.emit('close')
      this.emit('closed')
    }
    isFullScreen = (): boolean => false
    setBackgroundColor = noop
    setFullScreen = noop
    setVibrancy = noop
    setWindowButtonVisibility = noop
    show = noop
    loadURL = noop
    loadFile = noop
  }
  class TestJupyterServerRegistry {
    connection(workingDirectory: string): Record<string, unknown> | null {
      jupyterServerCalls.push({ action: 'connection', cwd: workingDirectory })
      return null
    }
    status(workingDirectory: string): Record<string, unknown> {
      jupyterServerCalls.push({ action: 'status', cwd: workingDirectory })
      return {
        projectCwd: workingDirectory,
        state: 'stopped',
        hasEndpoint: false
      }
    }
    start(workingDirectory: string): Record<string, unknown> {
      jupyterServerCalls.push({ action: 'start', cwd: workingDirectory })
      return {
        projectCwd: workingDirectory,
        state: 'starting',
        pid: 2026,
        hasEndpoint: false,
        message: '正在启动 Jupyter Server'
      }
    }
    stop(workingDirectory: string): Record<string, unknown> {
      jupyterServerCalls.push({ action: 'stop', cwd: workingDirectory })
      return {
        projectCwd: workingDirectory,
        state: 'stopped',
        hasEndpoint: false,
        message: 'Jupyter Server 已停止'
      }
    }
    disposeAll(): void {
      jupyterServerCalls.push({ action: 'disposeAll', cwd: '*' })
    }
  }
  class TestAnalysisNotebookSessionRegistry {
    status(input: { projectCwd: string; notebookPath: string }): Record<string, unknown> {
      notebookSessionCalls.push({
        action: 'status',
        cwd: input.projectCwd,
        path: input.notebookPath
      })
      return {
        projectCwd: input.projectCwd,
        notebookPath: input.notebookPath,
        state: 'disconnected',
        message: 'Notebook 尚未连接 kernel'
      }
    }
    ensureSession(input: { projectCwd: string; notebookPath: string }): Record<string, unknown> {
      notebookSessionCalls.push({
        action: 'ensure',
        cwd: input.projectCwd,
        path: input.notebookPath
      })
      return {
        projectCwd: input.projectCwd,
        notebookPath: input.notebookPath,
        kernelName: 'python3',
        sessionId: 'session-1',
        state: 'idle',
        message: 'Notebook kernel 已连接'
      }
    }
    closeSession(projectCwd: string, notebookPath: string): Record<string, unknown> {
      notebookSessionCalls.push({ action: 'close', cwd: projectCwd, path: notebookPath })
      return {
        projectCwd,
        notebookPath,
        state: 'disconnected',
        message: 'Notebook kernel 已断开'
      }
    }
    interruptSession(projectCwd: string, notebookPath: string): Record<string, unknown> {
      notebookSessionCalls.push({ action: 'interrupt', cwd: projectCwd, path: notebookPath })
      return {
        projectCwd,
        notebookPath,
        kernelName: 'python3',
        sessionId: 'session-1',
        state: 'idle',
        message: 'Notebook kernel 停止请求已发送'
      }
    }
    closeProject(projectCwd: string): void {
      notebookSessionCalls.push({ action: 'closeProject', cwd: projectCwd })
    }
    projectSummary(projectCwd: string): Record<string, unknown> {
      notebookSessionCalls.push({ action: 'summary', cwd: projectCwd })
      return {
        activeSessionCount: 1,
        busySessionCount: 0,
        sessions: [
          {
            projectCwd,
            notebookPath: `${projectCwd}/notebooks/demo.ipynb`,
            kernelName: 'python3',
            kernelDisplayName: 'Python 3',
            sessionId: 'session-1',
            state: 'idle',
            message: 'Notebook kernel 已连接',
            startedAt: '2026-09-10T01:00:00.000Z',
            updatedAt: '2026-09-10T01:02:00.000Z'
          }
        ]
      }
    }
    executionTarget(): Record<string, unknown> {
      return {
        connection: { url: 'http://127.0.0.1:8888/lab', token: 'secret' },
        sessionId: 'session-1',
        kernelId: 'kernel-1',
        kernelName: 'python3'
      }
    }
    updateSessionState(
      projectCwd: string,
      notebookPath: string,
      state: string,
      message?: string
    ): Record<string, unknown> {
      notebookSessionCalls.push({ action: `state:${state}`, cwd: projectCwd, path: notebookPath })
      return {
        projectCwd,
        notebookPath,
        kernelName: 'python3',
        sessionId: 'session-1',
        state,
        message
      }
    }
  }
  class TestAnalysisNotebookExecutor {
    async executeCell(input: {
      kernelId: string
      cell: { id: string; source: string }
    }): Promise<Record<string, unknown>> {
      notebookExecutionCalls.push({
        cellId: input.cell.id,
        source: input.cell.source,
        kernelId: input.kernelId
      })
      return {
        cellId: input.cell.id,
        executionCount: 2,
        outputs: [
          {
            outputType: 'stream',
            data: {},
            metadata: {},
            name: 'stdout',
            text: 'ran\n',
            extra: {}
          }
        ],
        state: 'idle',
        startedAt: '2026-09-09T00:00:00.000Z',
        completedAt: '2026-09-09T00:00:01.000Z'
      }
    }

    async introspectVariables(input: { kernelId: string; variableNames: string[] }): Promise<
      Array<{
        name: string
        exists: boolean
        datatype?: string
        shape?: string
        columns?: Array<{ name: string; type?: string }>
        preview?: string
      }>
    > {
      notebookExecutionCalls.push({
        cellId: '__introspection__',
        source: input.variableNames.join(','),
        kernelId: input.kernelId
      })
      return input.variableNames.map((name) =>
        name === 'df'
          ? {
              name,
              exists: true,
              datatype: 'pandas.core.frame.DataFrame',
              shape: '2 x 3',
              columns: [
                { name: 'Year', type: 'object' },
                { name: 'Income', type: 'float64' }
              ],
              preview: '| Year | Income |\\n| 19th | 1208.7 |'
            }
          : { name, exists: false }
      )
    }

    async completeCode(input: {
      kernelId: string
      code: string
      cursorPosition: number
    }): Promise<Record<string, unknown>> {
      notebookExecutionCalls.push({
        cellId: '__completion__',
        source: input.code,
        kernelId: input.kernelId,
        cursorPosition: input.cursorPosition
      })
      return {
        matches: ['df', 'df.head'],
        cursorStart: 0,
        cursorEnd: input.cursorPosition,
        metadata: {},
        status: 'ok'
      }
    }
  }
  const app = Object.assign(new EventEmitter(), {
    setName: noop,
    getVersion: (): string => '9.8.7',
    whenReady: (): Promise<void> => Promise.resolve(),
    quit: noop
  })
  const modules: Record<string, unknown> = {
    './agent-env': {},
    'node:os': { homedir: (): string => '/fake-home' },
    'node:fs': {
      openSync: (filePath: string): number => {
        const target = path.resolve(filePath)
        const content = previewFiles.get(target)
        if (!content) throw new Error(`ENOENT ${target}`)
        const fd = nextPreviewFileDescriptor++
        previewFileDescriptors.set(fd, { path: target, content })
        return fd
      },
      readSync: (
        fd: number,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number | null
      ): number => {
        const file = previewFileDescriptors.get(fd)
        if (!file) throw new Error(`EBADF ${fd}`)
        const start = typeof position === 'number' ? position : 0
        const chunk = file.content.subarray(start, start + length)
        chunk.copy(buffer, offset)
        previewReadRequests.push({ filePath: file.path, length })
        return chunk.byteLength
      },
      closeSync: (fd: number): void => {
        previewFileDescriptors.delete(fd)
      },
      watch: (): { close: () => void } => ({
        close: noop
      }),
      readdirSync: (
        filePath: string
      ): Array<{
        name: string
        isDirectory: () => boolean
        isFile: () => boolean
      }> => {
        const target = path.resolve(filePath)
        const entries = previewDirectories.get(target)
        if (!entries) throw new Error(`ENOTDIR ${target}`)
        return entries.map((entry) => ({
          name: entry.name,
          isDirectory: () => entry.kind === 'directory',
          isFile: () => entry.kind === 'file'
        }))
      },
      realpathSync: (filePath: string): string => {
        const target = path.resolve(filePath)
        const realpath = previewRealpaths.get(target) ?? target
        if (!previewFiles.has(realpath) && !previewDirectories.has(realpath)) {
          throw new Error(`ENOENT ${target}`)
        }
        return realpath
      },
      statSync: (
        filePath: string
      ): { isDirectory: () => boolean; isFile: () => boolean; size: number } => {
        const target = path.resolve(filePath)
        const content = previewFiles.get(target)
        const directory = previewDirectories.get(target)
        return {
          isDirectory: () => Boolean(directory),
          isFile: () => Boolean(content),
          size: content?.byteLength ?? 0
        }
      }
    },
    path,
    electron: {
      app,
      BrowserWindow: Window,
      shell: {
        openExternal: noop,
        openPath: async (filePath: string): Promise<string> => {
          openedPaths.push(filePath)
          return ''
        },
        showItemInFolder: (filePath: string): void => {
          revealedPaths.push(filePath)
        }
      },
      clipboard: {
        writeText: (text: string): void => {
          copiedText = text
        }
      },
      dialog: {
        showOpenDialog: async (
          ...args: unknown[]
        ): Promise<{ canceled: boolean; filePaths: string[] }> => {
          const options = (args.length === 2 ? args[1] : args[0]) as Record<string, unknown>
          openDialogOptions.push(options)
          return openDialogResult
        }
      },
      ipcMain: {
        on: noop,
        handle: (name: string, handler: Handler): void => {
          handlers.set(name, handler)
        }
      },
      nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
      nativeTheme: { shouldUseDarkColors: false }
    },
    '@electron-toolkit/utils': {
      electronApp: { setAppUserModelId: noop },
      optimizer: { watchWindowShortcuts: noop },
      is: { dev: false }
    },
    './agent/runtime/runtime-adapter': {
      createRuntimeResourceLoader: (options: Record<string, unknown>): unknown => {
        resourceLoaderOptions.push(options)
        return {
          options,
          async reload(): Promise<void> {
            return
          }
        }
      },
      createInMemoryRuntimeSessionManager: (cwd: string): { file: string; cwd: string } => ({
        file: 'in-memory',
        cwd
      }),
      openRuntimeSessionManager: (file: string): { getCwd: () => string } => ({
        getCwd: () => runtimeSessionCwds.get(file) ?? `/projects/${file}`
      })
    },
    './agent/session/session-manager': {
      createAgentSession: async (
        options: {
          cwd: string
          sessionManager: { file: string }
          model?: { provider: string; id: string }
          thinkingLevel?: string
        },
        onEvent?: (summary: Record<string, unknown>) => void
      ): Promise<{ session: FakeSession }> => {
        createdAgentOptions.push(options)
        const session = factory
          ? await factory(options.cwd, options.sessionManager.file)
          : new FakeSession(options.sessionManager.file)
        session.model = options.model
        session.thinkingLevel = options.thinkingLevel
        if (onEvent) {
          session.subscribe((event) => onEvent(event as Record<string, unknown>))
        }
        sessions.push(session)
        return { session }
      }
    },
    './agent/auth-manager': {
      getAuthManager: (): unknown => ({
        getProviderStatuses: async () => [
          {
            providerId: 'openai',
            name: 'OpenAI',
            configured: true,
            source: 'stored',
            hasApiKey: true,
            hasOAuth: false,
            hasConfigError: false,
            statusText: 'ready'
          }
        ],
        getRuntime: async () => ({
          getModels: () => [
            {
              provider: 'openai',
              id: 'gpt-test',
              name: 'GPT Test',
              reasoning: true
            },
            {
              provider: 'kimi-code',
              id: 'kimi-k2.5',
              name: 'Kimi K2.5',
              reasoning: true
            },
            {
              provider: 'kimi-code',
              id: 'kimi-for-coding',
              name: 'K2.7 Coding',
              reasoning: true
            }
          ],
          getModel: (providerId: string, modelId: string) =>
            providerId === 'missing'
              ? undefined
              : {
                  provider: providerId,
                  id: modelId,
                  name: modelId,
                  reasoning: true
                }
        })
      })
    },
    './agent/persona-manager': {
      setPersonaMarkdown: noop,
      getPersonaMarkdown: (): string => 'persona'
    },
    './agent/session/sessions': {
      WORKSPACE_DIR: '/workspace',
      phiOnlySessionPath: (sessionId: string): string => `phi-session:${sessionId}`,
      phiSessionIdFromPath: (path: string): string | null =>
        path.startsWith('phi-session:') ? path.slice('phi-session:'.length) : null,
      isPhiOnlySessionPath: (path: string | null | undefined): boolean =>
        typeof path === 'string' && path.startsWith('phi-session:'),
      createSessionManager: (cwd: string, file?: string): { file: string } => {
        const sessionFile = file ?? 'fresh.jsonl'
        runtimeSessionCwds.set(sessionFile, cwd)
        return { file: sessionFile }
      },
      listSessions: async (): Promise<unknown[]> => [],
      acknowledgeSession: (file: string, cwd: string): null => {
        acknowledgedSessions.push({ file, cwd })
        return null
      },
      deleteSession: (file: string): void => {
        deleted.push(file)
      }
    },
    './agent/projects': {
      assertProjectPathAvailable: (workingDirectory: string) => {
        if (workingDirectory.includes('missing-project')) throw new Error('项目路径不可用')
      },
      listProjects: () => [
        {
          id: 'project-/projects/defaults',
          name: 'Project /projects/defaults',
          workingDirectory: '/projects/defaults',
          workingDirectoryRealPath: '/projects/defaults',
          permissionMode: 'ask',
          pathAvailable: true,
          createdAt: '2026-09-05T00:00:00.000Z'
        }
      ],
      updateProjectDefaults: (id: string, defaults: Record<string, unknown>) => {
        updatedProjectDefaults.push({ id, defaults })
        return {
          id,
          name: 'Project',
          workingDirectory: '/projects/defaults',
          permissionMode: 'ask',
          pathAvailable: true,
          createdAt: '2026-09-05T00:00:00.000Z',
          ...defaults
        }
      },
      updateProjectPermissionMode: (id: string, permissionMode: string) => ({
        id,
        name: 'Project',
        workingDirectory: '/projects/defaults',
        permissionMode,
        pathAvailable: true,
        createdAt: '2026-09-05T00:00:00.000Z'
      }),
      updateProjectRemoteConnection: (id: string) => ({
        id,
        name: 'Project',
        workingDirectory: '/projects/defaults',
        permissionMode: 'ask',
        pathAvailable: true,
        createdAt: '2026-09-05T00:00:00.000Z'
      }),
      updateProjectRemoteDefaults: (id: string, defaults: Record<string, unknown>) => ({
        id,
        name: 'Project',
        workingDirectory: '/projects/defaults',
        permissionMode: 'ask',
        pathAvailable: true,
        createdAt: '2026-09-05T00:00:00.000Z',
        ...defaults
      }),
      getProjectByCwd: (
        cwd: string
      ): {
        id: string
        name: string
        permissionMode: string
        workingDirectoryRealPath: string
        defaultModel?: { providerId: string; modelId: string }
        defaultThinkingLevel?: string
      } | null =>
        cwd.startsWith('/projects/')
          ? {
              id: `project-${cwd}`,
              name: `Project ${cwd}`,
              permissionMode: 'ask',
              workingDirectory: cwd,
              workingDirectoryRealPath: cwd,
              ...(cwd.includes('defaults')
                ? {
                    defaultModel: { providerId: 'anthropic', modelId: 'claude-test' },
                    defaultThinkingLevel: 'medium'
                  }
                : cwd.includes('unavailable')
                  ? {
                      defaultModel: { providerId: 'missing', modelId: 'gone' },
                      defaultThinkingLevel: 'high'
                    }
                  : cwd.includes('kimi-retired')
                    ? {
                        defaultModel: { providerId: 'kimi-code', modelId: 'kimi-k2.5' },
                        defaultThinkingLevel: 'high'
                      }
                    : {})
            }
          : null
    },
    './agent/notebook/analysis-notebooks': {
      emptyNotebookRegistry: (message: string) => ({
        projectCwd: null,
        notebooks: [],
        truncated: false,
        initialized: false,
        message
      }),
      initializeProjectAnalysis: (workingDirectory: string) => ({
        notebooksDir: `${workingDirectory}/notebooks`,
        outputsDir: `${workingDirectory}/outputs`
      }),
      listProjectNotebooks: (workingDirectory: string) => ({
        notebooks:
          workingDirectory === '/projects/research'
            ? [
                {
                  path: '/projects/research/notebooks/qc.ipynb',
                  relativePath: 'notebooks/qc.ipynb',
                  name: 'qc.ipynb',
                  directory: 'notebooks',
                  bytes: 1024,
                  modifiedAt: '2026-09-09T00:00:00.000Z'
                }
              ]
            : [],
        truncated: false,
        initialized: true
      })
    },
    './agent/notebook/analysis-notebook-files': {
      openProjectNotebook: (workingDirectory: string, notebookPath: string) => ({
        path: `${workingDirectory}/${notebookPath}`,
        relativePath: notebookPath,
        name: 'qc.ipynb',
        bytes: 128,
        modifiedAt: '2026-09-09T00:00:00.000Z',
        savedRevision: 'nb-open',
        document: {
          nbformat: 4,
          nbformatMinor: 5,
          metadata: {},
          cells: [],
          extra: {},
          revision: 'nb-open'
        }
      }),
      saveProjectNotebook: (
        workingDirectory: string,
        input: { path: string; document: { revision: string } }
      ) => ({
        path: input.path,
        relativePath: input.path.replace(`${workingDirectory}/`, ''),
        name: 'qc.ipynb',
        bytes: 256,
        modifiedAt: '2026-09-09T00:01:00.000Z',
        savedRevision: input.document.revision,
        document: input.document
      }),
      createProjectNotebook: (workingDirectory: string) => ({
        path: `${workingDirectory}/notebooks/Untitled.ipynb`,
        relativePath: 'notebooks/Untitled.ipynb',
        name: 'Untitled.ipynb',
        bytes: 512,
        modifiedAt: '2026-09-09T00:02:00.000Z',
        savedRevision: 'nb-new',
        document: {
          nbformat: 4,
          nbformatMinor: 5,
          metadata: {},
          cells: [],
          extra: {},
          revision: 'nb-new'
        }
      }),
      closeProjectNotebook: (workingDirectory: string, notebookPath: string) => ({
        path: `${workingDirectory}/${notebookPath}`
      }),
      deleteProjectNotebook: (workingDirectory: string, notebookPath: string) => ({
        path: `${workingDirectory}/${notebookPath}`,
        relativePath: notebookPath
      })
    },
    './agent/notebook/analysis-notebook-watch': {
      AnalysisNotebookFileWatcher: class {
        watch(workingDirectory: string, notebookPath: string): unknown {
          return {
            path: `${workingDirectory}/${notebookPath}`,
            relativePath: notebookPath,
            name: 'qc.ipynb',
            bytes: 128,
            modifiedAt: '2026-09-09T00:00:00.000Z',
            savedRevision: 'nb-open',
            document: {
              nbformat: 4,
              nbformatMinor: 5,
              metadata: {},
              cells: [],
              extra: {},
              revision: 'nb-open'
            }
          }
        }
        watchFile(): void {
          return undefined
        }
        noteLocalWrite(): void {
          return undefined
        }
        unwatch(): void {
          return undefined
        }
        unwatchFile(): void {
          return undefined
        }
        unwatchProject(): void {
          return undefined
        }
        dispose(): void {
          return undefined
        }
      }
    },
    './agent/notebook/analysis-kernels': {
      detectAnalysisKernels: () => ({
        jupyterServer: { available: true, command: 'jupyter', version: '2.14.0' },
        kernels: [
          {
            name: 'python3',
            displayName: 'Python 3',
            language: 'python',
            rawLanguage: 'python'
          }
        ],
        preferredKernelName: 'python3',
        hasPythonKernel: true,
        hasRKernel: false,
        messages: ['未检测到 R kernel。']
      })
    },
    './agent/notebook/analysis-jupyter-server': {
      JupyterServerRegistry: TestJupyterServerRegistry
    },
    './agent/notebook/analysis-jupyter-sessions': {
      AnalysisNotebookSessionRegistry: TestAnalysisNotebookSessionRegistry
    },
    './agent/notebook/analysis-jupyter-execution': {
      AnalysisNotebookExecutor: TestAnalysisNotebookExecutor
    },
    './agent/notebook/analysis-notebook-completion': {
      completeNotebookPythonStaticCompletion: (): null => null,
      mergeNotebookCompletionResults: (primary: unknown): unknown => primary
    },
    './agent/notebook/analysis-notebook-formatting': {
      formatNotebookCellSource: (input: {
        projectCwd: string
        source: string
        language?: string
        lineLength?: number
      }): Record<string, unknown> => {
        notebookFormatCalls.push({
          projectCwd: input.projectCwd,
          source: input.source,
          language: input.language,
          lineLength: input.lineLength
        })
        const source = input.source.replace('x=1', 'x = 1')
        return {
          source,
          changed: source !== input.source,
          formatter: 'ruff'
        }
      }
    },
    './agent/notebook/notebook-tool-executor': {
      AnalysisNotebookToolExecutor: class TestAnalysisNotebookToolExecutor {
        execute(): never {
          throw new Error('notebookTool.execute is not exercised in main-integration.test.ts')
        }
        syncDraft(input: {
          cwd: string
          path: string
          document: unknown
          savedRevision?: string
          source?: string
        }): Record<string, unknown> {
          return {
            source: input.source ?? 'renderer',
            projectCwd: input.cwd,
            path: input.path,
            relativePath: input.path,
            document: input.document,
            savedRevision: input.savedRevision ?? 'synced'
          }
        }
      }
    },
    './agent/omp/omp-bridge': {
      getOmpBridge: (): { registerHostHandler: () => () => void } => ({
        registerHostHandler: () => () => {}
      })
    },
    './agent/notebook/notebook-code-generation': notebookCodeGeneration,
    '../shared/notebookDocument': notebookDocument,
    '../shared/sessionTitle': sessionTitle,
    './agent/tool-approval': {
      cancelToolApprovals: noop,
      createApprovalExtension: (options: Record<string, unknown>): Record<string, unknown> => {
        approvalOptions.push(options)
        return { name: 'approval-extension' }
      }
    },
    './agent/plugins': {
      listPlugins: async (): Promise<unknown[]> => [
        { id: 'plugin-1', name: 'Plugin', source: 'local', installed: true }
      ],
      installPlugin: async (): Promise<unknown[]> => [],
      removePlugin: async (): Promise<unknown[]> => []
    },
    './agent/resources': {
      listSkills: async (cwd: string): Promise<unknown[]> => [
        {
          id: `${cwd}:skill`,
          name: 'skill',
          description: 'skill',
          filePath: `${cwd}/.phi/skills/skill/SKILL.md`,
          source: 'project',
          scope: 'project',
          disabled: false
        }
      ],
      listPromptAgents: async (cwd: string): Promise<unknown[]> => [
        {
          id: `${cwd}:agent`,
          name: 'executor',
          description: 'agent',
          source: 'project',
          trigger: '/prompts:executor'
        }
      ],
      listMcpServers: async (cwd: string): Promise<unknown[]> => [
        {
          id: `${cwd}:mcp`,
          name: 'mcp',
          command: 'server',
          args: ['--serve'],
          envKeys: ['API_KEY'],
          sourcePath: `${cwd}/.phi/mcp.json`,
          status: 'configured'
        }
      ]
    },
    './agent/wrappers/runs': {
      submitWrapperRunPlan: (): never => {
        throw new Error('计划不存在: (mocked in main-integration.test.ts)')
      },
      cancelWrapperRunPlan: (): never => {
        throw new Error('计划不存在: (mocked in main-integration.test.ts)')
      },
      cancelWrapperRun: (): never => {
        throw new Error('run 不存在: (mocked in main-integration.test.ts)')
      }
    },
    './agent/wrappers/store': {
      readWrapperPlan: (): undefined => undefined,
      listWrapperRuns: (): unknown[] => [],
      readWrapperRun: (): undefined => undefined,
      readWrapperPlanArtifact: (): undefined => undefined
    },
    './agent/wrappers/reproducibility': {
      buildWrapperReproducibilityBundle: (): never => {
        throw new Error('run 不存在: (mocked in main-integration.test.ts)')
      }
    },
    './agent/wrappers/executor-slurm-reconcile': {
      reconcileRemoteWrapperRuns: (): Promise<void> => Promise.resolve()
    },
    './agent/wrappers/catalog': {
      ensureBundledWrappersInstalled: (): unknown[] => [],
      listWrapperCatalog: (): unknown[] => [],
      addCustomWrapper: (): never => {
        throw new Error('wrapper.yaml 校验失败: (mocked in main-integration.test.ts)')
      }
    },
    './agent/wrappers/remote-credential-store': {
      isRemoteCredentialStorageAvailable: (): boolean => false,
      storeRemoteConnectionPassphrase: (): void => {},
      deleteRemoteConnectionPassphrase: (): void => {}
    },
    './agent/diagnostics': { formatDiagnostics },
    './agent/app-logger': {
      LOG_RETENTION_DAYS: 14,
      cleanupOldLogs: () => 0,
      getPhiLogDir: () => '/tmp/phi/logs',
      writeAppLog: (entry: Record<string, unknown>) => {
        appLogs.push(entry)
      }
    },
    './agent/redaction': {
      redactSensitiveText: (text: string): string =>
        text
          .replace(/\borg-[A-Za-z0-9_-]+(?:<[^>\s]+>)?/g, '[redacted]')
          .replace(/\bak-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    },
    './agent/session/session-lifecycle': lifecycle,
    './agent/session/session-runner-registry': { SessionRunnerRegistry: RunnerRegistry },
    './agent/session/session-store': {
      appendSessionEvent: (sessionId: string, event: Record<string, unknown>) => {
        appendedSessionEvents.push({ sessionId, event })
        return { sessionId, eventId: `event-${appendedSessionEvents.length}`, ...event }
      },
      createPhiSession: (input: Record<string, unknown>): { sessionId: string } => {
        const sessionId = `phi-${++phiSessionCounter}`
        createdPhiSessions.push({ sessionId, ...input })
        return { sessionId }
      },
      createRunId: (): string => `run-${phiSessionCounter + 1}`,
      findPhiSessionByRuntimePath: (runtimeSessionPath: string): { sessionId: string } | null => {
        if (runtimeSessionPath === 'with-phi-events') return { sessionId: 'phi-existing' }
        const match = updatedSessionManifests.find(
          (entry) => entry.patch.runtimeSessionPath === runtimeSessionPath
        )
        return match ? { sessionId: match.sessionId } : null
      },
      findPhiSessionById: (sessionId: string): Record<string, unknown> | null => {
        const session = createdPhiSessions.find((entry) => entry.sessionId === sessionId)
        if (!session) return null
        const patches = updatedSessionManifests
          .filter((entry) => entry.sessionId === sessionId)
          .map((entry) => entry.patch)
        return Object.assign(
          {
            sessionId,
            cwd: session.cwd ?? '/workspace',
            permissionMode: session.permissionMode ?? 'auto',
            status: 'idle',
            unreadKind: null,
            messageCount: 0,
            createdAt: '2026-09-05T00:00:00.000Z',
            updatedAt: '2026-09-05T00:00:00.000Z',
            lastActivityAt: '2026-09-05T00:00:00.000Z'
          },
          session,
          ...patches
        )
      },
      listPhiSessions: () =>
        createdPhiSessions.map((session) => {
          const patches = updatedSessionManifests
            .filter((entry) => entry.sessionId === session.sessionId)
            .map((entry) => entry.patch)
          return Object.assign(
            {
              status: 'idle',
              unreadKind: null,
              messageCount: 0,
              createdAt: '2026-09-05T00:00:00.000Z',
              updatedAt: '2026-09-05T00:00:00.000Z',
              lastActivityAt: '2026-09-05T00:00:00.000Z'
            },
            session,
            ...patches
          )
        }),
      readSessionEvents: (sessionId: string) =>
        sessionId === 'phi-existing'
          ? [
              {
                eventId: 'event-user-existing',
                sessionId,
                createdAt: '2026-09-05T00:00:00.000Z',
                type: 'user_message',
                runId: 'run-existing',
                content: 'phi user'
              },
              {
                eventId: 'event-existing',
                sessionId,
                createdAt: '2026-09-05T00:00:00.000Z',
                type: 'tool_call_completed',
                runId: 'run-existing',
                toolCallId: 'tool-existing',
                toolName: 'bash',
                output: 'restored'
              }
            ]
          : appendedSessionEvents
              .filter((entry) => entry.sessionId === sessionId)
              .map((entry, index) => ({
                eventId: `event-${index + 1}`,
                sessionId,
                createdAt: '2026-09-05T00:00:00.000Z',
                ...entry.event
              })),
      persistToolOutput: (
        sessionId: string,
        input: { runId: string; toolCallId: string; output: string; inlineLimit?: number }
      ) => {
        persistedToolOutputs.push({ sessionId, input })
        const truncated = input.output.length > 8
        return {
          outputPreview: truncated ? `${input.output.slice(0, 8)}\n...saved` : input.output,
          ...(truncated ? { outputPath: `/tool-outputs/${input.toolCallId}.txt` } : {}),
          ...(truncated
            ? {
                outputArtifact: {
                  kind: 'tool_output',
                  path: `/tool-outputs/${input.toolCallId}.txt`,
                  bytes: input.output.length
                }
              }
            : {}),
          outputBytes: input.output.length,
          truncated
        }
      },
      recoverInterruptedPhiSessions: noop,
      updateSessionManifest: (
        sessionId: string,
        patch: Record<string, unknown>
      ): Record<string, unknown> => {
        operationLog.push({ type: 'updateSessionManifest', sessionId, patch })
        updatedSessionManifests.push({ sessionId, patch })
        return { sessionId, ...patch }
      }
    },
    '../../resources/icon.png?asset': { default: '/icon.png' }
  }
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const compiled = ts
    .transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    })
    .outputText.replaceAll('import.meta.dirname', "'/app/main'")
  const load = (specifier: string): unknown => {
    assert.ok(specifier in modules, `Unexpected external dependency: ${specifier}`)
    return modules[specifier]
  }
  new Function('require', 'exports', 'process', compiled)(
    load,
    {},
    {
      platform: process.platform,
      env: { PI_CODING_AGENT_DIR: '/isolated' },
      versions: { node: '22.0.0', electron: '39.0.0' }
    }
  )
  await tick()
  return {
    invoke: async (channel, ...args): Promise<unknown> => {
      const handler = handlers.get(channel)
      assert.ok(handler, `Missing IPC handler ${channel}`)
      return handler({ sender: Window.getFocusedWindow()?.webContents }, ...args)
    },
    sessions,
    deleted,
    events,
    approvalOptions,
    runnerEvents,
    createdPhiSessions,
    createdAgentOptions,
    resourceLoaderOptions,
    updatedProjectDefaults,
    updatedSessionManifests,
    appendedSessionEvents,
    persistedToolOutputs,
    revealedPaths,
    openedPaths,
    previewReadRequests,
    appLogs,
    acknowledgedSessions,
    jupyterServerCalls,
    notebookSessionCalls,
    notebookExecutionCalls,
    notebookFormatCalls,
    openDialogOptions,
    operationLog,
    setOpenDialogResult: (result): void => {
      openDialogResult = result
    },
    copiedText: () => copiedText
  }
}

test(
  'main IPC: stopping during SDK preflight never starts the cancelled model run',
  { timeout: 3000 },
  async () => {
    const gate = deferred<void>()
    const session = new FakeSession('fresh.jsonl')
    session.preflight = gate.promise
    const app = await harness(async () => session)
    const prompt = app.invoke('agent:prompt', 'hello')
    await tick()
    await app.invoke('agent:stop')
    gate.resolve()
    await prompt
    assert.equal(session.started, false)
  }
)

test('main IPC: agent prompt asks for explicit next-action recommendations without changing the saved user message', async () => {
  const session = new FakeSession('fresh.jsonl')
  const app = await harness(async () => session)

  await app.invoke('agent:prompt', 'hello')

  assert.equal(session.promptTexts.length, 1)
  assert.match(session.promptTexts[0], /^hello\n\n<phi_next_action_instruction>/)
  assert.match(session.promptTexts[0], /推荐下一步：<一句可以直接作为下一轮用户输入的中文操作>/)
  assert.equal(app.appendedSessionEvents[0].event.content, 'hello')
})

test('main IPC: reveal path is limited to Phi-owned files', async () => {
  const app = await harness()

  await app.invoke('files:reveal', '/isolated/sessions/session-1/tool-outputs/out.txt')
  await assert.rejects(
    app.invoke('files:reveal', '/tmp/out.txt'),
    /只能显示 Phi 保存的文件或当前项目内的文件/
  )
  await assert.rejects(app.invoke('files:reveal', 'relative.txt'), /只能显示绝对路径/)

  assert.deepEqual(app.revealedPaths, ['/isolated/sessions/session-1/tool-outputs/out.txt'])
})

test('main IPC: reveal path allows files inside the active project cwd', async () => {
  const app = await harness()

  await app.invoke('projects:newSession', '/projects/current', 'ask')
  await app.invoke('files:reveal', '/projects/current/src/App.tsx')
  await assert.rejects(
    app.invoke('files:reveal', '/projects/other/src/App.tsx'),
    /只能显示 Phi 保存的文件或当前项目内的文件/
  )

  assert.deepEqual(app.revealedPaths, ['/projects/current/src/App.tsx'])
})

test('main IPC: local path stats only report allowed existing files and directories', async () => {
  const app = await harness()

  const stats = await app.invoke('files:statLocalPaths', '/projects/current', [
    '/projects/current/README.md',
    '/projects/current/src',
    '/projects/current/qc-demo.csv',
    '/projects/current/notebooks/eda.ipynb',
    '/projects/current/adj.P.Val',
    '/projects/other/secret.txt',
    'relative.txt'
  ])

  assert.deepEqual(stats, [
    { path: '/projects/current/README.md', kind: 'file' },
    { path: '/projects/current/src', kind: 'directory' },
    { path: '/projects/current/qc-demo.csv', kind: 'file' },
    { path: '/projects/current/notebooks/eda.ipynb', kind: 'file' },
    { path: '/projects/current/adj.P.Val', kind: 'missing' },
    { path: '/projects/other/secret.txt', kind: 'missing' },
    { path: 'relative.txt', kind: 'missing' }
  ])

  assert.deepEqual(await app.invoke('files:statLocalPaths', '/tmp/external', ['/workspace']), [
    { path: '/workspace', kind: 'missing' }
  ])
})

test('main IPC: input file picker returns selected paths without reading files', async () => {
  const app = await harness()
  app.setOpenDialogResult({
    canceled: false,
    filePaths: ['/projects/current/src/App.tsx', '/tmp/external-data.csv']
  })

  const paths = await app.invoke('files:pickInput')

  assert.deepEqual(paths, ['/projects/current/src/App.tsx', '/tmp/external-data.csv'])
  assert.deepEqual(app.openDialogOptions.at(-1)?.properties, [
    'openFile',
    'openDirectory',
    'multiSelections'
  ])
  assert.equal(app.previewReadRequests.length, 0)
})

test('main IPC: input file picker returns an empty list when cancelled', async () => {
  const app = await harness()

  assert.deepEqual(await app.invoke('files:pickInput'), [])
})

test('main IPC: file preview is limited to project and Phi-owned files', async () => {
  const app = await harness()

  await app.invoke('projects:newSession', '/projects/current', 'ask')
  const projectPreview = (await app.invoke('files:preview', '/projects/current/src/App.tsx')) as {
    name: string
    path: string
    displayPath: string
    rootPath: string
    rootLabel: string
    content: string
    bytes: number
    previewBytes: number
    truncated: boolean
    kind: string
    mimeType: string
  }
  const savedOutputPreview = (await app.invoke(
    'files:preview',
    '/isolated/sessions/session-1/tool-outputs/out.txt'
  )) as { content: string }
  const largePreview = (await app.invoke('files:preview', '/projects/current/large.txt')) as {
    content: string
    bytes: number
    previewBytes: number
    truncated: boolean
  }
  const imagePreview = (await app.invoke('files:preview', '/projects/current/plot.png')) as {
    kind: string
    mimeType: string
    dataUrl: string
    content?: string
    bytes: number
    previewBytes: number
    truncated: boolean
  }
  const pdfPreview = (await app.invoke('files:preview', '/projects/current/report.pdf')) as {
    kind: string
    mimeType: string
    dataUrl: string
    content?: string
    bytes: number
    previewBytes: number
    truncated: boolean
  }

  assert.equal(projectPreview.name, 'App.tsx')
  assert.equal(projectPreview.path, '/projects/current/src/App.tsx')
  assert.equal(projectPreview.displayPath, 'src/App.tsx')
  assert.equal(projectPreview.rootPath, '/projects/current')
  assert.equal(projectPreview.rootLabel, 'current')
  assert.equal(projectPreview.kind, 'text')
  assert.equal(projectPreview.mimeType, 'text/plain')
  assert.equal(projectPreview.content, 'export const app = true\n')
  assert.equal(projectPreview.bytes, Buffer.byteLength(projectPreview.content))
  assert.equal(projectPreview.previewBytes, Buffer.byteLength(projectPreview.content))
  assert.equal(projectPreview.truncated, false)
  assert.equal(savedOutputPreview.content, 'saved output\n')
  assert.equal(largePreview.truncated, true)
  assert.equal(largePreview.bytes, 320010)
  assert.equal(largePreview.previewBytes, 320000)
  assert.equal(largePreview.content.length, 320000)
  assert.equal(imagePreview.kind, 'image')
  assert.equal(imagePreview.mimeType, 'image/png')
  assert.match(imagePreview.dataUrl, /^data:image\/png;base64,/)
  assert.equal(imagePreview.content, undefined)
  assert.equal(imagePreview.bytes, 8)
  assert.equal(imagePreview.previewBytes, 8)
  assert.equal(imagePreview.truncated, false)
  assert.equal(pdfPreview.kind, 'pdf')
  assert.equal(pdfPreview.mimeType, 'application/pdf')
  assert.match(pdfPreview.dataUrl, /^data:application\/pdf;base64,/)
  assert.equal(pdfPreview.content, undefined)
  assert.equal(pdfPreview.bytes, 9)
  assert.equal(pdfPreview.previewBytes, 9)
  assert.equal(pdfPreview.truncated, false)
  assert.deepEqual(
    app.previewReadRequests.find((request) => request.filePath === '/projects/current/large.txt'),
    { filePath: '/projects/current/large.txt', length: 320000 }
  )
  await assert.rejects(
    app.invoke('files:preview', '/projects/other/src/App.tsx'),
    /只能预览 Phi 保存的文件或当前项目内的文件/
  )
  await assert.rejects(
    app.invoke('files:preview', '/projects/current/link-out.txt'),
    /只能预览 Phi 保存的文件或当前项目内的文件/
  )
  await assert.rejects(app.invoke('files:preview', 'relative.txt'), /只能预览绝对路径/)
  await assert.rejects(
    app.invoke('files:preview', '/projects/current/binary.dat'),
    /暂不支持预览二进制文件/
  )
})

test('main IPC: hover file preview is tiered and bounded', async () => {
  const app = await harness()

  await app.invoke('projects:newSession', '/projects/current', 'ask')
  const textPreview = (await app.invoke('files:hoverPreview', '/projects/current/src/App.tsx')) as {
    kind: string
    content: string
    bytes: number
    previewBytes: number
    truncated: boolean
  }
  const spreadsheetPreview = (await app.invoke(
    'files:hoverPreview',
    '/projects/current/qc-demo.csv'
  )) as {
    kind: string
    mimeType: string
    format: string
    content: string
  }
  const imagePreview = (await app.invoke('files:hoverPreview', '/projects/current/plot.png')) as {
    kind: string
    mimeType: string
    dataUrl: string
    content?: string
    previewBytes: number
    truncated: boolean
  }
  const largeImagePreview = (await app.invoke(
    'files:hoverPreview',
    '/projects/current/large-plot.png'
  )) as {
    kind: string
    reason: string
    dataUrl?: string
    previewBytes: number
    truncated: boolean
  }
  const pdfPreview = (await app.invoke('files:hoverPreview', '/projects/current/report.pdf')) as {
    kind: string
    mimeType: string
    reason: string
    dataUrl?: string
    content?: string
  }
  const binaryPreview = (await app.invoke(
    'files:hoverPreview',
    '/projects/current/binary.dat'
  )) as {
    kind: string
    reason: string
    dataUrl?: string
    content?: string
  }
  const largeTextPreview = (await app.invoke(
    'files:hoverPreview',
    '/projects/current/large.txt'
  )) as {
    kind: string
    content: string
    previewBytes: number
    truncated: boolean
  }

  assert.equal(textPreview.kind, 'text')
  assert.equal(textPreview.content, 'export const app = true\n')
  assert.equal(textPreview.bytes, Buffer.byteLength(textPreview.content))
  assert.equal(textPreview.previewBytes, Buffer.byteLength(textPreview.content))
  assert.equal(textPreview.truncated, false)
  assert.equal(spreadsheetPreview.kind, 'spreadsheet')
  assert.equal(spreadsheetPreview.mimeType, 'text/csv')
  assert.equal(spreadsheetPreview.format, 'csv')
  assert.equal(spreadsheetPreview.content, 'sample_id,value_a\nS001,1.75\n')
  assert.equal(imagePreview.kind, 'image')
  assert.equal(imagePreview.mimeType, 'image/png')
  assert.match(imagePreview.dataUrl, /^data:image\/png;base64,/)
  assert.equal(imagePreview.content, undefined)
  assert.equal(imagePreview.previewBytes, 8)
  assert.equal(imagePreview.truncated, false)
  assert.equal(largeImagePreview.kind, 'metadata')
  assert.equal(largeImagePreview.reason, 'large_file')
  assert.equal(largeImagePreview.dataUrl, undefined)
  assert.equal(largeImagePreview.previewBytes, 512)
  assert.equal(largeImagePreview.truncated, true)
  assert.equal(pdfPreview.kind, 'metadata')
  assert.equal(pdfPreview.mimeType, 'application/pdf')
  assert.equal(pdfPreview.reason, 'pdf')
  assert.equal(pdfPreview.dataUrl, undefined)
  assert.equal(pdfPreview.content, undefined)
  assert.equal(binaryPreview.kind, 'metadata')
  assert.equal(binaryPreview.reason, 'binary')
  assert.equal(binaryPreview.dataUrl, undefined)
  assert.equal(binaryPreview.content, undefined)
  assert.equal(largeTextPreview.kind, 'text')
  assert.equal(largeTextPreview.previewBytes, 32768)
  assert.equal(largeTextPreview.content.length, 32768)
  assert.equal(largeTextPreview.truncated, true)
  assert.deepEqual(
    app.previewReadRequests
      .filter((request) => request.filePath === '/projects/current/large-plot.png')
      .map((request) => request.length),
    [512]
  )
  assert.deepEqual(
    app.previewReadRequests
      .filter((request) => request.filePath === '/projects/current/large.txt')
      .map((request) => request.length),
    [512, 32768]
  )
  await assert.rejects(
    app.invoke('files:hoverPreview', '/projects/other/secret.txt'),
    /只能预览 Phi 保存的文件或当前项目内的文件/
  )
})

test('main IPC: local file open and directory listing stay inside allowed roots', async () => {
  const app = await harness()

  await app.invoke('projects:newSession', '/projects/current', 'ask')
  await app.invoke('files:openPath', '/projects/current/src/App.tsx')
  const rootListing = (await app.invoke('files:listDirectory', '/projects/current')) as {
    displayPath: string
    rootPath: string
    entries: Array<{ name: string; path: string; displayPath: string; kind: 'directory' | 'file' }>
    truncated: boolean
  }
  const srcListing = (await app.invoke('files:listDirectory', '/projects/current/src')) as {
    displayPath: string
    entries: Array<{ name: string; displayPath: string; kind: 'directory' | 'file' }>
  }

  assert.deepEqual(app.openedPaths, ['/projects/current/src/App.tsx'])
  assert.equal(rootListing.displayPath, 'current')
  assert.equal(rootListing.rootPath, '/projects/current')
  assert.equal(rootListing.truncated, false)
  assert.deepEqual(
    rootListing.entries.map((entry) => [entry.name, entry.displayPath, entry.kind]),
    [
      ['src', 'src', 'directory'],
      ['large.txt', 'large.txt', 'file'],
      ['README.md', 'README.md', 'file']
    ]
  )
  assert.equal(srcListing.displayPath, 'src')
  assert.deepEqual(srcListing.entries, [
    {
      name: 'App.tsx',
      path: '/projects/current/src/App.tsx',
      displayPath: 'src/App.tsx',
      kind: 'file'
    }
  ])
  await assert.rejects(app.invoke('files:openPath', '/projects/other/secret.txt'), /只能打开/)
  await assert.rejects(
    app.invoke('files:listDirectory', '/projects/other'),
    /只能列出 Phi 保存的文件或当前项目内的文件/
  )
})

test('main IPC: diagnostics are copied without conversation or raw tool output', async () => {
  const app = await harness()

  const text = (await app.invoke('diagnostics:copy')) as string

  assert.equal(app.copiedText(), text)
  assert.match(text, /# Phi Diagnostics/)
  assert.match(text, /App: Phi 9\.8\.7/)
  assert.match(text, /Permission mode: auto/)
  assert.match(text, /OpenAI \(openai\).*apiKey=yes/)
  assert.match(text, /Skills: 1/)
  assert.match(text, /MCP servers: 1/)
  assert.match(text, /Log directory: \/tmp\/phi\/logs/)
  assert.match(text, /Log retention days: 14/)
  assert.doesNotMatch(text, /sk-/)
  assert.doesNotMatch(text, /assistant final/)
  assert.doesNotMatch(text, /abcdefghijklmnop/)
  assert.doesNotMatch(text, /private chain of thought/)
  assert.equal(
    app.appLogs.some((entry) => entry.event === 'diagnostics_copied'),
    true
  )
  assert.equal(
    app.appLogs.some(
      (entry) =>
        entry.event === 'diagnostics_copied' &&
        JSON.stringify(entry.metadata ?? {}).includes('Phi Diagnostics')
    ),
    false
  )
})

test('main IPC: unavailable project paths are blocked before creating a project session', async () => {
  const app = await harness()

  await assert.rejects(
    app.invoke('projects:newSession', '/projects/missing-project', 'ask'),
    /项目路径不可用/
  )
  assert.equal(app.sessions.length, 0)
})

test('main IPC: plugin operations write compact support log events', async () => {
  const app = await harness()

  await app.invoke('plugins:install', 'npm:@phi/example')
  await app.invoke('plugins:remove', 'npm:@phi/example')

  assert.equal(
    app.appLogs.some(
      (entry) =>
        entry.event === 'plugin_installed' &&
        (entry.metadata as { source?: string }).source === 'npm:@phi/example'
    ),
    true
  )
  assert.equal(
    app.appLogs.some(
      (entry) =>
        entry.event === 'plugin_removed' &&
        (entry.metadata as { source?: string }).source === 'npm:@phi/example'
    ),
    true
  )
})

test(
  'main IPC: a late background session creation cannot overwrite the selected conversation',
  { timeout: 3000 },
  async () => {
    const gate = deferred<FakeSession>()
    const app = await harness(async (_cwd, file) =>
      file === 'A' ? gate.promise : new FakeSession(file)
    )
    const first = app.invoke('sessions:switch', 'A')
    await tick()
    const second = app.invoke('sessions:switch', 'B')
    gate.resolve(new FakeSession('A'))
    await Promise.all([first, second])
    assert.equal(((await app.invoke('sessions:current')) as { path: string }).path, 'B')
    assert.equal(app.sessions.find((session) => session.sessionFile === 'A')?.disposed, false)
  }
)

test(
  'main IPC: switching conversations keeps the old prompt running in the background',
  { timeout: 3000 },
  async () => {
    const app = await harness(async (_cwd, file) => {
      const session = new FakeSession(file)
      session.hold = true
      return session
    })
    await app.invoke('sessions:switch', 'A')
    const prompt = app.invoke('agent:prompt', 'hello')
    await tick()
    const old = app.sessions[0]
    await app.invoke('sessions:switch', 'B')
    const before = app.events.filter((event) => event.channel === 'agent:event').length
    old.listeners.forEach((listener) => listener({ type: 'message_update' }))
    assert.equal(app.events.filter((event) => event.channel === 'agent:event').length, before + 1)
    old.finish.resolve()
    assert.deepEqual(await prompt, {
      path: 'phi-session:phi-1',
      phiSessionId: 'phi-1',
      sessionGeneration: 0
    })
    assert.equal(((await app.invoke('sessions:current')) as { path: string }).path, 'B')
    await tick()
    assert.equal(old.disposed, false)
    assert.deepEqual(old.log, ['started', 'saved'])
  }
)

test('main IPC: switching sessions includes stored Phi timeline events', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'runtime' }] })
    return session
  })

  const result = (await app.invoke('sessions:switch', 'with-phi-events')) as { messages: unknown[] }

  assert.deepEqual(result.messages, [
    { role: 'assistant', content: [{ type: 'text', text: 'runtime' }] },
    {
      source: 'phi',
      preferPhiTimeline: true,
      eventId: 'event-user-existing',
      sessionId: 'phi-existing',
      createdAt: '2026-09-05T00:00:00.000Z',
      type: 'user_message',
      runId: 'run-existing',
      content: 'phi user'
    },
    {
      source: 'phi',
      preferPhiTimeline: true,
      eventId: 'event-existing',
      sessionId: 'phi-existing',
      createdAt: '2026-09-05T00:00:00.000Z',
      type: 'tool_call_completed',
      runId: 'run-existing',
      toolCallId: 'tool-existing',
      toolName: 'bash',
      output: 'restored'
    }
  ])
})

test(
  'main IPC: current fresh prompt includes the user question before runtime materializes',
  { timeout: 3000 },
  async () => {
    const gate = deferred<FakeSession>()
    const app = await harness(async () => gate.promise)
    const prompt = app.invoke('agent:prompt', 'where is my question')

    try {
      await tick()
      const current = (await app.invoke('sessions:current')) as {
        path: string | null
        phiSessionId?: string
        messages: Array<Record<string, unknown>>
      }

      assert.equal(current.path, 'phi-session:phi-1')
      assert.equal(current.phiSessionId, 'phi-1')
      assert.equal(
        current.messages.some(
          (message) =>
            message.source === 'phi' &&
            message.type === 'user_message' &&
            message.content === 'where is my question'
        ),
        true
      )
    } finally {
      gate.resolve(new FakeSession('fresh.jsonl'))
      await prompt
    }
  }
)

test(
  'main IPC: Phi-only failed prompts can be restored and materialized later',
  { timeout: 3000 },
  async () => {
    let failBeforeRuntime = true
    const app = await harness(async () => {
      if (failBeforeRuntime) throw new Error('余额不足')
      return new FakeSession('fresh.jsonl')
    })

    await assert.rejects(app.invoke('agent:prompt', '这里输入的聊天为什么消失'), /余额不足/)

    assert.equal(app.createdPhiSessions.length, 1)
    assert.equal(
      app.updatedSessionManifests.some((entry) => 'runtimeSessionPath' in entry.patch),
      false
    )

    const restored = (await app.invoke('sessions:switch', 'phi-session:phi-1')) as {
      path: string
      messages: Array<Record<string, unknown>>
    }

    assert.equal(restored.path, 'phi-session:phi-1')
    assert.equal(
      restored.messages.some(
        (message) =>
          message.source === 'phi' &&
          message.type === 'user_message' &&
          message.content === '这里输入的聊天为什么消失'
      ),
      true
    )

    failBeforeRuntime = false
    await app.invoke('sessions:switch', 'other.jsonl')
    await app.invoke('agent:prompt', '继续', restored)

    assert.equal(app.createdPhiSessions.length, 1)
    assert.deepEqual(
      app.updatedSessionManifests.filter((entry) => 'runtimeSessionPath' in entry.patch),
      [{ sessionId: 'phi-1', patch: { runtimeSessionPath: 'fresh.jsonl' } }]
    )
  }
)

test('main IPC: prompt target controls the write destination even after another session is current', async () => {
  const app = await harness()

  await app.invoke('sessions:switch', 'selected.jsonl')
  const selected = (await app.invoke('sessions:current')) as {
    path: string | null
    cwd: string
    sessionGeneration: number
  }
  await app.invoke('sessions:switch', 'other.jsonl')

  await app.invoke('agent:prompt', 'write to selected', selected)

  const selectedSession = app.sessions.find((session) => session.sessionFile === 'selected.jsonl')
  const otherSession = app.sessions.find((session) => session.sessionFile === 'other.jsonl')
  assert.equal(selectedSession?.promptTexts.length, 1)
  assert.match(selectedSession?.promptTexts[0] ?? '', /^write to selected/)
  assert.equal(otherSession?.promptTexts.length, 0)
  assert.equal(app.createdPhiSessions.at(-1)?.runtimeSessionPath, 'selected.jsonl')
  assert.equal(app.appendedSessionEvents.at(-1)?.event.content, 'write to selected')
})

test('main IPC: continuing a restored runtime conversation reuses its Phi session', async () => {
  const app = await harness()

  await app.invoke('sessions:switch', 'with-phi-events')
  await app.invoke('agent:prompt', 'continue existing')

  assert.equal(app.createdPhiSessions.length, 0)
  assert.equal(app.appendedSessionEvents.at(-1)?.sessionId, 'phi-existing')
  assert.equal(app.appendedSessionEvents.at(-1)?.event.content, 'continue existing')
})

test('main IPC: prompt target rejects stale fresh sessions instead of writing to the wrong chat', async () => {
  const app = await harness()

  const fresh = (await app.invoke('sessions:current')) as {
    path: string | null
    cwd: string
    sessionGeneration: number
  }
  await app.invoke('sessions:switch', 'other.jsonl')

  await assert.rejects(app.invoke('agent:prompt', 'must not leak', fresh), /当前会话已切换/)
  assert.equal(app.createdPhiSessions.length, 0)
  assert.equal(app.appendedSessionEvents.length, 0)
})

test(
  'main IPC: materialized runtime path is linked before notifying the renderer',
  { timeout: 3000 },
  async () => {
    const app = await harness()

    await app.invoke('agent:prompt', 'hello')

    const runtimePathPatchIndex = app.operationLog.findIndex((entry) => {
      const patch = entry.patch as { runtimeSessionPath?: unknown } | undefined
      return entry.type === 'updateSessionManifest' && patch?.runtimeSessionPath === 'fresh.jsonl'
    })
    const firstMaterializedNotifyIndex = app.operationLog.findIndex((entry) => {
      const data = entry.data as { path?: unknown } | undefined
      return (
        entry.type === 'webContents.send' &&
        entry.channel === 'sessions:changed' &&
        data?.path === 'phi-session:phi-1'
      )
    })

    assert.notEqual(runtimePathPatchIndex, -1)
    assert.notEqual(firstMaterializedNotifyIndex, -1)
    assert.equal(runtimePathPatchIndex < firstMaterializedNotifyIndex, true)
  }
)

test('main IPC: delayed runtime path materialization is linked to the Phi session', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(undefined)
    session.materializedSessionFile = file
    return session
  })

  const result = (await app.invoke('agent:prompt', 'first delayed message')) as {
    path: string | null
    phiSessionId?: string
  }

  assert.equal(result.path, 'phi-session:phi-1')
  assert.equal(result.phiSessionId, 'phi-1')
  assert.deepEqual(
    app.updatedSessionManifests.filter((entry) => 'runtimeSessionPath' in entry.patch),
    [{ sessionId: 'phi-1', patch: { runtimeSessionPath: 'fresh.jsonl' } }]
  )
})

test('main IPC: continuing a freshly materialized conversation reuses its Phi session', async () => {
  const app = await harness()

  const first = (await app.invoke('agent:prompt', 'first message')) as {
    path: string | null
    cwd?: string
    sessionGeneration: number
  }
  await app.invoke('agent:prompt', 'second message', {
    path: first.path,
    cwd: first.cwd ?? '/workspace',
    sessionGeneration: first.sessionGeneration
  })

  const userEvents = app.appendedSessionEvents.filter(
    (entry) => (entry.event as { type?: string }).type === 'user_message'
  )
  assert.equal(app.createdPhiSessions.length, 1)
  assert.deepEqual(
    userEvents.map((entry) => entry.sessionId),
    ['phi-1', 'phi-1']
  )
  assert.deepEqual(
    userEvents.map((entry) => (entry.event as { content?: string }).content),
    ['first message', 'second message']
  )
})

test('main IPC: acknowledging a session uses that session cwd without sidebar rebroadcasts', async () => {
  const app = await harness()

  await app.invoke('sessions:switch', 'A')
  await app.invoke('sessions:switch', 'B')
  const changedEventsBeforeAcknowledge = app.events.filter(
    (event) => event.channel === 'sessions:changed'
  ).length
  await app.invoke('sessions:acknowledge', 'A')
  const changedEventsAfterAcknowledge = app.events.filter(
    (event) => event.channel === 'sessions:changed'
  ).length

  assert.deepEqual(app.acknowledgedSessions.at(-1), { file: 'A', cwd: '/projects/A' })
  assert.equal(changedEventsAfterAcknowledge, changedEventsBeforeAcknowledge)
})

test(
  'main IPC: project resources use the active working directory',
  { timeout: 3000 },
  async () => {
    const app = await harness()
    await app.invoke('projects:newSession', '/projects/custom', 'ask')
    assert.match(
      ((await app.invoke('skills:list')) as Array<{ id: string }>)[0].id,
      /^\/projects\/custom/
    )
    assert.match(
      ((await app.invoke('agents:list')) as Array<{ id: string }>)[0].id,
      /^\/projects\/custom/
    )
    assert.match(
      ((await app.invoke('mcp:listServers')) as Array<{ id: string }>)[0].id,
      /^\/projects\/custom/
    )
  }
)

test('main IPC: analysis notebooks use the active project working directory', async () => {
  const app = await harness()

  const ordinary = (await app.invoke('analysis:listNotebooks')) as { message?: string }
  await app.invoke('projects:newSession', '/projects/research', 'ask')
  const registry = (await app.invoke('analysis:listNotebooks')) as {
    projectCwd: string
    projectName: string
    notebooks: Array<{ relativePath: string }>
  }
  const initialized = (await app.invoke('analysis:initializeProject', '/projects/research')) as {
    notebooksDir: string
    outputsDir: string
  }

  assert.equal(ordinary.message, '选择一个项目后显示 notebooks')
  assert.equal(registry.projectCwd, '/projects/research')
  assert.equal(registry.projectName, 'Project /projects/research')
  assert.deepEqual(
    registry.notebooks.map((notebook) => notebook.relativePath),
    ['notebooks/qc.ipynb']
  )
  assert.deepEqual(initialized, {
    notebooksDir: '/projects/research/notebooks',
    outputsDir: '/projects/research/outputs'
  })
})

test('main IPC: analysis notebook files use the selected project service', async () => {
  const app = await harness()

  await app.invoke('projects:newSession', '/projects/research', 'ask')
  const opened = (await app.invoke(
    'analysis:openNotebook',
    '/projects/research',
    'notebooks/qc.ipynb'
  )) as { path: string; relativePath: string; savedRevision: string }
  const saved = (await app.invoke('analysis:saveNotebook', '/projects/research', {
    path: '/projects/research/notebooks/qc.ipynb',
    document: { revision: 'nb-edited' },
    expectedRevision: opened.savedRevision
  })) as { relativePath: string; savedRevision: string }
  const created = (await app.invoke('analysis:createNotebook', '/projects/research')) as {
    relativePath: string
  }
  const closed = (await app.invoke(
    'analysis:closeNotebook',
    '/projects/research',
    'notebooks/qc.ipynb'
  )) as { path: string }
  const deleted = (await app.invoke(
    'analysis:deleteNotebook',
    '/projects/research',
    'notebooks/qc.ipynb'
  )) as { path: string; relativePath: string }

  assert.equal(opened.path, '/projects/research/notebooks/qc.ipynb')
  assert.equal(opened.relativePath, 'notebooks/qc.ipynb')
  assert.equal(saved.relativePath, 'notebooks/qc.ipynb')
  assert.equal(saved.savedRevision, 'nb-edited')
  assert.equal(created.relativePath, 'notebooks/Untitled.ipynb')
  assert.equal(closed.path, '/projects/research/notebooks/qc.ipynb')
  assert.equal(deleted.path, '/projects/research/notebooks/qc.ipynb')
  assert.equal(deleted.relativePath, 'notebooks/qc.ipynb')
})

test('main IPC: analysis kernel diagnostics require a known project when cwd is provided', async () => {
  const app = await harness()

  const diagnostics = (await app.invoke('analysis:listKernels', '/projects/research')) as {
    jupyterServer: { available: boolean; version: string }
    hasPythonKernel: boolean
    hasRKernel: boolean
  }

  assert.equal(diagnostics.jupyterServer.available, true)
  assert.equal(diagnostics.jupyterServer.version, '2.14.0')
  assert.equal(diagnostics.hasPythonKernel, true)
  assert.equal(diagnostics.hasRKernel, false)
  await assert.rejects(app.invoke('analysis:listKernels', '/missing/project'), /请选择/)
})

test('main IPC: analysis Jupyter server lifecycle uses the selected project', async () => {
  const app = await harness()

  const initial = (await app.invoke('analysis:jupyterStatus', '/projects/research')) as {
    projectCwd: string
    state: string
  }
  const started = (await app.invoke('analysis:startJupyter', '/projects/research')) as {
    state: string
    pid: number
    hasEndpoint: boolean
  }
  const stopped = (await app.invoke('analysis:stopJupyter', '/projects/research')) as {
    state: string
  }

  assert.equal(initial.projectCwd, '/projects/research')
  assert.equal(initial.state, 'stopped')
  assert.equal(started.state, 'starting')
  assert.equal(started.pid, 2026)
  assert.equal(started.hasEndpoint, false)
  assert.equal(stopped.state, 'stopped')
  assert.deepEqual(app.jupyterServerCalls, [
    { action: 'status', cwd: '/projects/research' },
    { action: 'start', cwd: '/projects/research' },
    { action: 'stop', cwd: '/projects/research' }
  ])
  await assert.rejects(app.invoke('analysis:startJupyter', '/missing/project'), /请选择/)
})

test('main IPC: analysis Jupyter runtime status combines server and notebook sessions', async () => {
  const app = await harness()

  const status = (await app.invoke('analysis:jupyterRuntimeStatus', '/projects/research')) as {
    server: { projectCwd: string; state: string }
    notebooks: {
      activeSessionCount: number
      busySessionCount: number
      sessions: Array<{ notebookPath: string; kernelDisplayName: string; state: string }>
    }
  }

  assert.equal(status.server.projectCwd, '/projects/research')
  assert.equal(status.server.state, 'stopped')
  assert.equal(status.notebooks.activeSessionCount, 1)
  assert.equal(status.notebooks.busySessionCount, 0)
  assert.equal(
    status.notebooks.sessions[0]?.notebookPath,
    '/projects/research/notebooks/demo.ipynb'
  )
  assert.equal(status.notebooks.sessions[0]?.kernelDisplayName, 'Python 3')
  assert.equal(status.notebooks.sessions[0]?.state, 'idle')
  assert.deepEqual(app.jupyterServerCalls, [{ action: 'status', cwd: '/projects/research' }])
  assert.deepEqual(app.notebookSessionCalls, [{ action: 'summary', cwd: '/projects/research' }])
  await assert.rejects(app.invoke('analysis:jupyterRuntimeStatus', '/missing/project'), /请选择/)
})

test('main IPC: analysis notebook kernel session lifecycle uses the selected project', async () => {
  const app = await harness()
  const document = {
    nbformat: 4,
    nbformatMinor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: [],
    extra: {},
    revision: 'nb-1'
  }

  const status = (await app.invoke(
    'analysis:notebookSessionStatus',
    '/projects/research',
    'notebooks/demo.ipynb',
    document
  )) as { state: string }
  const ensured = (await app.invoke(
    'analysis:ensureNotebookSession',
    '/projects/research',
    'notebooks/demo.ipynb',
    document
  )) as { state: string; sessionId: string }
  const closed = (await app.invoke(
    'analysis:closeNotebookSession',
    '/projects/research',
    'notebooks/demo.ipynb'
  )) as { state: string }

  assert.equal(status.state, 'disconnected')
  assert.equal(ensured.state, 'idle')
  assert.equal(ensured.sessionId, 'session-1')
  assert.equal(closed.state, 'disconnected')
  assert.deepEqual(app.notebookSessionCalls, [
    {
      action: 'status',
      cwd: '/projects/research',
      path: '/projects/research/notebooks/demo.ipynb'
    },
    {
      action: 'ensure',
      cwd: '/projects/research',
      path: '/projects/research/notebooks/demo.ipynb'
    },
    { action: 'close', cwd: '/projects/research', path: '/projects/research/notebooks/demo.ipynb' }
  ])
  await assert.rejects(
    app.invoke('analysis:ensureNotebookSession', '/missing/project', 'x.ipynb', document),
    /请选择/
  )
})

test('main IPC: analysis notebook completion asks the live kernel for matches', async () => {
  const app = await harness()
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: [
      {
        id: 'cell-1',
        cell_type: 'code',
        metadata: {},
        execution_count: null,
        outputs: [],
        source: 'df.he'
      }
    ]
  })

  const result = (await app.invoke('analysis:completeNotebookCell', '/projects/research', {
    path: 'notebooks/demo.ipynb',
    document,
    cellId: 'cell-1',
    source: 'df.he',
    cursorPosition: 99
  })) as { matches: string[]; cursorEnd: number; status: string }

  assert.equal(result.status, 'ok')
  assert.deepEqual(result.matches, ['df', 'df.head'])
  assert.equal(result.cursorEnd, 5)
  assert.deepEqual(app.notebookExecutionCalls.slice(-1), [
    {
      cellId: '__completion__',
      source: 'df.he',
      kernelId: 'kernel-1',
      cursorPosition: 5
    }
  ])
})

test('main IPC: analysis notebook formatting returns formatter edits', async () => {
  const app = await harness()
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: [
      {
        id: 'cell-1',
        cell_type: 'code',
        metadata: {},
        execution_count: null,
        outputs: [],
        source: 'x=1'
      }
    ]
  })

  const result = (await app.invoke('analysis:formatNotebookCell', '/projects/research', {
    path: 'notebooks/demo.ipynb',
    document,
    cellId: 'cell-1',
    source: 'x=1',
    language: 'python',
    lineLength: 100
  })) as { source: string; changed: boolean; formatter: string }

  assert.equal(result.source, 'x = 1')
  assert.equal(result.changed, true)
  assert.equal(result.formatter, 'ruff')
  assert.deepEqual(app.notebookFormatCalls, [
    {
      projectCwd: '/projects/research',
      source: 'x=1',
      language: 'python',
      lineLength: 100
    }
  ])
})

test('main IPC: analysis notebook cell execution updates the returned document', async () => {
  const app = await harness()
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: [
      {
        id: 'cell-1',
        cell_type: 'code',
        metadata: {},
        execution_count: null,
        outputs: [],
        source: 'print("ran")'
      }
    ]
  })

  const result = (await app.invoke(
    'analysis:executeNotebookCell',
    '/projects/research',
    'notebooks/demo.ipynb',
    document,
    'cell-1'
  )) as {
    document: notebookDocument.NotebookDocument
    sessionStatus: { state: string; message: string }
    executionCount: number
  }

  assert.equal(result.executionCount, 2)
  assert.equal(result.document.cells[0].executionCount, 2)
  assert.equal(result.document.cells[0].outputs[0].text, 'ran\n')
  assert.deepEqual(result.document.cells[0].metadata.phi, {
    executionStartedAt: '2026-09-09T00:00:00.000Z',
    executionCompletedAt: '2026-09-09T00:00:01.000Z',
    executionDurationMs: 1000
  })
  assert.equal(result.sessionStatus.state, 'idle')
  assert.deepEqual(app.notebookExecutionCalls, [
    { cellId: 'cell-1', source: 'print("ran")', kernelId: 'kernel-1' }
  ])
  assert.deepEqual(app.notebookSessionCalls.slice(-3), [
    {
      action: 'ensure',
      cwd: '/projects/research',
      path: '/projects/research/notebooks/demo.ipynb'
    },
    {
      action: 'state:busy',
      cwd: '/projects/research',
      path: '/projects/research/notebooks/demo.ipynb'
    },
    {
      action: 'state:idle',
      cwd: '/projects/research',
      path: '/projects/research/notebooks/demo.ipynb'
    }
  ])
})

test('main IPC: analysis notebook execution can be interrupted', async () => {
  const app = await harness()

  const status = (await app.invoke(
    'analysis:interruptNotebookExecution',
    '/projects/research',
    'notebooks/demo.ipynb'
  )) as { state: string; message: string }

  assert.equal(status.state, 'idle')
  assert.match(status.message, /停止请求/)
  assert.deepEqual(app.notebookSessionCalls.at(-1), {
    action: 'interrupt',
    cwd: '/projects/research',
    path: '/projects/research/notebooks/demo.ipynb'
  })
})

test('main IPC: notebook AI generation uses assistant event text when session history is empty', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.skipFinalAssistantMessage = true
    session.toolEvents = [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                cells: [
                  {
                    cellType: 'code',
                    source: 'def greedy(items):\n    return sorted(items)',
                    language: 'python'
                  }
                ]
              })
            }
          ]
        }
      }
    ]
    return session
  })
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: []
  })

  const result = (await app.invoke(
    'analysis:generateNotebookCode',
    '/projects/research',
    'notebooks/qc.ipynb',
    document,
    {
      prompt: '写一个贪心算法',
      language: 'python',
      afterCellId: null,
      references: []
    }
  )) as { source: string; language: string; cells: Array<{ cellType: string; source: string }> }

  assert.equal(result.language, 'python')
  assert.deepEqual(result.cells, [
    {
      cellType: 'code',
      source: 'def greedy(items):\n    return sorted(items)',
      language: 'python'
    }
  ])
  assert.equal(result.source, 'def greedy(items):\n    return sorted(items)')
  assert.equal(app.sessions[0].messages.length, 0)
  assert.equal(app.createdAgentOptions[0].noTools, 'all')
  assert.deepEqual(app.sessions[0].promptOptions[0], {
    expandPromptTemplates: false,
    userInitiated: true,
    skipCompactionCheck: true
  })
  assert.doesNotMatch(app.sessions[0].promptTexts[0], /"cellType":"code"/)
  assert.match(app.sessions[0].promptTexts[0], /NotebookCellsCompletion pattern/)
  assert.match(app.sessions[0].promptTexts[0], /Return exactly one JSON object/)
  assert.match(app.sessions[0].promptTexts[0], /Do not include prose outside JSON/)
})

test('main IPC: notebook AI generation enriches @ variables from the live kernel', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.skipFinalAssistantMessage = true
    session.toolEvents = [
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  cells: [{ language: 'python', code: 'df.describe()' }]
                })
              }
            ]
          }
        ]
      }
    ]
    return session
  })
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: [
      {
        id: 'load',
        cell_type: 'code',
        metadata: {},
        execution_count: 1,
        outputs: [],
        source: 'df = pd.read_json("use_data.json")'
      }
    ]
  })

  const result = (await app.invoke(
    'analysis:generateNotebookCode',
    '/projects/research',
    'notebooks/qc.ipynb',
    document,
    {
      prompt: '@df 总结数据',
      language: 'python',
      afterCellId: 'load',
      references: [
        {
          id: 'dataframe:df',
          kind: 'dataframe',
          name: 'df',
          detail: 'df = pd.read_json("use_data.json")',
          cellId: 'load',
          preview: { source: 'df = pd.read_json("use_data.json")' }
        }
      ]
    }
  )) as { cells: Array<{ cellType: string; source: string }> }

  assert.deepEqual(result.cells, [
    { cellType: 'code', source: 'df.describe()', language: 'python' }
  ])
  assert.ok(
    app.notebookExecutionCalls.some(
      (call) =>
        call.cellId === '__introspection__' && call.source === 'df' && call.kernelId === 'kernel-1'
    )
  )
  const prompt = app.sessions[0].promptTexts[0]
  assert.match(prompt, /@dataframe:\/\/df/)
  assert.match(prompt, /pandas\.core\.frame\.DataFrame/)
  assert.match(prompt, /2 rows x 3 columns/)
  assert.match(prompt, /Year \(object\), Income \(float64\)/)
  assert.match(prompt, /\| Year \| Income \|/)
})

test('main IPC: notebook AI generation reads batched assistant messages from runtime events', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.skipFinalAssistantMessage = true
    session.toolEvents = [
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  cells: [
                    {
                      cellType: 'code',
                      source: 'def choose(items):\n    return max(items)',
                      language: 'python'
                    }
                  ]
                })
              }
            ]
          }
        ]
      }
    ]
    return session
  })
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: []
  })

  const result = (await app.invoke(
    'analysis:generateNotebookCode',
    '/projects/research',
    'notebooks/qc.ipynb',
    document,
    {
      prompt: '写一个贪心算法',
      language: 'python',
      afterCellId: null,
      references: []
    }
  )) as { source: string; language: string; cells: Array<{ cellType: string; source: string }> }

  assert.deepEqual(result.cells, [
    {
      cellType: 'code',
      source: 'def choose(items):\n    return max(items)',
      language: 'python'
    }
  ])
  assert.equal(result.source, 'def choose(items):\n    return max(items)')
})

test('main IPC: notebook AI generation lets the prompt model override project defaults', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  cells: [
                    {
                      cellType: 'code',
                      source: 'answer = 42',
                      language: 'python'
                    }
                  ]
                })
              }
            ]
          }
        ]
      }
    ]
    return session
  })
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: []
  })

  await app.invoke(
    'analysis:generateNotebookCode',
    '/projects/defaults',
    'notebooks/qc.ipynb',
    document,
    {
      prompt: '写一个答案',
      language: 'python',
      model: { providerId: 'openai', modelId: 'gpt-test' },
      afterCellId: null,
      references: []
    }
  )

  assert.deepEqual(app.createdAgentOptions[0].model, {
    provider: 'openai',
    id: 'gpt-test',
    name: 'gpt-test',
    reasoning: true
  })
  assert.equal(app.createdAgentOptions[0].thinkingLevel, 'medium')
})

test('main IPC: notebook AI generation preserves markdown and code cells', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  cells: [
                    {
                      language: 'markdown',
                      code: '## 贪婪算法\n每一步选择当前看来最优的候选。'
                    },
                    {
                      language: 'python',
                      code: 'def greedy(values):\n    return sorted(values, reverse=True)'
                    }
                  ]
                })
              }
            ]
          }
        ]
      }
    ]
    return session
  })
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: []
  })

  const result = (await app.invoke(
    'analysis:generateNotebookCode',
    '/projects/research',
    'notebooks/qc.ipynb',
    document,
    {
      prompt: '写一个贪婪算法，并解释思路',
      language: 'python',
      afterCellId: null,
      references: []
    }
  )) as { source: string; language: string; cells: Array<{ cellType: string; source: string }> }

  assert.deepEqual(result.cells, [
    {
      cellType: 'markdown',
      source: '## 贪婪算法\n每一步选择当前看来最优的候选。'
    },
    {
      cellType: 'code',
      source: 'def greedy(values):\n    return sorted(values, reverse=True)',
      language: 'python'
    }
  ])
  assert.equal(
    result.source,
    '## 贪婪算法\n每一步选择当前看来最优的候选。\n\n' +
      'def greedy(values):\n    return sorted(values, reverse=True)'
  )
})

test('main IPC: notebook AI generation chooses the full done message over a short streaming partial', async () => {
  let sessionCount = 0
  const app = await harness(async (_cwd, file) => {
    sessionCount += 1
    const session = new FakeSession(file)
    session.skipFinalAssistantMessage = true
    if (sessionCount > 1) {
      session.toolEvents = [
        {
          type: 'message_update',
          message: { role: 'assistant' },
          assistantMessageEvent: {
            type: 'text_delta',
            delta: JSON.stringify({
              cells: [
                {
                  language: 'markdown',
                  code: '## 折线图：各国\n\n下面的代码绘制各国收入随年份变化的折线图。'
                },
                {
                  language: 'python',
                  code: [
                    'fig, ax = plt.subplots()',
                    'income_by_country.T.plot(ax=ax)',
                    'ax.set_title("各国收入趋势")',
                    'ax'
                  ].join('\n')
                }
              ]
            })
          }
        }
      ]
      return session
    }
    session.toolEvents = [
      {
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: {
          type: 'partial',
          partial: {
            role: 'assistant',
            content: [{ type: 'text', text: '折线图：各国' }]
          }
        }
      },
      {
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: {
          type: 'done',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: [
                  '## 折线图：各国',
                  '',
                  '下面的代码绘制各国收入随年份变化的折线图。',
                  '',
                  '```python',
                  'fig, ax = plt.subplots()',
                  'income_by_country.T.plot(ax=ax)',
                  'ax.set_title("各国收入趋势")',
                  'ax',
                  '```'
                ].join('\n')
              }
            ]
          }
        }
      }
    ]
    return session
  })
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: []
  })

  const result = (await app.invoke(
    'analysis:generateNotebookCode',
    '/projects/research',
    'notebooks/qc.ipynb',
    document,
    {
      prompt: '画各国收入折线图',
      language: 'python',
      requestId: 'notebook-ai-stream-1',
      afterCellId: null,
      references: []
    }
  )) as { source: string; language: string; cells: Array<{ cellType: string; source: string }> }

  assert.equal(app.sessions.length, 1)
  assert.deepEqual(result.cells, [
    {
      cellType: 'code',
      source:
        'fig, ax = plt.subplots()\n' +
        'income_by_country.T.plot(ax=ax)\n' +
        'ax.set_title("各国收入趋势")\n' +
        'ax',
      language: 'python'
    }
  ])
  assert.match(result.source, /income_by_country\.T\.plot/)
  assert.notStrictEqual(result.source, '折线图：各国')
  const progressEvents = app.events.filter(
    (event) => event.channel === 'analysis:notebookCodeGenerationProgress'
  ) as Array<{
    channel: string
    data: {
      requestId: string
      source: string
      cells: Array<{ cellType: string; source: string }>
    }
  }>
  assert.equal(progressEvents.at(-1)?.data.requestId, 'notebook-ai-stream-1')
  assert.match(progressEvents.at(-1)?.data.source ?? '', /income_by_country\.T\.plot/)
  assert.deepEqual(
    progressEvents.at(-1)?.data.cells.map((cell) => cell.cellType),
    ['code']
  )
})

test('main IPC: notebook AI generation streams staged cells from partial NotebookCellsCompletion JSON', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.skipFinalAssistantMessage = true
    session.toolEvents = [
      {
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: {
          type: 'text_delta',
          delta: '{"cells":[{"language":"markdown","code":"## Summary"},'
        }
      },
      {
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: {
          type: 'text_delta',
          delta: '{"language":"python","code":"result = df.describe()"}]}'
        }
      }
    ]
    return session
  })
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: []
  })

  const result = (await app.invoke(
    'analysis:generateNotebookCode',
    '/projects/research',
    'notebooks/qc.ipynb',
    document,
    {
      prompt: '总结 df',
      language: 'python',
      requestId: 'notebook-ai-json-stream',
      afterCellId: null,
      references: []
    }
  )) as { cells: Array<{ cellType: string; source: string }> }
  const progressEvents = app.events.filter(
    (event) => event.channel === 'analysis:notebookCodeGenerationProgress'
  ) as Array<{
    data: {
      requestId: string
      cells: Array<{ cellType: string; source: string }>
    }
  }>

  assert.deepEqual(
    progressEvents.map((event) => event.data.cells.map((cell) => cell.cellType)),
    [['markdown'], ['markdown', 'code']]
  )
  assert.equal(progressEvents[0].data.requestId, 'notebook-ai-json-stream')
  assert.deepEqual(
    result.cells.map((cell) => cell.cellType),
    ['markdown', 'code']
  )
})

test('main IPC: notebook AI generation does not insert incomplete streamed JSON snapshots', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.skipFinalAssistantMessage = true
    session.toolEvents = [
      {
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: {
          type: 'text_delta',
          delta: '{"cells":[{"language":"markdown","code":"##"}'
        }
      }
    ]
    return session
  })
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: []
  })

  await assert.rejects(
    app.invoke(
      'analysis:generateNotebookCode',
      '/projects/research',
      'notebooks/qc.ipynb',
      document,
      {
        prompt: '写一个快速排序算法',
        language: 'python',
        requestId: 'notebook-ai-incomplete-json',
        afterCellId: null,
        references: []
      }
    ),
    /AI 没有生成可插入内容/
  )

  const progressEvents = app.events.filter(
    (event) => event.channel === 'analysis:notebookCodeGenerationProgress'
  )
  assert.equal(progressEvents.length, 0)
})

test('main IPC: notebook AI generation repairs prose transcripts into NotebookCellsCompletion JSON', async () => {
  let sessionCount = 0
  const app = await harness(async (_cwd, file) => {
    sessionCount += 1
    const session = new FakeSession(file)
    session.skipFinalAssistantMessage = true
    if (sessionCount === 1) {
      session.toolEvents = [
        {
          type: 'message_update',
          message: { role: 'assistant' },
          assistantMessageEvent: {
            type: 'text_delta',
            delta: [
              '最安全的是使用 matplotlib 的 tab10 中差异大的颜色。',
              '',
              '我提供一个 markdown 解释 + 修改后的 code cell。',
              '',
              '返回 JSON，包含两个 cells: markdown + python。'
            ].join('\n')
          }
        }
      ]
    } else {
      session.toolEvents = [
        {
          type: 'message_update',
          message: { role: 'assistant' },
          assistantMessageEvent: {
            type: 'text_delta',
            delta: JSON.stringify({
              cells: [
                { language: 'markdown', code: '#### 配色更新' },
                {
                  language: 'python',
                  code: 'colors = ["#1b9e77", "#d95f02"]\nax = inc_line.plot(color=colors)\nax'
                }
              ]
            })
          }
        }
      ]
    }
    return session
  })
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: [
      {
        id: 'cell-20',
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: 'inc_line.plot(color=["#0072B2", "#E69F00"])'
      }
    ]
  })

  const result = (await app.invoke(
    'analysis:generateNotebookCode',
    '/projects/research',
    'notebooks/qc.ipynb',
    document,
    {
      prompt: '@cell-20 这个图片使用其他配色',
      language: 'python',
      requestId: 'notebook-ai-repair-json',
      afterCellId: 'cell-20',
      references: []
    }
  )) as { cells: Array<{ cellType: string; source: string; language?: string }> }

  assert.equal(app.sessions.length, 2)
  assert.match(app.sessions[1].promptTexts[0], /Invalid previous model output/)
  assert.match(app.sessions[1].promptTexts[0], /我提供一个 markdown 解释/)
  assert.equal(app.sessions[1].promptOptions[0].synthetic, true)
  assert.deepEqual(result.cells, [
    { cellType: 'markdown', source: '#### 配色更新' },
    {
      cellType: 'code',
      source: 'colors = ["#1b9e77", "#d95f02"]\nax = inc_line.plot(color=colors)\nax',
      language: 'python'
    }
  ])
})

test('main IPC: notebook AI generation accepts a clear fenced code answer', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.skipFinalAssistantMessage = true
    session.toolEvents = [
      {
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: {
          type: 'text_delta',
          delta: [
            '下面是替换后的 Cell 20 代码：',
            '',
            '```python',
            'colors = ["#1b9e77", "#d95f02"]',
            'ax = inc_line.plot(color=colors)',
            'ax',
            '```'
          ].join('\n')
        }
      }
    ]
    return session
  })
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: [
      {
        id: 'cell-20',
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: 'inc_line.plot(color=["#0072B2", "#E69F00"])'
      }
    ]
  })

  const result = (await app.invoke(
    'analysis:generateNotebookCode',
    '/projects/research',
    'notebooks/qc.ipynb',
    document,
    {
      prompt: '@cell-20 这个图片使用其他配色',
      language: 'python',
      requestId: 'notebook-ai-fenced-code',
      afterCellId: 'cell-20',
      references: []
    }
  )) as { cells: Array<{ cellType: string; source: string; language?: string }> }

  assert.equal(app.sessions.length, 1)
  assert.deepEqual(result.cells, [
    {
      cellType: 'code',
      source: 'colors = ["#1b9e77", "#d95f02"]\nax = inc_line.plot(color=colors)\nax',
      language: 'python'
    }
  ])
})

test('main IPC: notebook AI generation accepts provider delta object text', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.skipFinalAssistantMessage = true
    session.toolEvents = [
      {
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: {
          type: 'message_delta',
          delta: {
            content: [
              {
                type: 'output_text',
                text: [
                  '下面是替换后的 Cell 20 代码：',
                  '',
                  '```python',
                  'colors = ["#1b9e77", "#d95f02"]',
                  'ax = inc_line.plot(color=colors)',
                  'ax',
                  '```'
                ].join('\n')
              }
            ]
          }
        }
      }
    ]
    return session
  })
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: [
      {
        id: 'cell-20',
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: 'inc_line.plot(color=["#0072B2", "#E69F00"])'
      }
    ]
  })

  const result = (await app.invoke(
    'analysis:generateNotebookCode',
    '/projects/research',
    'notebooks/qc.ipynb',
    document,
    {
      prompt: '@cell-20 这个图片使用其他配色',
      language: 'python',
      requestId: 'notebook-ai-provider-delta',
      afterCellId: 'cell-20',
      references: []
    }
  )) as { cells: Array<{ cellType: string; source: string; language?: string }> }

  assert.equal(app.sessions.length, 1)
  assert.deepEqual(result.cells, [
    {
      cellType: 'code',
      source: 'colors = ["#1b9e77", "#d95f02"]\nax = inc_line.plot(color=colors)\nax',
      language: 'python'
    }
  ])
})

test('main IPC: notebook AI generation accepts raw code answers', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.skipFinalAssistantMessage = true
    session.toolEvents = [
      {
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: {
          type: 'text_delta',
          delta: ['colors = ["#1b9e77", "#d95f02"]', 'ax = inc_line.plot(color=colors)', 'ax'].join(
            '\n'
          )
        }
      }
    ]
    return session
  })
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: [
      {
        id: 'cell-20',
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: 'inc_line.plot(color=["#0072B2", "#E69F00"])'
      }
    ]
  })

  const result = (await app.invoke(
    'analysis:generateNotebookCode',
    '/projects/research',
    'notebooks/qc.ipynb',
    document,
    {
      prompt: '@cell-20 这个图片使用其他配色',
      language: 'python',
      requestId: 'notebook-ai-raw-code',
      afterCellId: 'cell-20',
      references: []
    }
  )) as { cells: Array<{ cellType: string; source: string; language?: string }> }

  assert.equal(app.sessions.length, 1)
  assert.deepEqual(result.cells, [
    {
      cellType: 'code',
      source: 'colors = ["#1b9e77", "#d95f02"]\nax = inc_line.plot(color=colors)\nax',
      language: 'python'
    }
  ])
})

test('main IPC: notebook AI generation uses assistant done event before session history', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      {
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: {
          type: 'done',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  cells: [
                    {
                      cellType: 'code',
                      source: 'def greedy(items):\n    return sorted(items, reverse=True)',
                      language: 'python'
                    }
                  ]
                })
              }
            ]
          }
        }
      }
    ]
    return session
  })
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: []
  })

  const result = (await app.invoke(
    'analysis:generateNotebookCode',
    '/projects/research',
    'notebooks/qc.ipynb',
    document,
    {
      prompt: '写一个贪心算法',
      language: 'python',
      afterCellId: null,
      references: []
    }
  )) as { source: string; language: string; cells: Array<{ cellType: string; source: string }> }

  assert.equal(result.language, 'python')
  assert.deepEqual(result.cells, [
    {
      cellType: 'code',
      source: 'def greedy(items):\n    return sorted(items, reverse=True)',
      language: 'python'
    }
  ])
  assert.equal(result.source, 'def greedy(items):\n    return sorted(items, reverse=True)')
  assert.deepEqual(app.sessions[0].messages, [
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] }
  ])
})

test('main IPC: notebook AI generation surfaces assistant event errors', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.skipFinalAssistantMessage = true
    session.toolEvents = [
      {
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: {
          type: 'error',
          error: { errorMessage: 'Provider failed before returning notebook cells' }
        }
      }
    ]
    return session
  })
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: []
  })

  await assert.rejects(
    app.invoke(
      'analysis:generateNotebookCode',
      '/projects/research',
      'notebooks/qc.ipynb',
      document,
      {
        prompt: '写一个贪心算法',
        language: 'python',
        afterCellId: null,
        references: []
      }
    ),
    /Provider failed before returning notebook cells/
  )
})

test('main IPC: project agent sessions receive active notebook and app Jupyter context', async () => {
  const app = await harness()

  await app.invoke('projects:newSession', '/projects/research', 'auto')
  await app.invoke('analysis:openNotebook', '/projects/research', 'notebooks/qc.ipynb')
  await app.invoke('agent:prompt', '运行当前 notebook 的最后一个 cell')

  const resourceOptions = app.resourceLoaderOptions.at(-1)
  const appendSystemPrompt = resourceOptions?.appendSystemPrompt as string[] | undefined
  assert.ok(appendSystemPrompt?.length)
  const notebookPrompt = appendSystemPrompt.join('\n')
  assert.match(notebookPrompt, /<phi_notebook_runtime>/)
  assert.match(notebookPrompt, /Active notebook: notebooks\/qc\.ipynb/)
  assert.match(notebookPrompt, /Phi app-managed Jupyter Server/)
  assert.match(
    notebookPrompt,
    /Do not assume, probe, or instruct the user to restart JupyterLab on localhost:8888/
  )
  assert.match(notebookPrompt, /notebook\.run_cell/)
})

test(
  'main IPC: prompt text and tool events are persisted with large output previews',
  { timeout: 3000 },
  async () => {
    const app = await harness(async (_cwd, file) => {
      const session = new FakeSession(file)
      session.toolEvents = [
        {
          type: 'tool_execution_start',
          toolCallId: 'tool-1',
          toolName: 'bash',
          args: { command: 'printf long' }
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'tool-1',
          toolName: 'bash',
          result: { output: 'abcdefghijklmnop' },
          isError: false
        },
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'assistant final' }]
          }
        }
      ]
      return session
    })

    await app.invoke('agent:prompt', 'run tool')

    assert.deepEqual(app.appendedSessionEvents, [
      {
        sessionId: 'phi-1',
        event: {
          type: 'user_message',
          runId: 'run-2',
          content: 'run tool'
        }
      },
      {
        sessionId: 'phi-1',
        event: {
          type: 'tool_call_started',
          runId: 'run-2',
          toolCallId: 'tool-1',
          toolName: 'bash',
          args: { command: 'printf long' }
        }
      },
      {
        sessionId: 'phi-1',
        event: {
          type: 'tool_call_completed',
          runId: 'run-2',
          toolCallId: 'tool-1',
          toolName: 'bash',
          isError: false,
          output: 'abcdefgh\n...saved',
          outputBytes: 16,
          outputTruncated: true,
          outputPath: '/tool-outputs/tool-1.txt',
          outputArtifact: {
            kind: 'tool_output',
            path: '/tool-outputs/tool-1.txt',
            bytes: 16
          }
        }
      },
      {
        sessionId: 'phi-1',
        event: {
          type: 'assistant_message_finalized',
          runId: 'run-2',
          content: 'assistant final'
        }
      }
    ])
    assert.deepEqual(app.persistedToolOutputs, [
      {
        sessionId: 'phi-1',
        input: {
          runId: 'run-2',
          toolCallId: 'tool-1',
          output: 'abcdefghijklmnop',
          inlineLimit: 20000
        }
      }
    ])
    const toolEnd = app.events.find(
      (event) =>
        event.channel === 'agent:event' &&
        (event.data as { type?: string; toolCallId?: string }).type === 'tool_execution_end'
    )
    assert.deepEqual((toolEnd?.data as { result?: unknown }).result, {
      output: 'abcdefgh\n...saved',
      outputPath: '/tool-outputs/tool-1.txt',
      outputBytes: 16,
      truncated: true,
      outputArtifact: {
        kind: 'tool_output',
        path: '/tool-outputs/tool-1.txt',
        bytes: 16
      }
    })
  }
)

test('main IPC: current conversation permission mode affects the next run', async () => {
  const app = await harness()

  const current = (await app.invoke('sessions:updatePermissionMode', 'ask')) as {
    permissionMode: string
  }
  assert.equal(current.permissionMode, 'ask')

  await app.invoke('agent:prompt', 'needs permission')

  assert.equal(app.approvalOptions.length, 1)
})

test('main IPC: permission mode changes stay scoped to the selected conversation', async () => {
  const app = await harness()

  const first = (await app.invoke('sessions:switch', 'alpha')) as { permissionMode: string }
  assert.equal(first.permissionMode, 'ask')

  const updated = (await app.invoke('sessions:updatePermissionMode', 'full')) as {
    permissionMode: string
  }
  assert.equal(updated.permissionMode, 'full')

  const second = (await app.invoke('sessions:switch', 'beta')) as { permissionMode: string }
  assert.equal(second.permissionMode, 'ask')

  const restored = (await app.invoke('sessions:switch', 'alpha')) as { permissionMode: string }
  assert.equal(restored.permissionMode, 'full')
})

test('main IPC: full access permission mode runs without approval extension', async () => {
  const app = await harness()

  const current = (await app.invoke('sessions:updatePermissionMode', 'full')) as {
    permissionMode: string
  }
  assert.equal(current.permissionMode, 'full')

  await app.invoke('agent:prompt', 'full access')

  assert.equal(app.approvalOptions.length, 0)
})

test(
  'main IPC: assistant thinking deltas are persisted as timeline items',
  { timeout: 3000 },
  async () => {
    const app = await harness(async (_cwd, file) => {
      const session = new FakeSession(file)
      session.toolEvents = [
        { type: 'message_start', message: { role: 'assistant' } },
        {
          type: 'message_update',
          message: { role: 'assistant' },
          createdAt: '2026-09-07T00:00:00.000Z',
          assistantMessageEvent: {
            type: 'thinking_delta',
            contentIndex: 0,
            delta: 'Inspect '
          }
        },
        {
          type: 'message_update',
          message: { role: 'assistant' },
          createdAt: '2026-09-07T00:00:02.000Z',
          assistantMessageEvent: {
            type: 'thinking_delta',
            contentIndex: 0,
            delta: 'before answering.'
          }
        },
        {
          type: 'message_end',
          createdAt: '2026-09-07T00:00:04.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Done.' }]
          }
        }
      ]
      return session
    })

    await app.invoke('agent:prompt', 'hello')

    assert.deepEqual(
      app.appendedSessionEvents.map((entry) => (entry.event as { type: string }).type),
      ['user_message', 'assistant_thinking_completed', 'assistant_message_finalized']
    )
    assert.equal(
      (app.appendedSessionEvents[1].event as { content?: string }).content,
      'Inspect before answering.'
    )
    assert.equal((app.appendedSessionEvents[1].event as { durationMs?: number }).durationMs, 4000)
  }
)

test('main IPC: assistant failures preserve thinking timing in Phi timeline', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      { type: 'message_start', message: { role: 'assistant' } },
      {
        type: 'message_update',
        message: { role: 'assistant' },
        createdAt: '2026-09-07T00:00:00.000Z',
        assistantMessageEvent: {
          type: 'thinking_delta',
          contentIndex: 0,
          delta: 'Check provider '
        }
      },
      {
        type: 'message_update',
        message: { role: 'assistant' },
        createdAt: '2026-09-07T00:00:02.000Z',
        assistantMessageEvent: {
          type: 'thinking_delta',
          contentIndex: 0,
          delta: 'before failing.'
        }
      },
      {
        type: 'message_end',
        createdAt: '2026-09-07T00:00:05.000Z',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: '404 Not found the model kimi-k2.5 or Permission denied'
        }
      }
    ]
    return session
  })

  await app.invoke('agent:prompt', 'hello')

  assert.deepEqual(
    app.appendedSessionEvents.map((entry) => (entry.event as { type: string }).type),
    ['user_message', 'assistant_thinking_completed', 'run_failed']
  )
  assert.deepEqual(app.appendedSessionEvents[1].event, {
    type: 'assistant_thinking_completed',
    runId: 'run-2',
    content: 'Check provider before failing.',
    createdAt: '2026-09-07T00:00:05.000Z',
    durationMs: 5000
  })
})

test('main IPC: context compaction events are persisted as timeline notices', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      {
        type: 'auto_compaction_start',
        reason: 'threshold',
        action: 'remote'
      },
      {
        type: 'auto_compaction_end',
        action: 'remote',
        result: {
          summary: 'Full compaction summary.',
          shortSummary: 'Short compaction summary.',
          tokensBefore: 12345
        },
        aborted: false,
        willRetry: false
      }
    ]
    return session
  })

  await app.invoke('agent:prompt', 'hello')

  const event = app.appendedSessionEvents.find(
    (entry) => (entry.event as { type?: string }).type === 'context_compacted'
  )?.event as Record<string, unknown> | undefined
  assert.deepEqual(event, {
    type: 'context_compacted',
    runId: 'run-2',
    action: 'remote',
    reason: 'threshold',
    shortSummary: 'Short compaction summary.',
    summary: 'Full compaction summary.',
    tokensBefore: 12345
  })
})

test('main IPC: project sessions inherit project model defaults', { timeout: 3000 }, async () => {
  const app = await harness()
  await app.invoke('projects:newSession', '/projects/defaults', 'ask')
  await app.invoke('agent:prompt', 'hello')

  assert.deepEqual(app.createdPhiSessions[0].model, {
    providerId: 'anthropic',
    modelId: 'claude-test'
  })
  assert.equal(app.createdPhiSessions[0].thinkingLevel, 'medium')
  assert.deepEqual(app.createdAgentOptions[0].model, {
    provider: 'anthropic',
    id: 'claude-test',
    name: 'claude-test',
    reasoning: true
  })
  assert.equal(app.createdAgentOptions[0].thinkingLevel, 'medium')
})

test(
  'main IPC: unavailable session model fails before SDK session creation',
  {
    timeout: 3000
  },
  async () => {
    const app = await harness()
    await app.invoke('projects:newSession', '/projects/unavailable', 'ask')

    await assert.rejects(app.invoke('agent:prompt', 'hello'), /模型不可用: missing\/gone/)

    assert.deepEqual(app.createdPhiSessions[0].model, {
      providerId: 'missing',
      modelId: 'gone'
    })
    assert.equal(app.createdAgentOptions.length, 0)
  }
)

test('main IPC: prompt failures keep Phi timeline linked to the runtime session', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.promptError = new Error(
      '401 Invalid Authentication\nInvalid Authentication (type=invalid_authentication_error)'
    )
    return session
  })

  await assert.rejects(app.invoke('agent:prompt', 'hello'), /Invalid Authentication/)

  assert.deepEqual(
    app.updatedSessionManifests.filter((entry) => 'runtimeSessionPath' in entry.patch),
    [{ sessionId: 'phi-1', patch: { runtimeSessionPath: 'fresh.jsonl' } }]
  )
})

test('main IPC: assistant error message ends are restored after switching sessions', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage:
            '429 Your account org-930ebedfe4d54cf998034940e3c937c1<ak-fch4ix7rq6wi11c3z111> request reached organization max RPM: 3'
        }
      }
    ]
    return session
  })

  await app.invoke('agent:prompt', 'hello')
  await app.invoke('sessions:switch', 'other')
  const restored = (await app.invoke('sessions:switch', 'fresh.jsonl')) as { messages: unknown[] }

  assert.match(JSON.stringify(restored.messages), /run_failed/)
  assert.match(JSON.stringify(restored.messages), /request reached organization max RPM/)
  assert.doesNotMatch(JSON.stringify(restored.messages), /org-930/)
  assert.doesNotMatch(JSON.stringify(restored.messages), /ak-fch/)
})

test('main IPC: current session restores assistant error message ends after renderer refresh', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage:
            '404 Not found the model kimi-k2.5 or Permission denied (type=resource_not_found_error)'
        }
      }
    ]
    return session
  })

  await app.invoke('agent:prompt', 'hello')
  const restored = (await app.invoke('sessions:current')) as { messages?: unknown[] }

  assert.ok(Array.isArray(restored.messages))
  assert.match(JSON.stringify(restored.messages), /run_failed/)
  assert.match(JSON.stringify(restored.messages), /kimi-k2\.5/)
  assert.match(JSON.stringify(restored.messages), /resource_not_found_error/)
})

test(
  'main IPC: current session model selection overrides project defaults',
  { timeout: 3000 },
  async () => {
    const app = await harness()
    await app.invoke('projects:newSession', '/projects/defaults', 'ask')
    await app.invoke('models:select', 'openai', 'gpt-session')
    await app.invoke('thinking:select', 'high')
    await app.invoke('agent:prompt', 'hello')

    assert.deepEqual(app.createdPhiSessions[0].model, {
      providerId: 'anthropic',
      modelId: 'claude-test'
    })
    assert.equal(app.createdPhiSessions[0].thinkingLevel, 'medium')
    assert.deepEqual(
      app.updatedSessionManifests.filter((entry) => 'model' in entry.patch),
      [
        {
          sessionId: 'phi-1',
          patch: { model: { providerId: 'openai', modelId: 'gpt-session' } }
        }
      ]
    )
    assert.deepEqual(
      app.updatedSessionManifests.filter((entry) => 'thinkingLevel' in entry.patch),
      [{ sessionId: 'phi-1', patch: { thinkingLevel: 'high' } }]
    )
    assert.deepEqual(app.createdAgentOptions[0].model, {
      provider: 'openai',
      id: 'gpt-session',
      name: 'gpt-session',
      reasoning: true
    })
  }
)

test('main IPC: model list hides retired Kimi Code K2 entries', async () => {
  const app = await harness()
  const models = (await app.invoke('models:list')) as Array<{ providerId: string; modelId: string }>

  assert.equal(
    models.some((model) => model.providerId === 'kimi-code' && model.modelId === 'kimi-k2.5'),
    false
  )
  assert.equal(
    models.some((model) => model.providerId === 'kimi-code' && model.modelId === 'kimi-for-coding'),
    true
  )
})

test('main IPC: saved retired Kimi Code model selection migrates before prompting', async () => {
  const app = await harness()
  await app.invoke('projects:newSession', '/projects/kimi-retired', 'ask')
  await app.invoke('agent:prompt', 'hello')

  assert.deepEqual(app.createdPhiSessions[0].model, {
    providerId: 'kimi-code',
    modelId: 'kimi-k2.5'
  })
  assert.deepEqual(app.updatedSessionManifests[0], {
    sessionId: 'phi-1',
    patch: {
      model: {
        providerId: 'kimi-code',
        modelId: 'kimi-for-coding'
      }
    }
  })
  assert.deepEqual(app.createdAgentOptions[0].model, {
    provider: 'kimi-code',
    id: 'kimi-for-coding',
    name: 'kimi-for-coding',
    reasoning: true
  })
  assert.equal(
    app.appendedSessionEvents.some(
      (entry) => (entry.event as { type?: string }).type === 'model_selection_migrated'
    ),
    true
  )
})

test(
  'main IPC: starting another session in the same project emits one parallel warning',
  { timeout: 3000 },
  async () => {
    const app = await harness(async (_cwd, file) => {
      const session = new FakeSession(file)
      session.hold = true
      return session
    })

    await app.invoke('projects:newSession', '/projects/parallel', 'ask')
    const first = app.invoke('agent:prompt', 'first')
    await tick()

    await app.invoke('projects:newSession', '/projects/parallel', 'ask')
    const second = app.invoke('agent:prompt', 'second')
    await tick()

    const warnings = app.events.filter(
      (event) =>
        event.channel === 'agent:event' &&
        (event.data as { type?: string }).type === 'project_parallel_warning'
    )
    assert.equal(warnings.length, 1)
    assert.deepEqual(warnings[0].data, {
      type: 'project_parallel_warning',
      sessionGeneration: 0,
      sessionPath: 'phi-session:phi-2',
      cwd: '/projects/parallel',
      activeCount: 1
    })

    app.sessions.forEach((session) => session.finish.resolve())
    await Promise.all([first, second])
  }
)

test(
  'main IPC: project defaults update validates model availability',
  {
    timeout: 3000
  },
  async () => {
    const app = await harness()

    const project = await app.invoke('projects:updateDefaults', 'project-1', {
      defaultModel: { providerId: 'openai', modelId: 'gpt-project' },
      defaultThinkingLevel: 'high'
    })
    assert.deepEqual((project as { defaultModel: unknown }).defaultModel, {
      providerId: 'openai',
      modelId: 'gpt-project'
    })
    assert.deepEqual(app.updatedProjectDefaults, [
      {
        id: 'project-1',
        defaults: {
          defaultModel: { providerId: 'openai', modelId: 'gpt-project' },
          defaultThinkingLevel: 'high'
        }
      }
    ])

    await assert.rejects(
      app.invoke('projects:updateDefaults', 'project-1', {
        defaultModel: { providerId: 'missing', modelId: 'gone' }
      }),
      /模型不可用: missing\/gone/
    )
  }
)

test(
  'main IPC: same-tick conversation switches leave the latest selection current',
  { timeout: 3000 },
  async () => {
    const app = await harness()
    const first = app.invoke('sessions:switch', 'A')
    const second = app.invoke('sessions:switch', 'B')
    const [firstResult, secondResult] = await Promise.all([first, second])
    assert.equal((firstResult as { path: string }).path, 'A')
    assert.equal((secondResult as { path: string }).path, 'B')
    assert.equal(((await app.invoke('sessions:current')) as { path: string }).path, 'B')
  }
)

test('main IPC: direct conversation switch returns state without sidebar rebroadcasts', async () => {
  const app = await harness()
  const initialChangedEvents = app.events.filter(
    (event) => event.channel === 'sessions:changed'
  ).length

  const result = (await app.invoke('sessions:switch', 'A')) as { path: string; cwd: string }
  const changedEvents = app.events.filter((event) => event.channel === 'sessions:changed').length

  assert.equal(result.path, 'A')
  assert.equal(result.cwd, '/projects/A')
  assert.equal(changedEvents, initialChangedEvents)
  assert.deepEqual(app.acknowledgedSessions.at(-1), { file: 'A', cwd: '/projects/A' })
})

test(
  'main IPC: a new prompt after stop can run and persist normally',
  { timeout: 3000 },
  async () => {
    const session = new FakeSession('fresh.jsonl')
    session.hold = true
    const app = await harness(async () => session)
    const first = app.invoke('agent:prompt', 'first')
    await tick()
    await app.invoke('agent:stop')
    await first
    session.hold = false
    const next = await app.invoke('agent:prompt', 'next')
    assert.equal((next as { path: string }).path, 'phi-session:phi-1')
  }
)

test('main IPC: a session rejects a second prompt while running', { timeout: 3000 }, async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  const first = app.invoke('agent:prompt', 'first')
  await tick()
  await assert.rejects(app.invoke('agent:prompt', 'second'), /会话正在运行/)
  await app.invoke('agent:stop')
  await first
})

test(
  'main IPC: model and thinking selection during a run apply to the next prompt only',
  {
    timeout: 3000
  },
  async () => {
    const session = new FakeSession('fresh.jsonl')
    session.hold = true
    const app = await harness(async () => session)
    const prompt = app.invoke('agent:prompt', 'first')
    await tick()

    await app.invoke('models:select', 'openai', 'gpt-test')
    await app.invoke('thinking:select', 'medium')

    assert.equal(session.model?.id, undefined)
    assert.equal(session.thinkingLevel, 'high')
    assert.deepEqual(await app.invoke('models:selected'), {
      providerId: 'openai',
      modelId: 'gpt-test'
    })
    assert.equal(await app.invoke('thinking:selected'), 'medium')

    await app.invoke('agent:stop')
    await prompt
    session.hold = false
    await app.invoke('agent:prompt', 'second')

    assert.equal(session.model?.id, 'gpt-test')
    assert.equal(session.thinkingLevel, 'medium')
  }
)

test(
  'main IPC: permission mode changes during a run are saved without cancelling it',
  {
    timeout: 3000
  },
  async () => {
    const session = new FakeSession('fresh.jsonl')
    session.hold = true
    const app = await harness(async () => session)
    const prompt = app.invoke('agent:prompt', 'first')
    await tick()

    const current = (await app.invoke('sessions:updatePermissionMode', 'full')) as {
      permissionMode: string
    }

    assert.equal(current.permissionMode, 'full')
    assert.equal(session.disposed, false)
    assert.equal(session.log.includes('abort'), false)

    await app.invoke('agent:stop')
    await prompt
  }
)

test(
  'main IPC: active prompt limit rejects new runs without queueing',
  { timeout: 3000 },
  async () => {
    const app = await harness(async (_cwd, file) => {
      const session = new FakeSession(file)
      session.hold = true
      return session
    })
    const prompts: Array<Promise<unknown>> = []
    for (const file of ['A', 'B', 'C', 'D']) {
      await app.invoke('sessions:switch', file)
      prompts.push(app.invoke('agent:prompt', file))
      await tick()
    }

    await app.invoke('sessions:switch', 'E')
    await assert.rejects(app.invoke('agent:prompt', 'blocked'), /运行中的会话已达上限/)

    for (const session of app.sessions) {
      session.finish.resolve()
    }
    await Promise.all(prompts)
  }
)

test(
  'main IPC: project approval callbacks are tied to the active Phi session run',
  { timeout: 3000 },
  async () => {
    const app = await harness(async (_cwd, file) => {
      const session = new FakeSession(file)
      session.hold = true
      return session
    })
    await app.invoke('projects:newSession', '/projects/research', 'ask')
    const prompt = app.invoke('agent:prompt', 'needs shell')
    await tick()

    assert.equal(app.approvalOptions.length, 1)
    const options = app.approvalOptions[0] as {
      getContext: () => {
        sessionId: string
        sessionPath?: string
        runId: string
        cwd: string
        projectName?: string
      }
      onApprovalRequested: (request: {
        requestId: string
        sessionId: string
        toolName: string
        summary: string
      }) => void
      onApprovalResolved: (
        request: { requestId: string; sessionId: string },
        approved: boolean
      ) => void
      onApprovalCancelled: (request: { requestId: string; sessionId: string }) => void
    }
    const context = options.getContext()
    assert.deepEqual(
      {
        sessionId: context.sessionId,
        sessionPath: context.sessionPath,
        cwd: context.cwd,
        projectName: context.projectName
      },
      {
        sessionId: 'phi-1',
        sessionPath: 'phi-session:phi-1',
        cwd: '/projects/research',
        projectName: 'Project /projects/research'
      }
    )
    assert.match(context.runId, /^run-/)

    options.onApprovalRequested({
      requestId: 'approval-1',
      sessionId: context.sessionId,
      toolName: 'bash',
      summary: 'npm test'
    })
    options.onApprovalResolved({ requestId: 'approval-1', sessionId: context.sessionId }, false)
    options.onApprovalCancelled({ requestId: 'approval-2', sessionId: context.sessionId })

    assert.deepEqual(app.runnerEvents, [
      {
        type: 'approval_requested',
        sessionId: 'phi-1',
        approvalId: 'approval-1',
        metadata: { toolName: 'bash', summary: 'npm test' }
      },
      { type: 'approval_denied', sessionId: 'phi-1', approvalId: 'approval-1' },
      { type: 'approval_cancelled', sessionId: 'phi-1', approvalId: 'approval-2' }
    ])

    app.sessions[0].finish.resolve()
    await prompt
  }
)

test('main IPC: closing the window stops all active prompt runs', { timeout: 3000 }, async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.hold = true
    return session
  })

  await app.invoke('sessions:switch', 'A')
  const first = app.invoke('agent:prompt', 'first')
  await tick()
  await app.invoke('sessions:switch', 'B')
  const second = app.invoke('agent:prompt', 'second')
  await tick()

  await app.invoke('window:close')
  await Promise.all([first, second])

  assert.equal(
    app.runnerEvents.some((event) => event.type === 'stop_all'),
    true
  )
  assert.deepEqual(
    app.sessions.map((session) => session.log.includes('abort')),
    [true, true]
  )
})

test(
  'main IPC: returning to a background conversation reuses its live session',
  { timeout: 3000 },
  async () => {
    let aCreated = 0
    const app = await harness(async (_cwd, file) => {
      const session = new FakeSession(file)
      if (file === 'A') aCreated += 1
      return session
    })
    await app.invoke('sessions:switch', 'A')
    await app.invoke('sessions:switch', 'B')
    assert.equal(aCreated, 1)
    const back = app.invoke('sessions:switch', 'A')
    assert.equal(((await back) as { path: string }).path, 'A')
    assert.equal(aCreated, 1)
  }
)

test(
  'main IPC: switching back to a running project session returns active status',
  { timeout: 3000 },
  async () => {
    const app = await harness(async (cwd, file) => {
      const session = new FakeSession(file)
      if (cwd === '/projects/research') {
        session.hold = true
      }
      return session
    })

    await app.invoke('projects:newSession', '/projects/research', 'ask')
    const prompt = app.invoke('agent:prompt', 'long running')
    await tick()

    const current = (await app.invoke('sessions:current')) as {
      path: string | null
      status: string
      currentRunId?: string
      currentRunStartedAt?: string
    }
    assert.equal(current.path, 'phi-session:phi-1')
    assert.equal(current.status, 'running')
    assert.match(current.currentRunId ?? '', /^run-/)
    assert.equal(current.currentRunStartedAt, '2026-09-05T00:00:00.000Z')

    await app.invoke('sessions:switch', 'other')
    const restored = (await app.invoke('sessions:switch', 'phi-session:phi-1')) as {
      cwd: string
      status: string
      currentRunId?: string
    }
    assert.equal(restored.cwd, '/projects/research')
    assert.equal(restored.status, 'running')
    assert.match(restored.currentRunId ?? '', /^run-/)

    app.sessions[0].finish.resolve()
    await prompt
  }
)

test(
  'main IPC: deleting an idle active conversation removes its history',
  { timeout: 3000 },
  async () => {
    const old = new FakeSession('A')
    const app = await harness(async () => old)
    await app.invoke('sessions:switch', 'A')
    await app.invoke('sessions:delete', 'A')
    assert.deepEqual(app.deleted, ['A'])
  }
)

test(
  'main IPC: stopping immediately also cancels a prompt still queued for creation',
  { timeout: 3000 },
  async () => {
    const app = await harness()
    const prompt = app.invoke('agent:prompt', 'queued')
    await app.invoke('agent:stop')
    await prompt
    assert.equal(
      app.sessions.some((session) => session.started),
      false
    )
  }
)
