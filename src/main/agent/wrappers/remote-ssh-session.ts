import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { diagnoseSshConnectionFailure, RemoteSshConnectionError } from './remote-ssh-diagnostics'
import type { RemoteFileChunk, RemoteFileChunkOptions } from './remote-ssh-log'

/** OpenSSH host alias resolved by the user's SSH configuration. Never persist credentials here. */
export interface RemoteConnectionConfig {
  host: string
  user?: string
  port?: number
  identityFile?: string
  readyTimeoutMs?: number
  execTimeoutMs?: number
}

export interface RemoteExecResult {
  stdout: string
  stderr: string
  code: number | null
  signal: string | null
}

export interface RemoteExecBoundedResult extends RemoteExecResult {
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

export interface RemoteExecBoundedOptions {
  timeoutMs: number
  maxOutputBytes: number
  signal?: AbortSignal
}

/** The POSIX remote operations used by detached and Slurm wrapper runners. */
export interface RemoteSshSession {
  exec(command: string): Promise<RemoteExecResult>
  /** Optional transport-native page reader; the shared SSH log reader has a bounded exec fallback. */
  readFileChunk?: (path: string, options: RemoteFileChunkOptions) => Promise<RemoteFileChunk>
  execWithInput?: (command: string, input: string) => Promise<RemoteExecResult>
  execBounded?: (
    command: string,
    options: RemoteExecBoundedOptions
  ) => Promise<RemoteExecBoundedResult>
  readTextFile(remotePath: string): Promise<string>
  writeTextFile(remotePath: string, content: string): Promise<void>
  mkdirp(remotePath: string): Promise<void>
  exists(remotePath: string): Promise<boolean>
  uploadFile(localPath: string, remotePath: string): Promise<void>
  close(): Promise<void>
}

type SpawnImpl = (
  binary: string,
  args: string[],
  options: { stdio: ['pipe', 'pipe', 'pipe'] }
) => ChildProcessWithoutNullStreams

export interface OpenSshRuntime {
  spawnImpl?: SpawnImpl
  tempRoot?: string
}

const DEFAULT_READY_TIMEOUT_MS = 15_000
const DEFAULT_EXEC_TIMEOUT_MS = 30_000
const MAX_EXEC_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_CONTROL_OUTPUT_BYTES = 64 * 1024
const activeMasters = new Set<ChildProcessWithoutNullStreams>()

process.once('exit', () => {
  for (const master of activeMasters) master.kill('SIGTERM')
})

const SSH_OPTIONS = [
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=yes',
  '-o',
  'ForwardAgent=no',
  '-o',
  'ClearAllForwardings=yes',
  '-o',
  'ServerAliveInterval=10',
  '-o',
  'ServerAliveCountMax=3'
] as const

/** A host alias is one argv element, never a shell fragment or an SSH option. */
export function validateHostAlias(host: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(host)) {
    throw new Error('SSH 主机别名只能包含字母、数字、点、下划线、@ 和连字符，且不能以选项开头')
  }
  return host
}

export function validateRemoteConnectionOverrides(
  config: Pick<RemoteConnectionConfig, 'user' | 'port' | 'identityFile'>
): Pick<RemoteConnectionConfig, 'user' | 'port' | 'identityFile'> {
  const user = config.user?.trim()
  if (user && !/^[A-Za-z0-9_][A-Za-z0-9._@-]{0,127}$/.test(user)) {
    throw new Error('SSH 用户名无效')
  }
  if (
    config.port !== undefined &&
    (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
  ) {
    throw new Error('SSH 端口必须为 1–65535 的整数')
  }
  const identityInput = config.identityFile?.trim()
  const identityFile = identityInput?.startsWith('~/')
    ? join(homedir(), identityInput.slice(2))
    : identityInput
  if (identityFile && (!isAbsolute(identityFile) || /[\r\n\0]/.test(identityFile))) {
    throw new Error('SSH 私钥路径必须是本机绝对路径')
  }
  return {
    ...(user ? { user } : {}),
    ...(config.port !== undefined ? { port: config.port } : {}),
    ...(identityFile ? { identityFile } : {})
  }
}

function connectionArgs(
  config: Pick<RemoteConnectionConfig, 'user' | 'port' | 'identityFile'>,
  transport: 'ssh' | 'sftp'
): string[] {
  const checked = validateRemoteConnectionOverrides(config)
  return [
    ...(checked.user
      ? transport === 'ssh'
        ? ['-l', checked.user]
        : ['-o', `User=${checked.user}`]
      : []),
    ...(checked.port !== undefined
      ? [transport === 'ssh' ? '-p' : '-P', String(checked.port)]
      : []),
    ...(checked.identityFile ? ['-i', checked.identityFile, '-o', 'IdentitiesOnly=yes'] : [])
  ]
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function buildMkdirpCommand(remotePath: string): string {
  return `mkdir -p ${shellQuote(remotePath)}`
}

export function buildExistsCommand(remotePath: string): string {
  return `test -e ${shellQuote(remotePath)}`
}

export function buildReadTextFileCommand(remotePath: string): string {
  return `cat ${shellQuote(remotePath)}`
}

export interface WriteTextFileCommand {
  script: string
  needsTruncate: boolean
}

export function buildWriteTextFileCommand(
  remotePath: string,
  content: string
): WriteTextFileCommand {
  if (content.includes('\0')) throw new Error('远程文本文件不能包含 NUL 字节')
  let heredocMarker = '__PHI_EOF__'
  while (content.includes(heredocMarker)) {
    heredocMarker = `${heredocMarker}_${Math.random().toString(36).slice(2, 8)}`
  }
  const endsWithNewline = content.endsWith('\n')
  const body = endsWithNewline ? content : `${content}\n`
  return {
    script: `cat > ${shellQuote(remotePath)} <<'${heredocMarker}'\n${body}${heredocMarker}\n`,
    needsTruncate: !endsWithNewline
  }
}

export function buildTruncateLastByteCommand(remotePath: string): string {
  return `truncate -s -1 ${shellQuote(remotePath)}`
}

export function buildMasterArgs(
  host: string,
  controlPath: string,
  config: RemoteConnectionConfig = { host }
): string[] {
  return [
    '-T',
    '-M',
    '-N',
    '-S',
    controlPath,
    '-o',
    'ControlPersist=no',
    '-o',
    'ConnectTimeout=15',
    ...connectionArgs(config, 'ssh'),
    ...SSH_OPTIONS,
    validateHostAlias(host)
  ]
}

export function buildExecArgs(
  host: string,
  controlPath: string,
  command: string,
  config: RemoteConnectionConfig = { host }
): string[] {
  return [
    '-T',
    '-S',
    controlPath,
    ...connectionArgs(config, 'ssh'),
    ...SSH_OPTIONS,
    validateHostAlias(host),
    command
  ]
}

export function buildSftpArgs(
  host: string,
  controlPath: string,
  config: RemoteConnectionConfig = { host }
): string[] {
  return [
    '-q',
    '-b',
    '-',
    '-o',
    `ControlPath=${controlPath}`,
    ...connectionArgs(config, 'sftp'),
    ...SSH_OPTIONS,
    validateHostAlias(host)
  ]
}

export function buildControlArgs(
  host: string,
  controlPath: string,
  action: 'check' | 'exit',
  config: RemoteConnectionConfig = { host }
): string[] {
  return [
    '-S',
    controlPath,
    '-O',
    action,
    ...connectionArgs(config, 'ssh'),
    ...SSH_OPTIONS,
    validateHostAlias(host)
  ]
}

function connectionFailureFromResult(
  stderr: string,
  code: number | null
): RemoteSshConnectionError | null {
  if (code !== 255) return null
  return new RemoteSshConnectionError(diagnoseSshConnectionFailure(stderr))
}

/** SFTP batch paths are quoted separately from the remote POSIX shell. */
export function quoteSftpPath(value: string): string {
  if (!value || /[\r\n\0]/.test(value)) throw new Error('SFTP 路径不能为空或包含换行/NUL')
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function runProcess(
  spawnImpl: SpawnImpl,
  binary: string,
  args: string[],
  timeoutMs: number,
  maxBytes: number,
  input?: string,
  signal?: AbortSignal
): Promise<RemoteExecResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnImpl(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }

    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let totalBytes = 0
    let failure: Error | undefined
    let finished = false
    let force: ReturnType<typeof setTimeout> | undefined
    const fail = (error: Error): void => {
      failure ??= error
      child.kill('SIGTERM')
      force ??= setTimeout(() => {
        if (!finished) child.kill('SIGKILL')
      }, 2_000)
      force.unref()
    }
    const onAbort = (): void => {
      fail(new Error('SSH 连接已关闭；远端操作结果可能尚未确认'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    const timer = setTimeout(() => {
      fail(new Error(`${binary} 超时；远端操作结果可能尚未确认`))
    }, timeoutMs)

    const collect = (target: Buffer[], chunk: Buffer): void => {
      totalBytes += chunk.byteLength
      if (totalBytes > maxBytes) {
        fail(new Error(`${binary} 输出超过 ${maxBytes} 字节；远端操作结果可能尚未确认`))
        return
      }
      target.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk))
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk))
    child.once('error', (error) => {
      failure ??= error
    })
    child.once('close', (code, exitSignal) => {
      finished = true
      clearTimeout(timer)
      if (force) clearTimeout(force)
      signal?.removeEventListener('abort', onAbort)
      if (failure) {
        reject(failure)
        return
      }
      resolve({
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: Buffer.concat(stderr).toString('utf-8'),
        code,
        signal: exitSignal
      })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}

/** Keep draining both pipes after the inline budget fills, so output size does not kill a command. */
function runProcessBounded(
  spawnImpl: SpawnImpl,
  args: string[],
  options: RemoteExecBoundedOptions
): Promise<RemoteExecBoundedResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnImpl('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let captured = 0
    let stdoutTruncated = false
    let stderrTruncated = false
    let failure: Error | undefined
    let finished = false
    let force: ReturnType<typeof setTimeout> | undefined
    const fail = (error: Error): void => {
      failure ??= error
      child.kill('SIGTERM')
      force ??= setTimeout(() => {
        if (!finished) child.kill('SIGKILL')
      }, 2_000)
      force.unref()
    }
    const onAbort = (): void => fail(new Error('SSH 调用已取消；远端命令结果可能尚未确认'))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    const timer = setTimeout(
      () => fail(new Error('SSH 命令超时；远端命令结果可能尚未确认')),
      options.timeoutMs
    )
    const collect = (target: Buffer[], chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      const remaining = Math.max(0, options.maxOutputBytes - captured)
      const kept = Math.min(chunk.byteLength, remaining)
      if (kept > 0) target.push(chunk.subarray(0, kept))
      captured += kept
      if (kept < chunk.byteLength) {
        if (stream === 'stdout') stdoutTruncated = true
        else stderrTruncated = true
      }
    }
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk, 'stdout'))
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk, 'stderr'))
    child.once('error', (error) => {
      failure ??= error
    })
    child.once('close', (code, exitSignal) => {
      finished = true
      clearTimeout(timer)
      if (force) clearTimeout(force)
      options.signal?.removeEventListener('abort', onAbort)
      if (failure) {
        reject(failure)
        return
      }
      resolve({
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: Buffer.concat(stderr).toString('utf-8'),
        stdoutTruncated,
        stderrTruncated,
        code,
        signal: exitSignal
      })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end()
  })
}

/**
 * Reuses a private OpenSSH master for command and SFTP channels. Adapted from
 * deepseek-harness packages/ssh/ssh/src/index.ts at
 * 00102833dfaee1da9f48a3a8eae9d34005a75218 (MIT, Copyright 2026 DeepSeek).
 * The remote helper/RPC lifetime is intentionally absent: Phi's detached and
 * scheduler-submitted runs continue after this connection closes.
 */
export async function connectRemoteSshSession(
  config: RemoteConnectionConfig,
  runtime: OpenSshRuntime = {}
): Promise<RemoteSshSession> {
  const host = validateHostAlias(config.host)
  const spawnImpl: SpawnImpl =
    runtime.spawnImpl ?? ((binary, args, options) => spawn(binary, args, options))
  const dir = await mkdtemp(join(runtime.tempRoot ?? '/tmp', 'phi-ssh-'))
  await chmod(dir, 0o700)
  const controlPath = join(dir, 'master')
  const operations = new AbortController()
  let master: ChildProcessWithoutNullStreams
  try {
    master = spawnImpl('ssh', buildMasterArgs(host, controlPath, config), {
      stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    const diagnosis = diagnoseSshConnectionFailure(error)
    if (diagnosis.code === 'ssh_missing') throw new RemoteSshConnectionError(diagnosis)
    throw error
  }
  master.stdin.on('error', () => undefined)
  master.stdin.end()
  master.stdout.resume()
  activeMasters.add(master)
  let masterClosed = false
  let masterError = ''
  let masterFailure: Error | undefined
  master.stderr.on('data', (chunk: Buffer) => {
    masterError = (masterError + chunk.toString('utf-8')).slice(-2_000)
  })
  master.once('error', (error) => {
    masterFailure = error
    masterError = error.message
  })
  master.once('close', () => {
    masterClosed = true
    activeMasters.delete(master)
    operations.abort()
  })

  const execTimeout = config.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS
  let closed = false
  let closing: Promise<void> | undefined
  const checkOpen = (): void => {
    if (closed || masterClosed) throw new Error('SSH 连接已关闭；远端操作结果可能尚未确认')
  }
  const call = async (command: string): Promise<RemoteExecResult> => {
    checkOpen()
    let result: RemoteExecResult
    try {
      result = await runProcess(
        spawnImpl,
        'ssh',
        buildExecArgs(host, controlPath, command, config),
        execTimeout,
        MAX_EXEC_OUTPUT_BYTES,
        undefined,
        operations.signal
      )
    } catch (error) {
      const diagnosis = diagnoseSshConnectionFailure(error)
      if (diagnosis.code === 'ssh_missing') throw new RemoteSshConnectionError(diagnosis)
      throw error
    }
    const failure = connectionFailureFromResult(result.stderr, result.code)
    if (failure) throw failure
    return result
  }
  const close = (): Promise<void> => {
    closing ??= (async () => {
      closed = true
      operations.abort()
      if (!masterClosed) {
        await runProcess(
          spawnImpl,
          'ssh',
          buildControlArgs(host, controlPath, 'exit', config),
          2_000,
          MAX_CONTROL_OUTPUT_BYTES
        ).catch(() => undefined)
        if (!masterClosed) {
          const stopped = new Promise<void>((resolve) => master.once('close', () => resolve()))
          master.kill('SIGTERM')
          await Promise.race([stopped, delay(2_000)])
          if (!masterClosed) master.kill('SIGKILL')
        }
      }
      await rm(dir, { recursive: true, force: true })
    })()
    return closing
  }

  try {
    const deadline = Date.now() + (config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS)
    let ready = false
    while (Date.now() < deadline && !masterClosed) {
      const check = await runProcess(
        spawnImpl,
        'ssh',
        buildControlArgs(host, controlPath, 'check', config),
        Math.min(2_000, Math.max(1, deadline - Date.now())),
        MAX_CONTROL_OUTPUT_BYTES
      ).catch(() => null)
      if (check?.code === 0) {
        ready = true
        break
      }
      await delay(100)
    }
    if (!ready) {
      const diagnosis = diagnoseSshConnectionFailure(
        masterFailure ?? (masterError || (masterClosed ? '' : 'timed out'))
      )
      throw new RemoteSshConnectionError(diagnosis)
    }

    return {
      exec: call,
      async execWithInput(command, input) {
        checkOpen()
        const result = await runProcess(
          spawnImpl,
          'ssh',
          buildExecArgs(host, controlPath, command, config),
          execTimeout,
          MAX_CONTROL_OUTPUT_BYTES,
          input,
          operations.signal
        )
        const failure = connectionFailureFromResult(result.stderr, result.code)
        if (failure) throw failure
        return result
      },
      async execBounded(command, options) {
        checkOpen()
        const signal = options.signal
          ? AbortSignal.any([operations.signal, options.signal])
          : operations.signal
        let result: RemoteExecBoundedResult
        try {
          result = await runProcessBounded(
            spawnImpl,
            buildExecArgs(host, controlPath, command, config),
            {
              ...options,
              signal
            }
          )
        } catch (error) {
          const diagnosis = diagnoseSshConnectionFailure(error)
          if (diagnosis.code === 'ssh_missing') throw new RemoteSshConnectionError(diagnosis)
          throw error
        }
        const failure = connectionFailureFromResult(result.stderr, result.code)
        if (failure) throw failure
        return result
      },
      async readTextFile(remotePath) {
        const result = await call(buildReadTextFileCommand(remotePath))
        if (result.code !== 0) throw new Error(`远程读取文件失败: ${remotePath}\n${result.stderr}`)
        return result.stdout
      },
      async writeTextFile(remotePath, content) {
        const { script, needsTruncate } = buildWriteTextFileCommand(remotePath, content)
        const result = await call(script)
        if (result.code !== 0) throw new Error(`远程写入文件失败: ${remotePath}\n${result.stderr}`)
        if (needsTruncate) {
          const trim = await call(buildTruncateLastByteCommand(remotePath))
          if (trim.code !== 0)
            throw new Error(`远程写入文件末尾修正失败: ${remotePath}\n${trim.stderr}`)
        }
      },
      async mkdirp(remotePath) {
        const result = await call(buildMkdirpCommand(remotePath))
        if (result.code !== 0) throw new Error(`远程创建目录失败: ${remotePath}\n${result.stderr}`)
      },
      async exists(remotePath) {
        return (await call(buildExistsCommand(remotePath))).code === 0
      },
      async uploadFile(localPath, remotePath) {
        checkOpen()
        const batch = `put ${quoteSftpPath(localPath)} ${quoteSftpPath(remotePath)}\n`
        let result: RemoteExecResult
        try {
          result = await runProcess(
            spawnImpl,
            'sftp',
            buildSftpArgs(host, controlPath, config),
            execTimeout,
            MAX_CONTROL_OUTPUT_BYTES,
            batch,
            operations.signal
          )
        } catch (error) {
          const diagnosis = diagnoseSshConnectionFailure(error)
          if (diagnosis.code === 'ssh_missing') throw new RemoteSshConnectionError(diagnosis)
          throw error
        }
        const failure = connectionFailureFromResult(result.stderr, result.code)
        if (failure) throw failure
        if (result.code !== 0) throw new Error(`远程上传文件失败: ${remotePath}`)
      },
      close
    }
  } catch (error) {
    await close()
    throw error
  }
}
