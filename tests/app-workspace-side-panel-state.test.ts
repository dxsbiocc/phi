import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  maxWorkspaceSidePanelWidth,
  minWorkspaceSidePanelWidth,
  useWorkspaceSidePanel,
  type WorkspaceSidePanelController
} from '../src/renderer/src/lib/app-shell/useWorkspaceSidePanel'

/**
 * The hook only needs a window to read the viewport and to subscribe to
 * resizes. Rendering to string runs no effects, so a plain stub is enough.
 */
function stubViewport(width: number, height: number): void {
  const listeners = new Map<string, () => void>()
  ;(globalThis as { window?: unknown }).window = {
    innerWidth: width,
    innerHeight: height,
    addEventListener: (type: string, listener: () => void) => {
      listeners.set(type, listener)
    },
    removeEventListener: (type: string) => {
      listeners.delete(type)
    }
  }
}

function capture(
  read: (panel: WorkspaceSidePanelController) => unknown,
  options: { navigationWidth?: number } = {}
): unknown {
  const box: { value?: unknown } = {}
  function Probe(): null {
    box.value = read(useWorkspaceSidePanel({ navigationWidth: options.navigationWidth ?? 0 }))
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  return box.value
}

test.afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

test('a fresh side panel is collapsed and owns no width until a slot opens', () => {
  stubViewport(1440, 900)
  const state = capture((panel) => ({
    slots: panel.slots,
    collapsed: panel.collapsed,
    maximized: panel.state.maximized,
    active: panel.state.active,
    treeRevision: panel.treeRevision
  })) as {
    slots: unknown[]
    collapsed: boolean
    maximized: unknown
    active: unknown
    treeRevision: number
  }

  assert.deepEqual(state.slots, [])
  assert.equal(state.collapsed, true)
  assert.equal(state.maximized, null)
  assert.equal(state.active, null)
  assert.equal(state.treeRevision, 0)
})

test('two slots may share the dock only in a large enough window', () => {
  stubViewport(1440, 900)
  assert.equal(
    capture((panel) => panel.canSplit),
    true
  )

  // Same width, too short: the workspace below would be unusable.
  stubViewport(1440, 600)
  assert.equal(
    capture((panel) => panel.canSplit),
    false
  )

  stubViewport(1100, 900)
  assert.equal(
    capture((panel) => panel.canSplit),
    false
  )
})

test('a narrow window floats the panel and keeps it inside the viewport', () => {
  stubViewport(1000, 800)
  const state = capture((panel) => ({
    overlay: panel.overlay,
    activeWidth: panel.activeWidth
  })) as { overlay: boolean; activeWidth: number }

  assert.equal(state.overlay, true)
  assert.ok(state.activeWidth <= 1000 - 16)
  assert.ok(state.activeWidth >= 0)
})

test('a wide window docks the panel at its preferred width', () => {
  stubViewport(1600, 1000)
  const state = capture((panel) => ({
    overlay: panel.overlay,
    activeWidth: panel.activeWidth
  })) as { overlay: boolean; activeWidth: number }

  assert.equal(state.overlay, false)
  assert.ok(state.activeWidth >= minWorkspaceSidePanelWidth)
  assert.ok(state.activeWidth <= maxWorkspaceSidePanelWidth)
})

test('the hook exposes one action per user gesture plus a tree refresh', () => {
  stubViewport(1440, 900)
  const kinds = capture((panel) => ({
    open: typeof panel.open,
    close: typeof panel.close,
    toggleForLayout: typeof panel.toggleForLayout,
    toggleMaximized: typeof panel.toggleMaximized,
    refreshTree: typeof panel.refreshTree,
    startResize: typeof panel.startResize
  })) as Record<string, string>

  assert.deepEqual(kinds, {
    open: 'function',
    close: 'function',
    toggleForLayout: 'function',
    toggleMaximized: 'function',
    refreshTree: 'function',
    startResize: 'function'
  })
})
