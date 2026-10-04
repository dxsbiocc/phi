import type { TerminalRendererBridge } from '../../../../../shared/terminalTypes'

const ACK_FLUSH_DELAY_MS = 16
const ACK_FLUSH_THRESHOLD_BYTES = 32 * 1024

interface AckBatch {
  bytes: number
  timer?: ReturnType<typeof setTimeout>
}

export class TerminalAckBatcher {
  private readonly batches = new Map<number, AckBatch>()
  private disposed = false

  constructor(
    private readonly options: {
      terminalId: string
      ack: TerminalRendererBridge['ack']
      setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
      clearTimer(timer: ReturnType<typeof setTimeout>): void
    }
  ) {}

  queue(epoch: number, bytes: number): void {
    if (this.disposed || bytes <= 0) return
    let batch = this.batches.get(epoch)
    if (!batch) {
      batch = { bytes: 0 }
      this.batches.set(epoch, batch)
    }
    batch.bytes += bytes
    if (batch.bytes >= ACK_FLUSH_THRESHOLD_BYTES) {
      this.flush(epoch)
      return
    }
    batch.timer ??= this.options.setTimer(() => this.flush(epoch), ACK_FLUSH_DELAY_MS)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const batch of this.batches.values()) {
      if (batch.timer) this.options.clearTimer(batch.timer)
    }
    this.batches.clear()
  }

  private flush(epoch: number): void {
    const batch = this.batches.get(epoch)
    if (!batch) return
    if (batch.timer) this.options.clearTimer(batch.timer)
    this.batches.delete(epoch)
    if (this.disposed || batch.bytes <= 0) return
    // Each batch retains the epoch captured by xterm's write callback. Late
    // callbacks can therefore never credit bytes into a newer attachment.
    void this.options.ack(this.options.terminalId, epoch, batch.bytes).catch(() => undefined)
  }
}
