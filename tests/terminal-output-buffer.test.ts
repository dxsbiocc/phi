import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TERMINAL_OUTPUT_BATCH_MS,
  TerminalOutputBuffer,
  type TerminalDataRecord,
  type TerminalGap,
  type TerminalOutputBufferOptions
} from '../src/main/terminal/terminal-output-buffer'
import {
  TERMINAL_CREDIT_WINDOW_BYTES,
  TERMINAL_RING_BUFFER_BYTES
} from '../src/shared/terminalTypes'

interface BufferHarness {
  buffer: TerminalOutputBuffer
  data: TerminalDataRecord[]
  gaps: TerminalGap[]
  delays: number[]
  fireTimer: () => void
  hasTimer: () => boolean
}

type BufferOverrides = Omit<Partial<TerminalOutputBufferOptions>, 'onData' | 'onGap'>

function createHarness(overrides: BufferOverrides = {}): BufferHarness {
  const data: TerminalDataRecord[] = []
  const gaps: TerminalGap[] = []
  const delays: number[] = []
  let timer: (() => void) | undefined

  const buffer = new TerminalOutputBuffer({
    ...overrides,
    onData: (record) => data.push(record),
    onGap: (gap) => gaps.push(gap),
    setTimer: (callback, delayMs) => {
      timer = callback
      delays.push(delayMs)
      return callback
    },
    clearTimer: (handle) => {
      if (timer === handle) timer = undefined
    }
  })

  return {
    buffer,
    data,
    gaps,
    delays,
    fireTimer: () => {
      const callback = timer
      timer = undefined
      callback?.()
    },
    hasTimer: () => timer !== undefined
  }
}

test('coalesces chunks on the 16 ms timer and flushes immediately at the byte threshold', () => {
  const timed = createHarness({ batchBytes: 8 })
  timed.buffer.push('ab')
  timed.buffer.push('cd')

  assert.deepEqual(timed.delays, [TERMINAL_OUTPUT_BATCH_MS])
  assert.equal(timed.buffer.replay(1).records.length, 0)
  timed.fireTimer()
  assert.deepEqual(timed.buffer.replay(1).records, [{ seq: 1, data: 'abcd' }])

  const threshold = createHarness({ batchBytes: 4 })
  threshold.buffer.push('abcdefghij')
  assert.deepEqual(threshold.buffer.replay(1).records, [
    { seq: 1, data: 'abcd' },
    { seq: 2, data: 'efgh' }
  ])
  assert.equal(threshold.hasTimer(), true)
  threshold.buffer.flush()
  assert.deepEqual(threshold.buffer.replay(1).records, [
    { seq: 1, data: 'abcd' },
    { seq: 2, data: 'efgh' },
    { seq: 3, data: 'ij' }
  ])
  assert.equal(threshold.hasTimer(), false)
})

test('uses UTF-8 bytes and never cuts between emoji surrogate halves', () => {
  const chinese = createHarness({ batchBytes: 6 })
  chinese.buffer.push('你好a')
  chinese.buffer.flush()

  const chineseRecords = chinese.buffer.replay(1).records
  assert.deepEqual(chineseRecords, [
    { seq: 1, data: '你好' },
    { seq: 2, data: 'a' }
  ])
  assert.equal(Buffer.byteLength(chineseRecords[0].data, 'utf8'), 6)

  const emoji = createHarness({ batchBytes: 5 })
  emoji.buffer.push('a😀b😀')
  emoji.buffer.flush()
  const emojiRecords = emoji.buffer.replay(1).records
  assert.equal(emojiRecords.map((record) => record.data).join(''), 'a😀b😀')
  for (const record of emojiRecords) {
    assert.ok(Buffer.byteLength(record.data, 'utf8') <= 5)
    assert.doesNotMatch(record.data, /^[\uDC00-\uDFFF]/u)
    assert.doesNotMatch(record.data, /[\uD800-\uDBFF]$/u)
  }

  const splitCallback = createHarness({ batchBytes: 4 })
  splitCallback.buffer.push('\uD83D')
  splitCallback.buffer.push('\uDE00')
  assert.deepEqual(splitCallback.buffer.replay(1).records, [{ seq: 1, data: '😀' }])
})

test('evicts the oldest UTF-8 bytes and reports the missing sequence range', () => {
  const harness = createHarness({ batchBytes: 4, ringBytes: 8 })
  harness.buffer.push('aaaa')
  harness.buffer.push('你')
  harness.buffer.flush()
  harness.buffer.push('bb')
  harness.buffer.flush()
  harness.buffer.push('cccc')

  const replay = harness.buffer.replay(1)
  assert.deepEqual(replay.gap, { fromSeq: 1, toSeq: 2, droppedBytes: 7 })
  assert.deepEqual(replay.records, [
    { seq: 3, data: 'bb' },
    { seq: 4, data: 'cccc' }
  ])
  assert.equal(replay.nextSeq, 5)
  assert.equal(replay.more, false)
  assert.equal(harness.buffer.replay(3).gap, undefined)

  harness.buffer.addCredit(6)
  assert.deepEqual(harness.gaps, [{ fromSeq: 1, toSeq: 2, droppedBytes: 7 }])
  assert.deepEqual(harness.data, [
    { seq: 3, data: 'bb' },
    { seq: 4, data: 'cccc' }
  ])
})

test('does not report already-forwarded records as a live gap when retention evicts them', () => {
  const harness = createHarness({ batchBytes: 4, ringBytes: 8 })
  harness.buffer.addCredit(4)
  harness.buffer.push('1111')
  harness.buffer.push('2222')
  harness.buffer.push('3333')

  assert.deepEqual(harness.data, [{ seq: 1, data: '1111' }])
  assert.deepEqual(harness.gaps, [])

  harness.buffer.push('4444')
  harness.buffer.addCredit(8)
  assert.deepEqual(harness.gaps, [{ fromSeq: 2, toSeq: 2, droppedBytes: 4 }])
  assert.deepEqual(harness.data, [
    { seq: 1, data: '1111' },
    { seq: 3, data: '3333' },
    { seq: 4, data: '4444' }
  ])
})

test('gates forwarding on whole-record credit and caps outstanding credit', () => {
  const harness = createHarness({ batchBytes: 4, creditWindowBytes: 6 })
  harness.buffer.push('one!')
  harness.buffer.push('two!')
  assert.deepEqual(harness.data, [])

  assert.equal(harness.buffer.addCredit(99), 2)
  assert.deepEqual(harness.data, [{ seq: 1, data: 'one!' }])
  assert.equal(harness.buffer.addCredit(2), 0)
  assert.deepEqual(harness.data, [
    { seq: 1, data: 'one!' },
    { seq: 2, data: 'two!' }
  ])

  const defaults = createHarness()
  assert.equal(
    defaults.buffer.addCredit(TERMINAL_CREDIT_WINDOW_BYTES * 2),
    TERMINAL_CREDIT_WINDOW_BYTES
  )
  assert.equal(TERMINAL_CREDIT_WINDOW_BYTES, 512 * 1024)
  assert.equal(TERMINAL_RING_BUFFER_BYTES, 2 * 1024 * 1024)
})

test('pages replay results below the configured frame budget', () => {
  const harness = createHarness({
    batchBytes: 30,
    ringBytes: 1024,
    replayPageBytes: 180
  })
  for (const character of ['a', 'b', 'c', 'd']) {
    harness.buffer.push(character.repeat(30))
  }

  const first = harness.buffer.replay(1)
  assert.equal(first.more, true)
  assert.ok(first.records.length > 0)
  assert.ok(Buffer.byteLength(JSON.stringify(first), 'utf8') <= 180)

  const second = harness.buffer.replay(first.nextSeq)
  assert.equal(second.more, false)
  assert.ok(Buffer.byteLength(JSON.stringify(second), 'utf8') <= 180)
  assert.deepEqual(
    [...first.records, ...second.records].map((record) => record.seq),
    [1, 2, 3, 4]
  )
})

test('keeps default replay pages within the 256 KiB wire limit for escaped output', () => {
  const harness = createHarness()
  for (let index = 0; index < 5; index += 1) {
    harness.buffer.push('\\'.repeat(32 * 1024))
  }

  const records: TerminalDataRecord[] = []
  let nextSeq = 1
  let more = true
  while (more) {
    const page = harness.buffer.replay(nextSeq)
    assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= 256 * 1024)
    records.push(...page.records)
    nextSeq = page.nextSeq
    more = page.more
  }
  assert.deepEqual(
    records.map((record) => record.seq),
    [1, 2, 3, 4, 5]
  )
})

test('dispose cancels pending batching and rejects later output', () => {
  const harness = createHarness()
  harness.buffer.push('pending')
  assert.equal(harness.hasTimer(), true)
  harness.buffer.dispose()
  assert.equal(harness.hasTimer(), false)
  harness.fireTimer()
  assert.throws(() => harness.buffer.push('late'), /disposed/)
})
