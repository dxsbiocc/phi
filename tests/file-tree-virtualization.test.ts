import assert from 'node:assert/strict'
import test from 'node:test'

import {
  fileTreeVirtualWindow,
  normalizedFileTreeVirtualRowHeight,
  type FileTreeVirtualItem
} from '../src/renderer/src/lib/fileTreeVirtualization'

function rows(count: number): FileTreeVirtualItem[] {
  return Array.from({ length: count }, (_, index) => ({ id: `row-${index}` }))
}

test('file tree virtual window renders every row for a typical project', () => {
  const items = rows(50)
  const virtualWindow = fileTreeVirtualWindow(items, {}, { scrollTop: 0, viewportHeight: 400 })

  assert.equal(virtualWindow.enabled, false)
  assert.deepEqual(
    virtualWindow.items.map(({ index }) => index),
    items.map((_, index) => index)
  )
})

test('file tree virtual window windows rows once many directories are expanded', () => {
  const items = rows(1000)
  // estimatedRowHeight (32) is below virtualMinimumMeasuredRowHeight (48), so
  // the effective row height used is the clamped 48 — matches how notebook
  // and chat virtualization resolve their own estimates.
  const virtualWindow = fileTreeVirtualWindow(
    items,
    {},
    { scrollTop: 3200, viewportHeight: 400 },
    { estimatedRowHeight: 32, overscanPx: 0, minimumRowCount: 150 }
  )

  assert.equal(virtualWindow.enabled, true)
  assert.equal(virtualWindow.startIndex, 66)
  assert.equal(virtualWindow.endIndex, 76)
})

test('file tree virtual row height normalization keeps rows measurable', () => {
  assert.equal(normalizedFileTreeVirtualRowHeight(0), 32)
  assert.equal(normalizedFileTreeVirtualRowHeight(Number.NaN), 32)
  assert.equal(normalizedFileTreeVirtualRowHeight(12), 48)
  assert.equal(normalizedFileTreeVirtualRowHeight(60.2), 61)
})
