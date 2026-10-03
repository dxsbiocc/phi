import {
  TERMINAL_CREDIT_WINDOW_BYTES,
  TERMINAL_RING_BUFFER_BYTES
} from '../../shared/terminalTypes'

export const TERMINAL_OUTPUT_BATCH_MS = 16
export const TERMINAL_OUTPUT_BATCH_BYTES = 32 * 1024

// Leave room for the response id and protocol envelope inside the 256 KiB frame limit.
export const TERMINAL_REPLAY_PAGE_BYTES = 255 * 1024

export interface TerminalDataRecord {
  seq: number
  data: string
}

export interface TerminalGap {
  fromSeq: number
  toSeq: number
  droppedBytes: number
}

export interface WorkerReplayResult {
  records: TerminalDataRecord[]
  gap?: TerminalGap
  nextSeq: number
  more: boolean
}

type TimerHandle = unknown

interface BufferedRecord extends TerminalDataRecord {
  bytes: number
}

interface ReplaySnapshot {
  records: TerminalDataRecord[]
  gap?: TerminalGap
  index: number
  expectedFromSeq: number
  emptyNextSeq: number
}

export interface TerminalOutputBufferOptions {
  onData: (record: TerminalDataRecord) => void
  onGap: (gap: TerminalGap) => void
  batchDelayMs?: number
  batchBytes?: number
  ringBytes?: number
  creditWindowBytes?: number
  replayPageBytes?: number
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
}

interface StringPrefix {
  prefix: string
  rest: string
  bytes: number
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return value
}

function cutsSurrogatePair(value: string, index: number): boolean {
  if (index <= 0 || index >= value.length) return false
  const before = value.charCodeAt(index - 1)
  const after = value.charCodeAt(index)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
}

function startsWithLowSurrogate(value: string): boolean {
  const first = value.charCodeAt(0)
  return first >= 0xdc00 && first <= 0xdfff
}

function takeUtf8Prefix(value: string, maxBytes: number): StringPrefix {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return { prefix: value, rest: '', bytes: Buffer.byteLength(value, 'utf8') }
  }

  let low = 0
  let high = Math.min(value.length, maxBytes)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) low = middle
    else high = middle - 1
  }

  const boundary = cutsSurrogatePair(value, low) ? low - 1 : low
  const prefix = value.slice(0, boundary)
  return {
    prefix,
    rest: value.slice(boundary),
    bytes: Buffer.byteLength(prefix, 'utf8')
  }
}

function replayByteLength(
  recordsJsonBytes: number,
  gap: TerminalGap | undefined,
  nextSeq: number,
  more: boolean
): number {
  const emptyPageBytes = Buffer.byteLength(
    JSON.stringify({ records: [], ...(gap ? { gap } : {}), nextSeq, more }),
    'utf8'
  )
  return emptyPageBytes - 2 + recordsJsonBytes
}

export class TerminalOutputBuffer {
  private readonly onData: (record: TerminalDataRecord) => void
  private readonly onGap: (gap: TerminalGap) => void
  private readonly batchDelayMs: number
  private readonly batchBytes: number
  private readonly ringBytesLimit: number
  private readonly creditWindowBytes: number
  private readonly replayPageBytes: number
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle
  private readonly clearTimer: (handle: TimerHandle) => void

  private pendingParts: string[] = []
  private pendingBytes = 0
  private batchTimer: TimerHandle | undefined
  private records: BufferedRecord[] = []
  private recordHead = 0
  private retainedBytes = 0
  private nextSequence = 1
  private nextForwardSequence = 1
  private credit = 0
  private droppedGap: TerminalGap | undefined
  private pendingForwardGap: TerminalGap | undefined
  private replaySnapshot: ReplaySnapshot | undefined
  private disposed = false

  constructor(options: TerminalOutputBufferOptions) {
    this.onData = options.onData
    this.onGap = options.onGap
    this.batchDelayMs = positiveInteger(
      options.batchDelayMs ?? TERMINAL_OUTPUT_BATCH_MS,
      'batchDelayMs'
    )
    this.batchBytes = positiveInteger(
      options.batchBytes ?? TERMINAL_OUTPUT_BATCH_BYTES,
      'batchBytes'
    )
    if (this.batchBytes < 4) {
      throw new RangeError('batchBytes must fit one UTF-8 code point')
    }
    this.ringBytesLimit = positiveInteger(
      options.ringBytes ?? TERMINAL_RING_BUFFER_BYTES,
      'ringBytes'
    )
    this.creditWindowBytes = positiveInteger(
      options.creditWindowBytes ?? TERMINAL_CREDIT_WINDOW_BYTES,
      'creditWindowBytes'
    )
    this.replayPageBytes = positiveInteger(
      options.replayPageBytes ?? TERMINAL_REPLAY_PAGE_BYTES,
      'replayPageBytes'
    )
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
  }

  push(chunk: string): void {
    if (this.disposed) throw new Error('Terminal output buffer is disposed')
    if (!chunk) return

    let remaining = chunk
    if (this.pendingEndsWithHighSurrogate() && startsWithLowSurrogate(remaining)) {
      this.pendingParts.push(remaining[0])
      // A high surrogate encoded alone costs three bytes; completing the pair costs four.
      this.pendingBytes += 1
      remaining = remaining.slice(1)
      if (this.pendingBytes >= this.batchBytes) this.flush()
      else this.ensureBatchTimer()
    }

    while (remaining) {
      const capacity = this.batchBytes - this.pendingBytes
      const part = takeUtf8Prefix(remaining, capacity)
      if (!part.prefix) {
        this.flush()
        continue
      }

      this.pendingParts.push(part.prefix)
      this.pendingBytes += part.bytes
      remaining = part.rest

      if (this.pendingBytes >= this.batchBytes) this.flush()
      else this.ensureBatchTimer()
    }
  }

  flush(): TerminalDataRecord | undefined {
    if (this.pendingBytes === 0) return undefined
    this.cancelBatchTimer()

    const record: BufferedRecord = {
      seq: this.nextSequence++,
      data: this.pendingParts.join(''),
      bytes: this.pendingBytes
    }
    this.pendingParts = []
    this.pendingBytes = 0

    this.records.push(record)
    this.retainedBytes += record.bytes
    this.evictOverflow()
    this.forwardAvailable()
    return { seq: record.seq, data: record.data }
  }

  addCredit(bytes: number): number {
    if (this.disposed) return 0
    positiveInteger(bytes, 'credit bytes')
    this.credit = Math.min(this.creditWindowBytes, this.credit + bytes)
    this.forwardAvailable()
    return this.credit
  }

  setCredit(bytes: number): number {
    if (this.disposed) return 0
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.creditWindowBytes) {
      throw new RangeError(`credit bytes must be an integer from 0 to ${this.creditWindowBytes}`)
    }
    this.credit = bytes
    this.forwardAvailable()
    return this.credit
  }

  replay(fromSeq: number): WorkerReplayResult {
    positiveInteger(fromSeq, 'fromSeq')
    let snapshot = this.replaySnapshot
    if (!snapshot || snapshot.expectedFromSeq !== fromSeq) {
      const startIndex = this.firstIndexAtOrAfter(fromSeq)
      const gap = this.replayGap(fromSeq)
      snapshot = {
        records: this.records
          .slice(startIndex)
          .map((record) => ({ seq: record.seq, data: record.data })),
        ...(gap ? { gap } : {}),
        index: 0,
        expectedFromSeq: fromSeq,
        emptyNextSeq: Math.max(this.replayStartSequence(fromSeq), (gap?.toSeq ?? 0) + 1)
      }
      this.replaySnapshot = snapshot
    }

    const gap = snapshot.index === 0 ? snapshot.gap : undefined
    const records: TerminalDataRecord[] = []
    let recordsJsonBytes = 0
    let index = snapshot.index

    while (index < snapshot.records.length) {
      const record = snapshot.records[index]
      const recordJsonBytes = Buffer.byteLength(JSON.stringify(record), 'utf8')
      const candidateJsonBytes = recordsJsonBytes + (records.length > 0 ? 1 : 0) + recordJsonBytes
      const nextSeq = record.seq + 1
      const fits = replayByteLength(candidateJsonBytes, gap, nextSeq, false) <= this.replayPageBytes
      if (!fits) {
        if (records.length === 0) {
          throw new RangeError('A retained output record exceeds the replay page limit')
        }
        break
      }
      records.push(record)
      recordsJsonBytes = candidateJsonBytes
      index += 1
    }

    const more = index < snapshot.records.length
    const lastRecord = records.at(-1)
    const nextSeq = lastRecord ? lastRecord.seq + 1 : snapshot.emptyNextSeq
    if (more) {
      snapshot.index = index
      snapshot.expectedFromSeq = nextSeq
    } else if (this.replaySnapshot === snapshot) {
      this.replaySnapshot = undefined
    }
    return { records, ...(gap ? { gap } : {}), nextSeq, more }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelBatchTimer()
    this.pendingParts = []
    this.pendingBytes = 0
    this.records = []
    this.recordHead = 0
    this.retainedBytes = 0
    this.credit = 0
    this.replaySnapshot = undefined
  }

  private ensureBatchTimer(): void {
    if (this.batchTimer !== undefined) return
    this.batchTimer = this.setTimer(() => {
      this.batchTimer = undefined
      this.flush()
    }, this.batchDelayMs)
  }

  private cancelBatchTimer(): void {
    if (this.batchTimer === undefined) return
    this.clearTimer(this.batchTimer)
    this.batchTimer = undefined
  }

  private pendingEndsWithHighSurrogate(): boolean {
    const tail = this.pendingParts.at(-1)
    if (!tail) return false
    const codeUnit = tail.charCodeAt(tail.length - 1)
    return codeUnit >= 0xd800 && codeUnit <= 0xdbff
  }

  private evictOverflow(): void {
    while (this.retainedBytes > this.ringBytesLimit && this.recordHead < this.records.length) {
      const dropped = this.records[this.recordHead++]
      this.retainedBytes -= dropped.bytes
      this.rememberDrop(dropped)
    }

    if (this.recordHead > 1024 && this.recordHead * 2 > this.records.length) {
      this.records = this.records.slice(this.recordHead)
      this.recordHead = 0
    }
  }

  private rememberDrop(record: BufferedRecord): void {
    this.droppedGap = this.extendGap(this.droppedGap, record)
    if (record.seq < this.nextForwardSequence) return
    this.pendingForwardGap = this.extendGap(this.pendingForwardGap, record)
    this.nextForwardSequence = record.seq + 1
  }

  private extendGap(gap: TerminalGap | undefined, record: BufferedRecord): TerminalGap {
    return {
      fromSeq: gap?.fromSeq ?? record.seq,
      toSeq: record.seq,
      droppedBytes: (gap?.droppedBytes ?? 0) + record.bytes
    }
  }

  private forwardAvailable(): void {
    while (this.credit > 0) {
      const record = this.recordForSequence(this.nextForwardSequence)
      if (!record || record.bytes > this.credit) return

      if (this.pendingForwardGap) {
        this.onGap(this.pendingForwardGap)
        this.pendingForwardGap = undefined
      }
      this.credit -= record.bytes
      this.nextForwardSequence = record.seq + 1
      this.onData({ seq: record.seq, data: record.data })
    }
  }

  private recordForSequence(sequence: number): BufferedRecord | undefined {
    const first = this.records[this.recordHead]
    if (!first || sequence < first.seq) return undefined
    const index = this.recordHead + sequence - first.seq
    const record = this.records[index]
    return record?.seq === sequence ? record : undefined
  }

  private firstIndexAtOrAfter(sequence: number): number {
    const first = this.records[this.recordHead]
    if (!first) return this.records.length
    if (sequence <= first.seq) return this.recordHead
    return Math.min(this.records.length, this.recordHead + sequence - first.seq)
  }

  private replayGap(fromSeq: number): TerminalGap | undefined {
    if (!this.droppedGap || fromSeq > this.droppedGap.toSeq) return undefined
    return { ...this.droppedGap }
  }

  private replayStartSequence(fromSeq: number): number {
    const first = this.records[this.recordHead]
    if (first && fromSeq <= first.seq) return first.seq
    return fromSeq
  }
}
