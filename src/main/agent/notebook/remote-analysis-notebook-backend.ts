import { posix } from 'node:path'

import type { EnvironmentRequestConfirm } from '../content/env-request'
import {
  RemoteEnvironmentService,
  type RemoteEnvironmentServiceOptions
} from '../remote-runtime/environment-service'
import type { OpenRemoteRuntimeWorkspace } from '../remote-runtime/types'
import type { RemoteConnectionConfig } from '../wrappers/remote-ssh-session'
import { SshHost } from '../workspace-host/ssh-host'
import type { WorkspaceHost } from '../workspace-host/types'
import type { NotebookDocument } from '../../../shared/notebookDocument'
import type { AnalysisKernelDiagnostics } from './analysis-kernels'
import type { AnalysisNotebookFile, SaveProjectNotebookInput } from './analysis-notebook-files'
import { AnalysisNotebookExecutor } from './analysis-jupyter-execution'
import { AnalysisNotebookSessionRegistry } from './analysis-jupyter-sessions'
import {
  RemoteJupyterRuntimeBackend,
  type JupyterRuntimeBackend,
  type JupyterRuntimeState,
  type JupyterRuntimeStatus
} from './jupyter-runtime-backend'
import {
  RemoteKernelspecAdapter,
  type ResolveMissingRemoteJupyter
} from './remote-kernelspec-adapter'
import { RemoteJupyterServerSupervisor } from './remote-jupyter-server'
import {
  describeRemoteJupyterError,
  type RemoteJupyterStartJobHandle,
  type RemoteJupyterStartJobs
} from './remote-jupyter-start-jobs'
import type { RemoteJupyterResourcePolicyInput } from './remote-jupyter-resource-guard'
import { AnalysisNotebookToolExecutor, type NotebookDraftChange } from './notebook-tool-executor'
import type { NotebookToolDispatchControl, NotebookToolRequest } from './notebook-tools'
import {
  createNotebookWorkspace,
  type NotebookWorkspace,
  type NotebookWorkspaceWatchEvent,
  type NotebookWorkspaceWatchSubscription
} from './notebook-workspace'

export type RemoteNotebookServerMessageCode =
  'preparing_environment' | 'reconciling' | 'disconnected'

export type RemoteNotebookServerStatus = {
  projectCwd: string
  runtimeKind: 'ssh'
  serverLabel: string
  state: JupyterRuntimeState
  hasEndpoint: boolean
  port?: number
  remotePort?: number
  message?: string
  messageCode?: JupyterRuntimeStatus['messageCode'] | RemoteNotebookServerMessageCode
  messageParams?: JupyterRuntimeStatus['messageParams']
  cleanupUnconfirmed?: boolean
  canAbandonCleanup?: boolean
  resources?: ReturnType<JupyterRuntimeBackend['status']>['resources']
}

/** Environment preparation can take minutes on a first start; the cap only bounds the agent's wait. */
export const REMOTE_JUPYTER_AUTO_START_TIMEOUT_MS = 10 * 60_000
const READY_POLL_MS = 250

export class RemoteNotebookRuntimeController {
  private starting?: Promise<void>
  private approval?: Promise<boolean>
  private waiters = 0
  private lastError?: string

  constructor(
    private readonly options: {
      projectCwd: string
      serverLabel: string
      runtime: JupyterRuntimeBackend
      /** Starts the background-job record of one startup attempt. */
      beginJob?: () => RemoteJupyterStartJobHandle | undefined
    }
  ) {}

  private job?: RemoteJupyterStartJobHandle

  status(): RemoteNotebookServerStatus {
    const current = this.options.runtime.status(this.options.projectCwd)
    const state = this.lastError ? 'error' : current.state
    const { message, messageCode } = this.statusMessage(current, state)
    return {
      projectCwd: this.options.projectCwd,
      runtimeKind: 'ssh',
      serverLabel: this.options.serverLabel,
      state,
      hasEndpoint: current.hasConnection,
      ...(current.localPort === undefined ? {} : { port: current.localPort }),
      ...(current.remotePort === undefined ? {} : { remotePort: current.remotePort }),
      ...(message ? { message } : {}),
      ...(messageCode ? { messageCode } : {}),
      ...(current.messageParams ? { messageParams: current.messageParams } : {}),
      ...(current.cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}),
      ...(current.canAbandonCleanup ? { canAbandonCleanup: true } : {}),
      ...(current.resources ? { resources: current.resources } : {})
    }
  }

  private statusMessage(
    current: ReturnType<JupyterRuntimeBackend['status']>,
    state: RemoteNotebookServerStatus['state']
  ): Pick<RemoteNotebookServerStatus, 'message' | 'messageCode'> {
    if (this.lastError) return { message: this.lastError }
    const fallback = current.message ? undefined : this.defaultMessage(state)
    return {
      message: current.message ?? fallback?.message,
      messageCode: current.messageCode ?? fallback?.messageCode
    }
  }

  start(promptRuntimeSessionId?: string): RemoteNotebookServerStatus {
    if (!this.starting && !this.status().hasEndpoint) {
      this.lastError = undefined
      const job = this.options.beginJob?.()
      this.job = job
      job?.step(`Connecting to ${this.options.serverLabel}; preparing to start remote Jupyter`, {
        code: 'connecting',
        params: { serverLabel: this.options.serverLabel }
      })
      const pending = this.options.runtime
        .start(this.options.projectCwd, undefined, promptRuntimeSessionId)
        .then(
          () => job?.succeed(),
          (error) => {
            // Causes carry the actual reason, such as an early exit or a probe timeout.
            this.lastError = describeRemoteJupyterError(error)
            job?.fail(error)
          }
        )
      const tracked = pending.finally(() => {
        if (this.starting === tracked) this.starting = undefined
      })
      this.starting = tracked
    }
    return this.status()
  }

  async waitForStart(): Promise<void> {
    await this.starting
  }

  async stop(options: { abandonUnconfirmed?: boolean } = {}): Promise<RemoteNotebookServerStatus> {
    const pending = this.starting
    if (pending) this.job?.cancel()
    await this.options.runtime.stop(this.options.projectCwd, options)
    await pending
    this.lastError = undefined
    return this.status()
  }

  /**
   * Lets the agent start the remote Jupyter after one user approval, through the same start
   * path as the Runtime panel, then waits for it. Concurrent callers share the approval and
   * the start; a cancelled run stops the start only when nobody else is waiting on it.
   */
  async ensureReady(
    control: NotebookToolDispatchControl = {},
    options: { projectName?: string; timeoutMs?: number } = {}
  ): Promise<void> {
    const signal = control.signal
    signal?.throwIfAborted()
    if (this.status().hasEndpoint) return
    const state = this.status().state
    if (state === 'reconciling' || this.status().cleanupUnconfirmed) {
      throw new Error(
        'Remote Jupyter is checking whether the old process has exited. Check the Runtime panel, resolve the status, and try again. Phi did not fall back to local Jupyter.'
      )
    }
    let initiated = false
    if (!this.starting) {
      const approve = control.approveRemoteJupyterStart
      if (!approve) {
        throw new Error(
          'Remote Jupyter is not ready, and this call cannot ask for user approval. Start it explicitly in the Runtime panel first. Phi did not fall back to local Jupyter.'
        )
      }
      this.approval ??= approve({
        serverLabel: this.options.serverLabel,
        projectName: options.projectName ?? this.options.projectCwd
      }).finally(() => {
        this.approval = undefined
      })
      const approved = await this.approval
      signal?.throwIfAborted()
      if (!approved) {
        throw new Error(
          'The user declined to start remote Jupyter. It was not started, and Phi did not fall back to local Jupyter. Start it manually in the Runtime panel if needed.'
        )
      }
      if (!this.starting && !this.status().hasEndpoint) {
        this.start(control.runtimeSessionId)
        initiated = true
      }
    }
    this.waiters += 1
    try {
      await this.waitUntilReady(signal, options.timeoutMs ?? REMOTE_JUPYTER_AUTO_START_TIMEOUT_MS)
    } catch (error) {
      if (signal?.aborted && initiated && this.waiters === 1 && this.starting) {
        await this.stop().catch(() => undefined)
      }
      throw error
    } finally {
      this.waiters -= 1
    }
  }

  private async waitUntilReady(signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      signal?.throwIfAborted()
      if (this.status().hasEndpoint) return
      if (!this.starting) {
        throw new Error(
          this.lastError
            ? `Remote Jupyter failed to start: ${this.lastError}`
            : 'Remote Jupyter did not start. Phi did not fall back to local Jupyter.'
        )
      }
      if (Date.now() >= deadline) {
        throw new Error(
          'Timed out waiting for remote Jupyter to start. Startup is still running in the background; check progress in the Runtime panel and try again when it is ready.'
        )
      }
      await sleep(READY_POLL_MS, signal)
    }
  }

  requireReady(): void {
    if (this.status().hasEndpoint) return
    throw new Error(
      'Remote Jupyter is not ready. Start it explicitly in the Runtime panel and wait for environment preparation to finish. Phi did not fall back to local Jupyter.'
    )
  }

  private defaultMessage(
    state: JupyterRuntimeState
  ): { message: string; messageCode: RemoteNotebookServerMessageCode } | undefined {
    if (state === 'preparing_environment') {
      return {
        message:
          'Preparing the remote Notebook environment on the login node. Initial setup may take a while; stop to cancel.',
        messageCode: 'preparing_environment'
      }
    }
    if (state === 'reconciling') {
      return {
        message: 'Checking whether the old Jupyter has exited through a new SSH connection.',
        messageCode: 'reconciling'
      }
    }
    if (state === 'disconnected' || state === 'stopped') {
      return {
        message:
          'Remote Jupyter is disconnected. The kernel will restart after reconnection, and in-memory state will be lost.',
        messageCode: 'disconnected'
      }
    }
    return undefined
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

type RemoteBackendOptions = {
  projectCwd: string
  projectName: string
  serverLabel: string
  runtimeSessionId: string
  micromambaVersion: string
  projectHost: WorkspaceHost
  openWorkspace: OpenRemoteRuntimeWorkspace
  connection: RemoteConnectionConfig
  confirmEnvironment: (request: EnvironmentRequestConfirm) => Promise<boolean>
  resolveBaseEnvironment?: RemoteEnvironmentServiceOptions['resolveBaseEnvironment']
  notebookExecutor: AnalysisNotebookExecutor
  onDraftChanged?: (change: NotebookDraftChange) => void
  resourcePolicy?: RemoteJupyterResourcePolicyInput
  projectId?: string
  /** Records each startup attempt as a background job. */
  startJobs?: RemoteJupyterStartJobs
  /** The Jupyter path saved in the host's remote settings. */
  configuredJupyterPath?: () => string | undefined
  /** Asks the user how to recover when no configured or discovered Jupyter is usable. */
  resolveMissingJupyter?: ResolveMissingRemoteJupyter
}

export type RemoteAnalysisNotebookBackendOptions = Omit<RemoteBackendOptions, 'projectHost'> & {
  projectHostConfig: ConstructorParameters<typeof SshHost>[0]
}

export function createRemoteAnalysisNotebookBackend(
  options: RemoteAnalysisNotebookBackendOptions
): RemoteAnalysisNotebookBackend {
  const { projectHostConfig, ...backend } = options
  return new RemoteAnalysisNotebookBackend({
    ...backend,
    projectHost: new SshHost(projectHostConfig)
  })
}

export class RemoteAnalysisNotebookBackend {
  readonly projectCwd: string
  readonly projectName: string
  readonly workspace: NotebookWorkspace
  readonly runtime: RemoteJupyterRuntimeBackend
  readonly sessions: AnalysisNotebookSessionRegistry
  readonly tools: AnalysisNotebookToolExecutor
  readonly controller: RemoteNotebookRuntimeController
  private readonly watches = new Map<string, NotebookWorkspaceWatchSubscription>()
  private currentJob?: RemoteJupyterStartJobHandle

  constructor(private readonly options: RemoteBackendOptions) {
    this.projectCwd = options.projectCwd
    this.projectName = options.projectName
    this.workspace = createNotebookWorkspace({
      projectCwd: options.projectCwd,
      host: options.projectHost
    })
    const kernelspecs = this.createKernelspecs(options)
    this.runtime = new RemoteJupyterRuntimeBackend({
      kernelspecs,
      runtimeSessionId: options.runtimeSessionId,
      onProgress: (text, metadata) => this.currentJob?.step(text, metadata),
      createSupervisor: (launch) =>
        new RemoteJupyterServerSupervisor({
          connection: options.connection,
          launch,
          // Server output is the only place a failing launch explains itself.
          onLog: (line) => this.currentJob?.output(line),
          onStateChange: (status) => this.currentJob?.state(status.state, status.message),
          ...(options.resourcePolicy ? { resourcePolicy: options.resourcePolicy } : {})
        })
    })
    const startJobs = options.startJobs
    this.controller = new RemoteNotebookRuntimeController({
      projectCwd: options.projectCwd,
      serverLabel: options.serverLabel,
      runtime: this.runtime,
      ...(startJobs
        ? {
            beginJob: () => {
              this.currentJob = startJobs.begin({
                projectId: options.projectId ?? options.projectCwd,
                projectName: options.projectName,
                serverLabel: options.serverLabel
              })
              return this.currentJob
            }
          }
        : {})
    })
    this.sessions = new AnalysisNotebookSessionRegistry({ runtimeBackend: this.runtime })
    this.tools = this.createToolExecutor(options)
  }

  kernels(): AnalysisKernelDiagnostics {
    return this.runtime.kernels(this.projectCwd) ?? unavailableRemoteKernels()
  }

  async initializeProject(): Promise<{ notebooksDir: string; outputsDir: string }> {
    await Promise.all([
      this.options.projectHost.fs.mkdirp('notebooks'),
      this.options.projectHost.fs.mkdirp('outputs')
    ])
    return {
      notebooksDir: posix.join(this.projectCwd, 'notebooks'),
      outputsDir: posix.join(this.projectCwd, 'outputs')
    }
  }

  async open(
    path: string,
    onChange?: (event: NotebookWorkspaceWatchEvent) => void
  ): Promise<AnalysisNotebookFile> {
    const file = await this.workspace.open(path)
    if (onChange) await this.watch(file.path, onChange)
    return file
  }

  async save(input: SaveProjectNotebookInput): Promise<AnalysisNotebookFile> {
    return this.workspace.save(input)
  }

  async close(path: string): Promise<{ path: string }> {
    const file = await this.workspace.open(path)
    await this.sessions.closeSession(this.projectCwd, file.path)
    await this.unwatch(file.path)
    return this.workspace.close(file.path)
  }

  async delete(path: string): Promise<{ path: string; relativePath: string }> {
    const file = await this.workspace.open(path)
    await this.sessions.closeSession(this.projectCwd, file.path)
    await this.unwatch(file.path)
    return this.workspace.delete(file.path)
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([
      this.sessions.closeProject(this.projectCwd),
      ...[...this.watches.values()].map((watch) => watch.close())
    ])
    this.watches.clear()
    try {
      await this.runtime.releaseProject?.(this.projectCwd)
      await this.sessions.closeProject(this.projectCwd)
    } finally {
      await this.options.projectHost.close?.()
    }
  }

  private createKernelspecs(options: RemoteBackendOptions): RemoteKernelspecAdapter {
    const environments = new RemoteEnvironmentService({
      openWorkspace: options.openWorkspace,
      micromambaVersion: options.micromambaVersion,
      confirm: options.confirmEnvironment,
      ...(options.resolveBaseEnvironment
        ? { resolveBaseEnvironment: options.resolveBaseEnvironment }
        : {})
    })
    return new RemoteKernelspecAdapter({
      environments,
      openWorkspace: options.openWorkspace,
      ...(options.configuredJupyterPath
        ? { configuredJupyterPath: options.configuredJupyterPath }
        : {}),
      ...(options.resolveMissingJupyter
        ? { resolveMissingJupyter: options.resolveMissingJupyter }
        : {})
    })
  }

  private createToolExecutor(options: RemoteBackendOptions): AnalysisNotebookToolExecutor {
    return new AnalysisNotebookToolExecutor({
      resolveWorkspaceByCwd: () => ({
        workingDirectory: options.projectCwd,
        name: options.projectName
      }),
      resolveNotebookWorkspaceByCwd: () => this.workspace,
      resolveKernelsByCwd: () => this.kernels(),
      ensureJupyterServerReady: async (_cwd, control) =>
        this.controller.ensureReady(control, { projectName: options.projectName }),
      notebookSessionRegistry: this.sessions,
      notebookExecutor: options.notebookExecutor,
      onDraftChanged: options.onDraftChanged
    })
  }

  private async watch(
    path: string,
    onChange: (event: NotebookWorkspaceWatchEvent) => void
  ): Promise<void> {
    await this.unwatch(path)
    this.watches.set(path, await this.workspace.watch(path, onChange))
  }

  private async unwatch(path: string): Promise<void> {
    const watch = this.watches.get(path)
    this.watches.delete(path)
    await watch?.close()
  }
}

function unavailableRemoteKernels(): AnalysisKernelDiagnostics {
  const message =
    'Start remote Jupyter explicitly in the Runtime panel first. Opening a project does not create the environment automatically.'
  return {
    jupyterServer: { available: false, command: 'jupyter', error: message },
    kernels: [],
    hasPythonKernel: false,
    hasRKernel: false,
    messages: [message]
  }
}

export function remoteNotebookFileChange(
  projectCwd: string,
  event: NotebookWorkspaceWatchEvent
): Record<string, unknown> {
  if (event.type === 'changed') return { ...event, projectCwd, file: event.file }
  return { ...event, projectCwd }
}

export type { NotebookToolRequest, NotebookDocument }
