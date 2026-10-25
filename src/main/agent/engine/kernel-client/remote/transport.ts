import { createInterface } from 'node:readline'

import type { RemoteStdioProcess } from '../../../wrappers/remote-ssh-session'
import type { KernelClientTransport } from '..'

const ATTACH_STATUS_PREFIX = 'PHI_HELPER_ATTACH_STATUS='

export type RemoteKernelAttachStatus =
  { readonly state: 'attached' } | { readonly state: 'spawned'; readonly pid: number }

function parseAttachStatus(line: string): RemoteKernelAttachStatus | undefined {
  if (!line.startsWith(ATTACH_STATUS_PREFIX)) return undefined
  try {
    const value = JSON.parse(line.slice(ATTACH_STATUS_PREFIX.length)) as Record<string, unknown>
    if (value.state === 'attached') return { state: 'attached' }
    if (value.state === 'spawned' && Number.isSafeInteger(value.pid) && Number(value.pid) > 0) {
      return { state: 'spawned', pid: Number(value.pid) }
    }
  } catch {
    // The launcher turns an absent valid status into a typed launch failure.
  }
  return undefined
}

export class RemoteKernelTransport implements KernelClientTransport {
  private readonly lines
  private readonly lineListeners = new Set<(line: string) => void>()
  private readonly closeListeners = new Set<() => void>()
  private closed = false
  private closing?: Promise<void>
  private diagnosticRemainder = ''
  private resolveAttachStatus!: (status: RemoteKernelAttachStatus) => void
  readonly attachStatus: Promise<RemoteKernelAttachStatus>

  constructor(
    private readonly process: RemoteStdioProcess,
    onDiagnostic?: (text: string) => void
  ) {
    this.attachStatus = new Promise((resolve) => {
      this.resolveAttachStatus = resolve
    })
    this.lines = createInterface({ input: process.stdout, crlfDelay: Infinity })
    this.lines.on('line', (line) => {
      for (const listener of this.lineListeners) listener(line)
    })
    process.stderr.setEncoding('utf8')
    process.stderr.on('data', (chunk: string) => {
      this.diagnosticRemainder += chunk
      for (;;) {
        const newline = this.diagnosticRemainder.indexOf('\n')
        if (newline < 0) break
        const line = this.diagnosticRemainder.slice(0, newline).replace(/\r$/, '')
        this.diagnosticRemainder = this.diagnosticRemainder.slice(newline + 1)
        const status = parseAttachStatus(line)
        if (status) this.resolveAttachStatus(status)
        else onDiagnostic?.(`${line}\n`)
      }
    })
    process.stderr.once('end', () => {
      if (!this.diagnosticRemainder) return
      const status = parseAttachStatus(this.diagnosticRemainder.replace(/\r$/, ''))
      if (status) this.resolveAttachStatus(status)
      else onDiagnostic?.(this.diagnosticRemainder)
      this.diagnosticRemainder = ''
    })
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
