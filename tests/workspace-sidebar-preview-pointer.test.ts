import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isPointerWithinWorkspaceSidebarPreview,
  previewBoundsContainPointer,
  trackWorkspaceSidebarPointer
} from '../src/renderer/src/lib/workspaceSidebarPreviewPointer'

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

test('pointer exit without a DOM destination rechecks geometry instead of pinning hover', () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const region = { getBoundingClientRect: () => bounds }
  const documentElement = new EventTarget()
  const documentTarget = Object.assign(new EventTarget(), {
    documentElement,
    querySelectorAll: () => [],
    querySelector: (selector: string) =>
      selector.includes('data-phi-workspace-sidebar-preview-region') ? region : null,
    getElementById: () => region
  })
  const windowTarget = Object.assign(new EventTarget(), {
    innerWidth: 1000,
    innerHeight: 800,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' })
  })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentTarget })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: windowTarget })
  let release: (() => void) | undefined
  try {
    let changes = 0
    release = trackWorkspaceSidebarPointer(() => changes++)
    documentTarget.dispatchEvent(
      Object.assign(new Event('pointermove'), { clientX: 120, clientY: 180 })
    )
    assert.equal(isPointerWithinWorkspaceSidebarPreview(), true, 'initial pointer move')
    documentTarget.dispatchEvent(
      Object.assign(new Event('pointerout'), {
        clientX: 120,
        clientY: 180,
        relatedTarget: null
      })
    )
    assert.equal(changes, 2)
    assert.equal(isPointerWithinWorkspaceSidebarPreview(), true, 'pointerout inside popup')
    documentElement.dispatchEvent(new Event('pointerleave'))
    assert.equal(changes, 3)
    assert.equal(isPointerWithinWorkspaceSidebarPreview(), false, 'pointer left renderer root')
    documentTarget.dispatchEvent(
      Object.assign(new Event('pointermove'), { clientX: 120, clientY: 180 })
    )
    documentTarget.dispatchEvent(
      Object.assign(new Event('pointerout'), {
        clientX: 500,
        clientY: 180,
        relatedTarget: null
      })
    )
    assert.equal(changes, 5)
    assert.equal(isPointerWithinWorkspaceSidebarPreview(), false)
  } finally {
    release?.()
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else Reflect.deleteProperty(globalThis, 'document')
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
