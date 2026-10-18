import { CodedError } from '../../../shared/errorCodes'
import { shellQuote, type RemoteSshSession } from '../wrappers/remote-ssh-session'
import type { CommandResult, HostCommand } from './types'

/** After a stop request, how long the remote watcher waits between TERM and KILL. */
const REMOTE_KILL_GRACE_S = '0.5'
/** Local backstop: if the remote watcher never ends the channel, drop the ssh client itself. */
const CHANNEL_CLOSE_BACKSTOP_MS = 5_000
/** ssh reports its own failures (lost connection, refused channel) as 255. */
const SSH_CLIENT_FAILURE_CODE = 255
const SIGKILL_EXIT_CODE = 137

function invocation(command: HostCommand): string {
  return `exec ${command.map(shellQuote).join(' ')}`
}

/** The command in its working directory and environment, exactly as the detached launch runs it. */
export function workspaceCommand(
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

/**
 * The remote side of a foreground command. The command runs in its own session so a stop reaches
 * every descendant, and the channel's stdin doubles as the liveness line: a closed stdin (our
 * stop request, or a dead connection) makes the watcher TERM then KILL the command's group.
 */
export function foregroundScript(
  cwd: string,
  command: HostCommand,
  env: Readonly<Record<string, string>> = {}
): string {
  return [
    'exec 3<&0',
    `setsid ${workspaceCommand(cwd, command, env)} </dev/null 3<&- &`,
    'pid=$!',
    // A blocking `read` (no `-t`: bash 3.2 reports a timeout and EOF with the same status).
    '( read -r _ <&3',
    '  if kill -0 "$pid" 2>/dev/null; then',
    '    kill -TERM -$pid 2>/dev/null',
    `    sleep ${REMOTE_KILL_GRACE_S}`,
    '    kill -KILL -$pid 2>/dev/null',
    '  fi',
    ') >/dev/null 2>&1 &',
    'watcher=$!',
    'wait "$pid"',
    'code=$?',
    'kill "$watcher" 2>/dev/null',
    'exit $code'
  ].join('\n')
}

interface Capture {
  push(stream: 'stdout' | 'stderr', chunk: Buffer): void
  text(stream: 'stdout' | 'stderr'): string
  truncated(stream: 'stdout' | 'stderr'): boolean
}

/** Combined budget across both streams, in arrival order; the overflow is drained and dropped. */
function capture(maxBytes: number): Capture {
  const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
  const dropped = { stdout: false, stderr: false }
  let kept = 0
  return {
    push(stream, chunk) {
      const room = Math.max(0, maxBytes - kept)
      const part = chunk.subarray(0, room)
      if (part.length > 0) chunks[stream].push(part)
      kept += part.length
      if (part.length < chunk.length) dropped[stream] = true
    },
    text: (stream) => Buffer.concat(chunks[stream]).toString('utf8'),
    truncated: (stream) => dropped[stream]
  }
}

const CHANNEL_REFUSED = /mux_client|open failed|administratively prohibited|session request failed/i

/**
 * Why a channel ended with an ssh-level failure, if it did. A dead master is a lost transport;
 * a refused channel on a live master is an ordinary error and must not retire the connection.
 */
async function channelFailure(
  session: RemoteSshSession,
  stderr: string
): Promise<Error | undefined> {
  if (session.isAlive) {
    if (!(await session.isAlive().catch(() => false))) return transportLost()
    return CHANNEL_REFUSED.test(stderr)
      ? new Error(`SSH 通道被拒绝，命令未执行：${stderr.trim().slice(0, 200)}`)
      : undefined
  }
  try {
    await session.exec('true')
  } catch (error) {
    if (error instanceof CodedError && error.code === 'TRANSPORT_LOST') return error
  }
  return undefined
}

function transportLost(): CodedError {
  return new CodedError('TRANSPORT_LOST', 'SSH 连接已断开；远端命令结果可能尚未确认')
}

/**
 * Runs one command on its own channel of the shared connection and resolves with its output.
 * Timeout and cancellation stop the remote group and still return the partial output.
 */
export async function runForegroundCommand(
  session: RemoteSshSession,
  script: string,
  options: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal }
): Promise<CommandResult> {
  if (!session.openStdio) throw new Error('SSH session cannot stream foreground commands')
  const channel = await session.openStdio(`bash -c ${shellQuote(script)}`)
  const output = capture(options.maxOutputBytes)
  channel.stdout.on('data', (chunk: Buffer) => output.push('stdout', chunk))
  channel.stderr.on('data', (chunk: Buffer) => output.push('stderr', chunk))
  channel.stdin.on('error', () => undefined)
  let reason: CommandResult['terminationReason']
  let backstop: ReturnType<typeof setTimeout> | undefined
  const stop = (why: NonNullable<CommandResult['terminationReason']>): void => {
    if (reason) return
    reason = why
    channel.stdin.end()
    backstop = setTimeout(
      () => void channel.close().catch(() => undefined),
      CHANNEL_CLOSE_BACKSTOP_MS
    )
  }
  const onAbort = (): void => stop('cancelled')
  const timer = setTimeout(() => stop('timeout'), options.timeoutMs)
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) onAbort()
  try {
    const exit = await channel.closed
    const stopped = reason !== undefined
    if (!stopped && (exit.signal !== null || exit.code === SSH_CLIENT_FAILURE_CODE)) {
      const failure = await channelFailure(session, output.text('stderr'))
      if (failure) throw failure
    }
    const signal = stopped
      ? (exit.signal ?? (exit.code === SIGKILL_EXIT_CODE ? 'SIGKILL' : 'SIGTERM'))
      : exit.signal
    return {
      stdout: output.text('stdout'),
      stderr: output.text('stderr'),
      code: stopped ? null : exit.code,
      signal,
      truncated: output.truncated('stdout') || output.truncated('stderr'),
      stdoutTruncated: output.truncated('stdout'),
      stderrTruncated: output.truncated('stderr'),
      ...(stopped && reason ? { terminationReason: reason } : {})
    }
  } finally {
    clearTimeout(timer)
    if (backstop) clearTimeout(backstop)
    options.signal?.removeEventListener('abort', onAbort)
  }
}
