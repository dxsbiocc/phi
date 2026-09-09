import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import { formatDiagnostics } from '../src/main/agent/diagnostics'
import * as lifecycle from '../src/main/agent/session-lifecycle'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

type PromptOptions = { preflightResult?: (accepted: boolean) => void }
class FakeSession {
  readonly messages: unknown[] = []
  readonly listeners: Array<(event: unknown) => void> = []
  readonly log: string[] = []
  model?: { provider: string; id: string }
  thinkingLevel?: string
  preflight = Promise.resolve()
  abortGate = Promise.resolve()
  readonly finish = deferred<void>()
  toolEvents: unknown[] = []
  hold = false
  started = false
  disposed = false
  promptError?: Error
  constructor(readonly sessionFile: string) {}
  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.push(listener)
    return () => undefined
  }
  async prompt(_text: string, options?: PromptOptions): Promise<void> {
    await this.preflight
    options?.preflightResult?.(true)
    this.started = true
    this.log.push('started')
    for (const event of this.toolEvents) {
      this.listeners.forEach((listener) => listener(event))
    }
    if (this.promptError) throw this.promptError
    if (this.hold) await this.finish.promise
    this.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'done' }] })
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
  updatedProjectDefaults: Array<Record<string, unknown>>
  updatedSessionManifests: Array<{ sessionId: string; patch: Record<string, unknown> }>
  appendedSessionEvents: Array<Record<string, unknown>>
  persistedToolOutputs: Array<Record<string, unknown>>
  revealedPaths: string[]
  appLogs: Array<Record<string, unknown>>
  acknowledgedSessions: Array<{ file: string; cwd: string }>
  jupyterServerCalls: Array<{ action: string; cwd: string }>
  notebookSessionCalls: Array<{ action: string; cwd: string; path?: string }>
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
  const updatedProjectDefaults: Array<Record<string, unknown>> = []
  const updatedSessionManifests: Array<{ sessionId: string; patch: Record<string, unknown> }> = []
  const appendedSessionEvents: Array<Record<string, unknown>> = []
  const persistedToolOutputs: Array<Record<string, unknown>> = []
  const revealedPaths: string[] = []
  const appLogs: Array<Record<string, unknown>> = []
  const acknowledgedSessions: Array<{ file: string; cwd: string }> = []
  const jupyterServerCalls: Array<{ action: string; cwd: string }> = []
  const notebookSessionCalls: Array<{ action: string; cwd: string; path?: string }> = []
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
    closeProject(projectCwd: string): void {
      notebookSessionCalls.push({ action: 'closeProject', cwd: projectCwd })
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
    path,
    electron: {
      app,
      BrowserWindow: Window,
      shell: {
        openExternal: noop,
        showItemInFolder: (filePath: string): void => {
          revealedPaths.push(filePath)
        }
      },
      clipboard: {
        writeText: (text: string): void => {
          copiedText = text
        }
      },
      dialog: {},
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
    './agent/runtime-adapter': {
      createRuntimeResourceLoader: (): unknown => ({
        async reload(): Promise<void> {
          return
        }
      }),
      createInMemoryRuntimeSessionManager: (cwd: string): { file: string; cwd: string } => ({
        file: 'in-memory',
        cwd
      }),
      openRuntimeSessionManager: (file: string): { getCwd: () => string } => ({
        getCwd: () => runtimeSessionCwds.get(file) ?? `/projects/${file}`
      })
    },
    './agent/session-manager': {
      createAgentSession: async (options: {
        cwd: string
        sessionManager: { file: string }
        model?: { provider: string; id: string }
        thinkingLevel?: string
      }): Promise<{ session: FakeSession }> => {
        createdAgentOptions.push(options)
        const session = factory
          ? await factory(options.cwd, options.sessionManager.file)
          : new FakeSession(options.sessionManager.file)
        session.model = options.model
        session.thinkingLevel = options.thinkingLevel
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
    './agent/sessions': {
      WORKSPACE_DIR: '/workspace',
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
    './agent/analysis-notebooks': {
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
    './agent/analysis-notebook-files': {
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
      })
    },
    './agent/analysis-kernels': {
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
    './agent/analysis-jupyter-server': {
      JupyterServerRegistry: TestJupyterServerRegistry
    },
    './agent/analysis-jupyter-sessions': {
      AnalysisNotebookSessionRegistry: TestAnalysisNotebookSessionRegistry
    },
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
    './agent/session-lifecycle': lifecycle,
    './agent/session-runner-registry': { SessionRunnerRegistry: RunnerRegistry },
    './agent/session-store': {
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
    updatedProjectDefaults,
    updatedSessionManifests,
    appendedSessionEvents,
    persistedToolOutputs,
    revealedPaths,
    appLogs,
    acknowledgedSessions,
    jupyterServerCalls,
    notebookSessionCalls,
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
    assert.deepEqual(await prompt, { path: 'A', sessionGeneration: 0 })
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

test('main IPC: acknowledging a session uses that session cwd', async () => {
  const app = await harness()

  await app.invoke('sessions:switch', 'A')
  await app.invoke('sessions:switch', 'B')
  await app.invoke('sessions:acknowledge', 'A')

  assert.deepEqual(app.acknowledgedSessions.at(-1), { file: 'A', cwd: '/projects/A' })
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

  assert.equal(opened.path, '/projects/research/notebooks/qc.ipynb')
  assert.equal(opened.relativePath, 'notebooks/qc.ipynb')
  assert.equal(saved.relativePath, 'notebooks/qc.ipynb')
  assert.equal(saved.savedRevision, 'nb-edited')
  assert.equal(created.relativePath, 'notebooks/Untitled.ipynb')
  assert.equal(closed.path, '/projects/research/notebooks/qc.ipynb')
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
      providerId: 'openai',
      modelId: 'gpt-session'
    })
    assert.equal(app.createdPhiSessions[0].thinkingLevel, 'high')
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
      sessionPath: null,
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
    assert.equal((next as { path: string }).path, 'fresh.jsonl')
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
        sessionPath: 'fresh.jsonl',
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
    assert.equal(current.path, 'fresh.jsonl')
    assert.equal(current.status, 'running')
    assert.match(current.currentRunId ?? '', /^run-/)
    assert.equal(current.currentRunStartedAt, '2026-09-05T00:00:00.000Z')

    await app.invoke('sessions:switch', 'other')
    const restored = (await app.invoke('sessions:switch', 'fresh.jsonl')) as {
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
