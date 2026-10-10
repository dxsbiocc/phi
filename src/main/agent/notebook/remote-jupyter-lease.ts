import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { request } from 'node:http'

import type { RemoteConnectionConfig } from '../wrappers/remote-ssh-session'
import {
  allocateLoopbackPort,
  buildSshPortForwardArgs,
  waitForLoopbackListener,
  type SshPortForwardSpawn
} from '../workspace-host/ssh-port-forward'

interface MonitoredRemoteJupyterLease {
  closed: Promise<{ code: number | null; signal: string | null }>
  isClosed(): boolean
  started(): boolean
  cleanupConfirmed(): boolean
  localSpawnFailed(): boolean
  forwardFailureConfirmed(): boolean
  close(): Promise<void>
}

export interface RemoteJupyterLease extends MonitoredRemoteJupyterLease {
  readonly localPort: number
  readonly remotePort: number
}

export interface RemoteJupyterLeaseOptions {
  shutdownGraceMs?: number
  onLog?: (line: string) => void
}

export interface OpenRemoteJupyterLeaseOptions extends RemoteJupyterLeaseOptions {
  connection: RemoteConnectionConfig
  remotePort: number
  token: string
  cleanupMarker: string
  launchScript: string
  maxAttempts?: number
  signal?: AbortSignal
  spawnImpl?: SshPortForwardSpawn
  allocateLocalPort?: () => Promise<number>
  waitUntilReady?: (
    localPort: number,
    child: ChildProcessWithoutNullStreams,
    signal?: AbortSignal
  ) => Promise<void>
}

interface SanitizedLogSink {
  write(chunk: Buffer | string): void
  flush(): void
}

const activeLeaseChildren = new Set<ChildProcessWithoutNullStreams>()
const activeLeaseTimers = new Set<ReturnType<typeof setTimeout>>()
const MAX_LOG_LINE_LENGTH = 8_192

export class RemoteJupyterCleanupUnconfirmedError extends Error {
  constructor() {
    super('旧远程 Jupyter lease 清理尚未确认')
  }
}

process.once('exit', () => {
  for (const child of activeLeaseChildren) child.kill('SIGTERM')
})

export function remoteJupyterLeaseActivity(): { children: number; timers: number } {
  return { children: activeLeaseChildren.size, timers: activeLeaseTimers.size }
}

export async function openRemoteJupyterLease(
  options: OpenRemoteJupyterLeaseOptions
): Promise<RemoteJupyterLease> {
  const attempts = positiveInteger(options.maxAttempts ?? 3)
  const spawnImpl = options.spawnImpl ?? defaultSshSpawn
  const allocate = options.allocateLocalPort ?? allocateLoopbackPort
  const waitUntilReady = options.waitUntilReady ?? waitForLoopbackListener
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfAborted(options.signal)
    const localPort = await allocate()
    const child = spawnImpl(
      'ssh',
      buildSshPortForwardArgs(
        options.connection,
        localPort,
        options.remotePort,
        options.launchScript
      ),
      { stdio: ['pipe', 'pipe', 'pipe'] }
    )
    const lease = monitorRemoteJupyterLease(child, options.token, options.cleanupMarker, options)
    try {
      await waitUntilReady(localPort, child, options.signal)
      if (lease.isClosed()) throw new Error('远程 Jupyter SSH lease 在转发就绪前退出')
      return { ...lease, localPort, remotePort: options.remotePort }
    } catch (error) {
      await lease.close()
      const safePreLaunchFailure =
        !lease.started() && (lease.localSpawnFailed() || lease.forwardFailureConfirmed())
      if (!lease.cleanupConfirmed() && !safePreLaunchFailure) {
        throw new RemoteJupyterCleanupUnconfirmedError()
      }
      if (options.signal?.aborted) throw new Error('远程 Jupyter SSH lease 已取消')
      if (attempt === attempts) {
        throw new Error(`远程 Jupyter SSH lease 在 ${attempts} 次转发尝试后仍未就绪`, {
          cause: error
        })
      }
    }
  }
  throw new Error('远程 Jupyter SSH lease 未启动')
}

function monitorRemoteJupyterLease(
  child: ChildProcessWithoutNullStreams,
  token: string,
  cleanupMarker: string,
  options: RemoteJupyterLeaseOptions
): MonitoredRemoteJupyterLease {
  let closed = false
  let started = false
  let cleanupConfirmed = false
  let localSpawnFailed = false
  let forwardFailureConfirmed = false
  let closing: Promise<void> | undefined
  activeLeaseChildren.add(child)
  const stdoutLog = createSanitizedLogSink(token, options.onLog, (line) => {
    if (line.includes(cleanupMarker.replace('CLEANED', 'STARTED'))) started = true
    if (line.includes(cleanupMarker)) cleanupConfirmed = true
  })
  const stderrLog = createSanitizedLogSink(token, options.onLog, (line) => {
    if (/Could not request local forwarding/i.test(line)) forwardFailureConfirmed = true
  })
  const done = observeLeaseChild(child, stdoutLog, stderrLog, {
    onError: () => (localSpawnFailed = true),
    onClose: () => (closed = true)
  })
  child.stdin.write(`${token}\n`)
  return {
    closed: done,
    isClosed: () => closed,
    started: () => started,
    cleanupConfirmed: () => cleanupConfirmed,
    localSpawnFailed: () => localSpawnFailed,
    forwardFailureConfirmed: () => forwardFailureConfirmed,
    close() {
      closing ??= closeRemoteJupyterLease(child, done, () => closed, options.shutdownGraceMs ?? 500)
      return closing
    }
  }
}

function observeLeaseChild(
  child: ChildProcessWithoutNullStreams,
  stdoutLog: SanitizedLogSink,
  stderrLog: SanitizedLogSink,
  events: { onError(): void; onClose(): void }
): Promise<{ code: number | null; signal: string | null }> {
  child.stdout.on('data', stdoutLog.write)
  child.stderr.on('data', stderrLog.write)
  child.stdin.on('error', () => undefined)
  return new Promise((resolve) => {
    let finished = false
    const finish = (code: number | null, signal: string | null): void => {
      if (finished) return
      finished = true
      stdoutLog.flush()
      stderrLog.flush()
      activeLeaseChildren.delete(child)
      events.onClose()
      resolve({ code, signal })
    }
    child.once('error', () => {
      events.onError()
      finish(null, null)
    })
    child.once('close', finish)
  })
}

function createSanitizedLogSink(
  token: string,
  onLog?: (line: string) => void,
  onLine?: (line: string) => void
): SanitizedLogSink {
  let pending = ''
  let dropping = false
  const emit = (line: string): void => {
    if (line.length > MAX_LOG_LINE_LENGTH) return
    onLine?.(line)
    try {
      onLog?.(sanitizeRemoteJupyterText(line, token))
    } catch {
      // Logging observers must not interrupt lease cleanup.
    }
  }
  const write = (chunk: Buffer | string): void => {
    let text = String(chunk)
    if (dropping) {
      const newline = text.indexOf('\n')
      if (newline < 0) return
      dropping = false
      text = text.slice(newline + 1)
    }
    pending += text
    for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
      emit(pending.slice(0, newline))
      pending = pending.slice(newline + 1)
    }
    if (pending.length > MAX_LOG_LINE_LENGTH) {
      pending = ''
      dropping = true
    }
  }
  const flush = (): void => {
    if (!dropping && pending) emit(pending)
    pending = ''
  }
  return { write, flush }
}

async function closeRemoteJupyterLease(
  child: ChildProcessWithoutNullStreams,
  closed: Promise<unknown>,
  isClosed: () => boolean,
  graceMs: number
): Promise<void> {
  if (isClosed()) return
  child.stdin.end()
  if (await settlesWithin(closed, graceMs + 300)) return
  child.kill('SIGTERM')
  if (await settlesWithin(closed, graceMs)) return
  child.kill('SIGKILL')
  await closed
}

export function defaultRemoteJupyterReadyProbe(
  url: string,
  authorization: string,
  signal?: AbortSignal
): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = request(
      new URL('/api/status', url),
      { headers: { Authorization: authorization }, signal },
      (response) => {
        response.resume()
        resolve(response.statusCode === 200)
      }
    )
    probe.setTimeout(500, () => {
      probe.destroy()
      resolve(false)
    })
    probe.on('error', () => resolve(false))
    probe.end()
  })
}

export function pauseForRemoteJupyter(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      activeLeaseTimers.delete(timer)
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    const abort = (): void => {
      clearTimeout(timer)
      activeLeaseTimers.delete(timer)
      signal?.removeEventListener('abort', abort)
      reject(new Error('远程 Jupyter 操作已取消'))
    }
    const timer = setTimeout(finish, ms)
    activeLeaseTimers.add(timer)
    timer.unref()
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export function sanitizeRemoteJupyterText(text: string, token?: string): string {
  let sanitized = token ? text.split(token).join('<redacted>') : text
  sanitized = sanitized.replace(/([?&]token=)[^\s&'"\n]+/gi, '$1<redacted>')
  return sanitized.slice(0, 2_000)
}

export function sanitizedRemoteJupyterError(error: unknown, token?: string): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(sanitizeRemoteJupyterText(message, token))
}

export const defaultSshSpawn: SshPortForwardSpawn = (binary, args, options) =>
  spawn(binary, args, options)

function positiveInteger(value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error('SSH 转发重试次数必须是正整数')
  return value
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('远程 Jupyter SSH lease 已取消')
}

function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, ms))
      activeLeaseTimers.add(timer)
      timer.unref()
    })
  ]).finally(() => {
    clearTimeout(timer)
    activeLeaseTimers.delete(timer)
  })
}
