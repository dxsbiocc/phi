import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserRendererBridge, BrowserViewport } from '../src/shared/browserTypes'
import {
  browserViewportRectsOverlap,
  createBrowserViewportScheduler
} from '../src/renderer/src/features/browser/hooks/useBrowserViewport'

const viewport: BrowserViewport = { x: 900, y: 80, width: 340, height: 500 }

test('a left sidebar preview does not block a separate browser viewport', () => {
  assert.equal(
    browserViewportRectsOverlap(viewport, { x: 48, y: 90, width: 280, height: 180 }),
    false
  )
})

test('a preview blocks only positive-area intersections with browser content', () => {
  assert.equal(
    browserViewportRectsOverlap(viewport, { x: 880, y: 90, width: 280, height: 180 }),
    true
  )
  assert.equal(
    browserViewportRectsOverlap(viewport, { x: 900, y: 0, width: 280, height: 80 }),
    false
  )
  assert.equal(
    browserViewportRectsOverlap(viewport, { x: 620, y: 90, width: 280, height: 180 }),
    false
  )
  assert.equal(
    browserViewportRectsOverlap(viewport, { x: 900, y: 700, width: 280, height: 180 }),
    false
  )
  assert.equal(
    browserViewportRectsOverlap(viewport, { x: 900, y: 90, width: 0, height: 180 }),
    false
  )
})

test('a queued browser frame rechecks a preview that moved before delivery', () => {
  let preview = { x: 48, y: 90, width: 280, height: 180 }
  const updates: Array<BrowserViewport | null> = []
  const frames = new Map<number, (time: number) => void>()
  let nextId = 0
  const bridge: BrowserRendererBridge = {
    snapshot: async () => {
      throw new Error('not used')
    },
    execute: async () => {
      throw new Error('not used')
    },
    onEvent: () => () => undefined,
    setViewport: async (request) => {
      updates.push(request.viewport)
    }
  }
  const scheduler = createBrowserViewportScheduler({
    bridge,
    sessionId: 'session',
    sessionGeneration: 1,
    tabId: 'tab',
    getRect: () => (browserViewportRectsOverlap(viewport, preview) ? null : viewport),
    requestFrame: (callback) => {
      frames.set(++nextId, callback)
      return nextId
    },
    cancelFrame: (id) => frames.delete(id)
  })
  const runFrame = (): void => {
    const entry = frames.entries().next().value
    assert.ok(entry)
    frames.delete(entry[0])
    entry[1](0)
  }

  scheduler.schedule()
  preview = { ...preview, x: 880 }
  runFrame()
  assert.deepEqual(updates, [null])

  scheduler.schedule()
  preview = { ...preview, x: 48 }
  runFrame()
  assert.deepEqual(updates, [null, viewport])

  scheduler.schedule()
  scheduler.dispose()
  assert.equal(frames.size, 0)
  assert.deepEqual(updates, [null, viewport, null])
})
