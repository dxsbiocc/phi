import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'

import type {
  RemoteExecBoundedOptions,
  RemoteExecBoundedResult,
  RemoteExecResult,
  RemoteSshSession
} from '../wrappers/remote-ssh-session'
import { shellQuote } from '../wrappers/remote-ssh-session'
import type { CommandResult, RunCommandOptions, WorkspaceHost } from './types'

const EXEC_OUTPUT_BYTES = 8 * 1024 * 1024
const INPUT_OUTPUT_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const TEXT_FILE_BYTES = 8 * 1024 * 1024

interface RemoteSessionOptions {
  onFailure?: (error: unknown) => void
  defaultTimeoutMs?: number
}

async function monitored<T>(run: () => Promise<T>, options: RemoteSessionOptions): Promise<T> {
  try {
    return await run()
  } catch (error) {
    options.onFailure?.(error)
    throw error
  }
}

function executionOptions(
  root: string,
  options: Partial<RunCommandOptions> = {},
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS
): RunCommandOptions {
  return {
    cwd: root,
    timeoutMs: options.timeoutMs ?? defaultTimeoutMs,
    maxOutputBytes: options.maxOutputBytes ?? EXEC_OUTPUT_BYTES,
    ...(options.signal ? { signal: options.signal } : {})
  }
}

function remoteResult(result: CommandResult, options: RemoteSessionOptions = {}): RemoteExecResult {
  if (result.code === null && result.signal === null) {
    options.onFailure?.(new Error('SSH connection result is unknown'))
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    signal: result.signal
  }
}

function boundedResult(
  result: CommandResult,
  options: RemoteExecBoundedOptions
): RemoteExecBoundedResult {
  const stdoutBytes = Buffer.byteLength(result.stdout)
  const stderrBytes = Buffer.byteLength(result.stderr)
  return {
    ...remoteResult(result),
    stdoutTruncated:
      result.stdoutTruncated ?? (result.truncated && stdoutBytes >= options.maxOutputBytes),
    stderrTruncated:
      result.stderrTruncated ??
      (result.truncated && stdoutBytes + stderrBytes >= options.maxOutputBytes)
  }
}

async function runShell(
  host: WorkspaceHost,
  root: string,
  command: string,
  options: Partial<RunCommandOptions> = {},
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS
): Promise<CommandResult> {
  return host.exec.run(['bash', '-c', command], executionOptions(root, options, defaultTimeoutMs))
}

async function readText(host: WorkspaceHost, path: string): Promise<string> {
  const result = await host.fs.readRange(path, { offset: 0, length: TEXT_FILE_BYTES + 1 })
  if (!result.eof) throw new Error('远程文本响应超过字节上限')
  return new TextDecoder('utf-8', { fatal: true }).decode(result.content)
}

function combinedSignal(sessionSignal: AbortSignal, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([sessionSignal, signal]) : sessionSignal
}

function throwForControlTermination(result: CommandResult): void {
  if (result.terminationReason === 'timeout') {
    throw new Error('ssh 超时；远端操作结果可能尚未确认')
  }
  if (result.terminationReason === 'cancelled') {
    throw new Error('SSH 连接已关闭；远端操作结果可能尚未确认')
  }
}

function throwForBoundedTermination(result: CommandResult): void {
  if (result.terminationReason === 'timeout') {
    throw new Error('SSH 命令超时；远端命令结果可能尚未确认')
  }
  if (result.terminationReason === 'cancelled') {
    throw new Error('SSH 调用已取消；远端命令结果可能尚未确认')
  }
}

export function createWorkspaceHostRemoteSession(
  host: WorkspaceHost,
  canonicalRoot: string,
  sessionOptions: RemoteSessionOptions = {}
): RemoteSshSession {
  const controller = new AbortController()
  return {
    async exec(command) {
      return monitored(async () => {
        const result = await runShell(
          host,
          canonicalRoot,
          command,
          { signal: controller.signal },
          sessionOptions.defaultTimeoutMs
        )
        throwForControlTermination(result)
        return remoteResult(result, sessionOptions)
      }, sessionOptions)
    },
    async execBounded(command, runOptions) {
      return monitored(async () => {
        const result = await runShell(
          host,
          canonicalRoot,
          command,
          {
            timeoutMs: runOptions.timeoutMs,
            maxOutputBytes: runOptions.maxOutputBytes,
            signal: combinedSignal(controller.signal, runOptions.signal)
          },
          sessionOptions.defaultTimeoutMs
        )
        throwForBoundedTermination(result)
        const bounded = boundedResult(result, runOptions)
        if (bounded.code === null && bounded.signal === null) {
          sessionOptions.onFailure?.(new Error('SSH connection result is unknown'))
        }
        return bounded
      }, sessionOptions)
    },
    async execWithInput(command, input) {
      return monitored(async () => {
        const stagingPath = posix.join(canonicalRoot, `.phi-workspace-host-input-${randomUUID()}`)
        await host.fs.writeAtomic(stagingPath, input)
        try {
          const result = await runShell(
            host,
            canonicalRoot,
            `${command} < ${shellQuote(stagingPath)}`,
            { signal: controller.signal, maxOutputBytes: INPUT_OUTPUT_BYTES },
            sessionOptions.defaultTimeoutMs
          )
          throwForControlTermination(result)
          return remoteResult(result, sessionOptions)
        } finally {
          await host.fs.remove(stagingPath, { force: true }).catch(() => undefined)
        }
      }, sessionOptions)
    },
    readTextFile: (path) => monitored(() => readText(host, path), sessionOptions),
    async writeTextFile(path, content) {
      await monitored(() => host.fs.writeAtomic(path, content), sessionOptions)
    },
    mkdirp: (path) => monitored(() => host.fs.mkdirp(path), sessionOptions),
    async exists(path) {
      try {
        await host.fs.stat(path)
        return true
      } catch {
        return false
      }
    },
    async uploadFile(localPath, remotePath) {
      await monitored(async () => {
        await host.fs.writeAtomic(remotePath, await readFile(localPath))
      }, sessionOptions)
    },
    async close() {
      controller.abort()
    }
  }
}
