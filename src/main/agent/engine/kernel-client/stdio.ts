import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'

import { resolveBunExecutable } from '../bun-executable'
import { KernelProtocolClient, type KernelClientTransport } from '.'

class ChildProcessKernelTransport implements KernelClientTransport {
  private readonly lines
  private readonly lineListeners = new Set<(line: string) => void>()
  private readonly closeListeners = new Set<() => void>()
  private closed = false

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.lines.on('line', (line) => {
      for (const listener of this.lineListeners) listener(line)
    })
    this.lines.once('close', () => this.notifyClosed())
    child.once('error', () => this.notifyClosed())
    child.once('close', () => this.notifyClosed())
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
    if (this.closed) return
    this.child.stdin.end()
    await new Promise<void>((complete) => {
      const timeout = setTimeout(() => {
        this.child.kill('SIGTERM')
        complete()
      }, 1_000)
      timeout.unref()
      this.child.once('close', () => {
        clearTimeout(timeout)
        complete()
      })
    })
  }

  private notifyClosed(): void {
    if (this.closed) return
    this.closed = true
    this.lines.close()
    for (const listener of this.closeListeners) listener()
    this.closeListeners.clear()
  }
}

export type SpawnKernelStdioOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  bunExecutable?: string
  bunArgs?: string[]
  entry?: string
  onDiagnostic?: (text: string) => void
}

export type SpawnedKernelClient = {
  client: KernelProtocolClient
  process: ChildProcessWithoutNullStreams
  close(): Promise<void>
}

export function spawnKernelStdio(options: SpawnKernelStdioOptions = {}): SpawnedKernelClient {
  const child = spawn(
    options.bunExecutable ?? resolveBunExecutable(),
    [...(options.bunArgs ?? []), options.entry ?? resolve('src/kernel/main.ts')],
    {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => options.onDiagnostic?.(chunk))
  const transport = new ChildProcessKernelTransport(child)
  const client = new KernelProtocolClient(transport)
  return {
    client,
    process: child,
    close: () => client.close()
  }
}
