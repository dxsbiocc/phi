import { randomUUID } from 'node:crypto'

import type {
  LocalMcpConnectorRequest,
  McpConnectorSetupProgress
} from '../../../shared/mcpConnectorCatalog'
import { EnvironmentNotReadyError } from '../content/environment-refs'
import {
  addLocalMcpConnector,
  buildLocalStdioEntry,
  removeLocalMcpConnector,
  validateLocalConnectorRequest,
  type AddLocalMcpConnectorDependencies,
  type LocalStdioEntry
} from './custom-stdio'
import { ConnectorSetupBusyError, type ConnectorSetupTracker } from './connector-setup'
import { validateName } from './connector-name'
import type { EnvironmentLookup } from './stdio-environment'
import { ConfiguredStdioProbeError } from '../omp/configured-stdio-probe-error'

const LOCAL_CONNECTOR_TIMEOUT_MS = 600_000

export type LocalConnectorProbeRequest = {
  name: string
  entry: LocalStdioEntry
  environment: EnvironmentLookup
  requestKey: string
  timeoutMs: number
  captureStderr: true
}

type LocalConnectorJobEvent = 'started' | 'succeeded' | 'failed' | 'cancelled'

export interface LocalConnectorJobsDependencies extends Omit<
  Partial<AddLocalMcpConnectorDependencies>,
  'agentDir' | 'runtimeRoot' | 'probe'
> {
  tracker: ConnectorSetupTracker
  agentDir: string
  runtimeRoot: string
  probe(request: LocalConnectorProbeRequest): Promise<string[]>
  cancelProbe(requestKey: string): unknown | Promise<unknown>
  applyEnabled(name: string): unknown | Promise<unknown>
  now?: () => string
  requestKey?: () => string
  timeoutMs?: number
  onEvent?: (
    event: LocalConnectorJobEvent,
    metadata: { name: string; runtimeKind: LocalMcpConnectorRequest['runtime']['kind'] }
  ) => void
}

type ActiveJob = {
  requestKey: string
  cancelled: boolean
  probeStarted: boolean
  promise?: Promise<void>
}

export class LocalConnectorJobs {
  private readonly active = new Map<string, ActiveJob>()
  private readonly retryRequests = new Map<string, LocalMcpConnectorRequest>()

  constructor(private readonly deps: LocalConnectorJobsDependencies) {}

  startLocalConnectorAdd(rawRequest: unknown): { started: true; name: string } {
    const request = this.prepare(rawRequest)
    if (this.active.has(request.name) || this.deps.tracker.isActive(request.name)) {
      throw new ConnectorSetupBusyError(request.name)
    }

    const job: ActiveJob = {
      requestKey: (this.deps.requestKey ?? randomUUID)(),
      cancelled: false,
      probeStarted: false
    }
    this.active.set(request.name, job)
    this.retryRequests.set(request.name, copyRequest(request))
    const startedAt = (this.deps.now ?? (() => new Date().toISOString()))()
    const metadata = { name: request.name, runtimeKind: request.runtime.kind }
    const promise = this.deps.tracker
      .run(request.name, async (report) => {
        report('starting', {
          kind: 'local-stdio',
          title: request.name,
          startedAt,
          summary: localConnectorSummary(request)
        })
        if (job.cancelled) throw new Error('已取消')
        const result = await addLocalMcpConnector(request, {
          agentDir: this.deps.agentDir,
          runtimeRoot: this.deps.runtimeRoot,
          catalogIds: this.deps.catalogIds,
          environmentsDir: this.deps.environmentsDir,
          platform: this.deps.platform,
          baseEnv: this.deps.baseEnv,
          resolveBunExecutable: this.deps.resolveBunExecutable,
          fileSystem: this.deps.fileSystem,
          clock: this.deps.clock,
          probe: async (probeRequest) => {
            if (job.cancelled) throw new Error('已取消')
            job.probeStarted = true
            try {
              const tools = await this.deps.probe({
                ...probeRequest,
                requestKey: job.requestKey,
                timeoutMs: this.deps.timeoutMs ?? LOCAL_CONNECTOR_TIMEOUT_MS,
                captureStderr: true
              })
              if (job.cancelled) throw new Error('已取消')
              return tools
            } catch (error) {
              if (job.cancelled) throw new Error('已取消')
              throw localProbeFailure(error)
            } finally {
              job.probeStarted = false
            }
          }
        })
        try {
          await this.deps.applyEnabled(request.name)
          if (job.cancelled) throw new Error('已取消')
        } catch (error) {
          removeLocalMcpConnector(request.name, {
            agentDir: this.deps.agentDir,
            fileSystem: this.deps.fileSystem
          })
          await Promise.resolve(this.deps.applyEnabled(request.name)).catch(() => undefined)
          if (job.cancelled) throw new Error('已取消')
          throw error
        }
        report('ready', { toolNames: result.tools })
      })
      .then(
        () => this.deps.onEvent?.('succeeded', metadata),
        () => this.deps.onEvent?.(job.cancelled ? 'cancelled' : 'failed', metadata)
      )
      .finally(() => {
        if (this.active.get(request.name) === job) this.active.delete(request.name)
      })
    job.promise = promise
    this.deps.onEvent?.('started', metadata)
    return { started: true, name: request.name }
  }

  async cancelLocalConnectorAdd(rawName: unknown): Promise<void> {
    const name = validateName(rawName as string)
    const job = this.active.get(name)
    if (!job) return
    job.cancelled = true
    if (job.probeStarted) await this.deps.cancelProbe(job.requestKey)
    await job.promise?.catch(() => undefined)
  }

  retryLocalConnectorAdd(rawName: unknown): { started: true; name: string } {
    const name = validateName(rawName as string)
    const request = this.retryRequests.get(name)
    if (!request) throw new Error('无法重试，请重新添加')
    return this.startLocalConnectorAdd(copyRequest(request))
  }

  listLocalConnectorJobs(): McpConnectorSetupProgress[] {
    return this.deps.tracker.list().filter((progress) => progress.kind === 'local-stdio')
  }

  private prepare(rawRequest: unknown): LocalMcpConnectorRequest {
    const request = validateLocalConnectorRequest(rawRequest, {
      agentDir: this.deps.agentDir,
      catalogIds: this.deps.catalogIds,
      fileSystem: this.deps.fileSystem
    })
    try {
      buildLocalStdioEntry(request, {
        root: this.deps.runtimeRoot,
        agentDir: this.deps.agentDir,
        environmentsDir: this.deps.environmentsDir,
        platform: this.deps.platform,
        baseEnv: this.deps.baseEnv,
        resolveBunExecutable: this.deps.resolveBunExecutable
      })
    } catch (error) {
      if (error instanceof EnvironmentNotReadyError) {
        throw new Error('运行环境尚未就绪，请先在环境页构建')
      }
      throw error
    }
    return request
  }
}

const EARLY_EXIT_HINT =
  '服务在响应前就退出了，进程输出见详情。若它需要先初始化（例如运行 init），请先在终端完成。'

function localProbeFailure(error: unknown): unknown {
  if (!(error instanceof Error)) return error
  const detail = probeErrorDetail(error)
  if (
    !detail ||
    !/MCP subprocess .*?(?:closed|exited).*?before (?:responding|handshake)/iu.test(error.message)
  ) {
    return error
  }
  const enhanced = new ConfiguredStdioProbeError(`${error.message}\n${EARLY_EXIT_HINT}`, detail)
  if (error.stack) enhanced.stack = error.stack
  return enhanced
}

function probeErrorDetail(error: Error): string | undefined {
  const detail = (error as Error & { detail?: unknown }).detail
  return typeof detail === 'string' && detail ? detail : undefined
}

export function createLocalConnectorJobs(deps: LocalConnectorJobsDependencies): LocalConnectorJobs {
  return new LocalConnectorJobs(deps)
}

function copyRequest(request: LocalMcpConnectorRequest): LocalMcpConnectorRequest {
  return {
    ...request,
    runtime: { ...request.runtime },
    args: [...request.args],
    env: { ...request.env }
  }
}

function localConnectorSummary(request: LocalMcpConnectorRequest): string {
  const command = request.runtime.kind === 'bun' ? `bun ${request.command}` : request.command
  const args = request.args.map((argument, index) =>
    displayArgument(argument, request.args[index - 1])
  )
  const envKeys = Object.keys(request.env).sort()
  return [[command, ...args].join(' '), envKeys.length ? `env: ${envKeys.join(', ')}` : undefined]
    .filter(Boolean)
    .join(' · ')
    .slice(0, 4096)
}

function displayArgument(argument: string, previous: string | undefined): string {
  const sensitive = /(?:token|secret|password|api[-_]?key|credential|auth)/iu
  if (previous?.startsWith('-') && sensitive.test(previous)) return '••••'
  const equals = argument.indexOf('=')
  if (equals > 0 && sensitive.test(argument.slice(0, equals))) {
    return `${argument.slice(0, equals + 1)}••••`
  }
  if (/\s/u.test(argument)) return JSON.stringify(argument)
  return argument
}
