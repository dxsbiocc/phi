import assert from 'node:assert/strict'
import test from 'node:test'
import { previewBoundsContainPointer } from '../src/renderer/src/lib/workspaceSidebarPreviewPointer'

const bounds = { left: 54, top: 100, right: 334, bottom: 520 }

test('the full popup rectangle retains its title, controls and tooltip-covered text', () => {
  for (const point of [
    { x: 120, y: 120 },
    { x: 330, y: 300 },
    { x: 180, y: 400 }
  ]) {
    assert.equal(previewBoundsContainPointer(point, bounds), true)
  }
})

test('the six-pixel icon bridge belongs to the popup region', () => {
  assert.equal(previewBoundsContainPointer({ x: 50, y: 180 }, bounds, 6), true)
  assert.equal(previewBoundsContainPointer({ x: 47, y: 180 }, bounds, 6), false)
})

test('points outside the popup close it without relying on the hovered DOM target', () => {
  for (const point of [
    { x: 340, y: 300 },
    { x: 100, y: 99 },
    { x: 100, y: 521 }
  ]) {
    assert.equal(previewBoundsContainPointer(point, bounds), false)
  }
  assert.equal(previewBoundsContainPointer(null, bounds), false)
  assert.equal(previewBoundsContainPointer({ x: 54, y: 100 }, { ...bounds, right: 54 }), false)
})
