import type { Socket } from 'node:net'

import type { FrameTransport } from '../protocol'

export class UnixSocketFrameTransport implements FrameTransport {
  private readonly lineListeners = new Set<(line: string) => void>()
  private readonly closeListeners = new Set<() => void>()
  private buffer = ''
  private closed = false

  constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => this.receive(chunk))
    socket.once('close', () => this.notifyClosed())
    socket.once('error', () => this.notifyClosed())
  }

  send(line: string): void {
    if (this.closed || this.socket.destroyed) return
    this.socket.write(line)
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
    this.socket.destroy()
  }

  receive(chunk: string): void {
    if (this.closed) return
    this.buffer += chunk
    let delimiter = this.buffer.indexOf('\n')
    while (delimiter !== -1) {
      const line = this.buffer.slice(0, delimiter)
      this.buffer = this.buffer.slice(delimiter + 1)
      for (const listener of this.lineListeners) listener(line)
      delimiter = this.buffer.indexOf('\n')
    }
  }

  private notifyClosed(): void {
    if (this.closed) return
    this.closed = true
    for (const listener of this.closeListeners) listener()
    this.closeListeners.clear()
  }
}
