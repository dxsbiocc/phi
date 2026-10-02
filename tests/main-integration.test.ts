import { discoverPhiAgents } from '../src/main/agent/agents/discovery'
import { loadRemoteWrapperAgent } from '../src/main/agent/agents/remote-wrapper-agent'
import { BackgroundAgentApprovalTracker } from '../src/main/agent/agents/background-approval'
import * as jobContinue from '../src/main/agent/wrappers/composition/job-continue'
import { MAX_AUTOMATIC_CONTINUATIONS } from '../src/main/agent/wrappers/composition/job-continue'
import { deliverWrapperRunFinished } from '../src/main/agent/wrappers/composition/job-notify'
import { buildAgentLeaderPrompt } from '../src/main/agent/agents/leader-prompt'
import { isSecretMetadataKey } from '../src/main/agent/redaction'
import * as agentRunContinue from '../src/main/agent/agents/run-continue'
import { agentRunHostHandlers } from '../src/main/agent/agents/run-host'
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
import * as htmlReportPreview from '../src/shared/htmlReportPreview'
import * as phiPluginProblems from '../src/shared/phiPluginProblems'
import type { WorkspaceChangeSummary } from '../src/shared/workspaceChangeTypes'
import type { ContextUsageSnapshot } from '../src/shared/contextUsageTypes'
import { declaredExternalOutputRoot } from '../src/shared/wrapperResultTypes'
import { hoverMediaPreviewType, mediaPreviewType } from '../src/main/file-preview-media'
import { validateWrapperResultDownloadRequest } from '../src/main/agent/wrappers/remote-result-download'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function fakeBashApprovalDigest(input: Record<string, unknown>): string {
  const env =
    input.env && typeof input.env === 'object' && !Array.isArray(input.env)
      ? Object.fromEntries(
          Object.entries(input.env).sort(([left], [right]) => left.localeCompare(right))
        )
      : input.env
  return JSON.stringify({
    command: input.command,
    cwd: input.cwd,
    timeout: input.timeout,
    env,
    pty: input.pty,
    async: input.async
  })
}

function fakeWriteApprovalDigest(input: Record<string, unknown>): string {
  return JSON.stringify({ path: input.path, content: input.content, operation: 'write' })
}

function fakeEditApprovalDigest(input: Record<string, unknown>): string {
  return JSON.stringify({
    path: input.path,
    old_string: input.old_string,
    new_string: input.new_string,
    replace_all: input.replace_all,
    operation: 'edit'
  })
}

type PromptOptions = {
  preflightResult?: (accepted: boolean) => void
  images?: Array<{ type: 'image'; data: string; mimeType: string }>
  expandPromptTemplates?: boolean
  synthetic?: boolean
  userInitiated?: boolean
  skipCompactionCheck?: boolean
}
let fakeRuntimeSessionCounter = 0

class FakeSession {
  readonly runtimeSessionId = `runtime-${++fakeRuntimeSessionCounter}`
  readonly messages: unknown[] = []
  readonly listeners: Array<(event: unknown) => void> = []
  readonly log: string[] = []
  readonly promptTexts: string[] = []
  readonly promptOptions: PromptOptions[] = []
  model?: { provider: string; id: string; supportsImages?: boolean }
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
  contextUsage: ContextUsageSnapshot | null = null
  contextUsageGate = Promise.resolve()
  autoCompactionOverrides: { enabled?: boolean; thresholdPercent?: 70 | 80 | 90 } = {}
  autoCompactionSettingsCalls = 0
  compactCalls = 0
  compactGate = Promise.resolve()
  compactError?: Error
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
  async getContextUsage(): Promise<{
    tokens: number
    contextWindow: number
    percent: number
  } | null> {
    await this.contextUsageGate
    return this.contextUsage
  }
  async setAutoCompactionSettings(overrides: {
    enabled?: boolean
    thresholdPercent?: 70 | 80 | 90
  }): Promise<void> {
    this.autoCompactionSettingsCalls += 1
    this.autoCompactionOverrides = { ...overrides }
  }
  async compact(): Promise<{
    summary: string
    shortSummary: string
    tokensBefore: number
    tokensAfter?: number
  }> {
    this.compactCalls += 1
    await this.compactGate
    if (this.compactError) throw this.compactError
    return {
      summary: 'Earlier work was summarized.',
      shortSummary: 'Earlier work',
      tokensBefore: 24000,
      ...(this.contextUsage ? { tokensAfter: this.contextUsage.tokens } : {})
    }
  }
  dispose(): void {
    this.log.push('dispose')
    this.disposed = true
  }
  async setModel(model: { provider: string; id: string; supportsImages?: boolean }): Promise<void> {
    this.model = model
  }
  setThinkingLevel(level: string): void {
    this.thinkingLevel = level
  }
}

type Handler = (_event: unknown, ...args: unknown[]) => unknown
type HarnessResult = {
  hostHandlers: Map<string, (params: unknown) => Promise<unknown>>
  setAgentInteractionResponse: (response: Record<string, unknown>) => void
  setBridgeAgentJobs: (jobs: unknown[]) => void
  bridgeRequests: Array<{ method: string; params: unknown }>
  failBridgeRequests: (error: Error | undefined) => void
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  sessions: FakeSession[]
  deleted: string[]
  events: Array<{ channel: string; data: unknown }>
  approvalOptions: Array<Record<string, unknown>>
  runnerEvents: Array<Record<string, unknown>>
  runStartInputs: Array<Record<string, unknown>>
  createdPhiSessions: Array<Record<string, unknown>>
  remoteConnectionChecks: Array<{ sessionId: string; projectId: string }>
  wrapperJobOptions: Record<string, unknown>
  remoteResolverProjectIds: string[]
  remoteDoctorCalls: Array<{ hostProfileId: string; remotePath?: string; options?: unknown }>
  setWrapperPlan: (
    plan:
      | {
          revision?: number
          targetSelection?: {
            projectId: string
            target: string
            hostProfileId?: string
            remoteRoot?: string
            projectLocation?: { kind: string }
          }
        }
      | undefined
  ) => void
  setRemoteProjectPhase: (phase: 'reachable' | 'offline') => void
  retargetRequests: Array<Record<string, unknown>>
  submitPlanCalls: Array<{ planId: string; heavyWorkloadAcknowledged?: boolean }>
  setRemoteConnectionCheck: (impl: () => Promise<{ phase: string }>) => void
  createdAgentOptions: Array<Record<string, unknown>>
  resourceLoaderOptions: Array<Record<string, unknown>>
  updatedProjectDefaults: Array<Record<string, unknown>>
  updatedSessionManifests: Array<{ sessionId: string; patch: Record<string, unknown> }>
  appendedSessionEvents: Array<Record<string, unknown>>
  persistedToolOutputs: Array<Record<string, unknown>>
  revealedPaths: string[]
  openedPaths: string[]
  fileIconRequests: string[]
  execFileCalls: Array<{ file: string; args: string[] }>
  previewReadRequests: Array<{ filePath: string; length: number }>
  appLogs: Array<Record<string, unknown>>
  acknowledgedSessions: Array<{ file: string; cwd: string }>
  jupyterServerCalls: Array<{ action: string; cwd: string }>
  notebookSessionCalls: Array<{ action: string; cwd: string; path?: string }>
  notebookExecutionCalls: Array<{
    cellId: string
    source: string
    kernelId: string
    language?: string
    cursorPosition?: number
  }>
  notebookFormatCalls: Array<{
    projectCwd: string
    source: string
    language?: string
    lineLength?: number
  }>
  openDialogOptions: Array<Record<string, unknown>>
  saveDialogOptions: Array<Record<string, unknown>>
  downloadCalls: Array<{ request: unknown; destination: string }>
  setSaveDialogResult: (result: { canceled: boolean; filePath?: string }) => void
  setDownloadImpl: (
    impl: (
      request: unknown,
      destination: string,
      options: {
        signal: AbortSignal
        onProgress?: (progress: {
          requestId: string
          phase: 'downloading' | 'verifying' | 'saving'
          bytesDownloaded: number
          totalBytes: number
        }) => void
      }
    ) => Promise<unknown>
  ) => void
  operationLog: Array<Record<string, unknown>>
  appSettingsUpdates: string[]
  dbConnectorEnabledUpdates: Array<{ id: string; digest: string; enabled: boolean }>
  setOpenDialogResult: (result: { canceled: boolean; filePaths: string[] }) => void
  copiedText: () => string
  exportedSessions: Array<{ sessionId: string; destination: string }>
  setWorkspaceChangeSummary: (summary: WorkspaceChangeSummary | null) => void
  setWorkspaceDiffPatch: (patch: string | null) => void
  savedWorkspaceDiff: () => string | undefined
  tryFrameNavigation: (input: { isMainFrame: boolean; frameName?: string; url: string }) => boolean
}

async function harness(
  factory?: (cwd: string, file: string) => Promise<FakeSession>
): Promise<HarnessResult> {
  const handlers = new Map<string, Handler>()
  const sessions: FakeSession[] = []
  const deleted: string[] = []
  const events: Array<{ channel: string; data: unknown }> = []
  const approvalOptions: Array<Record<string, unknown>> = []
  const runnerEvents: Array<Record<string, unknown>> = []
  const runStartInputs: Array<Record<string, unknown>> = []
  const createdPhiSessions: Array<Record<string, unknown>> = []
  const remoteConnectionChecks: Array<{ sessionId: string; projectId: string }> = []
  const wrapperJobOptions: Record<string, unknown> = {}
  const remoteResolverProjectIds: string[] = []
  const remoteDoctorCalls: Array<{
    hostProfileId: string
    remotePath?: string
    options?: unknown
  }> = []
  let wrapperPlan:
    | {
        revision?: number
        targetSelection?: {
          projectId: string
          target: string
          hostProfileId?: string
          remoteRoot?: string
          projectLocation?: { kind: string }
        }
      }
    | undefined
  let remoteProjectPhase: 'reachable' | 'offline' = 'reachable'
  const retargetRequests: Array<Record<string, unknown>> = []
  const submitPlanCalls: Array<{ planId: string; heavyWorkloadAcknowledged?: boolean }> = []
  let remoteConnectionCheck: () => Promise<{ phase: string }> = async () => ({ phase: 'reachable' })
  const createdAgentOptions: Array<Record<string, unknown>> = []
  const resourceLoaderOptions: Array<Record<string, unknown>> = []
  const updatedProjectDefaults: Array<Record<string, unknown>> = []
  const updatedSessionManifests: Array<{ sessionId: string; patch: Record<string, unknown> }> = []
  const appendedSessionEvents: Array<Record<string, unknown>> = []
  const enablementGlobal: Record<string, boolean> = {}
  const enablementProjects: Record<string, Record<string, boolean>> = {}
  let appFocused = true
  const reportedWrapperRuns = new Set<string>()
  const wrapperJobFinishListeners: Array<(run: unknown, status: unknown) => void> = []
  const hostHandlers = new Map<string, (params: unknown) => Promise<unknown>>()
  let agentInteractionResponse: Record<string, unknown> = { answers: [] }
  let bridgeAgentJobs: unknown[] = []
  const bridgeRequests: Array<{ method: string; params: unknown }> = []
  let bridgeFailure: Error | undefined
  const osNotifications: Array<{ title: string; body: string }> = []
  const persistedToolOutputs: Array<Record<string, unknown>> = []
  const revealedPaths: string[] = []
  const openedPaths: string[] = []
  const fileIconRequests: string[] = []
  const execFileCalls: Array<{ file: string; args: string[] }> = []
  const previewReadRequests: Array<{ filePath: string; length: number }> = []
  const exportedSessions: Array<{ sessionId: string; destination: string }> = []
  let workspaceChangeSummary: WorkspaceChangeSummary | null = null
  let workspaceDiffPatch: string | null = null
  let savedWorkspaceDiff: string | undefined
  let frameNavigationHandler:
    | ((event: {
        isMainFrame: boolean
        frame: { name: string } | null
        url: string
        preventDefault: () => void
      }) => void)
    | undefined
  const appLogs: Array<Record<string, unknown>> = []
  const acknowledgedSessions: Array<{ file: string; cwd: string }> = []
  const jupyterServerCalls: Array<{ action: string; cwd: string }> = []
  const notebookSessionCalls: Array<{ action: string; cwd: string; path?: string }> = []
  const notebookExecutionCalls: Array<{
    cellId: string
    source: string
    kernelId: string
    language?: string
    cursorPosition?: number
  }> = []
  const notebookFormatCalls: Array<{
    projectCwd: string
    source: string
    language?: string
    lineLength?: number
  }> = []
  const openDialogOptions: Array<Record<string, unknown>> = []
  const saveDialogOptions: Array<Record<string, unknown>> = []
  const downloadCalls: Array<{ request: unknown; destination: string }> = []
  let downloadImpl: (
    request: unknown,
    destination: string,
    options: { signal: AbortSignal; onProgress?: (progress: unknown) => void }
  ) => Promise<unknown> = async (_request, destination) => ({
    status: 'saved',
    path: destination,
    bytes: 3,
    sha256: 'sha256:test',
    remoteDigestVerified: true
  })
  const operationLog: Array<Record<string, unknown>> = []
  const appSettingsUpdates: string[] = []
  const dbConnectorEnabledUpdates: Array<{ id: string; digest: string; enabled: boolean }> = []
  let appDefaultProxyMode = 'auto'
  const appNoProjectTaskFolder = '/workspace'
  const appProxyTransportStatus = {
    systemTransportAvailable: true,
    controlledProxyAvailable: false,
    autoTransportName: 'system',
    enabledModeAvailable: false,
    unavailableReason: '尚未配置受控代理通道'
  }
  let openDialogResult: { canceled: boolean; filePaths: string[] } = {
    canceled: true,
    filePaths: []
  }
  let saveDialogResult: { canceled: boolean; filePath?: string } = { canceled: true }
  const bundledFigurePreview = path.join(
    process.cwd(),
    'resources',
    'plugins',
    'visualization',
    'skills',
    'omics-visualization',
    'scripts',
    'scatter',
    'volcano',
    'preview.png'
  )
  const previewFiles = new Map<string, Buffer>([
    ['/projects/current/src/App.tsx', Buffer.from('export const app = true\n')],
    ['/projects/current/README.md', Buffer.from('# Project\n')],
    ['/projects/current/qc-demo.csv', Buffer.from('sample_id,value_a\nS001,1.75\n')],
    ['/projects/current/notebooks/eda.ipynb', Buffer.from('{"nbformat":4,"cells":[]}')],
    ['/projects/current/large.txt', Buffer.alloc(320010, 'a')],
    ['/projects/current/plot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    [bundledFigurePreview, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['/projects/current/photo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
    ['/projects/current/animation.gif', Buffer.from('GIF89a\x01\x00\x01\x00', 'binary')],
    [
      '/projects/current/chart.webp',
      Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])
    ],
    [
      '/projects/current/large-plot.png',
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(2 * 1024 * 1024, 0xff)
      ])
    ],
    ['/projects/current/report.pdf', Buffer.from('%PDF-1.7\n')],
    [
      '/projects/current/report.html',
      Buffer.from(
        '<!doctype html><html><body><h1>QC report</h1><script>alert(1)</script></body></html>'
      )
    ],
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
    [
      path.join(
        process.cwd(),
        'resources',
        'plugins',
        'visualization',
        'skills',
        'omics-visualization'
      ),
      []
    ],
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
        status: 'running' | 'needs_approval' | 'needs_input'
      }
    >()
    constructor(options: { maxActiveRuns?: number } = {}) {
      this.maxActiveRuns = options.maxActiveRuns ?? 4
    }
    startRun(input: {
      sessionId: string
      runId: string
      loadedSkills?: readonly string[]
      execute: (context: { signal: AbortSignal }) => Promise<void>
      getRecordedFailure?: () => string | null | undefined
    }): { done: Promise<void> } {
      if (this.runs.has(input.sessionId)) throw new Error('会话正在运行')
      if (this.runs.size >= this.maxActiveRuns) throw new Error('运行中的会话已达上限')
      const controller = new AbortController()
      runStartInputs.push({
        sessionId: input.sessionId,
        loadedSkills: input.loadedSkills
      })
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
      status: 'running' | 'needs_approval' | 'needs_input'
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
    markNeedsInput(
      sessionId: string,
      interactionId: string,
      metadata?: Record<string, unknown>
    ): void {
      const run = this.runs.get(sessionId)
      if (run) run.status = 'needs_input'
      runnerEvents.push({ type: 'input_requested', sessionId, interactionId, metadata })
    }
    markInputAnswered(sessionId: string, interactionId: string): void {
      const run = this.runs.get(sessionId)
      if (run) run.status = 'running'
      runnerEvents.push({ type: 'input_answered', sessionId, interactionId })
    }
    markInputCancelled(sessionId: string, interactionId: string): void {
      const run = this.runs.get(sessionId)
      if (run) run.status = 'running'
      runnerEvents.push({ type: 'input_cancelled', sessionId, interactionId })
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
      on: (name: string, handler: NonNullable<typeof frameNavigationHandler>): void => {
        if (name === 'will-frame-navigate') frameNavigationHandler = handler
      },
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
      return appFocused ? (Window.windows[0] ?? null) : null
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

    async introspectVariables(input: {
      kernelId: string
      variableNames: string[]
      language?: string
    }): Promise<
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
        kernelId: input.kernelId,
        language: input.language
      })
      if (input.language?.toLocaleLowerCase() === 'r') {
        return input.variableNames.map((name) =>
          name === 'df'
            ? {
                name,
                exists: true,
                datatype: 'data.frame',
                shape: '2 x 3',
                columns: [
                  { name: 'Year', type: 'character' },
                  { name: 'Income', type: 'numeric' }
                ],
                preview: '  Year Income\\n1 19th 1208.7'
              }
            : { name, exists: false }
        )
      }
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
    getFileIcon: async (
      filePath: string
    ): Promise<{ isEmpty: () => boolean; toDataURL: () => string }> => {
      fileIconRequests.push(filePath)
      return {
        isEmpty: () => false,
        toDataURL: () => 'data:image/png;base64,aWNvbg=='
      }
    },
    quit: noop
  })
  const modules: Record<string, unknown> = {
    semver: { gt: (left: string, right: string): boolean => left > right },
    './agent-env': {},
    './file-preview-media': { hoverMediaPreviewType, mediaPreviewType },
    '../shared/wrapperResultTypes': { declaredExternalOutputRoot },
    '../shared/htmlReportPreview': htmlReportPreview,
    '../shared/phiPluginProblems': phiPluginProblems,
    '../shared/presentedFileTypes': { MAX_PRESENTED_FILES: 4 },
    '../shared/remoteHostProfile': { sshConfigHostId: (alias: string) => `ssh-config:${alias}` },
    './molecule-renderer': {
      renderMoleculeSvg: async (): Promise<string> => '<svg xmlns="http://www.w3.org/2000/svg"/>'
    },
    './database-web-preview': {
      previewDatabaseWebImage: async (): Promise<never> => {
        throw new Error('Database web preview is mocked in main-integration.test.ts')
      }
    },
    './agent/db/credential-store': {
      clearDbConnectorSecret: (): void => {},
      hasDbConnectorSecret: (): boolean => false,
      isDbCredentialStorageAvailable: (): boolean => true,
      resolveDbAuthSecret: (): undefined => undefined,
      storeDbConnectorSecret: (): void => {}
    },
    './agent/environment': {
      createManagedEnvironmentActions: () => ({
        list: async () => [],
        build: () => ({ envId: 'phi-python-0123456789ab' }),
        rebuild: async () => undefined,
        remove: async () => ({ removed: true, bytesFreed: 0 }),
        clean: async () => ({
          removed: [],
          orphans: [],
          skipped: [],
          logsRemoved: 0,
          bytesFreed: 0
        })
      }),
      detectConfiguredAnalysisKernels: () => ({
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
      }),
      dismissEnvironmentSummary: (): void => {},
      getEnvironment: (): Record<string, never> => ({}),
      listManagedEnvironments: async () => [],
      redetectEnvironment: (): Record<string, never> => ({}),
      setEnvironmentToolPath: (): Record<string, never> => ({})
    },
    'node:child_process': {
      execFile: (
        file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ): void => {
        execFileCalls.push({ file, args })
        if (file === '/usr/bin/mdfind') {
          const query = String(args[0] ?? '')
          callback(
            null,
            query.includes('com.microsoft.vscode') ? '/Applications/Visual Studio Code.app\n' : '',
            ''
          )
          return
        }
        if (file !== '/usr/bin/plutil') {
          callback(new Error(`Unexpected command: ${file}`), '', '')
          return
        }
        callback(
          null,
          JSON.stringify({
            LSHandlers: [
              {
                LSHandlerContentTagClass: 'public.filename-extension',
                LSHandlerContentTag: 'tsx',
                LSHandlerRoleAll: 'com.microsoft.vscode'
              },
              {
                LSHandlerContentType: 'public.comma-separated-values-text',
                LSHandlerRoleAll: 'com.microsoft.excel'
              }
            ]
          }),
          ''
        )
      }
    },
    'node:os': { homedir: (): string => '/fake-home' },
    'node:fs': {
      existsSync: (filePath: string): boolean => {
        const target = path.resolve(filePath)
        return (
          target === path.resolve(process.cwd(), 'resources', 'skills') ||
          previewFiles.has(target) ||
          previewDirectories.has(target)
        )
      },
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
        },
        showSaveDialog: async (
          ...args: unknown[]
        ): Promise<{ canceled: boolean; filePath?: string }> => {
          const options = (args.length === 2 ? args[1] : args[0]) as Record<string, unknown>
          saveDialogOptions.push(options)
          return saveDialogResult
        }
      },
      ipcMain: {
        on: noop,
        handle: (name: string, handler: Handler): void => {
          handlers.set(name, handler)
        }
      },
      Notification: class {
        static isSupported(): boolean {
          return true
        }
        constructor(readonly options: { title: string; body: string }) {}
        on(): void {
          // click handling is not exercised here
        }
        show(): void {
          osNotifications.push(this.options)
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
      readAutoCompactionDefaults: async (): Promise<{
        enabled: boolean
        thresholdPercent: number
        thresholdTokens: number
      }> => ({ enabled: true, thresholdPercent: -1, thresholdTokens: -1 }),
      createRuntimeResourceLoader: (options: Record<string, unknown>): unknown => {
        resourceLoaderOptions.push(options)
        return {
          options,
          async reload(): Promise<void> {
            return
          },
          getSkills: (): unknown => ({ skills: [], diagnostics: [] })
        }
      },
      getBundledSkillsDir: (): string => path.join(process.cwd(), 'resources', 'skills'),
      getBundledAgentsDir: (): string => path.join(process.cwd(), 'resources', 'agents'),
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
              provider: 'openai',
              id: 'gpt-vision-test',
              name: 'GPT Vision Test',
              reasoning: false,
              supportsImages: true
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
                  reasoning: true,
                  ...(modelId === 'gpt-vision-test' ? { supportsImages: true } : {})
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
      subscribeRemoteProjectConnection: (): (() => void) => noop,
      getProject: (id: string) => {
        if (id === 'remote-project-1') {
          return {
            id,
            name: 'Remote project',
            location: {
              kind: 'ssh',
              hostProfileId: 'host-1',
              remoteRoot: '/cluster/project',
              canonicalRoot: '/canonical/project'
            },
            permissionMode: 'ask',
            workingDirectory: '/cluster/project',
            createdAt: '2026-09-24T00:00:00.000Z'
          }
        }
        if (id.startsWith('project-/projects/')) {
          const workingDirectory = id.slice('project-'.length)
          return {
            id,
            name: `Project ${workingDirectory}`,
            location: { kind: 'local', path: workingDirectory, realPath: workingDirectory },
            workingDirectory,
            workingDirectoryRealPath: workingDirectory,
            permissionMode: 'ask',
            createdAt: '2026-09-05T00:00:00.000Z'
          }
        }
        return undefined
      },
      assertProjectPathAvailable: (workingDirectory: string) => {
        if (workingDirectory.includes('missing-project')) throw new Error('项目路径不可用')
      },
      listProjects: () => [
        {
          id: 'project-/projects/defaults',
          name: 'Project /projects/defaults',
          location: { kind: 'local', path: '/projects/defaults', realPath: '/projects/defaults' },
          workingDirectory: '/projects/defaults',
          workingDirectoryRealPath: '/projects/defaults',
          permissionMode: 'ask',
          pathAvailable: true,
          createdAt: '2026-09-05T00:00:00.000Z'
        },
        {
          id: 'remote-project-1',
          location: {
            kind: 'ssh',
            hostProfileId: 'host-1',
            remoteRoot: '/cluster/project',
            canonicalRoot: '/canonical/project'
          },
          remoteConnection: {
            phase: remoteProjectPhase,
            message: remoteProjectPhase === 'offline' ? '服务器离线' : undefined
          }
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
      updateProjectPermissionMode: (id: string, permissionMode: string) =>
        id === 'remote-project-1'
          ? {
              id,
              name: 'Remote project',
              location: {
                kind: 'ssh',
                hostProfileId: 'host-1',
                remoteRoot: '/cluster/project',
                canonicalRoot: '/canonical/project'
              },
              workingDirectory: '/cluster/project',
              permissionMode,
              pathAvailable: true,
              createdAt: '2026-09-24T00:00:00.000Z'
            }
          : {
              id,
              name: 'Project',
              workingDirectory: '/projects/defaults',
              permissionMode,
              pathAvailable: true,
              createdAt: '2026-09-05T00:00:00.000Z'
            },
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
      getOmpBridge: (): {
        registerHostHandler: (
          method: string,
          handler: (params: unknown) => Promise<unknown>
        ) => () => void
        request: (method: string, params: unknown) => Promise<unknown>
      } => ({
        registerHostHandler: (method, handler) => {
          hostHandlers.set(method, handler)
          return () => hostHandlers.delete(method)
        },
        request: async (method, params) => {
          bridgeRequests.push({ method, params })
          if (bridgeFailure) throw bridgeFailure
          if (method === 'agentRuns.list') return bridgeAgentJobs
          if (method === 'mcp.featuredTools') return ['search_articles']
          if (method === 'mcp.featuredAuthStatus') return true
          return { ok: true }
        }
      })
    },
    './agent/notebook/notebook-code-generation': notebookCodeGeneration,
    '../shared/notebookDocument': notebookDocument,
    '../shared/sessionTitle': sessionTitle,
    './agent/content/skill-host': {
      createSkillHost: (): {
        scriptTools: (params: unknown) => Promise<{ tools: unknown[]; problems: string[] }>
        run: (params: unknown) => Promise<unknown>
        scriptTool: (params: unknown) => Promise<unknown>
        cancel: (params: unknown) => void
        approvalFor: (toolName: string, input: unknown) => undefined
      } => ({
        scriptTools: async () => ({ tools: [], problems: [] }),
        run: async () => {
          throw new Error('skill host is mocked')
        },
        scriptTool: async () => {
          throw new Error('skill host is mocked')
        },
        cancel: () => undefined,
        approvalFor: () => undefined
      })
    },
    './agent/content/env-request': {
      ADD_PACKAGES: '添加',
      confirmedEnvironmentRequest: (): boolean => false,
      environmentRequestQuestion: (): string => 'add packages?',
      requestProjectEnvironment: async (): Promise<unknown> => {
        throw new Error('env_request is mocked')
      }
    },
    './agent/content/environment-gate': {
      bindAgentSession: async (): Promise<unknown> => {
        throw new Error('environment binding is mocked')
      }
    },
    './agent/content/environment-builds': {
      createEnvironmentBuilds: (): {
        list: () => unknown[]
        cancel: (envId: string) => void
      } => ({
        list: () => [],
        cancel: () => undefined
      })
    },
    './agent/content/environment-build-prompt': {
      BUILD_NOW: '现在构建',
      confirmedEnvironmentBuild: (): boolean => false,
      environmentBuildQuestion: (): string => 'build?'
    },
    './agent/envs/runtime': {
      getRuntimeRoot: (): string => '/isolated/runtime'
    },
    './agent/tool-approval': {
      bashApprovalDigest: fakeBashApprovalDigest,
      writeApprovalDigest: fakeWriteApprovalDigest,
      editApprovalDigest: fakeEditApprovalDigest,
      cancelToolApprovals: noop,
      createApprovalExtension: (options: Record<string, unknown>): Record<string, unknown> => {
        approvalOptions.push(options)
        return { name: 'approval-extension' }
      }
    },
    './agent/user-interaction': {
      canRequestAgentUserInteraction: (): boolean => true,
      cancelAgentUserInteractions: noop,
      resolveAgentUserInteraction: noop,
      waitForAgentUserInteraction: async (
        request: Record<string, unknown>
      ): Promise<Record<string, unknown>> => ({
        requestId: request.requestId,
        ...agentInteractionResponse
      })
    },
    './agent/plugins': {
      listPlugins: async (): Promise<unknown[]> => [
        { id: 'plugin-1', name: 'Plugin', source: 'local', installed: true }
      ],
      installPlugin: async (): Promise<unknown[]> => [],
      removePlugin: async (): Promise<unknown[]> => []
    },
    './agent/plugins/bundled-install': {
      installBundledPlugins: async (): Promise<unknown> => ({
        installed: [],
        upgraded: [],
        skipped: [],
        errors: [],
        warnings: []
      })
    },
    './agent/plugins/loader': {
      listInstalledPlugins: (): unknown[] => [],
      loadedPlugins: (): unknown[] => [],
      installPlugin: (): unknown => ({ ok: true, errors: [], warnings: [] }),
      upgradePlugin: async (): Promise<unknown> => ({ ok: true, errors: [], warnings: [] }),
      setPluginEnabled: (): unknown => ({ ok: true, errors: [], warnings: [] }),
      uninstallPlugin: (): unknown => ({ ok: true, errors: [], warnings: [] })
    },
    './agent/plugins/store': {
      readPluginRegistry: (): unknown => ({ version: 1, plugins: {} }),
      writePluginRegistry: noop
    },
    './agent/enablement': {
      getEnablementPath: (): string => '/isolated/state/enabled.json',
      migrateEnablementFromHistory: (): unknown => ({
        migrated: false,
        enabledSkills: [],
        sessionsScanned: 0,
        bytesScanned: 0
      }),
      filterEnabledMainSkills: (skills: unknown[]): unknown[] => skills,
      getEnablementSnapshot: ({ projectDir }: { projectDir?: string } = {}): unknown => ({
        version: 1,
        global: { ...enablementGlobal },
        ...(projectDir ? { projectPath: projectDir } : {}),
        project: projectDir ? { ...(enablementProjects[projectDir] ?? {}) } : {}
      }),
      setEnabled: (
        item: string,
        value: boolean | null,
        { projectDir }: { projectDir?: string } = {}
      ): unknown => {
        const target = projectDir ? (enablementProjects[projectDir] ??= {}) : enablementGlobal
        if (value === null) delete target[item]
        else target[item] = value
        return { version: 1, global: enablementGlobal, projects: enablementProjects }
      }
    },
    './agent/plugins/validate': {
      validatePlugin: (): unknown => ({ ok: false, errors: [], warnings: [] })
    },
    './agent/packages/installer': {
      cleanupStalePackageStaging: (): string[] => [],
      readRegistry: (dir: string): unknown => ({
        id: dir,
        dir,
        schemaVersion: 1,
        generatedAt: '2026-10-02T00:00:00.000Z',
        packages: []
      }),
      planInstall: (registry: unknown, request: Record<string, unknown>): unknown => ({
        registry,
        root: { type: request.type, id: request.id, version: request.version ?? '1.0.0' },
        packages: [],
        totalSize: 0,
        environments: [],
        agentDir: '/isolated'
      }),
      installPackages: async (plan: { root: { type: string; id: string } }): Promise<unknown[]> => [
        { type: plan.root.type, id: plan.root.id }
      ],
      uninstallPackage: (): unknown[] => [],
      listInstalledPackages: (): unknown[] => []
    },
    './agent/content/skill': {
      validateSkill: (): unknown => ({ ok: true, errors: [], warnings: [] })
    },
    './agent/mcp-connectors': {
      addRemoteMcpConnector: noop,
      removeRemoteMcpConnector: noop
    },
    './agent/resources': {
      listGlobalSkills: async (): Promise<unknown[]> => [
        {
          id: '/isolated/skills/global/SKILL.md',
          name: 'global',
          description: 'global skill',
          filePath: '/isolated/skills/global/SKILL.md',
          source: 'user',
          scope: 'user',
          sourceCategory: 'user',
          sourceCategoryLabel: 'User',
          enabled: true,
          disabled: false
        }
      ],
      readGlobalSkillContent: async (filePath: string): Promise<unknown> => {
        if (filePath !== '/isolated/skills/global/SKILL.md') {
          throw new Error('远程项目级 Skill 暂不可用')
        }
        return { filePath, content: '# global skill\n' }
      },
      listGlobalMcpServers: async (): Promise<unknown[]> => [
        {
          id: 'global-mcp',
          name: 'global-mcp',
          sourcePath: '/isolated/mcp.json',
          status: 'configured'
        }
      ],
      listSkills: async (cwd: string): Promise<unknown[]> => [
        {
          id: `${cwd}:skill`,
          name: 'skill',
          description: 'skill',
          filePath: `${cwd}/.phi/skills/skill/SKILL.md`,
          source: 'project',
          scope: 'project',
          sourceCategory: 'user',
          sourceCategoryLabel: 'User',
          enabled: true,
          disabled: false
        },
        ...Object.entries(enablementGlobal)
          .filter(([key, enabled]) => key.startsWith('skill:') && enabled)
          .map(([key]) => {
            const name = key.slice('skill:'.length)
            return {
              id: `${cwd}:${name}`,
              name,
              description: name,
              filePath: `${cwd}/.phi/skills/${name}/SKILL.md`,
              source: 'installed-package',
              scope: 'user',
              sourceCategory: 'installed-package',
              sourceCategoryLabel: '已安装',
              enabled: true,
              disabled: false
            }
          })
      ],
      readSkillContent: async (filePath: string): Promise<unknown> => ({
        filePath,
        content: '# skill\n'
      }),
      setSkillDisabled: async (
        _filePath: string,
        disabled: boolean,
        cwd: string
      ): Promise<unknown[]> => [
        {
          id: `${cwd}:skill`,
          name: 'skill',
          description: 'skill',
          filePath: `${cwd}/.phi/skills/skill/SKILL.md`,
          source: 'project',
          scope: 'project',
          sourceCategory: 'user',
          sourceCategoryLabel: 'User',
          disabled
        }
      ],
      deleteSkill: async (): Promise<unknown[]> => [],
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
      submitWrapperRunPlan: (
        planId: string,
        options: { heavyWorkloadAcknowledged?: boolean }
      ): never => {
        submitPlanCalls.push({
          planId,
          heavyWorkloadAcknowledged: options.heavyWorkloadAcknowledged
        })
        throw new Error('计划不存在: (mocked in main-integration.test.ts)')
      },
      cancelWrapperRunPlan: (): never => {
        throw new Error('计划不存在: (mocked in main-integration.test.ts)')
      },
      cancelWrapperRun: (): never => {
        throw new Error('run 不存在: (mocked in main-integration.test.ts)')
      }
    },
    './agent/wrappers/remote-results': {
      listWrapperResultDirectory: async (request: unknown): Promise<unknown> => request
    },
    './agent/wrappers/remote-result-read': {
      previewWrapperResult: async (request: { path: string }): Promise<unknown> => ({
        path: `ssh://cluster-one/canonical/project/${request.path}`,
        rootPath: 'ssh://cluster-one/canonical/project',
        kind: 'text',
        mimeType: 'text/plain',
        content: 'remote result',
        bytes: 13,
        previewBytes: 13,
        truncated: false
      }),
      readWrapperResultRange: async (
        request: { path: string },
        options: { signal: AbortSignal }
      ): Promise<unknown> => {
        if (request.path === 'stall.bin') {
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('read aborted')), {
              once: true
            })
          })
        }
        return { path: `ssh://cluster-one/canonical/project/${request.path}`, dataBase64: 'AA==' }
      }
    },
    './agent/wrappers/remote-result-download': {
      validateWrapperResultDownloadRequest,
      downloadWrapperResultToPath: async (
        request: unknown,
        destination: string,
        options: { signal: AbortSignal; onProgress?: (progress: unknown) => void }
      ): Promise<unknown> => {
        downloadCalls.push({ request, destination })
        return downloadImpl(request, destination, options)
      }
    },
    './agent/wrappers/store': {
      readWrapperPlan: () => wrapperPlan,
      listWrapperRuns: (): unknown[] => [],
      readWrapperRun: (): undefined => undefined,
      readWrapperPlanArtifact: (): undefined => undefined
    },
    './agent/wrappers/plans': {
      retargetWrapperRunPlan: (request: Record<string, unknown>) => {
        retargetRequests.push(request)
        wrapperPlan = { ...wrapperPlan, revision: Number(wrapperPlan?.revision ?? 1) + 1 }
        return wrapperPlan
      }
    },
    './agent/wrappers/reproducibility': {
      buildWrapperReproducibilityBundle: (): never => {
        throw new Error('run 不存在: (mocked in main-integration.test.ts)')
      }
    },
    './agent/wrappers/composition/job-host-handlers': {
      wrapperJobHostHandlers: (): Record<string, never> => ({})
    },
    './agent/wrappers/composition/job-continue': jobContinue,
    // The real delivery logic: this test is what proves index.ts wires it to the session timeline.
    './agent/wrappers/composition/job-notify': { deliverWrapperRunFinished },
    './agent/wrappers/composition/job-manager': {
      WrapperJobManager: class {
        constructor(options: Record<string, unknown>) {
          Object.assign(wrapperJobOptions, options)
        }
        onChange(): () => void {
          return (): void => {}
        }
        onFinish(listener: (run: unknown, status: unknown) => void): () => void {
          wrapperJobFinishListeners.push(listener)
          return (): void => {}
        }
        shutdown(): void {
          // nothing running in the harness
        }
        cancel(): Promise<{ ok: true }> {
          return Promise.resolve({ ok: true })
        }
        adoptRemoteRuns(): Promise<number> {
          return Promise.resolve(0)
        }
        hasBeenReported(runId: string): boolean {
          return reportedWrapperRuns.has(runId)
        }
      }
    },
    './agent/wrappers/composition/run-record': {
      markInterruptedCompositionRuns: (): number => 0
    },
    './agent/wrappers/executor-slurm-reconcile': {
      reconcileRemoteWrapperRuns: (): Promise<void> => Promise.resolve()
    },
    './agent/wrappers/catalog': {
      ensureBundledWrappersInstalled: () =>
        Promise.resolve({
          packages: [],
          installed: [],
          removed: [],
          migratedCustom: [],
          legacyPackWarnings: [],
          diagnostics: { unattributedIncludes: [], unattributedSupportFiles: [] }
        }),
      listWrapperCatalog: (): unknown[] => [],
      addCustomWrapper: (): never => {
        throw new Error('wrapper.yaml 校验失败: (mocked in main-integration.test.ts)')
      }
    },
    // Real scan of the repo's bundled agents, but never the developer's own ~/.claude etc.
    './agent/agents/discovery': {
      discoverPhiAgents: (options: Parameters<typeof discoverPhiAgents>[0]) =>
        discoverPhiAgents({
          ...options,
          homeDir: '/nonexistent-home',
          ...(options.pluginAgentDirs === undefined
            ? {
                pluginAgentDirs: [
                  path.join(process.cwd(), 'resources', 'plugins', 'visualization', 'agents')
                ]
              }
            : {})
        })
    },
    './agent/plugins/preview': {
      isPluginSkillPreviewPath: (target: string): boolean =>
        target.includes(
          path.join('resources', 'plugins', 'visualization', 'skills', 'omics-visualization')
        ) && target.endsWith('preview.png')
    },
    './agent/agents/remote-wrapper-agent': { loadRemoteWrapperAgent },
    './agent/agents/background-approval': { BackgroundAgentApprovalTracker },
    './agent/agents/leader-prompt': { buildAgentLeaderPrompt },
    './agent/agents/run-continue': agentRunContinue,
    './agent/agents/run-host': { agentRunHostHandlers },
    './agent/wrappers/composition/discovery': {
      listWrapperCompositionCatalogStatus: (): unknown[] => [],
      resetWrapperCompositionCatalogCache: (): void => {}
    },
    './agent/remote-hosts': {
      listRemoteHostProfiles: (): unknown[] => [],
      listAvailableRemoteHostProfiles: (): unknown[] => [
        { id: 'ssh-config:lab-hpc', label: 'lab-hpc', hostAlias: 'lab-hpc', source: 'ssh-config' }
      ],
      getRemoteHostProfile: (id: string) =>
        id === 'host-1'
          ? { id, label: 'Cluster', hostAlias: 'cluster-one' }
          : id.startsWith('ssh-config:')
            ? {
                id,
                label: id.slice('ssh-config:'.length),
                hostAlias: id.slice('ssh-config:'.length),
                source: 'ssh-config'
              }
            : undefined,
      saveRemoteHostProfile: (input: { id?: string; label: string; hostAlias: string }) => ({
        id: input.id ?? 'test-remote-host',
        ...input
      }),
      deleteRemoteHostProfile: (): void => {}
    },
    './agent/ssh-config-discovery': {
      listOpenSshHosts: async () => [
        {
          alias: 'lab-hpc',
          hostname: 'compute.example.invalid',
          user: 'scientist',
          port: 22022,
          identityFiles: ['/tmp/lab-key']
        }
      ]
    },
    './agent/ssh-config-editor': {
      saveOpenSshHost: async (input: { alias: string }) => input.alias
    },
    './agent/remote-doctor': {
      remoteDoctor: async (hostProfileId: string, remotePath?: string, options?: unknown) => {
        remoteDoctorCalls.push({ hostProfileId, remotePath, options })
        return {
          hostProfileId,
          checkedAt: '2026-09-24T00:00:00.000Z',
          ok: true,
          checks: [{ id: 'ssh', status: 'ok', message: remotePath ?? 'connected' }]
        }
      }
    },
    './agent/remote-nextflow-install': {
      installRemoteNextflow: async () => ({
        path: '/home/scientist/.local/bin/nextflow',
        alreadyInstalled: false
      })
    },
    './agent/cursor-h2-bridge': {
      createCursorH2Bridge: () => ({
        ensure: async () => 'http://127.0.0.1:12345',
        close: async () => undefined
      })
    },
    './agent/remote-project-create': {
      createCheckedRemoteProject: async (input: Record<string, unknown>) => ({
        id: 'remote-project-1',
        name: input.name,
        location: {
          kind: 'ssh',
          hostProfileId: input.hostProfileId,
          remoteRoot: input.remoteRoot,
          canonicalRoot: '/canonical/project'
        },
        workingDirectory: input.remoteRoot,
        permissionMode: input.permissionMode
      })
    },
    './agent/remote-project-instructions': {
      loadRemoteProjectInstructions: async (): Promise<unknown[]> => [
        { path: 'ssh://cluster-one/cluster/project/AGENTS.md', content: 'Remote instructions v1' }
      ]
    },
    './agent/remote-project-connection': {
      RemoteProjectConnectionTracker: class {
        async check(sessionId: string, projectId: string): Promise<{ phase: string }> {
          remoteConnectionChecks.push({ sessionId, projectId })
          return remoteConnectionCheck()
        }
        async observe<T>(_projectId: string, operation: () => Promise<T>): Promise<T> {
          return operation()
        }
        noteRemoteRunLost(): void {
          return undefined
        }
      }
    },
    './agent/remote-workspace-boundary': {
      remoteBashApprovalScope: (hostAlias: string, cwd: string) =>
        `SSH ${hostAlias} · cwd ${cwd}；Shell 命令可访问项目目录之外，当前路径检查不是命令沙箱。`,
      resolveRemoteWorkspacePath: async (request: Record<string, unknown>) => ({
        ...request,
        path: '/canonical/project/readme.md',
        hostAlias: 'cluster-one'
      }),
      resolveRemoteBashContext: async (request: Record<string, unknown>) => ({
        ...request,
        cwd: '/canonical/project',
        hostAlias: 'cluster-one',
        approvalScope: 'SSH cluster-one · cwd /canonical/project；Shell 命令可访问项目目录之外'
      })
    },
    './agent/remote-workspace-read': {
      readRemoteWorkspacePath: async (request: Record<string, unknown>) => ({
        kind: 'file',
        path: 'ssh://cluster-one/canonical/project/readme.md',
        content: `remote:${request.path}`,
        fileSize: 13,
        contentType: 'text/plain'
      })
    },
    './agent/remote-workspace-file-ui': {
      previewRemoteWorkspaceFile: async (request: Record<string, unknown>) => ({
        path: 'ssh://cluster-one/canonical/project/readme.md',
        name: 'readme.md',
        displayPath: 'cluster-one/canonical/project/readme.md',
        rootPath: 'ssh://cluster-one/canonical/project',
        rootLabel: 'cluster-one',
        kind: 'text',
        mimeType: 'text/plain',
        bytes: 7,
        previewBytes: 7,
        truncated: false,
        content: `remote:${request.path}`
      }),
      listRemoteWorkspaceDirectory: async (request: Record<string, unknown>) => ({
        path: 'ssh://cluster-one/canonical/project',
        name: 'project',
        displayPath: 'cluster-one/canonical/project',
        rootPath: 'ssh://cluster-one/canonical/project',
        rootLabel: 'cluster-one',
        entries: [
          {
            path: 'ssh://cluster-one/canonical/project/readme.md',
            name: 'readme.md',
            displayPath: 'cluster-one/canonical/project/readme.md',
            kind: 'file'
          }
        ],
        truncated: false,
        requestPath: request.path
      })
    },
    './agent/remote-workspace-search': {
      remoteGlob: async (request: Record<string, unknown>) => ({
        paths: ['ssh://cluster-one/canonical/project/readme.md'],
        content: `glob:${request.path}`,
        truncated: false,
        engine: 'rg',
        gitignoreApplied: true
      }),
      remoteGrep: async (request: Record<string, unknown>) => ({
        matches: [],
        content: `grep:${request.pattern}`,
        fileCount: 0,
        matchCount: 0,
        truncated: false,
        engine: 'rg',
        gitignoreApplied: true
      })
    },
    './agent/remote-workspace-bash': {
      RemoteWorkspaceBashManager: class {
        constructor(
          private readonly options: { beforeRun?: (request: Record<string, unknown>) => void }
        ) {}
        async run(request: Record<string, unknown>): Promise<unknown> {
          this.options.beforeRun?.(request)
          return {
            status: 'completed',
            hostAlias: 'cluster-one',
            cwd: '/canonical/project',
            exitCode: 0,
            stdout: 'remote-ok',
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
            wallTimeMs: 1
          }
        }
        cancel(): boolean {
          return true
        }
        cancelSession(): void {
          this.cancel()
        }
        cancelAll(): void {
          this.cancel()
        }
      }
    },
    './agent/remote-workspace-write': {
      RemoteWorkspaceWriteManager: class {
        constructor(
          private readonly options: { beforeWrite?: (request: Record<string, unknown>) => void }
        ) {}
        async create(request: Record<string, unknown>): Promise<unknown> {
          this.options.beforeWrite?.(request)
          return {
            status: 'created',
            path: `ssh://cluster-one/canonical/project/${request.path}`,
            bytes: 2
          }
        }
        cancel(): boolean {
          return true
        }
        cancelSession(): void {
          this.cancel()
        }
        cancelAll(): void {
          this.cancel()
        }
      }
    },
    './agent/remote-workspace-edit': {
      RemoteWorkspaceReadBasis: class {
        readonly seen: Array<{
          sessionId: string
          projectId: string
          hostAlias: string
          path: string
          content: string
        }> = []
        record(
          sessionId: string,
          projectId: string,
          hostAlias: string,
          path: string,
          content: string
        ): void {
          this.seen.push({ sessionId, projectId, hostAlias, path, content })
        }
      },
      RemoteWorkspaceMutationManager: class {
        constructor(
          private readonly options: {
            beforeWrite?: (request: Record<string, unknown>) => void
            beforeEdit?: (request: Record<string, unknown>) => void
          }
        ) {}
        async write(request: Record<string, unknown>): Promise<unknown> {
          this.options.beforeWrite?.(request)
          return {
            status: 'created',
            path: `ssh://cluster-one/canonical/project/${request.path}`,
            bytes: 2
          }
        }
        async edit(request: Record<string, unknown>): Promise<unknown> {
          this.options.beforeEdit?.(request)
          return {
            status: 'updated',
            path: `ssh://cluster-one/canonical/project/${request.path}`,
            bytes: 2,
            oldText: request.old_string,
            newText: request.new_string
          }
        }
        cancel(): boolean {
          return true
        }
        cancelSession(): void {
          this.cancel()
        }
        cancelAll(): void {
          this.cancel()
        }
      }
    },
    './agent/remote-project-anchor': {
      remoteProjectAnchorPath: (id: string) => `/isolated/remote-project-anchors/${id}`,
      ensureRemoteProjectAnchor: (id: string) => `/isolated/remote-project-anchors/${id}`,
      isRemoteProjectAnchorPath: (path: string) => path.includes('/remote-project-anchors/')
    },
    './agent/wrappers/remote-connection-resolver': {
      resolveProjectRemoteTarget: (project: { id?: string } | undefined): { reason: string } => {
        if (project?.id) remoteResolverProjectIds.push(project.id)
        return { reason: 'remote execution is mocked out in main-integration.test.ts' }
      }
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
    './agent/app-settings': {
      readAppSettings: (): Record<string, unknown> => ({
        defaultProxyMode: appDefaultProxyMode,
        noProjectTaskFolder: appNoProjectTaskFolder,
        preventSleepDuringRuns: false,
        nextActionSuggestionsEnabled: true,
        proxyTransportStatus: appProxyTransportStatus
      }),
      updateDefaultProxyMode: (mode: string): Record<string, unknown> => {
        appSettingsUpdates.push(mode)
        appDefaultProxyMode = mode
        return {
          defaultProxyMode: appDefaultProxyMode,
          noProjectTaskFolder: appNoProjectTaskFolder,
          preventSleepDuringRuns: false,
          nextActionSuggestionsEnabled: true,
          proxyTransportStatus: appProxyTransportStatus
        }
      }
    },
    './agent/db/catalog': {
      listDbConnectorCatalog: (): unknown[] => [
        {
          manifest: {
            phiDbConnectorVersion: 1,
            id: 'entrez/ncbi',
            name: 'NCBI Entrez',
            protocolFamily: 'entrez',
            curationTier: 'curated',
            baseUrl: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils',
            networkPolicy: {
              allowedHosts: ['eutils.ncbi.nlm.nih.gov'],
              allowRedirects: false
            },
            domains: [{ id: 'gene', summary: 'Gene records.', commonFields: ['uid'] }]
          },
          trustTier: 'bundled',
          installedPath: '/resources/db-connectors/entrez/ncbi',
          installedAt: '2026-09-18T00:00:00.000Z',
          digest: 'digest-entrez',
          enabledForQuery: true
        }
      ],
      findDbConnectorCatalogEntry: (id: string): unknown =>
        id === 'entrez/ncbi'
          ? {
              manifest: {
                id: 'entrez/ncbi',
                name: 'NCBI Entrez',
                protocolFamily: 'entrez',
                curationTier: 'curated',
                domains: [{ id: 'gene', summary: 'Gene records.', commonFields: ['uid'] }]
              },
              trustTier: 'bundled',
              digest: 'digest-entrez',
              enabledForQuery: true
            }
          : undefined,
      syncGeneratedDbConnectorDocs: (): void => {}
    },
    './agent/db/store': {
      setDbConnectorQueryEnabled: (
        id: string,
        digest: string,
        _trustTier: string,
        enabled: boolean
      ): void => {
        dbConnectorEnabledUpdates.push({ id, digest, enabled })
      }
    },
    './agent/redaction': {
      isSecretMetadataKey,
      redactSensitiveText: (text: string): string =>
        text
          .replace(/\borg-[A-Za-z0-9_-]+(?:<[^>\s]+>)?/g, '[redacted]')
          .replace(/\bak-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    },
    './agent/session/session-lifecycle': lifecycle,
    './agent/session/session-runner-registry': { SessionRunnerRegistry: RunnerRegistry },
    './agent/session/session-export': {
      exportPhiSession: async (sessionId: string, destination: string) => {
        exportedSessions.push({ sessionId, destination })
        return {
          path: `${destination}/phi-session-${sessionId}`,
          fileCount: 5,
          bytes: 123,
          runtimeIncluded: true,
          blobCount: 1
        }
      }
    },
    './agent/deliverables/present-files': {
      validatePresentedFiles: (_cwd: string, value: unknown) => {
        if (!Array.isArray(value)) throw new Error('Invalid delivery files')
        return value
      }
    },
    './agent/session/workspace-changes': {
      beginWorkspaceChangeCapture: async (): Promise<object | null> =>
        workspaceChangeSummary ? {} : null,
      finishWorkspaceChangeCapture: async (
        _baseline: unknown,
        options?: { onTextDiff?: (name: string, patch: string) => Promise<unknown> }
      ): Promise<WorkspaceChangeSummary | null> => {
        if (!workspaceChangeSummary || !workspaceDiffPatch || !options?.onTextDiff) {
          return workspaceChangeSummary
        }
        const first = workspaceChangeSummary.files[0]
        const diff = await options.onTextDiff(first.displayPath, workspaceDiffPatch)
        return {
          ...workspaceChangeSummary,
          files: [{ ...first, ...(diff ? { diff } : {}) }, ...workspaceChangeSummary.files.slice(1)]
        } as WorkspaceChangeSummary
      }
    },
    './agent/session/workspace-diffs': {
      persistWorkspaceDiff: (sessionId: string, patch: string): unknown => {
        savedWorkspaceDiff = patch
        return { sessionId, id: 'd'.repeat(64), bytes: Buffer.byteLength(patch) }
      },
      readWorkspaceDiff: (ref: { id?: string }): string => {
        if (ref.id !== 'd'.repeat(64) || !savedWorkspaceDiff) throw new Error('Missing diff')
        return savedWorkspaceDiff
      }
    },
    './agent/session/prompt-images': {
      validatePromptImages: (value: unknown): unknown[] => (Array.isArray(value) ? value : []),
      persistPromptImages: (sessionId: string, images: unknown[]): unknown[] =>
        images.map(() => ({ sessionId, id: 'a'.repeat(64), mimeType: 'image/png' })),
      readPromptImage: (): { mimeType: string; data: string } => ({
        mimeType: 'image/png',
        data: 'iVBORw0KGgo='
      })
    },
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
    setWorkspaceChangeSummary: (summary): void => {
      workspaceChangeSummary = summary
    },
    setWorkspaceDiffPatch: (patch): void => {
      workspaceDiffPatch = patch
    },
    savedWorkspaceDiff: (): string | undefined => savedWorkspaceDiff,
    tryFrameNavigation: (input): boolean => {
      let prevented = false
      frameNavigationHandler?.({
        isMainFrame: input.isMainFrame,
        frame: input.frameName ? { name: input.frameName } : null,
        url: input.url,
        preventDefault: () => {
          prevented = true
        }
      })
      return prevented
    },
    sessions,
    exportedSessions,
    deleted,
    events,
    approvalOptions,
    runnerEvents,
    runStartInputs,
    createdPhiSessions,
    remoteConnectionChecks,
    wrapperJobOptions,
    remoteResolverProjectIds,
    remoteDoctorCalls,
    setWrapperPlan: (plan) => {
      wrapperPlan = plan
    },
    setRemoteProjectPhase: (phase) => {
      remoteProjectPhase = phase
    },
    retargetRequests,
    submitPlanCalls,
    setRemoteConnectionCheck: (impl) => {
      remoteConnectionCheck = impl
    },
    createdAgentOptions,
    resourceLoaderOptions,
    updatedProjectDefaults,
    updatedSessionManifests,
    appendedSessionEvents,
    wrapperJobFinishListeners,
    hostHandlers,
    setAgentInteractionResponse: (response): void => {
      agentInteractionResponse = response
    },
    setBridgeAgentJobs: (jobs): void => {
      bridgeAgentJobs = jobs
    },
    bridgeRequests,
    failBridgeRequests: (error: Error | undefined): void => {
      bridgeFailure = error
    },
    osNotifications,
    reportedWrapperRuns,
    setAppFocused: (focused: boolean): void => {
      appFocused = focused
    },
    persistedToolOutputs,
    revealedPaths,
    openedPaths,
    fileIconRequests,
    execFileCalls,
    previewReadRequests,
    appLogs,
    acknowledgedSessions,
    jupyterServerCalls,
    notebookSessionCalls,
    notebookExecutionCalls,
    notebookFormatCalls,
    openDialogOptions,
    saveDialogOptions,
    downloadCalls,
    operationLog,
    appSettingsUpdates,
    dbConnectorEnabledUpdates,
    setOpenDialogResult: (result): void => {
      openDialogResult = result
    },
    setSaveDialogResult: (result): void => {
      saveDialogResult = result
    },
    setDownloadImpl: (impl): void => {
      downloadImpl = impl
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

test('main IPC: user prompt stays verbatim while recommendation settings are read separately', async () => {
  const session = new FakeSession('fresh.jsonl')
  const app = await harness(async () => session)

  await app.invoke('agent:prompt', 'hello')

  assert.deepEqual(session.promptTexts, ['hello'])
  assert.equal(app.appendedSessionEvents[0].event.content, 'hello')
  assert.equal(await app.hostHandlers.get('settings.nextActionSuggestionsEnabled')?.({}), true)
  assert.deepEqual(await app.hostHandlers.get('cursorBridge.ensure')?.({}), {
    baseUrl: 'http://127.0.0.1:12345'
  })
})

test('main IPC: app settings exposes and updates default proxy mode', async () => {
  const app = await harness()
  const expectedStatus = {
    systemTransportAvailable: true,
    controlledProxyAvailable: false,
    autoTransportName: 'system',
    enabledModeAvailable: false,
    unavailableReason: '尚未配置受控代理通道'
  }

  assert.deepEqual(await app.invoke('settings:get'), {
    defaultProxyMode: 'auto',
    noProjectTaskFolder: '/workspace',
    preventSleepDuringRuns: false,
    nextActionSuggestionsEnabled: true,
    proxyTransportStatus: expectedStatus
  })
  assert.deepEqual(await app.invoke('settings:updateDefaultProxyMode', 'enabled'), {
    defaultProxyMode: 'enabled',
    noProjectTaskFolder: '/workspace',
    preventSleepDuringRuns: false,
    nextActionSuggestionsEnabled: true,
    proxyTransportStatus: expectedStatus
  })
  assert.deepEqual(await app.invoke('settings:get'), {
    defaultProxyMode: 'enabled',
    noProjectTaskFolder: '/workspace',
    preventSleepDuringRuns: false,
    nextActionSuggestionsEnabled: true,
    proxyTransportStatus: expectedStatus
  })
  assert.deepEqual(app.appSettingsUpdates, ['enabled'])
})

test('main IPC: DB connector tools stay behind Database agent and toggles remain per connector', async () => {
  const app = await harness()
  await app.invoke('projects:newSession', '/projects/db-enabled', 'ask')
  await app.invoke('agent:prompt', 'hello')
  assert.equal('enableDbConnectorTools' in app.createdAgentOptions[0], false)
  const resourceOptions = app.resourceLoaderOptions.at(-1)
  const appendSystemPrompt = resourceOptions?.appendSystemPrompt as string[] | undefined
  assert.doesNotMatch(appendSystemPrompt?.join('\n') ?? '', /<phi_db_connector_runtime>/)
  assert.doesNotMatch(
    appendSystemPrompt?.join('\n') ?? '',
    /\bdb_(?:search|domain|docs_search|query)\b/
  )
  // Phi's own scan feeds the leader prompt, and the same definitions go to the worker.
  assert.match(appendSystemPrompt?.join('\n') ?? '', /<phi_agents>/)
  assert.match(appendSystemPrompt?.join('\n') ?? '', /- Database: /)
  assert.match(appendSystemPrompt?.join('\n') ?? '', /- Visualization: /)
  assert.match(appendSystemPrompt?.join('\n') ?? '', /- Wrapper: /)
  const phiAgents = app.createdAgentOptions[0].phiAgents as Array<{ name: string }> | undefined
  assert.deepEqual(
    phiAgents?.map((agent) => agent.name),
    ['Database', 'Wrapper', 'Visualization']
  )

  const connectors = (await app.invoke('db:listConnectors')) as Array<{ id: string }>
  assert.deepEqual(
    connectors.map((connector) => connector.id),
    ['entrez/ncbi']
  )

  await app.invoke('db:setConnectorEnabled', 'entrez/ncbi', false)
  assert.deepEqual(app.dbConnectorEnabledUpdates, [
    { id: 'entrez/ncbi', digest: 'digest-entrez', enabled: false }
  ])
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

test('main IPC: file icons use the same local file boundary as file actions', async () => {
  const app = await harness()

  await app.invoke('projects:newSession', '/projects/current', 'ask')
  const icon = await app.invoke('files:getIcon', '/projects/current/src/App.tsx')
  const pngIcon = await app.invoke('files:getIcon', '/projects/current/plot.png')

  assert.equal(icon, 'data:image/png;base64,aWNvbg==')
  assert.equal(pngIcon, 'data:image/png;base64,aWNvbg==')
  assert.deepEqual(app.fileIconRequests, [
    process.platform === 'darwin'
      ? '/Applications/Visual Studio Code.app'
      : '/projects/current/src/App.tsx',
    process.platform === 'darwin'
      ? '/System/Applications/Preview.app'
      : '/projects/current/plot.png'
  ])
  if (process.platform === 'darwin') {
    assert.equal(app.execFileCalls.at(0)?.file, '/usr/bin/plutil')
    assert.equal(app.execFileCalls.at(1)?.file, '/usr/bin/mdfind')
    assert.equal(app.execFileCalls.at(2)?.file, '/usr/bin/mdfind')
    assert.equal(app.execFileCalls.length, 3)
  }
  await assert.rejects(
    app.invoke('files:getIcon', '/projects/other/src/App.tsx'),
    /只能读取图标 Phi 保存的文件或当前项目内的文件/
  )
  await assert.rejects(app.invoke('files:getIcon', 'relative.txt'), /只能读取图标绝对路径/)
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
  const htmlPreview = (await app.invoke('files:preview', '/projects/current/report.html')) as {
    kind: string
    mimeType: string
    content: string
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
  for (const [name, mimeType] of [
    ['photo.jpg', 'image/jpeg'],
    ['animation.gif', 'image/gif'],
    ['chart.webp', 'image/webp']
  ]) {
    const preview = (await app.invoke('files:preview', `/projects/current/${name}`)) as {
      kind: string
      mimeType: string
      dataUrl: string
      truncated: boolean
    }
    assert.equal(preview.kind, 'image')
    assert.equal(preview.mimeType, mimeType)
    assert.match(preview.dataUrl, new RegExp(`^data:${mimeType};base64,`))
    assert.equal(preview.truncated, false)
  }
  assert.equal(pdfPreview.kind, 'pdf')
  assert.equal(pdfPreview.mimeType, 'application/pdf')
  assert.match(pdfPreview.dataUrl, /^data:application\/pdf;base64,/)
  assert.equal(pdfPreview.content, undefined)
  assert.equal(pdfPreview.bytes, 9)
  assert.equal(pdfPreview.previewBytes, 9)
  assert.equal(pdfPreview.truncated, false)
  assert.equal(htmlPreview.kind, 'html')
  assert.equal(htmlPreview.mimeType, 'text/html')
  assert.match(htmlPreview.content, /<h1>QC report<\/h1>/)
  assert.equal(htmlPreview.previewBytes, Buffer.byteLength(htmlPreview.content))
  assert.equal(htmlPreview.truncated, false)
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

test('main IPC: an installed template preview image is displayable outside the project', async () => {
  const app = await harness()
  await app.invoke('projects:newSession', '/projects/current', 'ask')
  const previewPath = path.join(
    process.cwd(),
    'resources',
    'plugins',
    'visualization',
    'skills',
    'omics-visualization',
    'scripts',
    'scatter',
    'volcano',
    'preview.png'
  )
  assert.deepEqual(await app.invoke('files:statLocalPaths', '/projects/current', [previewPath]), [
    { path: previewPath, kind: 'file' }
  ])
  const preview = (await app.invoke('files:preview', previewPath)) as {
    kind: string
    path: string
    dataUrl: string
  }
  assert.equal(preview.kind, 'image')
  assert.equal(preview.path, previewPath)
  assert.match(preview.dataUrl, /^data:image\/png;base64,/)
  await assert.rejects(
    app.invoke(
      'files:preview',
      path.join(
        process.cwd(),
        'resources',
        'plugins',
        'visualization',
        'skills',
        'omics-visualization',
        'scripts',
        'scatter',
        'volcano',
        'plot.R'
      )
    ),
    /只能预览 Phi 保存的文件或当前项目内的文件/
  )
})

test('main window prevents HTML report frames from navigating away', async () => {
  const app = await harness()
  assert.equal(
    app.tryFrameNavigation({
      isMainFrame: false,
      frameName: htmlReportPreview.HTML_REPORT_FRAME_NAME,
      url: 'https://example.invalid/collect'
    }),
    true
  )
  assert.equal(
    app.tryFrameNavigation({
      isMainFrame: false,
      frameName: htmlReportPreview.HTML_REPORT_FRAME_NAME,
      url: 'about:srcdoc'
    }),
    false
  )
  assert.equal(app.tryFrameNavigation({ isMainFrame: true, url: 'http://localhost:5173/' }), false)
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

test('remote file panel IPC uses the bound project request and never falls through local file IPC', async () => {
  const app = await harness()
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  const request = {
    sessionId: String(app.createdPhiSessions[0]?.sessionId),
    projectId: 'remote-project-1',
    path: '/canonical/project/readme.md'
  }
  const preview = (await app.invoke('remoteWorkspace:preview', request)) as {
    path: string
    content: string
    rootPath: string
  }
  assert.equal(preview.path, 'ssh://cluster-one/canonical/project/readme.md')
  assert.equal(preview.content, 'remote:/canonical/project/readme.md')
  assert.equal(preview.rootPath, 'ssh://cluster-one/canonical/project')
  const listing = (await app.invoke('remoteWorkspace:listDirectory', {
    ...request,
    path: '/canonical/project'
  })) as { requestPath: string; entries: Array<{ path: string }> }
  assert.equal(listing.requestPath, '/canonical/project')
  assert.equal(listing.entries[0]?.path, 'ssh://cluster-one/canonical/project/readme.md')
  const resultRequest = {
    projectId: 'remote-project-1',
    hostProfileId: 'host-1',
    runId: 'wrun_a',
    scope: 'output',
    path: ''
  }
  assert.deepEqual(await app.invoke('wrapperResults:listDirectory', resultRequest), resultRequest)
  const resultPreview = (await app.invoke('wrapperResults:preview', {
    ...resultRequest,
    path: 'report.txt',
    requestId: 'preview_001'
  })) as { path: string; content: string }
  assert.equal(resultPreview.path, 'ssh://cluster-one/canonical/project/report.txt')
  assert.equal(resultPreview.content, 'remote result')
  const resultRange = (await app.invoke('wrapperResults:readRange', {
    ...resultRequest,
    path: 'data.bin',
    requestId: 'range_001',
    offset: 0,
    length: 1
  })) as { dataBase64: string }
  assert.equal(resultRange.dataBase64, 'AA==')
  const pendingRead = app.invoke('wrapperResults:readRange', {
    ...resultRequest,
    path: 'stall.bin',
    requestId: 'range_cancel_001',
    offset: 0,
    length: 1
  })
  assert.equal(await app.invoke('wrapperResults:cancelRead', 'range_cancel_001'), true)
  await assert.rejects(pendingRead, /读取已取消/)
  assert.equal(await app.invoke('wrapperResults:cancelRead', 'range_cancel_001'), false)
  assert.equal(app.previewReadRequests.length, 0)
  await assert.rejects(app.invoke('files:preview', preview.path), /只能预览绝对路径/)
  await assert.rejects(app.invoke('files:listDirectory', listing.entries[0]?.path))
  await assert.rejects(app.invoke('files:reveal', preview.path))
})

test('remote result download requires a save-dialog choice and routes progress and cancellation', async () => {
  const app = await harness()
  const request = {
    projectId: 'remote-project-1',
    hostProfileId: 'host-1',
    runId: 'wrun_a',
    scope: 'output',
    path: 'report.html',
    requestId: 'download_001'
  }
  assert.equal(app.downloadCalls.length, 0)
  await assert.rejects(
    app.invoke('wrapperResults:download', { ...request, destination: '/untrusted/path' }),
    /只能指定已保存的运行/
  )
  assert.equal(app.saveDialogOptions.length, 0)
  assert.deepEqual(await app.invoke('wrapperResults:download', request), { status: 'cancelled' })
  assert.equal(app.downloadCalls.length, 0)
  assert.equal(app.saveDialogOptions.at(-1)?.defaultPath, 'report.html')

  app.setSaveDialogResult({ canceled: false, filePath: '/chosen/report.html' })
  app.setDownloadImpl(async (_request, destination, options) => {
    options.onProgress?.({
      requestId: 'download_001',
      phase: 'downloading',
      bytesDownloaded: 2,
      totalBytes: 3
    })
    return {
      status: 'saved',
      path: destination,
      bytes: 3,
      sha256: 'sha256:abc',
      remoteDigestVerified: true
    }
  })
  const saved = (await app.invoke('wrapperResults:download', request)) as { path: string }
  assert.equal(saved.path, '/chosen/report.html')
  assert.deepEqual(app.downloadCalls[0], { request, destination: '/chosen/report.html' })
  assert.ok(
    app.events.some(
      (event) =>
        event.channel === 'wrapperResults:downloadProgress' &&
        (event.data as { bytesDownloaded?: number }).bytesDownloaded === 2
    )
  )
  assert.equal(await app.invoke('wrapperResults:cancelDownload', 'download_001'), false)

  const pendingRequest = { ...request, requestId: 'download_002' }
  app.setDownloadImpl(async (_request, _destination, options) => {
    options.onProgress?.({
      requestId: 'download_002',
      phase: 'downloading',
      bytesDownloaded: 0,
      totalBytes: 3
    })
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('cancelled by user')), {
        once: true
      })
    })
  })
  const pending = app.invoke('wrapperResults:download', pendingRequest)
  await tick()
  assert.equal(await app.invoke('wrapperResults:cancelDownload', 'download_002'), true)
  await assert.rejects(pending, /下载已取消/)
  assert.equal(await app.invoke('wrapperResults:cancelDownload', 'download_002'), false)
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

test('main IPC: remote doctor accepts a host profile before any project exists', async () => {
  const app = await harness()
  assert.deepEqual(await app.invoke('remote:doctor', 'host-1', '/cluster/work'), {
    hostProfileId: 'host-1',
    checkedAt: '2026-09-24T00:00:00.000Z',
    ok: true,
    checks: [{ id: 'ssh', status: 'ok', message: '/cluster/work' }]
  })
  await assert.rejects(app.invoke('remote:doctor', '', '/cluster/work'), /档案 ID 无效/)
  await assert.rejects(app.invoke('remote:doctor', 'host-1', 42), /路径无效/)
  assert.equal(app.sessions.length, 0)
})

test('main IPC lists OpenSSH configuration entries without creating Phi profiles', async () => {
  const app = await harness()
  assert.deepEqual(await app.invoke('projects:listOpenSshHosts'), [
    {
      alias: 'lab-hpc',
      hostname: 'compute.example.invalid',
      user: 'scientist',
      port: 22022,
      identityFiles: ['/tmp/lab-key']
    }
  ])
  assert.deepEqual(await app.invoke('projects:listRemoteHosts'), [
    { id: 'ssh-config:lab-hpc', label: 'lab-hpc', hostAlias: 'lab-hpc', source: 'ssh-config' }
  ])
})

test('main IPC writes a new SSH host through the config editor and returns its selectable identity', async () => {
  const app = await harness()
  const result = (await app.invoke('projects:saveOpenSshHost', {
    alias: 'new-lab',
    hostname: 'compute.example.invalid',
    user: 'scientist',
    port: 22022
  })) as { id: string; source: string }
  assert.deepEqual(result, {
    id: 'ssh-config:new-lab',
    label: 'new-lab',
    hostAlias: 'new-lab',
    source: 'ssh-config'
  })
  await assert.rejects(app.invoke('projects:saveOpenSshHost', null), /配置无效/)
})

test('main IPC protects the target identity of a host bound to a remote project', async () => {
  const app = await harness()
  await assert.rejects(
    app.invoke('projects:saveRemoteHost', {
      id: 'host-1',
      label: 'Cluster',
      hostAlias: 'other-server',
      user: 'scientist'
    }),
    /已绑定项目/
  )
  const updated = (await app.invoke('projects:saveRemoteHost', {
    id: 'host-1',
    label: 'Cluster',
    hostAlias: 'cluster-one',
    identityFile: '/tmp/new-key'
  })) as { identityFile: string }
  assert.equal(updated.identityFile, '/tmp/new-key')
})

test('main IPC: a remote project is registered without opening a local project session', async () => {
  const app = await harness()
  const project = (await app.invoke('projects:createRemote', {
    name: 'Cluster',
    hostProfileId: 'host-1',
    remoteRoot: '/cluster/project',
    permissionMode: 'ask'
  })) as { id: string; location: { kind: string; remoteRoot: string } }
  assert.equal(project.id, 'remote-project-1')
  assert.deepEqual(project.location, {
    kind: 'ssh',
    hostProfileId: 'host-1',
    remoteRoot: '/cluster/project',
    canonicalRoot: '/canonical/project'
  })
  assert.equal(app.sessions.length, 0)
})

test('main IPC: remote project session is tied to its ID and a private anchor', async () => {
  const app = await harness()
  const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    path: string
    cwd: string
    displayCwd: string
    projectId: string
    projectLocation: { kind: string; remoteRoot: string }
  }
  assert.equal(current.cwd, '/isolated/remote-project-anchors/remote-project-1')
  assert.equal(current.displayCwd, '/cluster/project')
  assert.equal(current.projectId, 'remote-project-1')
  assert.equal(current.projectLocation.kind, 'ssh')
  assert.equal(app.createdPhiSessions.at(-1)?.projectId, 'remote-project-1')
  assert.equal(app.createdPhiSessions.at(-1)?.cwd, current.cwd)
  assert.deepEqual(await app.invoke('projects:sessionsById', 'remote-project-1'), [])
  await assert.rejects(
    app.invoke('files:reveal', `${current.cwd}/AGENTS.md`),
    /只能显示 Phi 保存的文件或当前项目内的文件/
  )
  assert.deepEqual(
    await app.invoke('files:statLocalPaths', current.cwd, [`${current.cwd}/AGENTS.md`]),
    [{ path: `${current.cwd}/AGENTS.md`, kind: 'missing' }]
  )
  assert.deepEqual(
    ((await app.invoke('skills:list', current.cwd)) as Array<{ name: string }>).map(
      (skill) => skill.name
    ),
    ['global']
  )
  assert.deepEqual(
    ((await app.invoke('skills:list', '/projects/current')) as Array<{ name: string }>).map(
      (skill) => skill.name
    ),
    ['global']
  )
  assert.deepEqual(await app.invoke('agents:list', current.cwd), [])
  assert.deepEqual(
    ((await app.invoke('mcp:listServers', current.cwd)) as Array<{ name: string }>).map(
      (server) => server.name
    ),
    ['global-mcp']
  )
  assert.deepEqual(
    ((await app.invoke('mcp:listServers', '/projects/current')) as Array<{ name: string }>).map(
      (server) => server.name
    ),
    ['global-mcp']
  )
  assert.deepEqual(
    await app.invoke('skills:read', '/isolated/skills/global/SKILL.md', current.cwd),
    { filePath: '/isolated/skills/global/SKILL.md', content: '# global skill\n' }
  )
  await assert.rejects(app.invoke('files:pickInput'), /不会打开本机会话目录/)
  await assert.rejects(app.invoke('analysis:initializeProject', current.cwd), /请选择/)
  await assert.rejects(app.invoke('analysis:startJupyter', current.cwd), /请选择/)
  assert.deepEqual(app.jupyterServerCalls, [])
  assert.deepEqual(app.notebookSessionCalls, [])
  await assert.rejects(
    app.invoke('skills:read', `${current.cwd}/AGENTS.md`, current.cwd),
    /暂不可用/
  )
  await assert.rejects(
    app.invoke('skills:read', '/projects/current/.phi/skills/local/SKILL.md', '/projects/current'),
    /暂不可用/
  )
  await assert.rejects(app.invoke('wrappers:submitPlan', 'plan-1'), /不会在本机执行/)
  await app.invoke('sessions:create')
  const restored = (await app.invoke('sessions:switch', current.path)) as {
    projectId: string
    displayCwd: string
    cwd: string
  }
  assert.equal(restored.projectId, 'remote-project-1')
  assert.equal(restored.displayCwd, '/cluster/project')
  assert.equal(restored.cwd, current.cwd)
})

test('main IPC: featured MCP tools are read through the Bun worker', async () => {
  const app = await harness()
  assert.deepEqual(await app.invoke('mcp:featuredTools', 'pubmed'), ['search_articles'])
  assert.deepEqual(app.bridgeRequests.at(-1), {
    method: 'mcp.featuredTools',
    params: { id: 'pubmed' }
  })
  await assert.rejects(app.invoke('mcp:featuredTools', null), /连接器标识无效/)
  assert.equal(await app.invoke('mcp:featuredAuthStatus', 'notion'), true)
  assert.deepEqual(app.bridgeRequests.at(-1), {
    method: 'mcp.featuredAuthStatus',
    params: { id: 'notion' }
  })
  await assert.rejects(app.invoke('mcp:featuredAuthStatus', 'gmail'), /暂只支持 Notion/)
  await app.invoke('mcp:authorizeFeatured', 'notion')
  assert.deepEqual(app.bridgeRequests.at(-1), {
    method: 'mcp.authorizeFeatured',
    params: { id: 'notion' }
  })
  await assert.rejects(app.invoke('mcp:authorizeFeatured', 'gmail'), /暂只支持 Notion/)
  const openAuthUrl = app.hostHandlers.get('mcp.openAuthUrl')
  assert.ok(openAuthUrl)
  await assert.rejects(openAuthUrl({ url: 'http://example.com/authorize' }), /Notion MCP/)
  await assert.rejects(openAuthUrl({ url: 'https://example.com/authorize' }), /Notion MCP/)
  await assert.rejects(openAuthUrl({ url: 'https://user:pass@mcp.notion.com/' }), /Notion MCP/)
  await openAuthUrl({ url: 'https://mcp.notion.com/authorize' })
})

test(
  'main IPC: offline remote session restores history without waiting for SSH and retries by IDs',
  { timeout: 3000 },
  async () => {
    const app = await harness()
    const pending = deferred<{ phase: string }>()
    app.setRemoteConnectionCheck(() => pending.promise)
    const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
      path: string
      phiSessionId: string
      projectId: string
    }
    assert.equal(current.projectId, 'remote-project-1')
    assert.deepEqual(app.remoteConnectionChecks, [
      { sessionId: current.phiSessionId, projectId: current.projectId }
    ])

    app.appendedSessionEvents.push({
      sessionId: current.phiSessionId,
      event: { type: 'user_message', content: 'saved while offline', runId: 'old-run' }
    })
    const restored = (await app.invoke('sessions:switch', current.path)) as {
      projectId: string
      messages: Array<{ content?: string }>
    }
    assert.equal(restored.projectId, current.projectId)
    assert.equal(
      restored.messages.some((message) => message.content === 'saved while offline'),
      true
    )
    assert.equal(app.remoteConnectionChecks.length, 2)

    await assert.rejects(
      app.invoke('projects:retryRemoteConnection', {
        sessionId: current.phiSessionId,
        projectId: current.projectId,
        hostAlias: 'untrusted-host'
      }),
      /必须包含会话和项目 ID/
    )
    const retry = app.invoke('projects:retryRemoteConnection', {
      sessionId: current.phiSessionId,
      projectId: current.projectId
    })
    assert.deepEqual(app.remoteConnectionChecks.at(-1), {
      sessionId: current.phiSessionId,
      projectId: current.projectId
    })
    pending.resolve({ phase: 'reachable' })
    assert.deepEqual(await retry, { phase: 'reachable' })
  }
)

test('an older SSH session without a saved remote location cannot start local anchor tools', async () => {
  const app = await harness()
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  delete app.createdPhiSessions[0].projectLocation
  await assert.rejects(
    app.invoke('agent:prompt', 'read a project file'),
    /远程项目旧会话缺少服务器位置绑定/
  )
  assert.equal(app.sessions.length, 0)
})

test('main IPC allows only a plan snapshotted for the active SSH project to reach submit', async () => {
  const app = await harness()
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  app.setWrapperPlan({
    revision: 1,
    targetSelection: {
      projectId: 'another-project',
      target: 'remote',
      projectLocation: { kind: 'ssh' }
    }
  })
  await assert.rejects(
    app.invoke('wrappers:submitPlan', 'plan-1', undefined, {
      expectedRevision: 1,
      target: 'remote',
      projectId: 'another-project'
    }),
    /只能提交绑定本项目服务器/
  )
  app.setWrapperPlan({
    revision: 1,
    targetSelection: {
      projectId: 'remote-project-1',
      target: 'local',
      projectLocation: { kind: 'ssh' }
    }
  })
  await assert.rejects(
    app.invoke('wrappers:submitPlan', 'plan-1', undefined, {
      expectedRevision: 1,
      target: 'local',
      projectId: 'remote-project-1'
    }),
    /不会在本机执行/
  )
  app.setWrapperPlan({
    revision: 2,
    targetSelection: {
      projectId: 'remote-project-1',
      target: 'remote',
      hostProfileId: 'host-1',
      remoteRoot: '/canonical/project',
      projectLocation: { kind: 'ssh' }
    }
  })
  const confirmed = {
    expectedRevision: 2,
    target: 'remote',
    projectId: 'remote-project-1',
    hostProfileId: 'host-1',
    remoteRoot: '/canonical/project'
  }
  await assert.rejects(
    app.invoke('wrappers:submitPlan', 'plan-1', undefined, { ...confirmed, expectedRevision: 1 }),
    /执行目标已变化/
  )
  app.setRemoteProjectPhase('offline')
  await assert.rejects(
    app.invoke('wrappers:submitPlan', 'plan-1', undefined, confirmed),
    /服务器离线/
  )
  app.setRemoteProjectPhase('reachable')
  await assert.rejects(
    app.invoke('wrappers:submitPlan', 'plan-1', undefined, confirmed),
    /计划不存在: \(mocked/
  )
  app.setWrapperPlan({
    revision: 3,
    params: { outdir: '/scratch/approved-output' },
    targetSelection: {
      projectId: 'remote-project-1',
      target: 'remote',
      hostProfileId: 'host-1',
      remoteRoot: '/canonical/project',
      projectLocation: { kind: 'ssh' }
    }
  })
  const externalConfirmation = { ...confirmed, expectedRevision: 3 }
  await assert.rejects(
    app.invoke('wrappers:submitPlan', 'plan-1', undefined, externalConfirmation),
    /执行目标已变化/
  )
  await assert.rejects(
    app.invoke('wrappers:submitPlan', 'plan-1', undefined, {
      ...externalConfirmation,
      externalOutputRoot: '/scratch/other'
    }),
    /执行目标已变化/
  )
  await assert.rejects(
    app.invoke('wrappers:submitPlan', 'plan-1', undefined, {
      ...externalConfirmation,
      externalOutputRoot: '/scratch/approved-output'
    }),
    /计划不存在: \(mocked/
  )
  assert.deepEqual(app.submitPlanCalls, [
    { planId: 'plan-1', heavyWorkloadAcknowledged: undefined },
    { planId: 'plan-1', heavyWorkloadAcknowledged: undefined }
  ])
})

test('main IPC forwards an explicit local fallback request only with revision and confirmation', async () => {
  const app = await harness()
  await assert.rejects(
    app.invoke('wrappers:retargetPlan', {
      planId: 'plan-1',
      target: 'local',
      expectedRevision: 1,
      host: 'other'
    }),
    /目标变更请求无效/
  )
  const request = {
    planId: 'plan-1',
    target: 'local',
    expectedRevision: 1,
    confirmedLocalFallback: true
  }
  app.setWrapperPlan({
    revision: 1,
    targetSelection: { projectId: 'local-project', target: 'remote' }
  })
  const updated = (await app.invoke('wrappers:retargetPlan', request)) as { revision: number }
  assert.equal(updated.revision, 2)
  assert.deepEqual(app.retargetRequests, [request])
})

test('main IPC: remote conversation uses its project identity and disables anchor resources', async () => {
  const app = await harness()
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  await app.invoke('agent:prompt', 'hello from the cluster project')
  const options = app.createdAgentOptions.at(-1)
  assert.ok(options)
  assert.deepEqual(options.remoteProject, {
    phiSessionId: app.createdPhiSessions[0]?.sessionId,
    projectId: 'remote-project-1',
    location: {
      kind: 'ssh',
      hostProfileId: 'host-1',
      remoteRoot: '/cluster/project',
      canonicalRoot: '/canonical/project'
    },
    contextFiles: [
      { path: 'ssh://cluster-one/cluster/project/AGENTS.md', content: 'Remote instructions v1' }
    ]
  })
  const remoteAgent = (
    options.phiAgents as Array<{ name: string; tools: string[]; skills: string[] }>
  )[0]
  assert.equal(remoteAgent.name, 'Wrapper')
  assert.deepEqual(remoteAgent.skills, [])
  assert.deepEqual(remoteAgent.tools, [
    'read',
    'glob',
    'grep',
    'bash',
    'write',
    'edit',
    'wrapper_search',
    'wrapper_inspect',
    'wrapper_run',
    'wrapper_status',
    'wrapper_wait',
    'wrapper_cancel'
  ])
  const runtimeSessionId = app.sessions[0]?.runtimeSessionId
  assert.ok(runtimeSessionId)
  const resolveProjectForRun = app.wrapperJobOptions.resolveProjectForRun as
    ((sessionId: string) => { id: string } | undefined) | undefined
  const resolveRemoteTarget = app.wrapperJobOptions.resolveRemoteTarget as
    ((request: { originSessionId: string }) => unknown) | undefined
  assert.equal(resolveProjectForRun?.(runtimeSessionId)?.id, 'remote-project-1')
  resolveRemoteTarget?.({ originSessionId: runtimeSessionId })
  assert.equal(app.remoteResolverProjectIds.at(-1), 'remote-project-1')
  const checkRemoteEnvironment = app.wrapperJobOptions.checkRemoteEnvironment as
    | ((input: {
        project: { id: string; location: { kind: string; hostProfileId: string } }
        resolved: { target: { workspaceRoot: string; hpc: { scheduler: 'local' } } }
        profile: 'singularity'
      }) => Promise<unknown>)
    | undefined
  const boundProject = resolveProjectForRun?.(runtimeSessionId) as {
    id: string
    location: { kind: string; hostProfileId: string }
  }
  await checkRemoteEnvironment?.({
    project: boundProject,
    resolved: { target: { workspaceRoot: '/canonical/project', hpc: { scheduler: 'local' } } },
    profile: 'singularity'
  })
  assert.deepEqual(app.remoteDoctorCalls.at(-1), {
    hostProfileId: 'host-1',
    remotePath: '/canonical/project',
    options: { scope: 'full', scheduler: 'local', controller: 'login', runtime: 'singularity' }
  })
  const loader = app.resourceLoaderOptions.at(-1)
  assert.equal(loader?.noContextFiles, true)
  assert.equal(loader?.cwd, '/isolated')
  assert.equal(loader?.noSkills, undefined)
  assert.equal(loader?.noExtensions, true)
  assert.equal(app.approvalOptions.length, 1)
  const current = (await app.invoke('sessions:current')) as {
    displayCwd: string
    projectId: string
  }
  assert.equal(current.displayCwd, '/cluster/project')
  assert.equal(current.projectId, 'remote-project-1')
})

test('main bridge exposes only ID-bound remote path and Bash context requests', async () => {
  const app = await harness()
  const pathHandler = app.hostHandlers.get('remoteWorkspace.resolvePath')
  const bashHandler = app.hostHandlers.get('remoteWorkspace.resolveBashContext')
  const readHandler = app.hostHandlers.get('remoteWorkspace.read')
  const globHandler = app.hostHandlers.get('remoteWorkspace.glob')
  const grepHandler = app.hostHandlers.get('remoteWorkspace.grep')
  const bashRunHandler = app.hostHandlers.get('remoteWorkspace.bash')
  const bashCancelHandler = app.hostHandlers.get('remoteWorkspace.cancelBash')
  const writeHandler = app.hostHandlers.get('remoteWorkspace.write')
  const writeCancelHandler = app.hostHandlers.get('remoteWorkspace.cancelWrite')
  const editHandler = app.hostHandlers.get('remoteWorkspace.edit')
  const editCancelHandler = app.hostHandlers.get('remoteWorkspace.cancelEdit')
  assert.ok(pathHandler)
  assert.ok(bashHandler)
  assert.ok(readHandler)
  assert.ok(globHandler)
  assert.ok(grepHandler)
  assert.ok(bashRunHandler)
  assert.ok(bashCancelHandler)
  assert.ok(writeHandler)
  assert.ok(writeCancelHandler)
  assert.ok(editHandler)
  assert.ok(editCancelHandler)
  assert.deepEqual(
    await pathHandler({
      sessionId: 'session-a',
      projectId: 'remote-project-1',
      path: 'readme.md',
      mode: 'existing'
    }),
    {
      sessionId: 'session-a',
      projectId: 'remote-project-1',
      path: '/canonical/project/readme.md',
      mode: 'existing',
      hostAlias: 'cluster-one'
    }
  )
  assert.deepEqual(await bashHandler({ sessionId: 'session-a', projectId: 'remote-project-1' }), {
    sessionId: 'session-a',
    projectId: 'remote-project-1',
    cwd: '/canonical/project',
    hostAlias: 'cluster-one',
    approvalScope: 'SSH cluster-one · cwd /canonical/project；Shell 命令可访问项目目录之外'
  })
  assert.deepEqual(
    await readHandler({ sessionId: 'session-a', projectId: 'remote-project-1', path: 'readme.md' }),
    {
      kind: 'file',
      path: 'ssh://cluster-one/canonical/project/readme.md',
      content: 'remote:readme.md',
      fileSize: 13,
      contentType: 'text/plain'
    }
  )
  assert.equal(
    (
      (await globHandler({
        sessionId: 'session-a',
        projectId: 'remote-project-1',
        path: '*.md'
      })) as { content: string }
    ).content,
    'glob:*.md'
  )
  assert.equal(
    (
      (await grepHandler({
        sessionId: 'session-a',
        projectId: 'remote-project-1',
        pattern: 'marker'
      })) as { content: string }
    ).content,
    'grep:marker'
  )
})

test('remote ask-mode Bash needs a one-use approval tied to session, call and command', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.hold = true
    return session
  })
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  const prompt = app.invoke('agent:prompt', 'run a command')
  await tick()
  assert.equal(app.approvalOptions.length, 1)
  const options = app.approvalOptions[0] as {
    getContext: () => { cwd: string; scopeNote: string; sessionId: string }
    onApprovalResolved: (
      request: {
        sessionId: string
        requestId: string
        toolCallId: string
        toolName: string
        command: string
        approvalDigest: string
        cwd: string
      },
      approved: boolean
    ) => void
  }
  const context = options.getContext()
  assert.equal(context.cwd, 'ssh://cluster-one/canonical/project')
  assert.match(context.scopeNote, /Shell 命令可访问项目目录之外/)
  const run = app.hostHandlers.get('remoteWorkspace.bash')
  assert.ok(run)
  const request = {
    sessionId: context.sessionId,
    projectId: 'remote-project-1',
    requestId: 'remote-run-1',
    toolCallId: 'tool-1',
    command: 'printf remote-ok'
  }
  await assert.rejects(run(request), /尚未获得本次会话的批准/)
  options.onApprovalResolved(
    {
      sessionId: context.sessionId,
      requestId: 'approval-1',
      toolCallId: 'tool-1',
      toolName: 'bash',
      command: request.command,
      approvalDigest: fakeBashApprovalDigest(request),
      cwd: context.cwd
    },
    true
  )
  assert.equal(((await run(request)) as { stdout: string }).stdout, 'remote-ok')
  await assert.rejects(run(request), /尚未获得本次会话的批准/)
  options.onApprovalResolved(
    {
      sessionId: context.sessionId,
      requestId: 'approval-2',
      toolCallId: 'tool-2',
      toolName: 'bash',
      command: 'printf safe',
      approvalDigest: fakeBashApprovalDigest({ command: 'printf safe' }),
      cwd: context.cwd
    },
    true
  )
  await assert.rejects(
    run({ ...request, requestId: 'remote-run-2', toolCallId: 'tool-2', command: 'printf changed' }),
    /尚未获得本次会话的批准/
  )
  options.onApprovalResolved(
    {
      sessionId: context.sessionId,
      requestId: 'approval-3',
      toolCallId: 'tool-3',
      toolName: 'bash',
      command: request.command,
      approvalDigest: fakeBashApprovalDigest({ command: request.command, env: { TOKEN: 'safe' } }),
      cwd: context.cwd
    },
    true
  )
  await assert.rejects(
    run({
      ...request,
      requestId: 'remote-run-3',
      toolCallId: 'tool-3',
      env: { TOKEN: 'changed' }
    }),
    /尚未获得本次会话的批准/
  )
  await app.invoke('agent:stop')
  await prompt
})

test('remote ask-mode write needs a one-use approval tied to host, path and content', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.hold = true
    return session
  })
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  const prompt = app.invoke('agent:prompt', 'create one file')
  await tick()
  const options = app.approvalOptions[0] as {
    getContext: () => { cwd: string; writeScopeNote: string; sessionId: string }
    onApprovalResolved: (
      request: {
        sessionId: string
        requestId: string
        toolCallId: string
        toolName: string
        approvalDigest: string
        cwd: string
      },
      approved: boolean
    ) => void
  }
  const context = options.getContext()
  assert.equal(context.cwd, 'ssh://cluster-one/canonical/project')
  assert.match(context.writeScopeNote, /新建文件或修改已读取且未变化的文件/)
  const run = app.hostHandlers.get('remoteWorkspace.write')
  assert.ok(run)
  const request = {
    sessionId: context.sessionId,
    projectId: 'remote-project-1',
    requestId: 'write-1',
    toolCallId: 'tool-write-1',
    path: 'new.txt',
    content: 'ok'
  }
  await assert.rejects(run(request), /尚未获得本次会话的批准/)
  options.onApprovalResolved(
    {
      sessionId: context.sessionId,
      requestId: 'approval-write-1',
      toolCallId: request.toolCallId,
      toolName: 'write',
      approvalDigest: fakeWriteApprovalDigest(request),
      cwd: context.cwd
    },
    true
  )
  await assert.rejects(run({ ...request, path: 'other.txt' }), /尚未获得本次会话的批准/)
  options.onApprovalResolved(
    {
      sessionId: context.sessionId,
      requestId: 'approval-write-content',
      toolCallId: request.toolCallId,
      toolName: 'write',
      approvalDigest: fakeWriteApprovalDigest(request),
      cwd: context.cwd
    },
    true
  )
  await assert.rejects(run({ ...request, content: 'changed' }), /尚未获得本次会话的批准/)
  options.onApprovalResolved(
    {
      sessionId: context.sessionId,
      requestId: 'approval-write-2',
      toolCallId: request.toolCallId,
      toolName: 'write',
      approvalDigest: fakeWriteApprovalDigest(request),
      cwd: context.cwd
    },
    true
  )
  assert.equal(((await run(request)) as { status: string }).status, 'created')
  await assert.rejects(run(request), /尚未获得本次会话的批准/)
  await app.invoke('agent:stop')
  await prompt
})

test('remote ask-mode edit binds path, replacement and one-use approval', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.hold = true
    return session
  })
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  const prompt = app.invoke('agent:prompt', 'edit one file')
  await tick()
  const options = app.approvalOptions[0] as {
    getContext: () => { cwd: string; writeScopeNote: string; sessionId: string }
    onApprovalResolved: (
      request: {
        sessionId: string
        requestId: string
        toolCallId: string
        toolName: string
        approvalDigest: string
        cwd: string
      },
      approved: boolean
    ) => void
  }
  const context = options.getContext()
  const run = app.hostHandlers.get('remoteWorkspace.edit')
  assert.ok(run)
  const request = {
    sessionId: context.sessionId,
    projectId: 'remote-project-1',
    requestId: 'edit-1',
    toolCallId: 'tool-edit-1',
    path: 'existing.txt',
    old_string: 'before',
    new_string: 'after'
  }
  await assert.rejects(run(request), /尚未获得本次会话的批准/)
  const approve = (id: string): void =>
    options.onApprovalResolved(
      {
        sessionId: context.sessionId,
        requestId: id,
        toolCallId: request.toolCallId,
        toolName: 'edit',
        approvalDigest: fakeEditApprovalDigest(request),
        cwd: context.cwd
      },
      true
    )
  approve('approval-edit-1')
  await assert.rejects(run({ ...request, new_string: 'changed' }), /尚未获得本次会话的批准/)
  approve('approval-edit-2')
  assert.equal(((await run(request)) as { status: string }).status, 'updated')
  await assert.rejects(run(request), /尚未获得本次会话的批准/)
  await app.invoke('agent:stop')
  await prompt
})

test('remote background Wrapper approval keeps host, project, timeline and one-use ticket after the parent turn', async () => {
  const app = await harness()
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  await app.invoke('agent:prompt', 'inspect wrapper in the background')
  const options = app.approvalOptions[0] as {
    getContext: (event: { agentRunId?: string }) => {
      sessionId: string
      sessionPath: string
      runId: string
      cwd: string
      projectName: string
      writeScopeNote: string
    }
    onApprovalRequested: (request: Record<string, unknown>) => void
    onApprovalResolved: (request: Record<string, unknown>, approved: boolean) => void
  }
  const context = options.getContext({ agentRunId: 'wrapper-run-1' })
  assert.equal(context.sessionId, app.createdPhiSessions[0]?.sessionId)
  assert.equal(context.runId, 'wrapper-run-1')
  assert.equal(context.cwd, 'ssh://cluster-one/canonical/project')
  assert.equal(context.projectName, 'Remote project')
  assert.doesNotMatch(context.writeScopeNote, /remote-project-anchors/)
  const run = app.hostHandlers.get('remoteWorkspace.write')
  assert.ok(run)
  const input = {
    sessionId: context.sessionId,
    projectId: 'remote-project-1',
    requestId: 'background-write-1',
    toolCallId: 'background-tool-1',
    path: 'note.txt',
    content: 'safe'
  }
  const approval = {
    sessionId: context.sessionId,
    requestId: 'approval-background-1',
    toolCallId: input.toolCallId,
    agentRunId: 'wrapper-run-1',
    toolName: 'write',
    approvalDigest: fakeWriteApprovalDigest(input),
    cwd: context.cwd,
    summary: `${context.writeScopeNote}\nnote.txt`
  }
  options.onApprovalRequested(approval)
  assert.equal(app.appendedSessionEvents.at(-1)?.event.type, 'approval_requested')
  assert.equal(app.appendedSessionEvents.at(-1)?.event.runId, 'wrapper-run-1')
  assert.equal(app.updatedSessionManifests.at(-1)?.patch.status, 'needs_approval')
  options.onApprovalResolved(approval, false)
  assert.equal(app.appendedSessionEvents.at(-1)?.event.type, 'approval_denied')
  await assert.rejects(run(input), /尚未获得本次会话的批准/)

  const allowed = { ...approval, requestId: 'approval-background-2' }
  options.onApprovalRequested(allowed)
  options.onApprovalResolved(allowed, true)
  assert.equal(((await run(input)) as { status: string }).status, 'created')
  await assert.rejects(run(input), /尚未获得本次会话的批准/)
  assert.equal(app.appendedSessionEvents.at(-1)?.event.type, 'approval_approved')
})

test('remote project permission switches apply to existing sessions and host tickets', async () => {
  const app = await harness()
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  await app.invoke('agent:prompt', 'inspect a file')
  const options = app.approvalOptions[0] as { shouldGate: () => boolean }
  assert.ok(options)
  assert.equal(options.shouldGate(), true)
  const sessionId = String(app.createdPhiSessions[0]?.sessionId)
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  const secondSessionId = String(app.createdPhiSessions[1]?.sessionId)
  const run = app.hostHandlers.get('remoteWorkspace.write')
  assert.ok(run)
  const input = {
    sessionId,
    projectId: 'remote-project-1',
    requestId: 'mode-write-1',
    toolCallId: 'mode-tool-1',
    path: 'new.txt',
    content: 'safe'
  }
  await app.invoke('projects:updatePermissionMode', 'remote-project-1', 'full')
  assert.equal(options.shouldGate(), false)
  assert.equal(
    app.updatedSessionManifests.some(
      (entry) => entry.sessionId === secondSessionId && entry.patch.permissionMode === 'full'
    ),
    true
  )
  assert.equal(((await run(input)) as { status: string }).status, 'created')
  await app.invoke('projects:updatePermissionMode', 'remote-project-1', 'auto')
  assert.equal(options.shouldGate(), false)
  assert.equal(
    ((await run({ ...input, requestId: 'mode-write-2' })) as { status: string }).status,
    'created'
  )
  await app.invoke('projects:updatePermissionMode', 'remote-project-1', 'ask')
  assert.equal(options.shouldGate(), true)
  await assert.rejects(run({ ...input, requestId: 'mode-write-3' }), /尚未获得本次会话的批准/)
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

test('main IPC exposes local package registry planning and lifecycle channels', async () => {
  const app = await harness()

  app.setOpenDialogResult({ canceled: false, filePaths: ['/registry'] })
  assert.equal(await app.invoke('packages:pickRegistryDirectory'), '/registry')

  const registry = (await app.invoke('packages:registry', '/registry')) as {
    id: string
    schemaVersion: number
  }
  assert.equal(registry.id, '/registry')
  assert.equal(registry.schemaVersion, 1)
  const plan = (await app.invoke(
    'packages:plan',
    '/registry',
    'skill',
    'alpha-skill',
    '1.0.0'
  )) as { root: { type: string; id: string; version: string } }
  assert.deepEqual(plan.root, { type: 'skill', id: 'alpha-skill', version: '1.0.0' })
  assert.deepEqual(await app.invoke('packages:install', '/registry', 'skill', 'alpha-skill'), [
    { type: 'skill', id: 'alpha-skill' }
  ])
  assert.deepEqual(await app.invoke('enablement:get'), {
    version: 1,
    global: { 'skill:alpha-skill': true },
    project: {}
  })
  assert.deepEqual(await app.invoke('packages:listInstalled'), [])
  assert.deepEqual(await app.invoke('packages:uninstall', 'skill', 'alpha-skill'), [])
  await assert.rejects(app.invoke('packages:plan', '', 'wrapper', '', undefined), /参数无效/)
})

test('main IPC validates and stores global and project enablement', async () => {
  const app = await harness()

  assert.deepEqual(await app.invoke('enablement:get'), {
    version: 1,
    global: {},
    project: {}
  })
  assert.deepEqual(await app.invoke('enablement:set', 'skill:scanpy', true, { type: 'global' }), {
    version: 1,
    global: { 'skill:scanpy': true },
    project: {}
  })
  assert.deepEqual(
    await app.invoke('enablement:set', 'skill:scanpy', false, {
      type: 'project',
      projectCwd: '/projects/current'
    }),
    {
      version: 1,
      global: { 'skill:scanpy': true },
      projectPath: '/projects/current',
      project: { 'skill:scanpy': false }
    }
  )
  assert.deepEqual(
    await app.invoke('enablement:set', 'wrapper:module-nf-core-fastqc', true, { type: 'global' }),
    {
      version: 1,
      global: { 'skill:scanpy': true, 'wrapper:module-nf-core-fastqc': true },
      project: {}
    }
  )
  await assert.rejects(
    app.invoke('enablement:set', 'wrapper:FastQC', true, { type: 'global' }),
    /标识无效/
  )
  await assert.rejects(
    app.invoke('enablement:set', 'skill:scanpy', 'yes', { type: 'global' }),
    /启用值无效/
  )
  await assert.rejects(
    app.invoke('enablement:set', 'skill:scanpy', true, { type: 'project' }),
    /项目启用范围无效/
  )
})

test('main IPC records the production loaded-skill shape for migration', async () => {
  const app = await harness()

  await app.invoke('agent:prompt', 'use the available skill')

  const started = app.runStartInputs[0]
  assert.deepEqual(started?.loadedSkills, ['skill'])
})

test('main IPC refreshes loaded-skill history after runtime invalidation', async () => {
  const app = await harness()

  await app.invoke('agent:prompt', 'first run')
  await app.invoke('packages:install', '/registry', 'skill', 'alpha-skill')
  await app.invoke('agent:prompt', 'second run')

  assert.deepEqual(
    app.runStartInputs.map((input) => input.loadedSkills),
    [['skill'], ['alpha-skill', 'skill']]
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

test('main IPC: context usage follows the selected session and preserves unavailable capacity', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    if (file === 'alpha.jsonl') {
      session.contextUsage = {
        tokens: 24000,
        contextWindow: 200000,
        percent: 12,
        deferredMcpTokens: 8000,
        categories: [
          { id: 'systemPrompt', tokens: 1000 },
          { id: 'systemTools', tokens: 2500 },
          { id: 'mcpTools', tokens: 500 },
          { id: 'systemContext', tokens: 2000 },
          { id: 'skills', tokens: 4000 },
          { id: 'conversation', tokens: 14000 }
        ]
      }
    }
    return session
  })

  await app.invoke('sessions:switch', 'alpha.jsonl')
  const alpha = (await app.invoke('sessions:contextUsage')) as {
    sessionPath: string | null
    usage: FakeSession['contextUsage']
  }
  assert.equal(alpha.sessionPath, 'alpha.jsonl')
  assert.deepEqual(alpha.usage, {
    tokens: 24000,
    contextWindow: 200000,
    percent: 12,
    deferredMcpTokens: 8000,
    categories: [
      { id: 'systemPrompt', tokens: 1000 },
      { id: 'systemTools', tokens: 2500 },
      { id: 'mcpTools', tokens: 500 },
      { id: 'systemContext', tokens: 2000 },
      { id: 'skills', tokens: 4000 },
      { id: 'conversation', tokens: 14000 }
    ]
  })

  await app.invoke('sessions:switch', 'beta.jsonl')
  const beta = (await app.invoke('sessions:contextUsage')) as {
    sessionPath: string | null
    usage: FakeSession['contextUsage']
  }
  assert.equal(beta.sessionPath, 'beta.jsonl')
  assert.equal(beta.usage, null)
})

test('main IPC: a Phi-managed conversation reads usage after its first turn', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.contextUsage = { tokens: 12000, contextWindow: 128000, percent: 9.375 }
    return session
  })

  const created = (await app.invoke('sessions:create')) as { path: string }
  await app.invoke('agent:prompt', 'hello')
  const context = (await app.invoke('sessions:contextUsage')) as {
    sessionPath: string | null
    phiSessionId: string | null
    usage: FakeSession['contextUsage']
  }

  assert.equal(context.sessionPath, created.path)
  assert.ok(context.phiSessionId)
  assert.deepEqual(context.usage, { tokens: 12000, contextWindow: 128000, percent: 9.375 })
})

test('main IPC: an empty Phi session has no usage and does not start a runtime', async () => {
  const app = await harness()
  const created = (await app.invoke('sessions:create')) as { path: string }
  const before = app.sessions.length

  const context = (await app.invoke('sessions:contextUsage')) as {
    sessionPath: string | null
    usage: FakeSession['contextUsage']
  }

  assert.equal(context.sessionPath, created.path)
  assert.equal(context.usage, null)
  assert.equal(app.sessions.length, before)
})

test('main IPC: a late usage result cannot be attributed to the next selected session', async () => {
  const gate = deferred<void>()
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    if (file === 'alpha.jsonl') {
      session.contextUsage = { tokens: 24000, contextWindow: 200000, percent: 12 }
      session.contextUsageGate = gate.promise
    }
    return session
  })

  await app.invoke('sessions:switch', 'alpha.jsonl')
  const pending = app.invoke('sessions:contextUsage')
  await tick()
  await app.invoke('sessions:switch', 'beta.jsonl')
  gate.resolve()

  const stale = (await pending) as {
    sessionPath: string | null
    usage: FakeSession['contextUsage']
  }
  assert.equal(stale.sessionPath, 'alpha.jsonl')
  assert.equal(stale.usage, null)
})

function compactionTarget(current: unknown): {
  sessionPath: string | null
  phiSessionId: string | null
  sessionGeneration: number
} {
  const session = current as {
    path: string | null
    phiSessionId?: string
    sessionGeneration: number
  }
  return {
    sessionPath: session.path,
    phiSessionId: session.phiSessionId ?? null,
    sessionGeneration: session.sessionGeneration
  }
}

test('main IPC: automatic compaction settings stay with their session and use SDK defaults', async () => {
  const app = await harness()
  const first = (await app.invoke('sessions:create')) as { path: string }
  const firstTarget = compactionTarget(await app.invoke('sessions:current'))
  const defaults = (await app.invoke('sessions:autoCompactionSettings', firstTarget)) as {
    enabled: boolean
    thresholdPercent: number
    overrides: Record<string, unknown>
  }
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.thresholdPercent, -1)
  assert.deepEqual(defaults.overrides, {})

  const firstSettings = (await app.invoke('sessions:autoCompactionSettings:set', firstTarget, {
    enabled: false,
    thresholdPercent: 70
  })) as { enabled: boolean; thresholdPercent: number; overrides: Record<string, unknown> }
  assert.equal(firstSettings.enabled, false)
  assert.equal(firstSettings.thresholdPercent, 70)
  assert.deepEqual(firstSettings.overrides, { enabled: false, thresholdPercent: 70 })
  await app.invoke('agent:prompt', 'first conversation')
  assert.deepEqual(app.createdAgentOptions[0].autoCompaction, {
    enabled: false,
    thresholdPercent: 70
  })
  assert.deepEqual(app.sessions[0].autoCompactionOverrides, {
    enabled: false,
    thresholdPercent: 70
  })

  await app.invoke('sessions:create')
  const secondTarget = compactionTarget(await app.invoke('sessions:current'))
  const secondDefaults = (await app.invoke('sessions:autoCompactionSettings', secondTarget)) as {
    enabled: boolean
    thresholdPercent: number
  }
  assert.equal(secondDefaults.enabled, true)
  assert.equal(secondDefaults.thresholdPercent, -1)
  await app.invoke('sessions:autoCompactionSettings:set', secondTarget, { thresholdPercent: 90 })
  await app.invoke('agent:prompt', 'second conversation')
  assert.deepEqual(app.sessions[1].autoCompactionOverrides, { thresholdPercent: 90 })
  await app.invoke('sessions:autoCompactionSettings:set', secondTarget, { enabled: false })
  assert.deepEqual(app.sessions[1].autoCompactionOverrides, {
    enabled: false,
    thresholdPercent: 90
  })
  assert.deepEqual(app.sessions[0].autoCompactionOverrides, {
    enabled: false,
    thresholdPercent: 70
  })

  await app.invoke('sessions:switch', first.path)
  const restored = (await app.invoke(
    'sessions:autoCompactionSettings',
    compactionTarget(await app.invoke('sessions:current'))
  )) as {
    enabled: boolean
    thresholdPercent: number
  }
  assert.equal(restored.enabled, false)
  assert.equal(restored.thresholdPercent, 70)
  await app.invoke(
    'sessions:autoCompactionSettings:set',
    compactionTarget(await app.invoke('sessions:current')),
    { enabled: null, thresholdPercent: null }
  )
  const reset = (await app.invoke(
    'sessions:autoCompactionSettings',
    compactionTarget(await app.invoke('sessions:current'))
  )) as {
    enabled: boolean
    thresholdPercent: number
    overrides: Record<string, unknown>
  }
  assert.equal(reset.enabled, true)
  assert.equal(reset.thresholdPercent, -1)
  assert.deepEqual(reset.overrides, {})
  assert.deepEqual(app.sessions[0].autoCompactionOverrides, {})
})

test('main IPC: automatic compaction settings reject invalid presets and stale targets', async () => {
  const app = await harness()
  await app.invoke('sessions:create')
  const target = compactionTarget(await app.invoke('sessions:current'))
  await assert.rejects(
    app.invoke('sessions:autoCompactionSettings:set', target, { thresholdPercent: 55 }),
    /阈值无效/
  )
  await app.invoke('sessions:create')
  await assert.rejects(
    app.invoke('sessions:autoCompactionSettings:set', target, { enabled: false }),
    /会话已切换/
  )
})

test('main IPC: automatic compaction settings cannot change during a run', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.hold = true
    return session
  })
  await app.invoke('sessions:create')
  const target = compactionTarget(await app.invoke('sessions:current'))
  const prompt = app.invoke('agent:prompt', 'hello')
  await tick()
  await assert.rejects(
    app.invoke('sessions:autoCompactionSettings:set', target, { enabled: false }),
    /运行结束/
  )
  app.sessions[0].finish.resolve()
  await prompt
})

test('main IPC: manual compaction persists a notice without sending a chat message', async () => {
  const app = await harness()
  await app.invoke('sessions:create')
  await app.invoke('agent:prompt', 'hello')
  const target = compactionTarget(await app.invoke('sessions:current'))
  app.sessions[0].contextUsage = { tokens: 5000, contextWindow: 200000, percent: 2.5 }
  const userMessagesBefore = app.appendedSessionEvents.filter(
    (entry) => entry.event.type === 'user_message'
  ).length

  const result = (await app.invoke('sessions:compact', target)) as {
    phiSessionId: string
    tokensBefore: number
    tokensAfter?: number
  }

  assert.equal(result.tokensBefore, 24000)
  assert.equal(result.tokensAfter, 5000)
  assert.equal(app.sessions[0].compactCalls, 1)
  assert.equal(
    app.appendedSessionEvents.filter((entry) => entry.event.type === 'user_message').length,
    userMessagesBefore
  )
  const notice = app.appendedSessionEvents.find((entry) => entry.event.type === 'context_compacted')
  assert.equal(notice?.sessionId, result.phiSessionId)
  assert.deepEqual(withoutTimestamp(notice?.event ?? {}), {
    type: 'context_compacted',
    action: 'manual',
    reason: 'user',
    summary: 'Earlier work was summarized.',
    shortSummary: 'Earlier work',
    tokensBefore: 24000,
    tokensAfter: 5000
  })
  assert.ok(
    app.events.some(
      (event) =>
        event.channel === 'agent:event' &&
        (event.data as { type?: string }).type === 'context_compacted'
    )
  )
})

test('main IPC: manual compaction rejects running and stale conversations', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.hold = true
    return session
  })
  await app.invoke('sessions:create')
  const target = compactionTarget(await app.invoke('sessions:current'))
  const prompt = app.invoke('agent:prompt', 'hello')
  await tick()
  await assert.rejects(app.invoke('sessions:compact', target), /运行结束/)
  app.sessions[0].finish.resolve()
  await prompt
  await app.invoke('sessions:switch', 'other.jsonl')
  await assert.rejects(app.invoke('sessions:compact', target), /会话已切换/)
  assert.equal(app.sessions[0].compactCalls, 0)
})

test('main IPC: manual compaction leaves an empty conversation untouched', async () => {
  const app = await harness()
  await app.invoke('sessions:create')
  const target = compactionTarget(await app.invoke('sessions:current'))
  const before = app.sessions.length

  await assert.rejects(app.invoke('sessions:compact', target), /暂无可压缩的历史/)
  assert.equal(app.sessions.length, before)
  assert.equal(
    app.appendedSessionEvents.some((entry) => entry.event.type === 'context_compacted'),
    false
  )
})

test('main IPC: manual compaction excludes duplicates and new prompts until it finishes', async () => {
  const gate = deferred<void>()
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.compactGate = gate.promise
    return session
  })
  await app.invoke('sessions:create')
  await app.invoke('agent:prompt', 'hello')
  const target = compactionTarget(await app.invoke('sessions:current'))
  const compacting = app.invoke('sessions:compact', target)
  await tick()

  await assert.rejects(app.invoke('sessions:compact', target), /正在进行/)
  await assert.rejects(app.invoke('agent:prompt', 'second'), /压缩正在进行/)
  gate.resolve()
  await compacting
  assert.equal(app.sessions[0].compactCalls, 1)
  assert.deepEqual(app.sessions[0].promptTexts, ['hello'])
})

test('main IPC: a background result waits until manual compaction ends before waking its conversation', async () => {
  const gate = deferred<void>()
  const { app, session } = await idleConversation()
  session.compactGate = gate.promise
  const target = compactionTarget(await app.invoke('sessions:current'))
  const compacting = app.invoke('sessions:compact', target)
  await tick()

  await agentRunFinished(app, session.runtimeSessionId)
  await tick()
  assert.equal(session.promptTexts.length, 1)

  gate.resolve()
  await compacting
  await waitUntil(() => session.promptTexts.length === 2)
  assert.match(session.promptTexts[1], AGENT_WOKEN)
})

test('main IPC: a failed manual compaction records the reason and releases its lock', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.compactError = new Error('summary unavailable')
    return session
  })
  await app.invoke('sessions:create')
  await app.invoke('agent:prompt', 'hello')
  const target = compactionTarget(await app.invoke('sessions:current'))

  await assert.rejects(app.invoke('sessions:compact', target), /summary unavailable/)
  const failure = app.appendedSessionEvents.find(
    (entry) => entry.event.type === 'context_compaction_failed'
  )
  assert.equal((failure?.event as { errorMessage?: string })?.errorMessage, 'summary unavailable')
  await assert.rejects(app.invoke('sessions:compact', target), /summary unavailable/)
  assert.equal(app.sessions[0].compactCalls, 2)
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

test('main IPC: retry prompt target can suppress a duplicate user event', async () => {
  const app = await harness()

  const first = (await app.invoke('agent:prompt', 'retry me')) as {
    path: string | null
    phiSessionId?: string
    cwd?: string
    sessionGeneration: number
  }
  const beforeRetryEventCount = app.appendedSessionEvents.length

  await app.invoke('agent:prompt', 'retry me', {
    path: first.path,
    phiSessionId: first.phiSessionId,
    cwd: first.cwd ?? '/workspace',
    sessionGeneration: first.sessionGeneration,
    suppressUserMessageEvent: true,
    retryUserMessageId: 'event-user'
  })

  const retryEvents = app.appendedSessionEvents.slice(beforeRetryEventCount)
  assert.equal(
    retryEvents.some((entry) => (entry.event as { type?: string }).type === 'user_message'),
    false
  )
  assert.deepEqual(
    retryEvents.filter((entry) => (entry.event as { type?: string }).type === 'user_message_retry'),
    [
      {
        sessionId: 'phi-1',
        event: {
          type: 'user_message_retry',
          runId: 'run-2',
          content: 'retry me',
          userMessageId: 'event-user'
        }
      }
    ]
  )
  const session = app.sessions.find((item) => item.sessionFile === 'fresh.jsonl')
  assert.equal(session?.promptTexts.length, 2)
  assert.equal(
    session?.promptTexts.every((text) => text.startsWith('retry me')),
    true
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

  assert.equal(ordinary.projectCwd, '/workspace')
  assert.equal(ordinary.message, undefined)
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

test('main IPC: analysis notebook files also support the ordinary workspace', async () => {
  const app = await harness()

  const created = (await app.invoke('analysis:createNotebook', '/workspace')) as {
    path: string
    relativePath: string
  }
  const opened = (await app.invoke(
    'analysis:openNotebook',
    '/workspace',
    created.relativePath
  )) as {
    path: string
    relativePath: string
  }

  assert.equal(created.path, '/workspace/notebooks/Untitled.ipynb')
  assert.equal(created.relativePath, 'notebooks/Untitled.ipynb')
  assert.equal(opened.path, '/workspace/notebooks/Untitled.ipynb')
  assert.equal(opened.relativePath, 'notebooks/Untitled.ipynb')
})

test('main IPC: analysis kernel diagnostics tolerate a missing project cwd', async () => {
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
  const missingProjectDiagnostics = (await app.invoke(
    'analysis:listKernels',
    '/missing/project'
  )) as {
    jupyterServer: { available: boolean; version: string }
    hasPythonKernel: boolean
    hasRKernel: boolean
  }
  assert.equal(missingProjectDiagnostics.jupyterServer.available, true)
  assert.equal(missingProjectDiagnostics.jupyterServer.version, '2.14.0')
  assert.equal(missingProjectDiagnostics.hasPythonKernel, true)
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

test('main IPC: read-only Jupyter status returns an empty state for a missing project cwd', async () => {
  const app = await harness()

  const status = (await app.invoke('analysis:jupyterStatus', '/missing/project')) as {
    projectCwd: string
    state: string
    hasEndpoint: boolean
    message?: string
  }
  const runtime = (await app.invoke('analysis:jupyterRuntimeStatus', '/missing/project')) as {
    server: { projectCwd: string; state: string; hasEndpoint: boolean; message?: string }
    notebooks: { activeSessionCount: number; busySessionCount: number; sessions: unknown[] }
  }

  assert.deepEqual(status, {
    projectCwd: '/missing/project',
    state: 'stopped',
    hasEndpoint: false,
    message: '请选择一个已添加的项目或当前 workspace'
  })
  assert.deepEqual(runtime, {
    server: {
      projectCwd: '/missing/project',
      state: 'stopped',
      hasEndpoint: false,
      message: '请选择一个已添加的项目或当前 workspace'
    },
    notebooks: {
      activeSessionCount: 0,
      busySessionCount: 0,
      sessions: []
    }
  })
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
  const missing = (await app.invoke('analysis:jupyterRuntimeStatus', '/missing/project')) as {
    server: { state: string; message: string }
    notebooks: { activeSessionCount: number; sessions: unknown[] }
  }
  assert.equal(missing.server.state, 'stopped')
  assert.match(missing.server.message, /请选择/)
  assert.equal(missing.notebooks.activeSessionCount, 0)
  assert.deepEqual(missing.notebooks.sessions, [])
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

test('main IPC: notebook AI generation enriches R @ data frames from the live kernel', async () => {
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
                  cells: [{ language: 'r', code: 'summary(df)' }]
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
    metadata: { kernelspec: { display_name: 'R', language: 'R', name: 'ir' } },
    cells: [
      {
        id: 'load',
        cell_type: 'code',
        metadata: {},
        execution_count: 1,
        outputs: [],
        source: 'df <- readr::read_csv("use_data.csv")'
      }
    ]
  })

  const result = (await app.invoke(
    'analysis:generateNotebookCode',
    '/projects/research',
    'notebooks/qc-r.ipynb',
    document,
    {
      prompt: '@df 总结数据',
      language: 'r',
      afterCellId: 'load',
      references: [
        {
          id: 'dataframe:df',
          kind: 'dataframe',
          name: 'df',
          detail: 'df <- readr::read_csv("use_data.csv")',
          cellId: 'load',
          preview: { source: 'df <- readr::read_csv("use_data.csv")' }
        }
      ]
    }
  )) as { cells: Array<{ cellType: string; source: string }> }

  assert.deepEqual(result.cells, [{ cellType: 'code', source: 'summary(df)', language: 'r' }])
  assert.ok(
    app.notebookExecutionCalls.some(
      (call) =>
        call.cellId === '__introspection__' &&
        call.source === 'df' &&
        call.kernelId === 'kernel-1' &&
        call.language === 'r'
    )
  )
  const prompt = app.sessions[0].promptTexts[0]
  assert.match(prompt, /@dataframe:\/\/df/)
  assert.match(prompt, /data\.frame/)
  assert.match(prompt, /2 rows x 3 columns/)
  assert.match(prompt, /Year \(character\), Income \(numeric\)/)
  assert.match(prompt, /19th 1208\.7/)
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

test('main IPC persists and broadcasts a bounded change summary after the run', async () => {
  const app = await harness()
  const summary: WorkspaceChangeSummary = {
    files: [
      {
        path: '/workspace/result.txt',
        displayPath: 'result.txt',
        status: 'modified',
        added: 2,
        deleted: 1
      }
    ],
    totalChanged: 1,
    truncated: false
  }
  app.setWorkspaceChangeSummary(summary)
  await app.invoke('agent:prompt', 'update the result')

  const saved = app.appendedSessionEvents.find(
    (entry) => (entry.event as { type?: string }).type === 'workspace_changes'
  )?.event as Record<string, unknown> | undefined
  assert.equal(saved?.runId, 'run-2')
  assert.deepEqual(saved?.files, summary.files)
  assert.equal(
    app.events.some(
      (entry) =>
        entry.channel === 'agent:event' &&
        (entry.data as { type?: string }).type === 'workspace_changes'
    ),
    true
  )
})

test('main IPC stores a run diff separately and can read it after the run', async () => {
  const app = await harness()
  const patch = '@@ -1 +1 @@\n-before\n+after\n'
  app.setWorkspaceChangeSummary({
    files: [
      {
        path: '/workspace/result.txt',
        displayPath: 'result.txt',
        status: 'modified',
        added: 1,
        deleted: 1
      }
    ],
    totalChanged: 1,
    truncated: false
  })
  app.setWorkspaceDiffPatch(patch)
  await app.invoke('agent:prompt', 'edit result')

  const event = app.appendedSessionEvents.find(
    (entry) => (entry.event as { type?: string }).type === 'workspace_changes'
  )?.event as { files: Array<{ diff?: { sessionId: string; id: string; bytes: number } }> }
  const ref = event.files[0].diff
  assert.ok(ref)
  assert.equal(ref.sessionId, 'phi-1')
  assert.equal(app.savedWorkspaceDiff(), patch)
  assert.equal(await app.invoke('workspaceChanges:readDiff', ref), patch)
  assert.doesNotMatch(JSON.stringify(event), /@@ -1|-before|\+after/)
})

test('main IPC: pasted image is saved as a reference and reaches the vision model', async () => {
  const app = await harness()
  const image = { mimeType: 'image/png', data: 'iVBORw0KGgo=' }
  await app.invoke('models:select', 'openai', 'gpt-vision-test')
  await app.invoke('agent:prompt', '', { images: [image] })

  assert.deepEqual(app.sessions[0].promptOptions[0].images, [{ type: 'image', ...image }])
  const userEvent = app.appendedSessionEvents.find(
    (entry) => (entry.event as { type?: string }).type === 'user_message'
  )?.event as {
    content: string
    images: Array<{ sessionId: string; id: string; mimeType: string }>
  }
  assert.equal(userEvent.content, '')
  assert.deepEqual(userEvent.images, [
    { sessionId: 'phi-1', id: 'a'.repeat(64), mimeType: 'image/png' }
  ])
  assert.deepEqual(await app.invoke('agent:readPromptImage', userEvent.images[0]), image)
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

    assert.deepEqual(
      app.appendedSessionEvents.map((entry) => ({
        ...entry,
        event: withoutTimestamp(entry.event as Record<string, unknown>)
      })),
      [
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
      ]
    )
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

test('main IPC: provider-managed tool results are persisted and sent to the chat', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'provider-call-1',
              name: 'web_fetch',
              arguments: { url: 'https://example.com' }
            },
            { type: 'text', text: 'Here is the result.' }
          ]
        }
      },
      {
        type: 'message_end',
        message: {
          role: 'toolResult',
          toolCallId: 'provider-call-1',
          content: [{ type: 'text', text: 'Fetched page' }],
          isError: false
        }
      }
    ]
    return session
  })

  await app.invoke('agent:prompt', 'fetch a page')

  const toolEvents = app.appendedSessionEvents
    .map((entry) => entry.event as Record<string, unknown>)
    .filter((event) => event.toolCallId === 'provider-call-1')
  assert.deepEqual(
    toolEvents.map((event) => event.type),
    ['tool_call_started', 'tool_call_completed']
  )
  assert.equal(toolEvents[0].toolName, 'web_fetch')
  assert.match(String(toolEvents[1].output), /Fetched/)
  assert.ok(
    app.events.some(
      (event) =>
        (event.data as { type?: string; toolCallId?: string }).type ===
          'provider_tool_call_completed' &&
        (event.data as { toolCallId?: string }).toolCallId === 'provider-call-1'
    )
  )
})

test('main IPC: hosted fetch is stored between the thinking and text blocks around it', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'before' },
            { type: 'text', text: 'I will search.' },
            {
              type: 'toolCall',
              id: 'hosted-1',
              name: 'web_fetch',
              arguments: { url: 'https://pubmed.ncbi.nlm.nih.gov/?term=MID1IP1' }
            },
            { type: 'thinking', thinking: 'after' },
            { type: 'text', text: 'Here are the papers.' }
          ]
        }
      },
      {
        type: 'message_end',
        message: {
          role: 'toolResult',
          toolCallId: 'hosted-1',
          content: [{ type: 'text', text: 'PubMed results' }]
        }
      }
    ]
    return session
  })

  await app.invoke('agent:prompt', 'find MID1IP1 papers')
  const events = app.appendedSessionEvents.map((entry) => entry.event as Record<string, unknown>)
  assert.deepEqual(
    events.map((event) => event.type),
    [
      'user_message',
      'assistant_thinking_completed',
      'assistant_message_finalized',
      'tool_call_started',
      'assistant_thinking_completed',
      'assistant_message_finalized',
      'tool_call_completed'
    ]
  )
  assert.equal(events[2].content, 'I will search.')
  assert.equal(events[5].content, 'Here are the papers.')
})

test('main IPC: SDK tool execution is not duplicated by its message history', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'sdk-call-1', name: 'bash', arguments: { command: 'pwd' } }
          ]
        }
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'sdk-call-1',
        toolName: 'bash',
        args: { command: 'pwd' }
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'sdk-call-1',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: '/workspace' }] },
        isError: false
      },
      {
        type: 'message_end',
        message: {
          role: 'toolResult',
          toolCallId: 'sdk-call-1',
          content: [{ type: 'text', text: '/workspace' }]
        }
      }
    ]
    return session
  })

  await app.invoke('agent:prompt', 'show the directory')
  const events = app.appendedSessionEvents
    .map((entry) => entry.event as Record<string, unknown>)
    .filter((event) => event.toolCallId === 'sdk-call-1')
  assert.deepEqual(
    events.map((event) => event.type),
    ['tool_call_started', 'tool_call_completed']
  )
  assert.equal(
    app.events.some(
      (event) => (event.data as { type?: string }).type === 'provider_tool_call_completed'
    ),
    false
  )
})

test('main IPC: an SDK completion without a start still suppresses a hosted duplicate', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'todo-1', name: 'todo', arguments: { todos: [] } }]
        }
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'todo-1',
        toolName: 'todo',
        result: { content: [{ type: 'text', text: 'updated' }] },
        isError: false
      },
      {
        type: 'message_end',
        message: {
          role: 'toolResult',
          toolCallId: 'todo-1',
          content: [{ type: 'text', text: 'updated' }]
        }
      }
    ]
    return session
  })
  await app.invoke('agent:prompt', 'update todo')
  const completed = app.appendedSessionEvents
    .map((entry) => entry.event as Record<string, unknown>)
    .filter((event) => event.type === 'tool_call_completed' && event.toolCallId === 'todo-1')
  assert.equal(completed.length, 1)
})

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

/**
 * The SDK's events carry no time, so the main process stamps the ones it forwards and stores.
 * Tests that compare a whole event check the stamp is a real time and compare the rest.
 */
function withoutTimestamp<T extends Record<string, unknown>>(event: T): Omit<T, 'createdAt'> {
  const { createdAt, ...rest } = event
  if (createdAt !== undefined) {
    assert.ok(Number.isFinite(Date.parse(String(createdAt))), 'the timestamp is a real time')
  }
  return rest
}

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
        tokensAfter: 4200,
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
  assert.deepEqual(withoutTimestamp(event ?? {}), {
    type: 'context_compacted',
    runId: 'run-2',
    action: 'remote',
    reason: 'threshold',
    shortSummary: 'Short compaction summary.',
    summary: 'Full compaction summary.',
    tokensBefore: 12345,
    tokensAfter: 4200
  })
  assert.ok(
    app.events.some(
      (entry) =>
        entry.channel === 'agent:event' &&
        (entry.data as { type?: string; eventId?: string }).type === 'context_compacted' &&
        typeof (entry.data as { eventId?: string }).eventId === 'string'
    )
  )
})

test('main IPC: automatic shake and image rescue have accurate timeline notices', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      { type: 'auto_compaction_start', action: 'shake', reason: 'threshold' },
      {
        type: 'auto_compaction_end',
        action: 'shake',
        aborted: false,
        skipped: false,
        willRetry: false,
        tokensAfter: 12000
      },
      {
        type: 'notice',
        source: 'compaction',
        level: 'info',
        message:
          'Compaction dead-end recovery: dropped 2 attached images so maintenance could make progress.'
      }
    ]
    return session
  })

  await app.invoke('agent:prompt', 'hello')

  const shaken = app.appendedSessionEvents.find((entry) => entry.event.type === 'context_shaken')
  assert.deepEqual(withoutTimestamp(shaken?.event ?? {}), {
    type: 'context_shaken',
    runId: 'run-2',
    action: 'shake',
    reason: 'threshold',
    tokensAfter: 12000
  })
  const rescue = app.appendedSessionEvents.find(
    (entry) => entry.event.type === 'context_maintenance_notice'
  )
  assert.match(String(rescue?.event.noticeText), /dropped 2 attached images/)
  assert.equal(
    app.appendedSessionEvents.some((entry) => entry.event.type === 'context_compacted'),
    false
  )
})

test('main IPC: maintenance notices remain visible when the SDK emits them after a run', async () => {
  const app = await harness()
  await app.invoke('agent:prompt', 'hello')

  for (const listener of app.sessions[0].listeners) {
    listener({
      type: 'auto_compaction_end',
      action: 'shake',
      aborted: false,
      skipped: false,
      willRetry: false,
      tokensAfter: 9000
    })
    listener({
      type: 'notice',
      source: 'compaction',
      level: 'info',
      message: 'dropped 1 attached image'
    })
  }

  const shaken = app.appendedSessionEvents.find((entry) => entry.event.type === 'context_shaken')
  const rescued = app.appendedSessionEvents.find(
    (entry) => entry.event.type === 'context_maintenance_notice'
  )
  assert.equal(shaken?.event.tokensAfter, 9000)
  assert.equal(shaken?.event.runId, undefined)
  assert.match(String(rescued?.event.noticeText), /dropped 1 attached image/)
})

test('main IPC: failed automatic compaction is not reported as success', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      { type: 'auto_compaction_start', action: 'handoff', reason: 'threshold' },
      {
        type: 'auto_compaction_end',
        action: 'handoff',
        aborted: false,
        skipped: false,
        willRetry: false,
        errorMessage: 'provider rejected summary'
      }
    ]
    return session
  })

  await app.invoke('agent:prompt', 'hello')

  assert.equal(
    app.appendedSessionEvents.some((entry) => entry.event.type === 'context_compacted'),
    false
  )
  const failure = app.appendedSessionEvents.find(
    (entry) => entry.event.type === 'context_compaction_failed'
  )
  assert.equal(failure?.event.errorMessage, 'provider rejected summary')
})

test('main IPC: aborted automatic compaction records its failure reason', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      { type: 'auto_compaction_start', reason: 'threshold', action: 'handoff' },
      {
        type: 'auto_compaction_end',
        action: 'handoff',
        aborted: true,
        willRetry: false
      }
    ]
    return session
  })

  await app.invoke('agent:prompt', 'hello')

  const event = app.appendedSessionEvents.find(
    (entry) => entry.event.type === 'context_compaction_failed'
  )?.event
  assert.deepEqual(withoutTimestamp(event ?? {}), {
    type: 'context_compaction_failed',
    runId: 'run-2',
    action: 'handoff',
    reason: 'threshold',
    errorMessage: '已取消'
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

test('main IPC: unsupported provider region stops automatic retry and fails the run', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.hold = true
    session.skipFinalAssistantMessage = true
    session.toolEvents = [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'This model provider is not supported in your region.'
        }
      },
      {
        type: 'auto_retry_start',
        attempt: 1,
        maxAttempts: 5,
        delayMs: 30_000,
        errorMessage: 'This model provider is not supported in your region.'
      }
    ]
    const abort = session.abort.bind(session)
    session.abort = async () => {
      for (const listener of session.listeners) {
        listener({
          type: 'message_end',
          message: { role: 'assistant', stopReason: 'error', errorMessage: 'Request was aborted' }
        })
      }
      await abort()
    }
    return session
  })

  const prompt = app.invoke('agent:prompt', '测试连接')
  const settled = await Promise.race([
    prompt.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 250))
  ])
  if (!settled) app.sessions[0].finish.resolve()
  await prompt

  assert.equal(settled, true, 'a permanent region denial should not wait through retry backoff')
  assert.ok(app.sessions[0].log.includes('abort'))
  assert.equal(app.appendedSessionEvents.at(-1)?.event.type, 'run_failed')
  assert.match(
    String(app.appendedSessionEvents.at(-1)?.event.errorMessage),
    /not supported in your region/
  )
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

test('main IPC exports only after the user chooses a destination folder', async () => {
  const app = await harness()
  await app.invoke('agent:prompt', 'private prompt')

  await assert.rejects(app.invoke('sessions:export', 'missing'), /会话不存在/)

  assert.equal(await app.invoke('sessions:export', 'phi-1'), null)
  assert.deepEqual(app.exportedSessions, [])

  app.setOpenDialogResult({ canceled: false, filePaths: ['/chosen/export-parent'] })
  const result = (await app.invoke('sessions:export', 'phi-1')) as { path: string }
  assert.equal(result.path, '/chosen/export-parent/phi-session-phi-1')
  assert.deepEqual(app.exportedSessions, [
    { sessionId: 'phi-1', destination: '/chosen/export-parent' }
  ])
  assert.equal(
    app.appLogs.some((entry) => JSON.stringify(entry).includes('private prompt')),
    false
  )
})

test('main IPC rejects export while its conversation is running', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  const run = app.invoke('agent:prompt', 'still running')
  await tick()
  await assert.rejects(app.invoke('sessions:export', 'phi-1'), /运行结束/)
  assert.deepEqual(app.exportedSessions, [])
  await app.invoke('agent:stop')
  await run
})

test('main host records final file delivery only for an active conversation', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  const prompt = app.invoke('agent:prompt', 'create report')
  await tick()
  const present = app.hostHandlers.get('deliverables.present')
  assert.ok(present)
  const files = [{ path: '/workspace/report.pdf', displayPath: 'report.pdf', bytes: 123 }]
  const result = await present({
    runtimeSessionId: session.runtimeSessionId,
    toolCallId: 'present-1',
    files
  })
  assert.deepEqual(result, { files })
  const saved = app.appendedSessionEvents.find(
    (entry) => (entry.event as { type?: string }).type === 'files_presented'
  )
  assert.ok(saved)
  assert.equal(saved.event.type, 'files_presented')
  assert.match(String(saved.event.runId), /^run-/)
  assert.equal(saved.event.toolCallId, 'present-1')
  assert.deepEqual(saved.event.files, files)
  assert.equal(
    app.events.some(
      (entry) =>
        entry.channel === 'agent:event' &&
        (entry.data as { type?: string }).type === 'files_presented'
    ),
    true
  )
  await assert.rejects(
    async () => present({ runtimeSessionId: 'unknown', toolCallId: 'present-2', files }),
    /No active conversation/
  )
  await app.invoke('agent:stop')
  await prompt
})

test('main host splits presented file batches into events of at most 4', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  const prompt = app.invoke('agent:prompt', 'create report')
  await tick()
  const present = app.hostHandlers.get('deliverables.present')
  assert.ok(present)
  const files = Array.from({ length: 5 }, (_, index) => ({
    path: `/workspace/report-${index}.txt`,
    displayPath: `report-${index}.txt`,
    bytes: index + 1
  }))
  const result = await present({
    runtimeSessionId: session.runtimeSessionId,
    toolCallId: 'present-batch',
    files
  })
  assert.deepEqual(result, { files })
  const batches = app.appendedSessionEvents
    .filter((entry) => (entry.event as { toolCallId?: string }).toolCallId === 'present-batch')
    .map((entry) => (entry.event as { files: Array<{ displayPath: string }> }).files)
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [4, 1]
  )
  assert.equal(batches[0]?.[0]?.displayPath, 'report-0.txt')
  assert.equal(batches[0]?.[3]?.displayPath, 'report-3.txt')
  assert.equal(batches[1]?.[0]?.displayPath, 'report-4.txt')
  assert.equal(
    app.events.filter(
      (entry) =>
        entry.channel === 'agent:event' &&
        (entry.data as { type?: string; toolCallId?: string }).type === 'files_presented' &&
        (entry.data as { toolCallId?: string }).toolCallId === 'present-batch'
    ).length,
    2
  )
  await app.invoke('agent:stop')
  await prompt
})

test('main plan review pauses the run and records approval in its conversation', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  const current = (await app.invoke('sessions:current')) as Record<string, unknown>
  const prompt = app.invoke('agent:prompt', 'Analyze then write a report', {
    ...current,
    planMode: true
  })
  await tick()
  assert.equal(
    app.bridgeRequests.some((request) => request.method === 'session.plan.enter'),
    true
  )

  app.setAgentInteractionResponse({
    answers: [{ questionIndex: 0, question: 'plan_review', kind: 'option', answer: 'approve' }]
  })
  const review = app.hostHandlers.get('planReview.request')
  assert.ok(review)
  const result = await review({
    runtimeSessionId: session.runtimeSessionId,
    title: 'analysis-plan',
    planContent: '# Analysis plan\n\n1. Inspect data\n2. Write report',
    planFilePath: 'local://analysis-plan.md'
  })
  assert.deepEqual(result, { decision: 'approve' })
  const planEvents = app.appendedSessionEvents
    .filter((entry) => String(entry.event.type).startsWith('plan_review_'))
    .map((entry) => entry.event)
  assert.deepEqual(
    planEvents.map((event) => event.type),
    ['plan_review_submitted', 'plan_review_decided']
  )
  assert.equal(planEvents[1].decision, 'approve')
  assert.equal(planEvents[0].reviewId, planEvents[1].reviewId)
  assert.equal(
    app.runnerEvents.some((event) => event.type === 'input_requested'),
    true
  )
  assert.equal(
    app.events.some(
      (event) =>
        event.channel === 'agent:event' &&
        (event.data as { type?: string }).type === 'plan_review_decided'
    ),
    true
  )
  await assert.rejects(
    async () =>
      review({
        runtimeSessionId: 'unknown',
        title: 'plan',
        planContent: '# Plan',
        planFilePath: 'local://plan.md'
      }),
    /No active conversation/
  )
  await assert.rejects(
    async () =>
      review({
        runtimeSessionId: session.runtimeSessionId,
        title: 'too-large',
        planContent: 'x'.repeat(65 * 1024),
        planFilePath: 'local://too-large.md'
      }),
    /Invalid plan review request/
  )
  await app.invoke('agent:stop')
  await prompt
})

test('main plan review refuses remote project sessions before starting a run', async () => {
  const app = await harness()
  const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as Record<
    string,
    unknown
  >
  await assert.rejects(
    app.invoke('agent:prompt', 'Analyze this server project', { ...current, planMode: true }),
    /远程项目暂不支持计划评审/
  )
  assert.equal(
    app.bridgeRequests.some((request) => request.method === 'session.plan.enter'),
    false
  )
  assert.equal(
    app.appendedSessionEvents.some((entry) => entry.event.type === 'user_message'),
    false
  )
})

test('main plan review preserves requested revisions in the session timeline', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  const prompt = app.invoke('agent:prompt', 'Draft a plan')
  await tick()
  app.setAgentInteractionResponse({
    answers: [{ questionIndex: 0, question: 'plan_review', kind: 'option', answer: 'revise' }],
    globalNote: 'Add a validation step'
  })
  const review = app.hostHandlers.get('planReview.request')
  assert.ok(review)
  assert.deepEqual(
    await review({
      runtimeSessionId: session.runtimeSessionId,
      title: 'analysis-plan',
      planContent: '# Analysis plan',
      planFilePath: 'local://analysis-plan.md'
    }),
    { decision: 'revise', note: 'Add a validation step' }
  )
  const decided = app.appendedSessionEvents.find(
    (entry) => entry.event.type === 'plan_review_decided'
  )
  assert.equal(decided?.event.decision, 'revise')
  assert.equal(decided?.event.note, 'Add a validation step')
  await app.invoke('agent:stop')
  await prompt
})

test('main jobs list maps live Agent runs to their owning Phi conversations', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  const prompt = app.invoke('agent:prompt', 'Analyze samples')
  await tick()
  app.setBridgeAgentJobs([
    {
      agentSessionId: session.runtimeSessionId,
      agentRunId: 'agent-run-1',
      agentName: 'Database',
      task: 'Search metadata',
      state: 'running',
      background: true,
      startedAt: Date.now(),
      lastStep: 'db_query',
      report: 'private full report must not reach the job list'
    },
    {
      agentSessionId: 'unknown',
      agentRunId: 'agent-run-2',
      agentName: 'Unknown',
      task: 'Not owned by Phi',
      state: 'running',
      startedAt: Date.now()
    }
  ])
  const jobs = (await app.invoke('jobs:listAgents')) as Array<Record<string, unknown>>
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].agentRunId, 'agent-run-1')
  assert.equal(jobs[0].sessionPath, 'phi-session:phi-1')
  assert.equal(jobs[0].sessionTitle, 'Analyze samples')
  assert.equal(jobs[0].lastStep, 'db_query')
  assert.equal('report' in jobs[0], false)
  await app.invoke('agent:stop')
  await prompt
})

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

test('main IPC: a background wrapper run that ends is reported in the conversation that started it', async () => {
  const app = await harness()
  await app.invoke('projects:newSession', '/projects/wrapper-notice', 'ask')
  await app.invoke('agent:prompt', 'run fastqc')
  const runtimeSessionId = (app.sessions[0] as unknown as { runtimeSessionId: string })
    .runtimeSessionId
  assert.equal(app.wrapperJobFinishListeners.length, 1)

  const before = app.events.length
  app.wrapperJobFinishListeners[0](
    {
      runId: 'wrun_1',
      state: 'completed',
      exitCode: 0,
      outDir: '/data/qc',
      originSessionId: runtimeSessionId,
      wrapper: { canonicalId: 'nf-core/modules/fastqc' }
    },
    { elapsedSeconds: 42, missingOutputs: [] }
  )

  const persisted = app.appendedSessionEvents.filter(
    (entry) => (entry.event as { type?: string }).type === 'wrapper_run_finished'
  )
  assert.equal(persisted.length, 1)
  const event = persisted[0].event as { wrapperRunId: string; state: string; outDir: string }
  assert.equal(event.wrapperRunId, 'wrun_1')
  assert.equal(event.state, 'completed')
  assert.equal(event.outDir, '/data/qc')

  const pushed = app.events
    .slice(before)
    .filter((entry) => (entry.data as { type?: string }).type === 'wrapper_run_finished')
  assert.equal(pushed.length, 1)
  assert.equal(pushed[0].channel, 'agent:event')
  const payload = pushed[0].data as { phiSessionId?: string; sessionPath?: string; cwd?: string }
  assert.equal(payload.phiSessionId, persisted[0].sessionId)
  assert.match(payload.sessionPath ?? '', new RegExp(String(persisted[0].sessionId)))
  assert.equal(payload.cwd, '/projects/wrapper-notice')

  // The (fake) window is focused, so no system notification on top of the in-chat one.
  assert.deepEqual(app.osNotifications, [])
})

test('main IPC: a run that ends while Phi is in the background raises a system notification', async () => {
  const app = await harness()
  await app.invoke('projects:newSession', '/projects/wrapper-notice', 'ask')
  await app.invoke('agent:prompt', 'hi')
  const runtimeSessionId = (app.sessions[0] as unknown as { runtimeSessionId: string })
    .runtimeSessionId

  app.setAppFocused(false)
  app.wrapperJobFinishListeners[0](
    {
      runId: 'wrun_2',
      state: 'failed',
      exitCode: 1,
      outDir: '/x',
      originSessionId: runtimeSessionId,
      wrapper: { canonicalId: 'a/b/c' }
    },
    { elapsedSeconds: 5 }
  )

  assert.equal(app.osNotifications.length, 1)
  assert.equal(app.osNotifications[0].title, 'Wrapper 运行失败')
  assert.match(app.osNotifications[0].body, /a\/b\/c/)
  assert.match(app.osNotifications[0].body, /wrun_2/)
})

test('main IPC: a run from a session Phi does not know is announced by system notification only', async () => {
  const app = await harness()
  await app.invoke('projects:newSession', '/projects/wrapper-notice', 'ask')
  await app.invoke('agent:prompt', 'hi')

  app.setAppFocused(false)
  app.wrapperJobFinishListeners[0](
    {
      runId: 'wrun_3',
      state: 'completed',
      exitCode: 0,
      outDir: '/x',
      originSessionId: 'runtime-unknown',
      wrapper: { canonicalId: 'a/b/c' }
    },
    { elapsedSeconds: 5 }
  )

  assert.equal(
    app.appendedSessionEvents.some(
      (entry) => (entry.event as { type?: string }).type === 'wrapper_run_finished'
    ),
    false
  )
  assert.equal(app.osNotifications.length, 1)
  assert.equal(app.osNotifications[0].title, 'Wrapper 运行已完成')
})

// ── automatic continuation after a background wrapper run ─────────────────

const FINISHED_RUN = (
  originSessionId: string,
  overrides: Record<string, unknown> = {}
): unknown => ({
  runId: 'wrun_1',
  state: 'completed',
  exitCode: 0,
  outDir: '/data/qc',
  originSessionId,
  wrapper: { canonicalId: 'nf-core/modules/fastqc' },
  ...overrides
})

async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function idleConversation(): Promise<{
  app: Awaited<ReturnType<typeof harness>>
  session: FakeSession
}> {
  const app = await harness()
  await app.invoke('projects:newSession', '/projects/wrapper-continue', 'ask')
  await app.invoke('agent:prompt', 'run fastqc on my reads')
  await tick()
  return { app, session: app.sessions[0] as unknown as FakeSession }
}

const WOKEN = /<phi_wrapper_run_finished>/

test('main IPC: a run that ends wakes an idle conversation with a message from Phi', async () => {
  const { app, session } = await idleConversation()
  const userMessagesBefore = app.appendedSessionEvents.filter(
    (e) => (e.event as { type?: string }).type === 'user_message'
  ).length

  app.wrapperJobFinishListeners[0](FINISHED_RUN(session.runtimeSessionId), { elapsedSeconds: 42 })
  await waitUntil(() => session.promptTexts.length === 2)

  assert.match(session.promptTexts[1], WOKEN)
  assert.match(session.promptTexts[1], /wrun_1/)
  assert.match(session.promptTexts[1], /\/data\/qc/)
  // Not the user's words: no user bubble is recorded for it…
  assert.equal(
    app.appendedSessionEvents.filter((e) => (e.event as { type?: string }).type === 'user_message')
      .length,
    userMessagesBefore
  )
  // …but the run is tracked like any other, and nothing else was opened or switched.
  await waitUntil(() => session.log.filter((entry) => entry === 'saved').length === 2)
  assert.equal(app.sessions.length, 1)
})

test('main IPC: a run that ends while the conversation is busy wakes it once the busy run is over', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  await app.invoke('projects:newSession', '/projects/wrapper-continue', 'ask')
  const first = app.invoke('agent:prompt', 'work on something')
  await tick()

  app.wrapperJobFinishListeners[0](FINISHED_RUN(session.runtimeSessionId), { elapsedSeconds: 7 })
  await tick()
  assert.equal(session.promptTexts.length, 1, 'must not interrupt the run in progress')

  session.finish.resolve()
  await first
  await waitUntil(() => session.promptTexts.length === 2)
  assert.match(session.promptTexts[1], WOKEN)
})

test('main IPC: runs that end while busy are reported together in one wake-up', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  await app.invoke('projects:newSession', '/projects/wrapper-continue', 'ask')
  const first = app.invoke('agent:prompt', 'work')
  await tick()

  app.wrapperJobFinishListeners[0](FINISHED_RUN(session.runtimeSessionId), { elapsedSeconds: 1 })
  app.wrapperJobFinishListeners[0](
    FINISHED_RUN(session.runtimeSessionId, {
      runId: 'wrun_2',
      wrapper: { canonicalId: 'nf-core/modules/fastp' }
    }),
    { elapsedSeconds: 2 }
  )
  session.finish.resolve()
  await first
  await waitUntil(() => session.promptTexts.length === 2)
  await tick()

  assert.equal(session.promptTexts.length, 2)
  assert.match(session.promptTexts[1], /wrun_1/)
  assert.match(session.promptTexts[1], /wrun_2/)
})

test('main IPC: stopping a run means its pending wake-up is dropped', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  await app.invoke('projects:newSession', '/projects/wrapper-continue', 'ask')
  const first = app.invoke('agent:prompt', 'work')
  await tick()

  app.wrapperJobFinishListeners[0](FINISHED_RUN(session.runtimeSessionId), { elapsedSeconds: 1 })
  await app.invoke('agent:stop')
  await first
  await tick()
  await tick()

  assert.equal(session.promptTexts.length, 1)
})

test('main IPC: a cancelled run, an opted-out run and an unknown conversation do not wake anything', async () => {
  const { app, session } = await idleConversation()
  const fire = (run: unknown): void => app.wrapperJobFinishListeners[0](run, { elapsedSeconds: 1 })

  fire(FINISHED_RUN(session.runtimeSessionId, { state: 'cancelled', exitCode: -1 }))
  fire(FINISHED_RUN(session.runtimeSessionId, { continueWhenDone: false }))
  fire(FINISHED_RUN('runtime-unknown'))
  await tick()
  await tick()

  assert.equal(session.promptTexts.length, 1)
})

test('main IPC: automatic wake-ups are capped, and a real user message starts the count over', async () => {
  const { app, session } = await idleConversation()
  const wake = async (n: number): Promise<void> => {
    app.wrapperJobFinishListeners[0](
      FINISHED_RUN(session.runtimeSessionId, { runId: `wrun_${n}` }),
      { elapsedSeconds: 1 }
    )
    await tick()
    await tick()
  }

  for (let n = 1; n <= MAX_AUTOMATIC_CONTINUATIONS; n += 1) {
    await wake(n)
    await waitUntil(() => session.promptTexts.length === 1 + n)
  }
  await wake(99)
  assert.equal(session.promptTexts.length, 1 + MAX_AUTOMATIC_CONTINUATIONS, 'the cap holds')

  await app.invoke('agent:prompt', 'ok, carry on')
  await tick()
  await wake(100)
  await waitUntil(() => session.promptTexts.length === 2 + MAX_AUTOMATIC_CONTINUATIONS + 1)
  assert.match(session.promptTexts.at(-1) ?? '', /wrun_100/)
})

test('main IPC: a run whose outcome Wrapper already reported inside the same turn does not wake the conversation again', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  await app.invoke('projects:newSession', '/projects/wrapper-continue', 'ask')
  const first = app.invoke('agent:prompt', 'run it and wait for the result')
  await tick()

  // The run ends while the turn is still going, and Wrapper's wait hands the outcome to the agent.
  app.wrapperJobFinishListeners[0](FINISHED_RUN(session.runtimeSessionId), { elapsedSeconds: 3 })
  app.reportedWrapperRuns.add('wrun_1')
  session.finish.resolve()
  await first
  await tick()
  await tick()

  assert.equal(session.promptTexts.length, 1)
})

test('main IPC: only the runs nobody has reported are included in a wake-up', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  await app.invoke('projects:newSession', '/projects/wrapper-continue', 'ask')
  const first = app.invoke('agent:prompt', 'work')
  await tick()

  app.wrapperJobFinishListeners[0](FINISHED_RUN(session.runtimeSessionId), { elapsedSeconds: 1 })
  app.wrapperJobFinishListeners[0](FINISHED_RUN(session.runtimeSessionId, { runId: 'wrun_2' }), {
    elapsedSeconds: 1
  })
  app.reportedWrapperRuns.add('wrun_1')
  session.finish.resolve()
  await first
  await waitUntil(() => session.promptTexts.length === 2)

  assert.doesNotMatch(session.promptTexts[1], /wrun_1/)
  assert.match(session.promptTexts[1], /wrun_2/)
})

// ── automatic continuation after a background agent run ───────────────────

const AGENT_WOKEN = /<phi_agent_run_finished>/

const agentRunFinished = (
  app: Awaited<ReturnType<typeof harness>>,
  runtimeSessionId: string,
  overrides: Record<string, unknown> = {}
): Promise<unknown> => {
  const handler = app.hostHandlers.get('agentRun.finished')
  assert.ok(handler, 'the main process registers agentRun.finished')
  return handler({
    originSessionId: runtimeSessionId,
    run: {
      id: 'run_1',
      agent: 'Wrapper',
      task: 'align the reads',
      state: 'done',
      background: true,
      startedAt: 1_000,
      completedAt: 61_000,
      toolCalls: 4,
      report: 'Aligned. BAMs are in /data/bam.',
      ...overrides
    }
  })
}

test('main IPC: a background agent run that ends is noted in the conversation and wakes it with its report', async () => {
  const { app, session } = await idleConversation()
  const before = app.events.length

  await agentRunFinished(app, session.runtimeSessionId)
  await waitUntil(() => session.promptTexts.length === 2)

  const persisted = app.appendedSessionEvents.filter(
    (entry) => (entry.event as { type?: string }).type === 'agent_run_finished'
  )
  assert.equal(persisted.length, 1)
  assert.equal((persisted[0].event as { agentRunId: string }).agentRunId, 'run_1')
  assert.equal(
    app.events
      .slice(before)
      .filter((entry) => (entry.data as { type?: string }).type === 'agent_run_finished').length,
    1
  )

  assert.match(session.promptTexts[1], AGENT_WOKEN)
  assert.match(session.promptTexts[1], /run_1 · Wrapper · done/)
  assert.match(session.promptTexts[1], /BAMs are in \/data\/bam\./)
  assert.equal(app.sessions.length, 1)
})

test('main IPC: an agent run that ends while the conversation is busy waits for the busy run to finish', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  await app.invoke('projects:newSession', '/projects/agent-continue', 'ask')
  const first = app.invoke('agent:prompt', 'work on something')
  await tick()

  await agentRunFinished(app, session.runtimeSessionId)
  await tick()
  assert.equal(session.promptTexts.length, 1, 'must not interrupt the run in progress')

  session.finish.resolve()
  await first
  await waitUntil(() => session.promptTexts.length === 2)
  assert.match(session.promptTexts[1], AGENT_WOKEN)
})

test('main IPC: a run the agent already collected with agent_wait does not wake the conversation again', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  await app.invoke('projects:newSession', '/projects/agent-continue', 'ask')
  const first = app.invoke('agent:prompt', 'start it and wait for it')
  await tick()

  await agentRunFinished(app, session.runtimeSessionId)
  await app.hostHandlers.get('agentRun.reported')?.({
    originSessionId: session.runtimeSessionId,
    runId: 'run_1'
  })
  session.finish.resolve()
  await first
  await tick()
  await tick()

  assert.equal(session.promptTexts.length, 1)
})

test('main IPC: a stale receipt for a reused run id does not swallow a later run', async () => {
  const { app, session } = await idleConversation()
  await app.hostHandlers.get('agentRun.reported')?.({
    originSessionId: session.runtimeSessionId,
    runId: 'run_1'
  })
  await agentRunFinished(app, session.runtimeSessionId)
  await waitUntil(() => session.promptTexts.length === 2)
  assert.match(session.promptTexts[1], /run_1/)
})

test('main IPC: only the agent runs nobody collected are in a wake-up', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  await app.invoke('projects:newSession', '/projects/agent-continue', 'ask')
  const first = app.invoke('agent:prompt', 'work')
  await tick()

  await agentRunFinished(app, session.runtimeSessionId)
  await agentRunFinished(app, session.runtimeSessionId, { id: 'run_2', report: 'Second report.' })
  await app.hostHandlers.get('agentRun.reported')?.({
    originSessionId: session.runtimeSessionId,
    runId: 'run_1'
  })
  session.finish.resolve()
  await first
  await waitUntil(() => session.promptTexts.length === 2)

  assert.doesNotMatch(session.promptTexts[1], /run_1/)
  assert.match(session.promptTexts[1], /run_2/)
})

test('main IPC: stopping the busy run drops the pending agent wake-up', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  await app.invoke('projects:newSession', '/projects/agent-continue', 'ask')
  const first = app.invoke('agent:prompt', 'work')
  await tick()

  await agentRunFinished(app, session.runtimeSessionId)
  await app.invoke('agent:stop')
  await first
  await tick()
  await tick()

  assert.equal(session.promptTexts.length, 1)
})

test('main IPC: a cancelled agent run is noted but does not wake anything', async () => {
  const { app, session } = await idleConversation()
  await agentRunFinished(app, session.runtimeSessionId, { state: 'cancelled', report: undefined })
  await tick()
  await tick()

  assert.equal(
    app.appendedSessionEvents.filter(
      (entry) => (entry.event as { type?: string }).type === 'agent_run_finished'
    ).length,
    1
  )
  assert.equal(session.promptTexts.length, 1)
})

test('main IPC: agent and wrapper runs share one wake-up cap, and one wake-up can carry both', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  await app.invoke('projects:newSession', '/projects/agent-continue', 'ask')
  const first = app.invoke('agent:prompt', 'work')
  await tick()

  await agentRunFinished(app, session.runtimeSessionId)
  app.wrapperJobFinishListeners[0](FINISHED_RUN(session.runtimeSessionId), { elapsedSeconds: 1 })
  session.finish.resolve()
  await first
  await waitUntil(() => session.promptTexts.length === 2)

  assert.match(session.promptTexts[1], AGENT_WOKEN)
  assert.match(session.promptTexts[1], WOKEN)
})

test('main IPC: a run that ends while Phi is in the background raises a system notification too', async () => {
  const { app, session } = await idleConversation()
  app.setAppFocused(false)
  await agentRunFinished(app, session.runtimeSessionId)
  assert.equal(app.osNotifications.length, 1)
  assert.equal(app.osNotifications[0].title, 'Wrapper 后台任务已完成')
})

// ── the agent card: run ids, background start, background progress, steer/stop ───

function agentDelegationSession(extraEvents: unknown[]): {
  factory: (cwd: string, file: string) => Promise<FakeSession>
  session: () => FakeSession
} {
  let created: FakeSession | undefined
  return {
    session: () => created as FakeSession,
    factory: async (_cwd, file) => {
      const session = new FakeSession(file)
      session.toolEvents = [
        {
          type: 'tool_execution_start',
          toolCallId: 'call-1',
          toolName: 'Wrapper',
          args: { task: 'align the reads', background: true }
        },
        ...extraEvents
      ]
      created = session
      return session
    }
  }
}

const persistedTypes = (app: Awaited<ReturnType<typeof harness>>): string[] =>
  app.appendedSessionEvents.map((entry) => String((entry.event as { type?: string }).type))

test('main IPC: a foreground agent step tells the card which run and session it belongs to', async () => {
  const delegation = agentDelegationSession([
    {
      type: 'tool_execution_update',
      toolCallId: 'call-1',
      toolName: 'Wrapper',
      partialResult: {
        content: [{ type: 'text', text: 'read /a.nf' }],
        details: {
          kind: 'agent_step',
          agent: 'Wrapper',
          agentRunId: 'run_1',
          step: { id: 's1', toolName: 'read', status: 'running', args: { path: '/a.nf' } }
        }
      }
    }
  ])
  const app = await harness(delegation.factory)
  await app.invoke('agent:prompt', 'go')

  const step = app.appendedSessionEvents
    .map((entry) => entry.event as Record<string, unknown>)
    .find((event) => event.type === 'agent_execution_step')
  assert.ok(step)
  assert.equal(step.agentRunId, 'run_1')
  assert.equal(step.agentSessionId, delegation.session().runtimeSessionId)
})

test('main IPC: starting an agent in the background leaves its card running instead of completing it', async () => {
  const delegation = agentDelegationSession([
    {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'Wrapper',
      result: {
        content: [
          { type: 'text', text: 'Started the Wrapper agent in the background as run run_1.' }
        ],
        details: { kind: 'agent_started', agent: 'Wrapper', runId: 'run_1' }
      },
      isError: false
    }
  ])
  const app = await harness(delegation.factory)
  await app.invoke('agent:prompt', 'go')

  assert.ok(!persistedTypes(app).includes('agent_execution_completed'))
  const marker = app.appendedSessionEvents
    .map((entry) => entry.event as Record<string, unknown>)
    .find((event) => event.type === 'agent_execution_background')
  assert.ok(marker)
  assert.equal(marker.toolCallId, 'call-1')
  assert.equal(marker.agentName, 'Wrapper')
  assert.equal(marker.agentRunId, 'run_1')
  assert.equal(marker.agentSessionId, delegation.session().runtimeSessionId)
  assert.ok(
    app.events.some(
      (event) => (event.data as { type?: string }).type === 'agent_execution_background'
    ),
    'the window hears about it'
  )
})

test('main IPC: a foreground agent still completes its card as before', async () => {
  const delegation = agentDelegationSession([
    {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'Wrapper',
      result: {
        content: [{ type: 'text', text: 'All done.' }],
        details: { kind: 'agent_result', agent: 'Wrapper', toolCalls: 2 }
      },
      isError: false
    }
  ])
  const app = await harness(delegation.factory)
  await app.invoke('agent:prompt', 'go')
  assert.ok(persistedTypes(app).includes('agent_execution_completed'))
  assert.ok(!persistedTypes(app).includes('agent_execution_background'))
})

test('main IPC: a background run’s steps and end reach its card after the turn is over', async () => {
  const delegation = agentDelegationSession([
    {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'Wrapper',
      result: {
        content: [{ type: 'text', text: 'Started.' }],
        details: { kind: 'agent_started', agent: 'Wrapper', runId: 'run_1' }
      },
      isError: false
    }
  ])
  const app = await harness(delegation.factory)
  await app.invoke('projects:newSession', '/projects/agent-card', 'ask')
  await app.invoke('agent:prompt', 'go')
  await tick()
  const runtime = delegation.session().runtimeSessionId

  await app.hostHandlers.get('agentRun.step')?.({
    originSessionId: runtime,
    run: { id: 'run_1', agent: 'Wrapper', toolCallId: 'call-1' },
    step: { id: 's1', toolName: 'wrapper_run', status: 'done', output: 'x'.repeat(50) }
  })
  await agentRunFinished(app, runtime, { toolCallId: 'call-1' })
  await tick()

  const events = app.appendedSessionEvents.map((entry) => entry.event as Record<string, unknown>)
  const step = events.find((event) => event.type === 'agent_execution_step' && event.agentRunId)
  assert.ok(step, 'the background step is on the card')
  assert.equal(step.toolCallId, 'call-1')
  assert.ok(
    app.persistedToolOutputs.some(
      (entry) => (entry.input as { output?: string }).output === 'x'.repeat(50)
    )
  )
  const completed = events.find((event) => event.type === 'agent_execution_completed')
  assert.ok(completed, 'the card is completed when the run ends')
  assert.equal(completed.toolCallId, 'call-1')
  assert.equal(completed.finalReport, 'Aligned. BAMs are in /data/bam.')
})

test('main IPC: the card’s steer and stop reach the run in the agent worker', async () => {
  const app = await harness()
  await app.invoke('agent:steerRun', 'runtime-7', 'run_3', '  use the mouse genome  ')
  await app.invoke('agent:stopRun', 'runtime-7', 'run_3')
  assert.deepEqual(app.bridgeRequests, [
    {
      method: 'agentRun.steer',
      params: { sessionId: 'runtime-7', runId: 'run_3', message: 'use the mouse genome' }
    },
    { method: 'agentRun.stop', params: { sessionId: 'runtime-7', runId: 'run_3' } }
  ])
})

test('main IPC: steering and stopping refuse malformed requests without asking the worker', async () => {
  const app = await harness()
  await assert.rejects(app.invoke('agent:steerRun', '', 'run_1', 'hi'))
  await assert.rejects(app.invoke('agent:steerRun', 'runtime-7', '', 'hi'))
  await assert.rejects(app.invoke('agent:steerRun', 'runtime-7', 'run_1', '   '))
  await assert.rejects(app.invoke('agent:steerRun', 'runtime-7', 'run_1', 'x'.repeat(5000)))
  await assert.rejects(app.invoke('agent:stopRun', 'runtime-7', 42))
  assert.deepEqual(app.bridgeRequests, [])
})

test('main IPC: a steering message is recorded on the card once the agent has accepted it', async () => {
  const { app, session } = await idleConversation()
  const before = app.events.length

  await app.invoke(
    'agent:steerRun',
    session.runtimeSessionId,
    'run_3',
    '  use the mouse genome  ',
    'call-1'
  )

  const recorded = app.appendedSessionEvents
    .map((entry) => entry.event as Record<string, unknown>)
    .filter((event) => event.type === 'agent_execution_steered')
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].toolCallId, 'call-1')
  assert.equal(recorded[0].agentRunId, 'run_3')
  assert.equal(recorded[0].text, 'use the mouse genome')

  const pushed = app.events
    .slice(before)
    .filter((entry) => (entry.data as { type?: string }).type === 'agent_execution_steered')
  assert.equal(pushed.length, 1)
  assert.equal(pushed[0].channel, 'agent:event')
  assert.match(String((pushed[0].data as { sessionPath?: string }).sessionPath), /phi-/)
})

test('main IPC: a steering message is redacted before it is stored', async () => {
  const { app, session } = await idleConversation()
  await app.invoke(
    'agent:steerRun',
    session.runtimeSessionId,
    'run_3',
    'use key ak-abcdefgh12345 please',
    'call-1'
  )
  const recorded = app.appendedSessionEvents
    .map((entry) => entry.event as Record<string, unknown>)
    .find((event) => event.type === 'agent_execution_steered')
  assert.ok(recorded)
  assert.doesNotMatch(String(recorded.text), /ak-abcdefgh/)
})

test('main IPC: a steering message the agent did not accept is not recorded', async () => {
  const { app, session } = await idleConversation()
  app.failBridgeRequests(new Error('Run run_3 is no longer running.'))
  await assert.rejects(
    app.invoke('agent:steerRun', session.runtimeSessionId, 'run_3', 'hello', 'call-1'),
    /no longer running/
  )
  assert.equal(
    app.appendedSessionEvents.some(
      (entry) => (entry.event as { type?: string }).type === 'agent_execution_steered'
    ),
    false
  )
})

test('main IPC: steering still works when there is no conversation or card to record it on', async () => {
  const { app, session } = await idleConversation()
  await app.invoke('agent:steerRun', 'runtime-unknown', 'run_3', 'hello', 'call-1')
  await app.invoke('agent:steerRun', session.runtimeSessionId, 'run_3', 'hello')
  assert.equal(app.bridgeRequests.length, 2)
  assert.equal(
    app.appendedSessionEvents.some(
      (entry) => (entry.event as { type?: string }).type === 'agent_execution_steered'
    ),
    false
  )
})

// ── timing: the SDK's tool events carry no timestamp ─────────────────────

test('main IPC: a delegated agent’s live events are timed even though the SDK’s events carry no time', async () => {
  const delegation = agentDelegationSession([
    {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'Wrapper',
      result: {
        content: [{ type: 'text', text: 'All done.' }],
        details: { kind: 'agent_result', agent: 'Wrapper', toolCalls: 2 }
      },
      isError: false
    }
  ])
  const app = await harness(delegation.factory)
  await app.invoke('agent:prompt', 'go')

  const live = (type: string): { createdAt?: string } | undefined =>
    app.events
      .map((entry) => entry.data as { type?: string; createdAt?: string })
      .find((data) => data.type === type)
  const started = live('agent_execution_started')
  const completed = live('agent_execution_completed')
  assert.ok(started && completed)
  assert.ok(Number.isFinite(Date.parse(started.createdAt ?? '')), 'the card knows when it started')
  assert.ok(Number.isFinite(Date.parse(completed.createdAt ?? '')), 'and when it ended')
  assert.ok(
    Date.parse(completed.createdAt as string) >= Date.parse(started.createdAt as string),
    'in order'
  )
})

test('main IPC: an event that already carries a time keeps it', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      {
        type: 'tool_execution_start',
        toolCallId: 'call-1',
        toolName: 'Wrapper',
        args: { task: 'align' },
        createdAt: '2026-09-20T01:02:03.000Z'
      }
    ]
    return session
  })
  await app.invoke('agent:prompt', 'go')
  const started = app.events
    .map((entry) => entry.data as { type?: string; createdAt?: string })
    .find((data) => data.type === 'agent_execution_started')
  assert.equal(started?.createdAt, '2026-09-20T01:02:03.000Z')
})
