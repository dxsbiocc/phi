import { spawn } from 'node:child_process'

/** The outcome of running one program; it never throws, so callers report what happened. */
export interface ProcessResult {
  /** Null when the program did not exit normally: it never started, or it was killed. */
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** Set when the program could not be started at all, for example `ENOENT` for a missing binary. */
  spawnError?: string
}

export interface ProcessOptions {
  cwd?: string
  /** Added to the current environment. */
  env?: Record<string, string>
  timeoutMs: number
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: ProcessOptions
) => Promise<ProcessResult>

/** Enough to keep the end of a noisy run, where the error is, without holding all of it. */
const MAX_CAPTURE_CHARS = 200_000

function keepTail(current: string, chunk: string): string {
  const joined = current + chunk
  return joined.length > MAX_CAPTURE_CHARS
    ? joined.slice(joined.length - MAX_CAPTURE_CHARS)
    : joined
}

export const runProcess: ProcessRunner = (command, args, options) =>
  new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const settle = (result: ProcessResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = keepTail(stdout, chunk.toString('utf-8'))
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = keepTail(stderr, chunk.toString('utf-8'))
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      settle({ code: null, stdout, stderr, timedOut, spawnError: error.code ?? error.message })
    })
    child.on('close', (code) => {
      settle({ code: timedOut ? null : code, stdout, stderr, timedOut })
    })
  })
