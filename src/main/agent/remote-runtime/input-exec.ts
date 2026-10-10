import type { Readable } from 'node:stream'

import type {
  RemoteExecResult,
  RemoteSshSession,
  RemoteStdioProcess
} from '../wrappers/remote-ssh-session'
import type { CommandResult } from '../workspace-host/types'
import type { RemoteRuntimeInputExec, RemoteRuntimeInputOptions } from './types'

interface CapturedStream {
  chunks: Buffer[]
  size: number
  kept: number
}

interface CaptureState {
  remaining: number
  stdout: CapturedStream
  stderr: CapturedStream
}

export function createRemoteRuntimeInputExec(
  connect: () => Promise<RemoteSshSession>
): RemoteRuntimeInputExec {
  return async (script, options) => {
    options.signal?.throwIfAborted()
    const session = await connect()
    try {
      options.signal?.throwIfAborted()
      if (session.openStdio) return await runStdio(session, script, options)
      if (session.execWithInput) return await runLegacyInput(session, script, options)
      throw new Error('当前 SSH 连接不支持安全 stdin 脚本')
    } finally {
      await session.close().catch(() => undefined)
    }
  }
}

async function runLegacyInput(
  session: RemoteSshSession,
  script: string,
  options: RemoteRuntimeInputOptions
): Promise<CommandResult> {
  let reason: CommandResult['terminationReason']
  const stop = (next: CommandResult['terminationReason']): void => {
    reason ??= next
    void session.close()
  }
  const abort = (): void => stop('cancelled')
  options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => stop('timeout'), options.timeoutMs)
  if (options.signal?.aborted) abort()
  try {
    const result = bounded(await session.execWithInput!('sh -s', script), options)
    return { ...result, ...(reason ? { terminationReason: reason } : {}) }
  } catch (error) {
    if (!reason) throw error
    return emptyTermination(reason)
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}

async function runStdio(
  session: RemoteSshSession,
  script: string,
  options: RemoteRuntimeInputOptions
): Promise<CommandResult> {
  const process = await session.openStdio!('sh -s')
  const capture = captureOutput(process, options.maxOutputBytes)
  let reason: CommandResult['terminationReason']
  const stop = (next: CommandResult['terminationReason']): void => {
    reason ??= next
    void process.close()
  }
  const abort = (): void => stop('cancelled')
  options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => stop('timeout'), options.timeoutMs)
  process.stdin.on('error', () => undefined)
  process.stdin.end(script)
  try {
    const closed = await process.closed
    return capturedResult(closed, capture, reason)
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}

function captureOutput(process: RemoteStdioProcess, limit: number): CaptureState {
  const state: CaptureState = {
    remaining: limit,
    stdout: { chunks: [], size: 0, kept: 0 },
    stderr: { chunks: [], size: 0, kept: 0 }
  }
  watch(process.stdout, state.stdout, state)
  watch(process.stderr, state.stderr, state)
  return state
}

function watch(stream: Readable, target: CapturedStream, state: CaptureState): void {
  stream.on('data', (value: Buffer | string) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    target.size += chunk.length
    const kept = chunk.subarray(0, Math.max(0, state.remaining))
    if (kept.length > 0) target.chunks.push(Buffer.from(kept))
    target.kept += kept.length
    state.remaining -= kept.length
  })
}

function capturedResult(
  closed: { code: number | null; signal: string | null },
  capture: CaptureState,
  terminationReason?: CommandResult['terminationReason']
): CommandResult {
  return {
    ...closed,
    stdout: Buffer.concat(capture.stdout.chunks).toString('utf8'),
    stderr: Buffer.concat(capture.stderr.chunks).toString('utf8'),
    truncated:
      capture.stdout.kept < capture.stdout.size || capture.stderr.kept < capture.stderr.size,
    stdoutTruncated: capture.stdout.kept < capture.stdout.size,
    stderrTruncated: capture.stderr.kept < capture.stderr.size,
    ...(terminationReason ? { terminationReason } : {})
  }
}

function emptyTermination(terminationReason: CommandResult['terminationReason']): CommandResult {
  return {
    stdout: '',
    stderr: '',
    code: null,
    signal: null,
    truncated: false,
    terminationReason
  }
}

function bounded(result: RemoteExecResult, options: RemoteRuntimeInputOptions): CommandResult {
  const stdout = Buffer.from(result.stdout)
  const keptStdout = stdout.subarray(0, options.maxOutputBytes)
  const stderr = Buffer.from(result.stderr)
  const keptStderr = stderr.subarray(0, Math.max(0, options.maxOutputBytes - keptStdout.length))
  return {
    code: result.code,
    signal: result.signal,
    stdout: keptStdout.toString('utf8'),
    stderr: keptStderr.toString('utf8'),
    truncated: keptStdout.length < stdout.length || keptStderr.length < stderr.length,
    stdoutTruncated: keptStdout.length < stdout.length,
    stderrTruncated: keptStderr.length < stderr.length
  }
}
