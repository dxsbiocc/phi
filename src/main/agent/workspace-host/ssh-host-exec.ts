import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { REMOTE_BASH_MAX_OUTPUT_BYTES } from '../remote-workspace-bash'
import {
  buildDetachedLaunchCommand,
  readDetachedStatus,
  signalDetachedRun,
  wrapWithExitCodeTrap,
  type RemoteJobHandle,
  type RemoteRunStatus
} from '../wrappers/executor-remote'
import { verifyRemoteCancelTarget } from '../wrappers/remote-launch-claim'
import { MAX_REMOTE_LOG_RAW_BYTES, readRemoteFileChunk } from '../wrappers/remote-ssh-log'
import { shellQuote, type RemoteSshSession } from '../wrappers/remote-ssh-session'
import { SshHostContext } from './ssh-host-context'
import {
  WorkspaceHostError,
  type BackgroundProcessHandle,
  type BackgroundProcessState,
  type CommandResult,
  type HostCommand,
  type RunCommandOptions,
  type WorkspaceHost
} from './types'

type ExecutionHost = WorkspaceHost['exec']
const DEFAULT_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 25
const TERMINATE_GRACE_MS = 500

interface RemoteOutput {
  text: string
  size: number
}

function validate(command: HostCommand, options: RunCommandOptions): number {
  const maxBytes = options.maxOutputBytes ?? REMOTE_BASH_MAX_OUTPUT_BYTES
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const env = Object.entries(options.env ?? {})
  if (
    command.length === 0 ||
    command.some((part) => part.includes('\0')) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    !Number.isSafeInteger(timeout) ||
    timeout <= 0 ||
    env.length > 32 ||
    env.some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes('\0')) ||
    Buffer.byteLength(JSON.stringify(options.env ?? {}), 'utf8') > 8192
  ) {
    throw new WorkspaceHostError('invalid command options', 'INVALID_ARGUMENT')
  }
  return maxBytes
}

function invocation(command: HostCommand): string {
  return `exec ${command.map(shellQuote).join(' ')}`
}

function workspaceCommand(
  cwd: string,
  command: HostCommand,
  env: Readonly<Record<string, string>> = {}
): string {
  const body = [
    `cd -P -- ${shellQuote(cwd)} || exit 72`,
    `[ "$PWD" = ${shellQuote(cwd)} ] || exit 72`,
    ...Object.entries(env).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
    invocation(command)
  ].join('\n')
  return `bash -c ${shellQuote(body)}`
}

function parsePid(raw: string): number {
  const value = raw.trim()
  const pid = Number(value)
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(pid)) {
    throw new Error('远程启动回执没有有效 PID')
  }
  return pid
}

async function readOutput(
  session: RemoteSshSession,
  path: string,
  limit: number
): Promise<RemoteOutput> {
  const probe = await readRemoteFileChunk(session, path, { offset: 0, maxBytes: 1 })
  if (probe.missing) return { text: '', size: 0 }
  if (limit === 0) return { text: '', size: probe.size }
  const buffers = [probe.bytes.subarray(0, Math.min(limit, probe.bytes.length))]
  let cursor = probe.nextOffset
  let remaining = limit - buffers[0].length
  while (remaining > 0 && cursor < probe.size) {
    const chunk = await readRemoteFileChunk(session, path, {
      offset: cursor,
      maxBytes: Math.min(remaining, MAX_REMOTE_LOG_RAW_BYTES)
    })
    if (chunk.missing || chunk.nextOffset <= cursor) break
    buffers.push(chunk.bytes)
    cursor = chunk.nextOffset
    remaining -= chunk.bytes.length
  }
  return { text: Buffer.concat(buffers).toString('utf8'), size: probe.size }
}

class SshProcess implements BackgroundProcessHandle {
  readonly pid: number
  private result?: CommandResult
  private settling?: Promise<CommandResult>
  private timer?: ReturnType<typeof setTimeout>
  private abort?: () => void
  private abortSignal?: AbortSignal
  private terminationReason?: CommandResult['terminationReason']

  constructor(
    private readonly context: SshHostContext,
    private readonly handle: RemoteJobHandle,
    private readonly maxOutputBytes: number
  ) {
    this.pid = handle.pid ?? 0
  }

  attach(options: RunCommandOptions): void {
    const terminate = (reason: CommandResult['terminationReason']): void => {
      this.terminationReason ??= reason
      void this.terminate()
    }
    this.abort = () => terminate('cancelled')
    this.abortSignal = options.signal
    options.signal?.addEventListener('abort', this.abort, { once: true })
    this.timer = setTimeout(() => terminate('timeout'), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    if (options.signal?.aborted) this.abort()
  }

  async query(): Promise<BackgroundProcessState> {
    if (this.result) return { pid: this.pid, running: false, result: { ...this.result } }
    if (this.settling) return { pid: this.pid, running: true }
    const status = await this.context.withSession((session) =>
      readDetachedStatus(session, this.handle)
    )
    if (status.outcome === 'running') return { pid: this.pid, running: true }
    const result = await this.settle(status, null)
    return { pid: this.pid, running: false, result: { ...result } }
  }

  async wait(): Promise<CommandResult> {
    for (;;) {
      if (this.result) return { ...this.result }
      if (this.settling) return { ...(await this.settling) }
      const state = await this.query()
      if (!state.running && state.result) return state.result
      await delay(POLL_INTERVAL_MS)
    }
  }

  async terminate(): Promise<CommandResult> {
    if (this.result) return { ...this.result }
    if (this.settling) return { ...(await this.settling) }
    this.terminationReason ??= 'terminated'
    this.settling = this.stopAndCollect()
    return { ...(await this.settling) }
  }

  private async stopAndCollect(): Promise<CommandResult> {
    let status: RemoteRunStatus = { outcome: 'lost' }
    let signal = 'SIGTERM'
    await this.context.withSession(async (session) => {
      status = await readDetachedStatus(session, this.handle)
      if (status.outcome !== 'running') return
      await signalDetachedRun(session, this.handle, 'TERM')
      await delay(TERMINATE_GRACE_MS)
      status = await readDetachedStatus(session, this.handle)
      if (status.outcome === 'completed' || status.outcome === 'failed') return
      await verifyRemoteCancelTarget(
        session,
        this.handle.remoteRunDir,
        this.handle.runId,
        'detached',
        this.pid
      )
      await session.exec(`kill -KILL -${this.pid} 2>/dev/null || true`)
      signal = 'SIGKILL'
      status = await readDetachedStatus(session, this.handle)
    })
    return this.collect(status, signal)
  }

  private settle(status: RemoteRunStatus, signal: string | null): Promise<CommandResult> {
    this.settling ??= this.collect(status, signal)
    return this.settling
  }

  private async collect(status: RemoteRunStatus, signal: string | null): Promise<CommandResult> {
    const result = await this.context.withSession(async (session) => {
      const stdout = await readOutput(
        session,
        posix.join(this.handle.remoteRunDir, 'logs/stdout.log'),
        this.maxOutputBytes
      )
      const stderr = await readOutput(
        session,
        posix.join(this.handle.remoteRunDir, 'logs/stderr.log'),
        Math.max(0, this.maxOutputBytes - Buffer.byteLength(stdout.text))
      )
      return {
        stdout: stdout.text,
        stderr: stderr.text,
        code: signal ? null : (status.exitCode ?? null),
        signal,
        truncated: stdout.size + stderr.size > this.maxOutputBytes,
        stdoutTruncated: stdout.size > this.maxOutputBytes,
        stderrTruncated:
          stderr.size > Math.max(0, this.maxOutputBytes - Buffer.byteLength(stdout.text)),
        ...(signal && this.terminationReason ? { terminationReason: this.terminationReason } : {})
      }
    })
    this.result = result
    this.cleanupLifecycle()
    await this.cleanupRemote()
    return result
  }

  private cleanupLifecycle(): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.abort) this.abortSignal?.removeEventListener('abort', this.abort)
    this.abort = undefined
    this.abortSignal = undefined
  }

  private async cleanupRemote(): Promise<void> {
    await this.context
      .withPath(this.handle.remoteRunDir, 'existing', async (session, path) => {
        await session.exec(`rm -rf -- ${shellQuote(path)}`)
      })
      .catch(() => undefined)
  }
}

class SshExecution {
  constructor(private readonly context: SshHostContext) {}

  asHost(): ExecutionHost {
    return {
      run: (command, options) => this.run(command, options),
      spawnBackground: (command, options) => this.spawnBackground(command, options)
    }
  }

  private async run(command: HostCommand, options: RunCommandOptions): Promise<CommandResult> {
    const process = await this.spawnBackground(command, options)
    return (process as SshProcess).wait()
  }

  private async spawnBackground(
    command: HostCommand,
    options: RunCommandOptions
  ): Promise<BackgroundProcessHandle> {
    const maxBytes = validate(command, options)
    const runId = `workspace-host-${randomUUID()}`
    const runDir = posix.join(this.context.canonicalRoot, 'wrappers', 'runs', runId)
    await this.context.mkdirp(runDir)
    const process = await this.context.withPath(options.cwd, 'existing', async (session, cwd) => {
      const claimDir = posix.join(runDir, '.phi-launch-claim')
      await session.mkdirp(claimDir)
      await session.writeTextFile(posix.join(claimDir, 'run-id'), `${runId}\n`)
      const script = wrapWithExitCodeTrap(workspaceCommand(cwd, command, options.env))
      await session.writeTextFile(posix.join(runDir, 'launch.sh'), script)
      const launched = await session.exec(buildDetachedLaunchCommand(runDir))
      if (launched.code !== 0) {
        throw new Error(launched.stderr || launched.stdout || '启动命令未返回 PID')
      }
      const handle = { runId, remoteRunDir: runDir, pid: parsePid(launched.stdout) }
      return new SshProcess(this.context, handle, maxBytes)
    })
    process.attach(options)
    return process
  }
}

export function createSshExecution(context: SshHostContext): ExecutionHost {
  return new SshExecution(context).asHost()
}
