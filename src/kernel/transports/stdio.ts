import { createInterface, type Interface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

import { KERNEL_STDIO_FRAME_PREFIX } from '../../shared/kernel-protocol/constants'
import type { FrameTransport } from '../protocol'

export class StdioFrameTransport implements FrameTransport {
  private readonly lines: Interface
  private readonly lineListeners = new Set<(line: string) => void>()
  private readonly closeListeners = new Set<() => void>()
  private closed = false

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly taggedOutput = false
  ) {
    this.lines = createInterface({ input, crlfDelay: Infinity })
    this.lines.on('line', (line) => {
      for (const listener of this.lineListeners) listener(line)
    })
    this.lines.once('close', () => this.notifyClosed())
    input.once('error', () => this.notifyClosed())
    output.once('error', () => this.notifyClosed())
  }

  send(line: string): void {
    if (this.closed) return
    // Start a fresh line even if a dependency wrote a partial diagnostic to stdout.
    this.output.write(this.taggedOutput ? `\n${KERNEL_STDIO_FRAME_PREFIX}${line}` : line)
  }

  onLine(callback: (line: string) => void): void {
    this.lineListeners.add(callback)
  }

  onClose(callback: () => void): void {
    if (this.closed) {
      queueMicrotask(callback)
      return
    }
    this.closeListeners.add(callback)
  }

  close(): void {
    this.lines.close()
  }

  private notifyClosed(): void {
    if (this.closed) return
    this.closed = true
    for (const listener of this.closeListeners) listener()
    this.closeListeners.clear()
  }
}
