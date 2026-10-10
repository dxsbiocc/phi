import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, connect as connectSocket } from 'node:net'

import {
  SSH_OPTIONS,
  validateHostAlias,
  validateRemoteConnectionOverrides,
  type RemoteConnectionConfig
} from '../wrappers/remote-ssh-session'

export type SshPortForwardSpawn = (
  binary: string,
  args: string[],
  options: { stdio: ['pipe', 'pipe', 'pipe'] }
) => ChildProcessWithoutNullStreams

export interface SshPortForwardLease {
  readonly localPort: number
  readonly remotePort: number
  readonly closed: Promise<{ code: number | null; signal: string | null }>
  close(): Promise<void>
}

export interface OpenSshPortForwardOptions {
  connection: RemoteConnectionConfig
  remotePort: number
  maxAttempts?: number
  signal?: AbortSignal
  spawnImpl?: SshPortForwardSpawn
  allocateLocalPort?: () => Promise<number>
  waitUntilReady?: (
    localPort: number,
    child: ChildProcessWithoutNullStreams,
    signal?: AbortSignal
  ) => Promise<void>
  shutdownGraceMs?: number
}

interface ChildMonitor {
  child: ChildProcessWithoutNullStreams
  closed: Promise<{ code: number | null; signal: string | null }>
  isClosed(): boolean
}

const activeForwardChildren = new Set<ChildProcessWithoutNullStreams>()
const activeForwardTimers = new Set<ReturnType<typeof setTimeout>>()

process.once('exit', () => {
  for (const child of activeForwardChildren) child.kill('SIGTERM')
})

export function sshPortForwardActivity(): { children: number; timers: number } {
  return { children: activeForwardChildren.size, timers: activeForwardTimers.size }
}

export function buildSshConnectionArgs(config: RemoteConnectionConfig): string[] {
  const checked = validateRemoteConnectionOverrides(config)
  return [
    ...(checked.user ? ['-l', checked.user] : []),
    ...(checked.port !== undefined ? ['-p', String(checked.port)] : []),
    ...(checked.identityFile ? ['-i', checked.identityFile, '-o', 'IdentitiesOnly=yes'] : [])
  ]
}

function forwardingSafeOptions(): string[] {
  const options: string[] = []
  for (let index = 0; index < SSH_OPTIONS.length; index += 2) {
    const option = SSH_OPTIONS[index + 1]
    if (option !== 'ClearAllForwardings=yes') options.push(SSH_OPTIONS[index], option)
  }
  return [...options, '-o', 'ClearAllForwardings=no', '-o', 'ExitOnForwardFailure=yes']
}

export function buildSshPortForwardArgs(
  config: RemoteConnectionConfig,
  localPort: number,
  remotePort: number,
  remoteCommand?: string
): string[] {
  assertPort(localPort)
  assertPort(remotePort)
  return [
    ...(remoteCommand ? [] : ['-N']),
    '-T',
    ...buildSshConnectionArgs(config),
    ...forwardingSafeOptions(),
    '-L',
    `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    validateHostAlias(config.host),
    ...(remoteCommand ? [remoteCommand] : [])
  ]
}

export async function allocateLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve)
  })
  const address = server.address()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  if (!address || typeof address === 'string') throw new Error('无法分配本机随机端口')
  return address.port
}

export async function openSshPortForward(
  options: OpenSshPortForwardOptions
): Promise<SshPortForwardLease> {
  const attempts = positiveInteger(options.maxAttempts ?? 3, 'SSH 隧道重试次数')
  const spawnImpl = options.spawnImpl ?? defaultSpawn
  const allocate = options.allocateLocalPort ?? allocateLoopbackPort
  const waitUntilReady = options.waitUntilReady ?? waitForLoopbackListener
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfAborted(options.signal)
    const localPort = await allocate()
    const monitor = monitorChild(
      spawnImpl('ssh', buildSshPortForwardArgs(options.connection, localPort, options.remotePort), {
        stdio: ['pipe', 'pipe', 'pipe']
      })
    )
    monitor.child.stdin.end()
    try {
      await waitUntilReady(localPort, monitor.child, options.signal)
      if (monitor.isClosed()) throw new Error('SSH 隧道在监听就绪前退出')
      return createLease(monitor, localPort, options.remotePort, options.shutdownGraceMs ?? 500)
    } catch (error) {
      await stopChild(monitor, options.shutdownGraceMs ?? 500)
      if (options.signal?.aborted) throw abortError()
      if (attempt === attempts) {
        throw new Error(`SSH 端口转发在 ${attempts} 次尝试后仍未就绪`, { cause: error })
      }
    }
  }
  throw new Error('SSH 端口转发未启动')
}

function createLease(
  monitor: ChildMonitor,
  localPort: number,
  remotePort: number,
  graceMs: number
): SshPortForwardLease {
  let closing: Promise<void> | undefined
  return {
    localPort,
    remotePort,
    closed: monitor.closed,
    close() {
      closing ??= stopChild(monitor, graceMs)
      return closing
    }
  }
}

function monitorChild(child: ChildProcessWithoutNullStreams): ChildMonitor {
  let closed = false
  activeForwardChildren.add(child)
  child.stdout.resume()
  child.stderr.resume()
  const done = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    const finish = (code: number | null, signal: string | null): void => {
      if (closed) return
      closed = true
      activeForwardChildren.delete(child)
      resolve({ code, signal })
    }
    child.once('error', () => finish(null, null))
    child.once('close', finish)
  })
  return { child, closed: done, isClosed: () => closed }
}

async function stopChild(monitor: ChildMonitor, graceMs: number): Promise<void> {
  if (monitor.isClosed()) return
  monitor.child.kill('SIGTERM')
  if (await settlesWithin(monitor.closed, graceMs)) return
  monitor.child.kill('SIGKILL')
  await monitor.closed
}

export async function waitForLoopbackListener(
  port: number,
  child: ChildProcessWithoutNullStreams,
  signal?: AbortSignal
): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('SSH 隧道提前退出')
    if (await canConnect(port)) return
    await pause(25, signal)
  }
  throw new Error('SSH 隧道未在本机回环地址监听')
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connectSocket({ host: '127.0.0.1', port })
    const finish = (ready: boolean): void => {
      socket.destroy()
      resolve(ready)
    }
    socket.setTimeout(100, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      activeForwardTimers.delete(timer)
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    const abort = (): void => {
      clearTimeout(timer)
      activeForwardTimers.delete(timer)
      signal?.removeEventListener('abort', abort)
      reject(abortError())
    }
    const timer = setTimeout(finish, ms)
    activeForwardTimers.add(timer)
    signal?.addEventListener('abort', abort, { once: true })
    timer.unref()
  })
}

function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, ms))
      activeForwardTimers.add(timer)
      timer.unref()
    })
  ]).finally(() => {
    clearTimeout(timer)
    activeForwardTimers.delete(timer)
  })
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 转发端口无效')
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label}必须是正整数`)
  return value
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function abortError(): Error {
  return new Error('SSH 端口转发已取消')
}

function defaultSpawn(
  binary: string,
  args: string[],
  options: { stdio: ['pipe', 'pipe', 'pipe'] }
): ChildProcessWithoutNullStreams {
  return spawn(binary, args, options)
}
