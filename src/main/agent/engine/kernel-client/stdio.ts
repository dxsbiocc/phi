import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'

import { resolveBunExecutable } from '../bun-executable'
import { KernelProtocolClient, type KernelClientTransport } from '.'

export const LOCAL_KERNEL_EXIT_BUDGET_MS = 2_000
const LOCAL_KERNEL_CLOSE_PHASE_MS = 900
const LOCAL_KERNEL_KILL_CONFIRM_MS = LOCAL_KERNEL_EXIT_BUDGET_MS - LOCAL_KERNEL_CLOSE_PHASE_MS * 2

type ProcessExit = {
  code: number | null
  signal: NodeJS.Signals | null
}

export type LocalKernelCloseOutcome = ProcessExit & {
  action: 'already-exited' | 'stdin-eof' | 'sigterm' | 'sigkill'
}

class ChildProcessKernelTransport implements KernelClientTransport {
  private readonly lines
  private readonly lineListeners = new Set<(line: string) => void>()
  private readonly closeListeners = new Set<() => void>()
  private readonly exited: Promise<ProcessExit>
  private exit?: ProcessExit
  private closing?: Promise<LocalKernelCloseOutcome>
  private closed = false

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.exited = new Promise((resolveExit) => {
      child.once('close', (code, signal) => {
        this.exit = { code, signal }
        resolveExit(this.exit)
        this.notifyClosed()
      })
    })
    this.lines.on('line', (line) => {
      for (const listener of this.lineListeners) listener(line)
    })
    this.lines.once('close', () => this.notifyClosed())
    child.once('error', () => this.notifyClosed())
    child.stdin.once('error', () => this.notifyClosed())
  }

  send(line: string): void {
    if (this.closed) throw new Error('Kernel stdio transport is closed')
    this.child.stdin.write(line)
  }

  onLine(callback: (line: string) => void): void {
    this.lineListeners.add(callback)
  }

  onClose(callback: () => void): void {
    if (this.closed) queueMicrotask(callback)
    else this.closeListeners.add(callback)
  }

  async close(): Promise<void> {
    await this.closeWithOutcome()
  }

  closeWithOutcome(): Promise<LocalKernelCloseOutcome> {
    return (this.closing ??= this.performClose())
  }

  private notifyClosed(): void {
    if (this.closed) return
    this.closed = true
    this.lines.close()
    for (const listener of this.closeListeners) listener()
    this.closeListeners.clear()
  }

  private async performClose(): Promise<LocalKernelCloseOutcome> {
    if (this.exit) return { action: 'already-exited', ...this.exit }

    if (!this.child.stdin.destroyed) this.child.stdin.end()
    const graceful = await this.waitForExit(LOCAL_KERNEL_CLOSE_PHASE_MS)
    if (graceful) return { action: 'stdin-eof', ...graceful }

    this.child.kill('SIGTERM')
    const terminated = await this.waitForExit(LOCAL_KERNEL_CLOSE_PHASE_MS)
    if (terminated) return { action: 'sigterm', ...terminated }

    this.child.kill('SIGKILL')
    const killed = await this.waitForExit(LOCAL_KERNEL_KILL_CONFIRM_MS)
    return {
      action: 'sigkill',
      ...(killed ?? {
        code: this.child.exitCode,
        signal: this.child.signalCode ?? 'SIGKILL'
      })
    }
  }

  private waitForExit(timeoutMs: number): Promise<ProcessExit | undefined> {
    if (this.exit) return Promise.resolve(this.exit)
    return new Promise((resolveWait) => {
      let settled = false
      const finish = (result: ProcessExit | undefined): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolveWait(result)
      }
      const timer = setTimeout(() => finish(undefined), timeoutMs)
      timer.unref()
      void this.exited.then(finish)
    })
  }
}

type SpawnKernelStdioCommonOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  onDiagnostic?: (text: string) => void
}

type SpawnSourceKernelStdioOptions = SpawnKernelStdioCommonOptions & {
  sourceMode?: true
  executable?: never
  bunExecutable?: string
  bunArgs?: string[]
  entry?: string
}

type SpawnCompiledKernelStdioOptions = SpawnKernelStdioCommonOptions & {
  executable: string
  sourceMode?: false
  bunExecutable?: never
  bunArgs?: never
  entry?: never
}

export type SpawnKernelStdioOptions =
  SpawnSourceKernelStdioOptions | SpawnCompiledKernelStdioOptions

export type SpawnedKernelClient = {
  client: KernelProtocolClient
  process: ChildProcessWithoutNullStreams
  close(): Promise<LocalKernelCloseOutcome>
}

export function spawnKernelStdio(options: SpawnKernelStdioOptions = {}): SpawnedKernelClient {
  const executable = options.executable ?? options.bunExecutable ?? resolveBunExecutable()
  const args = options.executable
    ? []
    : [...(options.bunArgs ?? []), options.entry ?? resolve('src/kernel/main.ts')]
  const child = spawn(executable, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => options.onDiagnostic?.(chunk))
  const transport = new ChildProcessKernelTransport(child)
  const client = new KernelProtocolClient(transport)
  return {
    client,
    process: child,
    async close() {
      await client.close()
      return transport.closeWithOutcome()
    }
  }
}
