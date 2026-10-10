import { randomUUID } from 'node:crypto'

import type { AnalysisKernelDiagnostics, AnalysisKernelSummary } from './analysis-kernels'
import {
  JupyterServerRegistry,
  type JupyterServerConnection,
  type JupyterServerPublicStatus
} from './analysis-jupyter-server'
import type {
  PreparedRemoteJupyterRuntime,
  RemoteKernelspecAdapter
} from './remote-kernelspec-adapter'
import {
  type RemoteJupyterConnection,
  type RemoteJupyterLaunchCommand,
  type RemoteJupyterServerSupervisor,
  type RemoteJupyterServerStatus
} from './remote-jupyter-server'

export type JupyterRuntimeKind = 'local' | 'ssh'
export type JupyterRuntimeState =
  JupyterServerPublicStatus['state'] | RemoteJupyterServerStatus['state']

export interface JupyterRuntimeStatus {
  kind: JupyterRuntimeKind
  projectCwd: string
  state: JupyterRuntimeState
  hasConnection: boolean
  message?: string
  localPort?: number
  remotePort?: number
}

export interface JupyterRuntimeBackend {
  readonly kind: JupyterRuntimeKind
  status(projectCwd: string): JupyterRuntimeStatus
  start(projectCwd: string, signal?: AbortSignal): Promise<void>
  stop(projectCwd: string): Promise<void>
  connection(projectCwd: string): JupyterServerConnection | null
}

export function jupyterAuthorizationHeader(
  connection: JupyterServerConnection
): string | undefined {
  const value = connection.authorizationHeader?.() ?? tokenHeader(connection.token)
  if (value && /[\r\n]/.test(value)) throw new Error('Jupyter authorization header 无效')
  return value
}

export function jupyterWebSocketToken(connection: JupyterServerConnection): string | undefined {
  const authorization = jupyterAuthorizationHeader(connection)
  if (!authorization) return undefined
  const match = /^token ([^\r\n]+)$/.exec(authorization)
  if (!match) throw new Error('Jupyter WebSocket 需要 token authorization')
  return match[1]
}

export function jupyterConnectionIdentity(connection: JupyterServerConnection): string {
  return connection.runtimeId ?? `legacy:${connection.url}`
}

export function sanitizeJupyterConnectionError(
  error: unknown,
  connection: JupyterServerConnection
): string {
  let message = error instanceof Error ? error.message : String(error)
  try {
    const token = jupyterWebSocketToken(connection)
    if (token) message = message.split(token).join('<redacted>')
  } catch {
    // An expired dynamic connection may no longer expose its token.
  }
  return message.replace(/([?&]token=)[^\s&'"\n]+/gi, '$1<redacted>')
}

export class LocalJupyterRuntimeBackend implements JupyterRuntimeBackend {
  readonly kind = 'local' as const

  constructor(private readonly registry: JupyterServerRegistry) {}

  status(projectCwd: string): JupyterRuntimeStatus {
    const status = this.registry.status(projectCwd)
    return {
      kind: this.kind,
      projectCwd,
      state: status.state,
      hasConnection: status.hasEndpoint && status.state === 'ready',
      ...(status.message ? { message: status.message } : {}),
      ...(status.port === undefined ? {} : { localPort: status.port })
    }
  }

  async start(projectCwd: string): Promise<void> {
    this.registry.start(projectCwd)
  }

  async stop(projectCwd: string): Promise<void> {
    this.registry.stop(projectCwd)
  }

  connection(projectCwd: string): JupyterServerConnection | null {
    return this.registry.connection(projectCwd)
  }

  disposeAll(): void {
    this.registry.disposeAll()
  }
}

type RemoteKernelAdapter = Pick<RemoteKernelspecAdapter, 'prepareRuntime' | 'select'>
type RemoteSupervisor = Pick<RemoteJupyterServerSupervisor, 'status' | 'start' | 'stop'>

export interface RemoteJupyterRuntimeBackendOptions {
  kernelspecs: RemoteKernelAdapter
  runtimeSessionId: string
  createSupervisor: (launch: RemoteJupyterLaunchCommand) => RemoteSupervisor
}

export class RemoteJupyterRuntimeBackend implements JupyterRuntimeBackend {
  readonly kind = 'ssh' as const
  private boundProject?: string
  private currentConnection?: JupyterServerConnection
  private currentKernels?: AnalysisKernelDiagnostics
  private supervisor?: RemoteSupervisor
  private launchIdentity?: string
  private preparing = false
  private starting?: Promise<void>
  private startAbort?: AbortController

  constructor(private readonly options: RemoteJupyterRuntimeBackendOptions) {}

  status(projectCwd: string): JupyterRuntimeStatus {
    const status = this.supervisor?.status() ?? { state: 'stopped' as const }
    const state = this.preparing ? 'preparing_environment' : status.state
    const active = this.boundProject === projectCwd
    return {
      kind: this.kind,
      projectCwd,
      state: active ? state : 'stopped',
      hasConnection: active && state === 'ready' && Boolean(this.currentConnection),
      ...(active && status.message ? { message: status.message } : {}),
      ...(active && status.localPort !== undefined ? { localPort: status.localPort } : {}),
      ...(active && status.remotePort !== undefined ? { remotePort: status.remotePort } : {})
    }
  }

  async start(projectCwd: string, signal?: AbortSignal): Promise<void> {
    this.claimProject(projectCwd)
    if (this.isReady() && this.currentKernels) return
    if (this.starting) return this.starting
    this.startAbort = new AbortController()
    const combined = signal
      ? AbortSignal.any([signal, this.startAbort.signal])
      : this.startAbort.signal
    this.starting = this.startRuntime(combined).finally(() => {
      this.starting = undefined
      this.startAbort = undefined
    })
    return this.starting
  }

  private async startRuntime(signal: AbortSignal): Promise<void> {
    this.preparing = true
    try {
      const prepared = await this.options.kernelspecs.prepareRuntime({
        runtimeSessionId: this.options.runtimeSessionId,
        signal
      })
      this.currentKernels = prepared.kernels
      this.preparing = false
      const supervisor = this.supervisorFor(prepared)
      const remote = await supervisor.start(signal)
      this.currentConnection = this.connect(remote)
    } catch (error) {
      this.currentConnection = undefined
      this.currentKernels = undefined
      await this.supervisor?.stop().catch(() => undefined)
      throw error
    } finally {
      this.preparing = false
    }
  }

  async stop(projectCwd: string): Promise<void> {
    if (this.boundProject !== projectCwd) return
    this.startAbort?.abort()
    this.currentConnection = undefined
    this.currentKernels = undefined
    await this.starting?.catch(() => undefined)
    await this.supervisor?.stop()
  }

  connection(projectCwd: string): JupyterServerConnection | null {
    if (this.boundProject !== projectCwd) return null
    if (this.supervisor?.status().state !== 'ready') return null
    return this.currentConnection ?? null
  }

  kernels(projectCwd: string): AnalysisKernelDiagnostics | null {
    return this.boundProject === projectCwd ? (this.currentKernels ?? null) : null
  }

  selectKernel(projectCwd: string, name?: string): AnalysisKernelSummary {
    const diagnostics = this.kernels(projectCwd)
    if (!diagnostics) throw new Error('远程 Notebook kernel 尚未准备')
    return this.options.kernelspecs.select(diagnostics, name)
  }

  private claimProject(projectCwd: string): void {
    if (this.boundProject && this.boundProject !== projectCwd) {
      throw new Error('远程 Jupyter runtime 已由另一个项目占用')
    }
    this.boundProject = projectCwd
  }

  private isReady(): boolean {
    return this.supervisor?.status().state === 'ready' && Boolean(this.currentConnection)
  }

  private supervisorFor(prepared: PreparedRemoteJupyterRuntime): RemoteSupervisor {
    const identity = JSON.stringify(prepared.launch)
    if (!this.supervisor) {
      this.supervisor = this.options.createSupervisor(prepared.launch)
      this.launchIdentity = identity
      return this.supervisor
    }
    if (this.launchIdentity !== identity) {
      throw new Error('远程 Jupyter 受管环境已变化，请重新打开项目 runtime')
    }
    return this.supervisor
  }

  private connect(remote: RemoteJupyterConnection): JupyterServerConnection {
    assertTunnelEndpoint(remote.baseUrl)
    return {
      url: remote.baseUrl,
      authorizationHeader: remote.authorizationHeader,
      runtimeId: randomUUID()
    }
  }
}

function tokenHeader(token: string | undefined): string | undefined {
  return token ? `token ${token}` : undefined
}

function assertTunnelEndpoint(value: string): void {
  const url = new URL(value)
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('远程 Jupyter 连接必须使用本机 SSH tunnel endpoint')
  }
}
