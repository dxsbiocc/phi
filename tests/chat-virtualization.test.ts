import assert from 'node:assert/strict'
import test from 'node:test'

import {
  chatVirtualWindow,
  normalizedChatVirtualRowHeight,
  type ChatVirtualItem
} from '../src/renderer/src/lib/chatVirtualization'

function chatItems(count: number): ChatVirtualItem[] {
  return Array.from({ length: count }, (_, index) => ({ id: `group-${index}` }))
}

test('chat virtual window renders every row for short conversations', () => {
  const items = chatItems(10)
  const virtualWindow = chatVirtualWindow(items, {}, { scrollTop: 0, viewportHeight: 400 })

  assert.equal(virtualWindow.enabled, false)
  assert.equal(virtualWindow.beforeHeight, 0)
  assert.equal(virtualWindow.afterHeight, 0)
  assert.deepEqual(
    virtualWindow.items.map(({ index }) => index),
    items.map((_, index) => index)
  )
})

test('chat virtual window returns only viewport rows and spacer heights for long conversations', () => {
  const items = chatItems(100)
  const virtualWindow = chatVirtualWindow(
    items,
    {},
    { scrollTop: 250, viewportHeight: 200 },
    { estimatedRowHeight: 100, overscanPx: 0, minimumRowCount: 10 }
  )

  assert.equal(virtualWindow.enabled, true)
  assert.equal(virtualWindow.startIndex, 2)
  assert.equal(virtualWindow.endIndex, 5)
  assert.equal(virtualWindow.beforeHeight, 200)
  assert.equal(virtualWindow.afterHeight, 9500)
  assert.equal(virtualWindow.totalHeight, 10000)
})

test('chat virtual window keeps the last group in the window when scrolled to the bottom', () => {
  const items = chatItems(50)
  const totalEstimated = 50 * chatVirtualEstimatedRowHeightForTest()
  const virtualWindow = chatVirtualWindow(
    items,
    {},
    { scrollTop: totalEstimated, viewportHeight: 400 }
  )

  assert.equal(virtualWindow.enabled, true)
  assert.equal(virtualWindow.endIndex, items.length)
  assert.equal(
    virtualWindow.items.at(-1)?.item.id,
    items.at(-1)?.id,
    'the newest group must stay mounted so streaming content keeps rendering while stuck to the bottom'
  )
})

function chatVirtualEstimatedRowHeightForTest(): number {
  // Mirrors chatVirtualEstimatedRowHeight without importing an internal;
  // kept in sync via the assertion above (a mismatch would fail the test).
  return 160
}

test('chat virtual row height normalization keeps rows measurable', () => {
  assert.equal(normalizedChatVirtualRowHeight(0), 160)
  assert.equal(normalizedChatVirtualRowHeight(Number.NaN), 160)
  assert.equal(normalizedChatVirtualRowHeight(12), 48)
  assert.equal(normalizedChatVirtualRowHeight(72.3), 73)
})
