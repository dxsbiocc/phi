import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizedNotebookVirtualRowHeight,
  notebookVirtualWindow,
  type NotebookVirtualItem
} from '../src/renderer/src/features/analysis/lib/notebookVirtualization'

function notebookItems(count: number): NotebookVirtualItem[] {
  return Array.from({ length: count }, (_, index) => ({ id: `cell-${index}` }))
}

test('notebook virtual window renders every row for small notebooks', () => {
  const items = notebookItems(3)
  const virtualWindow = notebookVirtualWindow(items, {}, { scrollTop: 0, viewportHeight: 400 })

  assert.equal(virtualWindow.enabled, false)
  assert.equal(virtualWindow.beforeHeight, 0)
  assert.equal(virtualWindow.afterHeight, 0)
  assert.deepEqual(
    virtualWindow.items.map(({ index }) => index),
    [0, 1, 2]
  )
})

test('notebook virtual window returns only viewport rows and spacer heights', () => {
  const items = notebookItems(100)
  const virtualWindow = notebookVirtualWindow(
    items,
    {},
    { scrollTop: 250, viewportHeight: 200 },
    {
      estimatedRowHeight: 100,
      overscanPx: 0,
      minimumRowCount: 10
    }
  )

  assert.equal(virtualWindow.enabled, true)
  assert.equal(virtualWindow.startIndex, 2)
  assert.equal(virtualWindow.endIndex, 5)
  assert.equal(virtualWindow.beforeHeight, 200)
  assert.equal(virtualWindow.afterHeight, 9500)
  assert.equal(virtualWindow.totalHeight, 10000)
  assert.deepEqual(
    virtualWindow.items.map(({ index }) => index),
    [2, 3, 4]
  )
})

test('notebook virtual window uses measured row heights when available', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const virtualWindow = notebookVirtualWindow(
    items,
    { a: 80, b: 140, c: 60 },
    { scrollTop: 90, viewportHeight: 100 },
    { estimatedRowHeight: 100, overscanPx: 0, minimumRowCount: 0 }
  )

  assert.equal(virtualWindow.enabled, true)
  assert.deepEqual(virtualWindow.heights, [80, 140, 60])
  assert.deepEqual(virtualWindow.offsets, [0, 80, 220, 280])
  assert.equal(virtualWindow.beforeHeight, 80)
  assert.equal(virtualWindow.afterHeight, 60)
  assert.deepEqual(
    virtualWindow.items.map(({ item, index }) => [item.id, index]),
    [['b', 1]]
  )
})

test('notebook virtual row height normalization keeps rows measurable', () => {
  assert.equal(normalizedNotebookVirtualRowHeight(0), 220)
  assert.equal(normalizedNotebookVirtualRowHeight(Number.NaN), 220)
  assert.equal(normalizedNotebookVirtualRowHeight(12), 48)
  assert.equal(normalizedNotebookVirtualRowHeight(72.3), 73)
})
