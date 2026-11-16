import { sshBootstrapCopy } from './copy'
import { spawn } from 'node:child_process'

import type {
  SshBootstrapSecretCommandRequest,
  SshBootstrapSecretCommandResult
} from './credentials'

export interface SshBootstrapRuntimeCommandRequest extends SshBootstrapSecretCommandRequest {
  timeoutMs?: number
  maxOutputBytes?: number
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024
/** Bound on how long a daemonized command may keep inherited pipes after the parent exits. */
const BACKGROUND_DRAIN_GRACE_MS = 250

function appendBounded(current: Buffer, chunk: Buffer, limit: number): Buffer {
  const combined = Buffer.concat([current, chunk])
  return combined.length <= limit ? combined : combined.subarray(combined.length - limit)
}

function sanitizedOutput(output: Buffer, secret: string | undefined, limit: number): string {
  const redacted = secret
    ? output.toString('utf8').replaceAll(secret, '[REDACTED]')
    : output.toString('utf8')
  const encoded = Buffer.from(redacted)
  return (encoded.length <= limit ? encoded : encoded.subarray(encoded.length - limit)).toString(
    'utf8'
  )
}

/** Spawn without a shell and without ever logging argv, stdin, or the child environment. */
export function runSshBootstrapCommand(
  request: SshBootstrapRuntimeCommandRequest
): Promise<SshBootstrapSecretCommandResult> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve({
      exitCode: null,
      stdout: '',
      stderr: sshBootstrapCopy.commandTimeoutInvalid
    })
  }
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    return Promise.resolve({
      exitCode: null,
      stdout: '',
      stderr: sshBootstrapCopy.outputLimitInvalid
    })
  }

  return new Promise((resolve) => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let timedOut = false
    let settled = false
    let drainGrace: ReturnType<typeof setTimeout> | undefined
    const secret = request.env?.PHI_SSH_ASKPASS_SECRET
    const collectionLimit = maxOutputBytes + (secret ? Buffer.byteLength(secret) : 0)
    let child
    try {
      child = spawn(request.command, request.args, {
        env: { ...process.env, ...request.env },
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch {
      resolve({ exitCode: null, stdout: '', stderr: sshBootstrapCopy.commandStartFailed })
      return
    }
    const finish = (result: SshBootstrapSecretCommandResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (drainGrace) {
        clearTimeout(drainGrace)
        drainGrace = undefined
      }
      resolve(result)
    }
    const releaseStreams = (): void => {
      for (const stream of [child.stdout, child.stderr, child.stdin]) {
        stream.destroy()
      }
    }
    const settleTimedOut = (): void => {
      releaseStreams()
      finish({
        exitCode: null,
        stdout: sanitizedOutput(stdout, secret, maxOutputBytes),
        stderr: sshBootstrapCopy.commandTimedOut
      })
    }
    const settleFromClose = (exitCode: number | null): void => {
      finish({
        exitCode,
        stdout: sanitizedOutput(stdout, secret, maxOutputBytes),
        stderr: timedOut
          ? sshBootstrapCopy.commandTimedOut
          : sanitizedOutput(stderr, secret, maxOutputBytes)
      })
    }
    const settleForBackgroundExit = (exitCode: number | null): void => {
      if (settled || !request.background) return
      // Intentional daemonization: the direct child exits while the detached service keeps the
      // inherited pipes. Its exit status is authoritative either way, so give already-buffered
      // output a bounded chance to drain, then settle without waiting for the background
      // descendant. If the pipes are released first, `close` settles normally and cancels this
      // grace timer, which keeps ordinary commands on pure close semantics.
      drainGrace ??= setTimeout(() => {
        releaseStreams()
        settleFromClose(exitCode)
      }, BACKGROUND_DRAIN_GRACE_MS)
    }
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
      // Descendants may still hold the inherited pipes after the direct child is killed, so
      // `close` can arrive arbitrarily late. A deadline is a failure now: settle immediately
      // and release our own streams instead of waiting for them.
      settleTimedOut()
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk, collectionLimit)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk, collectionLimit)
    })
    child.stdin.on('error', () => undefined)
    child.once('error', () => {
      releaseStreams()
      finish({ exitCode: null, stdout: '', stderr: sshBootstrapCopy.commandStartFailed })
    })
    child.once('exit', settleForBackgroundExit)
    // Ordinary commands settle only when the OS reports every inherited pipe closed, so trailing
    // output from descendants is never truncated.
    child.once('close', settleFromClose)

    if (request.stdin !== undefined) child.stdin.end(request.stdin)
    else child.stdin.end()
  })
}
