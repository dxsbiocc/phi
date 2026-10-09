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
    return Promise.resolve({ exitCode: null, stdout: '', stderr: '命令超时参数无效' })
  }
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    return Promise.resolve({ exitCode: null, stdout: '', stderr: '命令输出上限无效' })
  }

  return new Promise((resolve) => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let timedOut = false
    let settled = false
    const secret = request.env?.PHI_SSH_ASKPASS_SECRET
    const collectionLimit = maxOutputBytes + (secret ? Buffer.byteLength(secret) : 0)
    let child
    try {
      child = spawn(request.command, request.args, {
        env: { ...process.env, ...request.env },
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch {
      resolve({ exitCode: null, stdout: '', stderr: '无法启动命令' })
      return
    }
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    const finish = (result: SshBootstrapSecretCommandResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk, collectionLimit)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk, collectionLimit)
    })
    child.stdin.on('error', () => undefined)
    child.once('error', () => {
      finish({ exitCode: null, stdout: '', stderr: '无法启动命令' })
    })
    child.once('close', (exitCode) => {
      finish({
        exitCode,
        stdout: sanitizedOutput(stdout, secret, maxOutputBytes),
        stderr: timedOut ? '命令执行超时' : sanitizedOutput(stderr, secret, maxOutputBytes)
      })
    })

    if (request.stdin !== undefined) child.stdin.end(request.stdin)
    else child.stdin.end()
  })
}
