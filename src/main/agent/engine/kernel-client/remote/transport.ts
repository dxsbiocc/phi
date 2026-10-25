import { createInterface } from 'node:readline'

import type { RemoteStdioProcess } from '../../../wrappers/remote-ssh-session'
import type { KernelClientTransport } from '..'

export class RemoteKernelTransport implements KernelClientTransport {
  private readonly lines
  private readonly lineListeners = new Set<(line: string) => void>()
  private readonly closeListeners = new Set<() => void>()
  private closed = false
  private closing?: Promise<void>

  constructor(
    private readonly process: RemoteStdioProcess,
    onDiagnostic?: (text: string) => void
  ) {
    this.lines = createInterface({ input: process.stdout, crlfDelay: Infinity })
    this.lines.on('line', (line) => {
      for (const listener of this.lineListeners) listener(line)
    })
    process.stderr.setEncoding('utf8')
    process.stderr.on('data', (chunk: string) => onDiagnostic?.(chunk))
    this.lines.once('close', () => this.notifyClosed())
    void process.closed.then(
      () => this.notifyClosed(),
      () => this.notifyClosed()
    )
  }

  send(line: string): void {
    if (this.closed) throw new Error('Remote kernel stdio transport is closed')
    this.process.stdin.write(line)
  }

  onLine(callback: (line: string) => void): void {
    this.lineListeners.add(callback)
  }

  onClose(callback: () => void): void {
    if (this.closed) queueMicrotask(callback)
    else this.closeListeners.add(callback)
  }

  close(): Promise<void> {
    this.closing ??= this.process.close().finally(() => this.notifyClosed())
    return this.closing
  }

  private notifyClosed(): void {
    if (this.closed) return
    this.closed = true
    this.lines.close()
    for (const listener of this.closeListeners) listener()
    this.closeListeners.clear()
  }
}
