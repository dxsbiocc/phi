import { spawn } from 'node:child_process'

const ENV_ALLOWLIST = [
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES'
] as const

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

export interface OfficeCliRunOptions {
  cwd?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  stdin?: string
  onSpawn?: (pid: number) => void
}

export interface OfficeCliRunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** Set when output exceeded the cap; the process is killed and the text is truncated. */
  truncated: boolean
  /** Set when the process could not be started (missing file, not executable, …). */
  spawnError?: string
}

/**
 * The child gets an allowlisted environment: no provider keys, no Phi variables, no PATH.
 * Auto-update stays off; OfficeCLI's unattended install and update paths are never used.
 */
export function officeCliEnv(
  base: NodeJS.ProcessEnv = process.env,
  extra: Readonly<Record<string, string>> = {}
): NodeJS.ProcessEnv {
  const allowed: NodeJS.ProcessEnv = {}
  for (const key of ENV_ALLOWLIST) {
    const value = base[key]
    if (typeof value === 'string') allowed[key] = value
  }
  return { ...allowed, ...extra, OFFICECLI_SKIP_UPDATE: '1' }
}

/** Runs the binary with an argument array (never through a shell) and a hard timeout. */
export function runOfficeCli(
  binaryPath: string,
  args: readonly string[],
  options: OfficeCliRunOptions = {}
): Promise<OfficeCliRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let truncated = false
    let settled = false

    const child = spawn(binaryPath, [...args], {
      cwd: options.cwd,
      env: options.env ?? officeCliEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: options.signal,
      shell: false
    })
    if (typeof child.pid === 'number') options.onSpawn?.(child.pid)

    const finish = (result: OfficeCliRunResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }
    const collect = (current: string, chunk: Buffer): string => {
      if (current.length + chunk.length > MAX_OUTPUT_BYTES) {
        truncated = true
        child.kill('SIGKILL')
        return current
      }
      return current + chunk.toString('utf8')
    }

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            child.kill('SIGKILL')
          }, timeoutMs)
        : undefined

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = collect(stdout, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = collect(stderr, chunk)
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(options.stdin ?? '')

    child.on('error', (error) => {
      finish({
        exitCode: null,
        stdout,
        stderr,
        timedOut,
        truncated,
        spawnError: error.message
      })
    })
    child.on('close', (exitCode) => {
      finish({ exitCode, stdout, stderr, timedOut, truncated })
    })
  })
}
