import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

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

interface OutputCapture {
  push: (stream: 'stdout' | 'stderr', chunk: Buffer) => void
  result: () => Pick<CommandResult, 'stdout' | 'stderr' | 'truncated'>
}

function isInside(root: string, path: string): boolean {
  const part = relative(root, path)
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}

function captureOutput(maxBytes: number): OutputCapture {
  const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
  let bytes = 0
  let truncated = false
  return {
    push(stream, chunk): void {
      const remaining = maxBytes - bytes
      const kept = chunk.subarray(0, Math.max(remaining, 0))
      if (kept.length > 0) output[stream].push(Buffer.from(kept))
      bytes += kept.length
      truncated ||= kept.length < chunk.length
    },
    result: () => ({
      stdout: Buffer.concat(output.stdout).toString('utf8'),
      stderr: Buffer.concat(output.stderr).toString('utf8'),
      truncated
    })
  }
}

function signalProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    child.kill(signal)
  }
}

class LocalProcess implements BackgroundProcessHandle {
  readonly pid: number
  private running = true
  private result?: CommandResult
  private terminationSweep?: Promise<void>
  private readonly completion: Promise<CommandResult>

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    capture: OutputCapture
  ) {
    this.pid = child.pid ?? 0
    this.completion = new Promise((resolveResult, reject) => {
      child.once('error', (error) => {
        this.running = false
        reject(error)
      })
      child.once('close', (code, signal) => {
        this.running = false
        this.result = { ...capture.result(), code, signal }
        resolveResult(this.result)
      })
    })
  }

  requestTermination(): void {
    if (!this.running || this.terminationSweep) return
    signalProcess(this.child, 'SIGTERM')
    this.terminationSweep = new Promise((resolveSweep) => {
      setTimeout(() => {
        signalProcess(this.child, 'SIGKILL')
        resolveSweep()
      }, 500)
    })
  }

  wait(): Promise<CommandResult> {
    return this.completion
  }

  async finishTermination(): Promise<void> {
    await this.terminationSweep
  }

  async query(): Promise<BackgroundProcessState> {
    return {
      pid: this.pid,
      running: this.running,
      ...(this.result ? { result: { ...this.result } } : {})
    }
  }

  async terminate(): Promise<CommandResult> {
    this.requestTermination()
    const result = await this.completion
    await this.finishTermination()
    return result
  }
}

function validateOptions(command: HostCommand, options: RunCommandOptions): number {
  const maxBytes = options.maxOutputBytes ?? 1024 * 1024
  if (
    command.length === 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    (options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0))
  ) {
    throw new WorkspaceHostError('invalid command options', 'INVALID_ARGUMENT')
  }
  return maxBytes
}

class LocalExecution {
  private readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  asHost(): ExecutionHost {
    return {
      run: (command, options) => this.run(command, options),
      spawnBackground: (command, options) => this.spawnBackground(command, options)
    }
  }

  private async resolveCwd(path: string): Promise<string> {
    const root = await realpath(this.root)
    const candidate = resolve(root, path)
    if (!isInside(root, candidate)) {
      throw new WorkspaceHostError('path is outside the workspace root', 'PATH_OUTSIDE_ROOT')
    }
    const cwd = await realpath(candidate)
    if (!isInside(root, cwd)) {
      throw new WorkspaceHostError('path is outside the workspace root', 'PATH_OUTSIDE_ROOT')
    }
    return cwd
  }

  private async start(command: HostCommand, options: RunCommandOptions): Promise<LocalProcess> {
    const maxBytes = validateOptions(command, options)
    const child = spawn(command[0], command.slice(1), {
      cwd: await this.resolveCwd(options.cwd),
      env: { ...process.env, ...options.env },
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe']
    }) as ChildProcessWithoutNullStreams
    child.stdin.end()
    const capture = captureOutput(maxBytes)
    child.stdout.on('data', (chunk: Buffer) => capture.push('stdout', chunk))
    child.stderr.on('data', (chunk: Buffer) => capture.push('stderr', chunk))
    return new LocalProcess(child, capture)
  }

  private async run(command: HostCommand, options: RunCommandOptions): Promise<CommandResult> {
    const child = await this.start(command, options)
    const terminate = (): void => child.requestTermination()
    const timeout = options.timeoutMs ? setTimeout(terminate, options.timeoutMs) : undefined
    options.signal?.addEventListener('abort', terminate, { once: true })
    if (options.signal?.aborted) terminate()
    try {
      const result = await child.wait()
      await child.finishTermination()
      return result
    } finally {
      if (timeout) clearTimeout(timeout)
      options.signal?.removeEventListener('abort', terminate)
    }
  }

  private async spawnBackground(
    command: HostCommand,
    options: RunCommandOptions
  ): Promise<BackgroundProcessHandle> {
    const child = await this.start(command, options)
    const terminate = (): void => child.requestTermination()
    const timeout = options.timeoutMs ? setTimeout(terminate, options.timeoutMs) : undefined
    options.signal?.addEventListener('abort', terminate, { once: true })
    if (options.signal?.aborted) terminate()
    void child.wait().then(
      () => {
        if (timeout) clearTimeout(timeout)
        options.signal?.removeEventListener('abort', terminate)
      },
      () => {
        if (timeout) clearTimeout(timeout)
        options.signal?.removeEventListener('abort', terminate)
      }
    )
    return child
  }
}

export function createLocalExecution(root: string): ExecutionHost {
  return new LocalExecution(root).asHost()
}
