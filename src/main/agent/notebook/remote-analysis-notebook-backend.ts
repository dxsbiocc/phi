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
  type JupyterRuntimeState
} from './jupyter-runtime-backend'
import { RemoteKernelspecAdapter } from './remote-kernelspec-adapter'
import { RemoteJupyterServerSupervisor } from './remote-jupyter-server'
import type { RemoteJupyterResourcePolicyInput } from './remote-jupyter-resource-guard'
import { AnalysisNotebookToolExecutor, type NotebookDraftChange } from './notebook-tool-executor'
import type { NotebookToolRequest } from './notebook-tools'
import {
  createNotebookWorkspace,
  type NotebookWorkspace,
  type NotebookWorkspaceWatchEvent,
  type NotebookWorkspaceWatchSubscription
} from './notebook-workspace'

export type RemoteNotebookServerStatus = {
  projectCwd: string
  runtimeKind: 'ssh'
  serverLabel: string
  state: JupyterRuntimeState
  hasEndpoint: boolean
  port?: number
  remotePort?: number
  message?: string
  cleanupUnconfirmed?: boolean
  canAbandonCleanup?: boolean
  resources?: ReturnType<JupyterRuntimeBackend['status']>['resources']
}

export class RemoteNotebookRuntimeController {
  private starting?: Promise<void>
  private lastError?: string

  constructor(
    private readonly options: {
      projectCwd: string
      serverLabel: string
      runtime: JupyterRuntimeBackend
    }
  ) {}

  status(): RemoteNotebookServerStatus {
    const current = this.options.runtime.status(this.options.projectCwd)
    const failed = Boolean(this.lastError)
    const state = failed ? 'error' : current.state
    const message = failed ? this.lastError : (current.message ?? this.defaultMessage(state))
    return {
      projectCwd: this.options.projectCwd,
      runtimeKind: 'ssh',
      serverLabel: this.options.serverLabel,
      state,
      hasEndpoint: current.hasConnection,
      ...(current.localPort === undefined ? {} : { port: current.localPort }),
      ...(current.remotePort === undefined ? {} : { remotePort: current.remotePort }),
      ...(message ? { message } : {}),
      ...(current.cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}),
      ...(current.canAbandonCleanup ? { canAbandonCleanup: true } : {}),
      ...(current.resources ? { resources: current.resources } : {})
    }
  }

  start(): RemoteNotebookServerStatus {
    if (!this.starting && !this.status().hasEndpoint) {
      this.lastError = undefined
      const pending = this.options.runtime.start(this.options.projectCwd).catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error)
      })
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
    await this.options.runtime.stop(this.options.projectCwd, options)
    await pending
    this.lastError = undefined
    return this.status()
  }

  requireReady(): void {
    if (this.status().hasEndpoint) return
    throw new Error(
      '远程 Jupyter 尚未就绪；请先在 Runtime 面板显式启动并等待环境准备完成。没有回退到本机 Jupyter。'
    )
  }

  private defaultMessage(state: JupyterRuntimeState): string | undefined {
    if (state === 'preparing_environment') {
      return '正在登录节点准备远程 Notebook 环境；首次创建可能较慢，可停止以取消。'
    }
    if (state === 'reconciling') return '正在通过新的 SSH 连接确认旧 Jupyter 是否已退出。'
    if (state === 'disconnected' || state === 'stopped') {
      return '远程 Jupyter 未连接；重新连接后 kernel 将重启，内存状态会丢失。'
    }
    return undefined
  }
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
      createSupervisor: (launch) =>
        new RemoteJupyterServerSupervisor({
          connection: options.connection,
          launch,
          ...(options.resourcePolicy ? { resourcePolicy: options.resourcePolicy } : {})
        })
    })
    this.controller = new RemoteNotebookRuntimeController({
      projectCwd: options.projectCwd,
      serverLabel: options.serverLabel,
      runtime: this.runtime
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
      openWorkspace: options.openWorkspace
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
      ensureJupyterServerReady: async () => this.controller.requireReady(),
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
  const message = '请先在 Runtime 面板显式启动远程 Jupyter；打开项目不会自动创建环境。'
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
