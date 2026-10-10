import { createHash } from 'node:crypto'
import { posix } from 'node:path'

import {
  environmentRequestQuestion,
  type EnvironmentRequestConfirm,
  type EnvRequestResult
} from '../content/env-request'
import { remoteMicromambaPath } from '../../../shared/remoteMicromambaTypes'
import type { CommandResult } from '../workspace-host/types'
import type {
  OpenRemoteRuntimeWorkspace,
  RemoteEnvironmentHandle,
  RemoteRuntimeWorkspace
} from './types'
import { untilAbort } from './abort-wait'
import {
  validRemoteEnvironmentRequest,
  type ValidRemoteEnvironmentRequest
} from './environment-request-validation'
import {
  ensureEnvironmentAliases,
  probeEnvironmentAlias,
  probeEnvironmentMarker,
  publishEnvironmentMarker
} from './environment-transport'

const DEFAULT_TIMEOUT_MS = 10 * 60_000
const DEFAULT_OUTPUT_BYTES = 1024 * 1024
const SETTINGS_GUIDANCE =
  '请打开“设置 → 远程”，检查 micromamba 路径，或恢复由 Phi 管理的默认值后重试。Phi 没有回退到本机创建环境。'

interface EnvironmentRecord extends RemoteEnvironmentHandle {
  baseRef: string
  added: string[]
}

export interface RemoteEnvironmentServiceOptions {
  openWorkspace: OpenRemoteRuntimeWorkspace
  micromambaVersion: string
  confirm: (request: EnvironmentRequestConfirm) => Promise<boolean>
  resolveBasePackages?: (ref: string, pluginId?: string) => Promise<readonly string[]>
  resolveBaseEnvironment?: (
    ref: string,
    pluginId?: string
  ) => Promise<{ packages: readonly string[]; channels: readonly string[] }>
  timeoutMs?: number
  maxOutputBytes?: number
}

export class RemoteEnvironmentService {
  private readonly runs = new Map<string, AbortController>()
  private readonly cancelled = new Set<string>()
  private readonly locks = new Map<string, Promise<void>>()

  constructor(private readonly options: RemoteEnvironmentServiceOptions) {}

  async request(params: unknown): Promise<EnvRequestResult> {
    let input: ValidRemoteEnvironmentRequest
    try {
      input = validRemoteEnvironmentRequest(params)
    } catch (error) {
      return { error: errorText(error) }
    }
    if (!(await this.confirm(input))) return { declined: true }
    const controller = this.begin(input.requestId)
    let workspace: RemoteRuntimeWorkspace | undefined
    try {
      workspace = await this.options.openWorkspace(input.runtimeSessionId, controller.signal)
      return await this.withLock(
        `${workspace.projectRoot}\0${input.environment}`,
        controller.signal,
        () => this.createOrReuse(workspace!, input, controller.signal)
      )
    } catch (error) {
      return { error: controller.signal.aborted ? '远程环境创建已取消' : errorText(error) }
    } finally {
      await workspace?.close?.().catch(() => undefined)
      this.end(input.requestId, controller)
    }
  }

  cancel(params: unknown): void {
    const requestId = optionalRequestId(params)
    if (!requestId) return
    const controller = this.runs.get(requestId)
    if (controller) controller.abort()
    else this.cancelled.add(requestId)
  }

  async bindSession(params: unknown): Promise<Record<string, unknown>> {
    const record = requireRecord(params)
    const runtimeSessionId = requireText(record, 'runtimeSessionId')
    const ref = requireText(record, 'ref')
    const workspace = await this.options.openWorkspace(runtimeSessionId)
    try {
      const handle = await this.resolveInWorkspace(ref, workspace)
      if (!handle) return { notReady: notReady(ref) }
      return { ...handle, variables: remoteEnvironmentVariables(handle.prefix) }
    } finally {
      await workspace.close?.().catch(() => undefined)
    }
  }

  async resolveInWorkspace(
    ref: string,
    workspace: RemoteRuntimeWorkspace
  ): Promise<RemoteEnvironmentHandle | undefined> {
    const alias = await this.storedEnvironment(ref, workspace)
    if (!alias) return undefined
    return {
      ref: alias.ref,
      envId: alias.envId,
      name: alias.name,
      prefix: posix.join(workspace.runtimeRoot, 'envs', alias.envId),
      packages: [...alias.packages],
      channels: [...alias.channels]
    }
  }

  private async storedEnvironment(
    ref: string,
    workspace: RemoteRuntimeWorkspace,
    signal?: AbortSignal
  ): Promise<EnvironmentRecord | undefined> {
    const state = await probeEnvironmentAlias(
      workspace,
      aliasPath(workspace.projectRoot, ref),
      signal
    )
    if (!state) return undefined
    const alias = parsedRecord(state.alias)
    const marker = parsedRecord(state.marker)
    if (!alias || !marker || !safeId(alias.envId) || alias.ref !== ref) return undefined
    if (typeof alias.name !== 'string' || marker.envId !== alias.envId) return undefined
    if (!sameStringArray(marker.packages, alias.packages)) return undefined
    if (!sameStringArray(marker.channels, alias.channels)) return undefined
    return alias
  }

  micromambaPath(workspace: RemoteRuntimeWorkspace): string {
    return (
      workspace.micromambaPath ??
      remoteMicromambaPath(workspace.runtimeRoot, this.options.micromambaVersion)
    )
  }

  private async confirm(input: ValidRemoteEnvironmentRequest): Promise<boolean> {
    return this.options.confirm({
      runtimeSessionId: input.runtimeSessionId,
      packages: input.packages,
      reason: input.reason,
      environment: input.environment,
      question: environmentRequestQuestion(input)
    })
  }

  private begin(requestId: string | undefined): AbortController {
    const controller = new AbortController()
    if (!requestId) return controller
    if (this.cancelled.delete(requestId)) controller.abort()
    this.runs.get(requestId)?.abort()
    this.runs.set(requestId, controller)
    return controller
  }

  private end(requestId: string | undefined, controller: AbortController): void {
    if (requestId && this.runs.get(requestId) === controller) this.runs.delete(requestId)
  }

  private async createOrReuse(
    workspace: RemoteRuntimeWorkspace,
    input: ValidRemoteEnvironmentRequest,
    signal: AbortSignal
  ): Promise<EnvRequestResult> {
    const previous = await this.storedEnvironment(input.environment, workspace, signal)
    const base = previous ?? (await this.baseEnvironment(input))
    const packages = uniquePackages([...base.packages, ...input.packages])
    const channels = ['conda-forge']
    const record = environmentRecord(workspace, input, packages, channels)
    await this.withLock(`${workspace.runtimeRoot}\0${record.envId}`, signal, async () => {
      const previousReady = previous?.envId === record.envId
      if (!previousReady && !(await this.environmentReady(workspace, record, signal))) {
        await this.createEnvironment(workspace, record, signal)
      }
    })
    signal.throwIfAborted()
    await this.writeAliases(workspace, input.environment, record, signal)
    return { ref: record.ref, envId: record.envId, name: record.name, added: record.added }
  }

  private async baseEnvironment(
    input: ValidRemoteEnvironmentRequest
  ): Promise<{ packages: readonly string[]; channels: readonly string[] }> {
    if (this.options.resolveBaseEnvironment) {
      return this.options.resolveBaseEnvironment(input.environment, input.pluginId)
    }
    const packages =
      (await this.options.resolveBasePackages?.(input.environment, input.pluginId)) ?? []
    return { packages, channels: ['conda-forge'] }
  }

  private async environmentReady(
    workspace: RemoteRuntimeWorkspace,
    record: EnvironmentRecord,
    signal: AbortSignal
  ): Promise<boolean> {
    const stored = parsedRecord(
      (await probeEnvironmentMarker(workspace, record.envId, signal)) ?? ''
    )
    return (
      stored?.envId === record.envId &&
      sameStringArray(stored.packages, record.packages) &&
      sameStringArray(stored.channels, record.channels)
    )
  }

  private async createEnvironment(
    workspace: RemoteRuntimeWorkspace,
    record: EnvironmentRecord,
    signal: AbortSignal
  ): Promise<void> {
    const binary = this.micromambaPath(workspace)
    if (
      !workspace.micromambaPath &&
      !(await isFile(workspace, posix.relative(workspace.runtimeRoot, binary)))
    ) {
      throw new Error(`服务器运行时根目录中没有可用的 micromamba。${SETTINGS_GUIDANCE}`)
    }
    const result = await workspace.projectHost.exec.run(
      [
        binary,
        'create',
        '-p',
        record.prefix,
        '--override-channels',
        ...record.channels.flatMap((channel) => ['-c', channel]),
        '--yes',
        ...record.packages
      ],
      {
        cwd: workspace.projectRoot,
        env: { MAMBA_ROOT_PREFIX: workspace.runtimeRoot },
        signal,
        timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxOutputBytes: this.options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES
      }
    )
    throwForCreateFailure(result)
    signal.throwIfAborted()
    await publishEnvironmentMarker(workspace, record.envId, json(record), signal)
  }

  private async writeAliases(
    workspace: RemoteRuntimeWorkspace,
    baseRef: string,
    record: EnvironmentRecord,
    signal: AbortSignal
  ): Promise<void> {
    const aliases: Record<string, string> = {}
    for (const ref of new Set([baseRef, record.ref])) {
      signal.throwIfAborted()
      const value = { ...record, ref }
      aliases[aliasPath(workspace.projectRoot, ref)] = json(value)
    }
    await ensureEnvironmentAliases(workspace, aliases, signal)
  }

  private async withLock<T>(
    key: string,
    signal: AbortSignal,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => held)
    this.locks.set(key, tail)
    try {
      await untilAbort(previous, signal)
    } catch (error) {
      release()
      if (this.locks.get(key) === tail) this.locks.delete(key)
      throw error
    }
    try {
      signal.throwIfAborted()
      return await operation()
    } finally {
      release()
      if (this.locks.get(key) === tail) this.locks.delete(key)
    }
  }
}

function environmentRecord(
  workspace: RemoteRuntimeWorkspace,
  input: ValidRemoteEnvironmentRequest,
  packages: string[],
  channels: string[]
): EnvironmentRecord {
  const envId = digest(
    JSON.stringify({
      packages: [...packages].sort(),
      channels
    })
  )
  const name = `remote-${envId.slice(0, 16)}`
  return {
    baseRef: input.environment,
    ref: `project:${name}`,
    envId,
    name,
    prefix: posix.join(workspace.runtimeRoot, 'envs', envId),
    packages,
    channels,
    added: [...input.packages]
  }
}

function throwForCreateFailure(result: CommandResult): void {
  if (result.terminationReason === 'cancelled') throw new Error('远程环境创建已取消')
  if (result.terminationReason === 'timeout') throw new Error('远程环境创建超时')
  if (result.code === 0) return
  const detail = `${result.stderr}\n${result.stdout}`.trim()
  if (/resolve host|network is unreachable|connection|repodata|timed? out|ssl/i.test(detail)) {
    throw new Error(
      '服务器无法访问 conda 软件源。请使用服务器管理员提供的 conda 镜像配置，或先在可联网机器构建环境后再迁移到服务器；Phi 没有回退到本机创建环境。'
    )
  }
  throw new Error(`服务器上的 micromamba 创建环境失败：${detail || `exit code ${result.code}`}`)
}

function aliasPath(projectRoot: string, ref: string): string {
  return posix.join('envs', 'aliases', digest(projectRoot), `${digest(ref)}.json`)
}

async function isFile(workspace: RemoteRuntimeWorkspace, path: string): Promise<boolean> {
  try {
    return (await workspace.runtimeHost.fs.stat(path)).kind === 'file'
  } catch {
    return false
  }
}

function parsedRecord(value: string): EnvironmentRecord | undefined {
  try {
    return JSON.parse(value) as EnvironmentRecord
  } catch {
    return undefined
  }
}

function remoteEnvironmentVariables(prefix: string): Record<string, string> {
  return { PATH: `${posix.join(prefix, 'bin')}:/usr/bin:/bin`, CONDA_PREFIX: prefix }
}

function notReady(ref: string): { ref: string; envId: string; message: string } {
  return { ref, envId: '', message: `远程环境 ${ref} 尚未创建；请先调用 env_request。` }
}

function uniquePackages(packages: readonly string[]): string[] {
  return [...new Set(packages)]
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function sameStringArray(left: unknown, right: unknown): left is string[] {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => typeof value === 'string' && value === right[index])
  )
}

function json(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('expected an object')
  return value as Record<string, unknown>
}

function requireText(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`)
  return value
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function optionalRequestId(params: unknown): string | undefined {
  return optionalText(requireRecord(params).requestId)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
