import {
  withAuthorizedRemoteWorkspacePath,
  type RemoteWorkspaceBoundaryDependencies
} from './remote-workspace-boundary'
import { shellQuote, type RemoteSshSession } from './wrappers/remote-ssh-session'

export const REMOTE_BASH_MAX_OUTPUT_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_SECONDS = 30
const MAX_TIMEOUT_SECONDS = 120

export interface RemoteBashRequest {
  sessionId: string
  projectId: string
  requestId: string
  toolCallId: string
  command: string
  timeout?: number
  cwd?: string
  env?: Record<string, string>
  pty?: boolean
  async?: boolean
}

export type RemoteBashResult =
  | {
      status: 'completed'
      hostAlias: string
      cwd: string
      exitCode: number
      stdout: string
      stderr: string
      stdoutTruncated: boolean
      stderrTruncated: boolean
      wallTimeMs: number
    }
  | {
      status: 'unknown'
      reason: 'cancelled' | 'timeout' | 'connection_lost'
      message: string
      wallTimeMs: number
    }

export interface RemoteBashManagerDependencies extends RemoteWorkspaceBoundaryDependencies {
  beforeRun?: (request: RemoteBashRequest) => void
  now?: () => number
  releaseHostSession?: (sessionId: string) => void
  releaseAllHosts?: () => void
}

function validRequest(value: unknown): RemoteBashRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('远程命令请求无效')
  }
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).some(
      (key) =>
        ![
          'sessionId',
          'projectId',
          'requestId',
          'toolCallId',
          'command',
          'timeout',
          'cwd',
          'env',
          'pty',
          'async'
        ].includes(key)
    ) ||
    typeof record.sessionId !== 'string' ||
    !record.sessionId ||
    typeof record.projectId !== 'string' ||
    !record.projectId ||
    typeof record.requestId !== 'string' ||
    !record.requestId ||
    typeof record.toolCallId !== 'string' ||
    !record.toolCallId ||
    typeof record.command !== 'string' ||
    !record.command.trim() ||
    Buffer.byteLength(record.command, 'utf-8') > 64 * 1024 ||
    record.command.includes('\0') ||
    (record.cwd !== undefined && typeof record.cwd !== 'string') ||
    (record.pty !== undefined && typeof record.pty !== 'boolean') ||
    (record.async !== undefined && typeof record.async !== 'boolean') ||
    (record.timeout !== undefined &&
      (typeof record.timeout !== 'number' ||
        !Number.isFinite(record.timeout) ||
        record.timeout < 1 ||
        record.timeout > MAX_TIMEOUT_SECONDS))
  ) {
    throw new Error('远程命令参数无效')
  }
  if (record.pty === true || record.async === true) {
    throw new Error('远程 bash 暂不支持 PTY 或后台运行；长时任务请使用 Wrapper')
  }
  const env = record.env
  if (env !== undefined) {
    if (typeof env !== 'object' || env === null || Array.isArray(env)) {
      throw new Error('远程环境变量无效')
    }
    const entries = Object.entries(env)
    if (
      entries.length > 32 ||
      entries.some(
        ([key, item]) =>
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== 'string' || item.includes('\0')
      ) ||
      Buffer.byteLength(JSON.stringify(env), 'utf-8') > 8192
    ) {
      throw new Error('远程环境变量无效')
    }
  }
  return record as unknown as RemoteBashRequest
}

/** Login profile first, then pin the physical project root before the user command. */
export function buildRemoteBashCommand(
  remoteRoot: string,
  canonicalRoot: string,
  command: string,
  env: Record<string, string> = {}
): string {
  const body = [
    `cd -P -- ${shellQuote(remoteRoot)} || exit 72`,
    `[ "$PWD" = ${shellQuote(canonicalRoot)} ] || exit 72`,
    ...Object.entries(env).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
    command
  ].join('\n')
  return `bash -lc ${shellQuote(body)}`
}

function unknownResult(
  reason: 'cancelled' | 'timeout' | 'connection_lost',
  wallTimeMs: number
): RemoteBashResult {
  const message =
    reason === 'cancelled'
      ? '已停止本地 SSH 调用；远端命令可能仍在运行，结果未知。请在服务器核对后再重试。'
      : reason === 'timeout'
        ? 'SSH 等待已超时；远端命令可能仍在运行，结果未知。请在服务器核对后再重试。'
        : 'SSH 连接中断；远端命令结果未知。请在服务器核对后再重试。'
  return { status: 'unknown', reason, message, wallTimeMs }
}

type ActiveRun = {
  sessionId: string
  projectId: string
  controller: AbortController
  session?: RemoteSshSession
  cancelled: boolean
}

export class RemoteWorkspaceBashManager {
  private readonly active = new Map<string, ActiveRun>()

  constructor(private readonly dependencies: RemoteBashManagerDependencies = {}) {}

  private stopLocalSsh(entry: ActiveRun): void {
    entry.cancelled = true
    entry.controller.abort()
    if (entry.session) void entry.session.close()
  }

  async run(input: unknown): Promise<RemoteBashResult> {
    const request = validRequest(input)
    if (this.active.has(request.requestId)) throw new Error('远程命令请求 ID 已在运行')
    this.dependencies.beforeRun?.(request)
    const entry: ActiveRun = {
      sessionId: request.sessionId,
      projectId: request.projectId,
      controller: new AbortController(),
      cancelled: false
    }
    this.active.set(request.requestId, entry)
    const now = this.dependencies.now ?? Date.now
    const startedAt = now()
    try {
      return await withAuthorizedRemoteWorkspacePath(
        {
          sessionId: request.sessionId,
          projectId: request.projectId,
          path: '.',
          mode: 'existing'
        },
        async (authorized, session) => {
          entry.session = session
          if (
            request.cwd !== undefined &&
            request.cwd !== '.' &&
            request.cwd !== authorized.remoteRoot &&
            request.cwd !== authorized.canonicalRoot
          ) {
            throw new Error('远程 bash 的 cwd 固定为项目根目录')
          }
          if (entry.cancelled) return unknownResult('cancelled', now() - startedAt)
          if (!session.execBounded) throw new Error('当前 SSH 连接不支持有界远程命令')
          const command = buildRemoteBashCommand(
            authorized.remoteRoot,
            authorized.canonicalRoot,
            request.command,
            request.env
          )
          try {
            const result = await session.execBounded(command, {
              timeoutMs: Math.round((request.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000),
              maxOutputBytes: REMOTE_BASH_MAX_OUTPUT_BYTES,
              signal: entry.controller.signal
            })
            if (entry.cancelled) return unknownResult('cancelled', now() - startedAt)
            if (result.code === null) return unknownResult('connection_lost', now() - startedAt)
            return {
              status: 'completed',
              hostAlias: authorized.hostAlias,
              cwd: authorized.canonicalRoot,
              exitCode: result.code,
              stdout: result.stdout,
              stderr: result.stderr,
              stdoutTruncated: result.stdoutTruncated,
              stderrTruncated: result.stderrTruncated,
              wallTimeMs: now() - startedAt
            }
          } catch (error) {
            if (entry.cancelled) return unknownResult('cancelled', now() - startedAt)
            const message = error instanceof Error ? error.message : String(error)
            return unknownResult(
              /超时|timed out/i.test(message) ? 'timeout' : 'connection_lost',
              now() - startedAt
            )
          }
        },
        {
          ...this.dependencies,
          onConnected: (session) => {
            entry.session = session
            this.dependencies.onConnected?.(session)
            if (entry.cancelled) void session.close()
          }
        }
      )
    } catch (error) {
      if (entry.cancelled) return unknownResult('cancelled', now() - startedAt)
      throw error
    } finally {
      this.active.delete(request.requestId)
    }
  }

  cancel(input: unknown): boolean {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new Error('远程命令取消请求无效')
    }
    const record = input as Record<string, unknown>
    if (
      Object.keys(record).some((key) => !['sessionId', 'projectId', 'requestId'].includes(key)) ||
      typeof record.sessionId !== 'string' ||
      typeof record.projectId !== 'string' ||
      typeof record.requestId !== 'string'
    ) {
      throw new Error('远程命令取消请求无效')
    }
    const entry = this.active.get(record.requestId)
    if (!entry) return false
    if (entry.sessionId !== record.sessionId || entry.projectId !== record.projectId) {
      throw new Error('远程命令取消请求归属不匹配')
    }
    this.stopLocalSsh(entry)
    return true
  }

  cancelSession(sessionId: string): void {
    for (const entry of this.active.values()) {
      if (entry.sessionId === sessionId) this.stopLocalSsh(entry)
    }
    this.dependencies.releaseHostSession?.(sessionId)
  }

  cancelAll(): void {
    for (const entry of this.active.values()) this.stopLocalSsh(entry)
    this.dependencies.releaseAllHosts?.()
  }
}
