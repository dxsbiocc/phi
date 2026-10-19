import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { useWorkspaceSidebar } from '../src/renderer/src/lib/app-shell/useWorkspaceSidebar'

/** Same capture pattern as app-dialogs-state.test.ts: read back through a property. */
function capture<T>(read: (state: ReturnType<typeof useWorkspaceSidebar>) => T): T {
  const box: { value?: T } = {}
  function Probe(): null {
    box.value = read(useWorkspaceSidebar())
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  assert.ok(box.value !== undefined, 'probe captured nothing')
  return box.value
}

test('the navigation sidebar starts closed on the conversations mode', () => {
  const state = capture((sidebar) => ({
    open: sidebar.isSidebarOpen,
    mode: sidebar.workspaceSidebarMode,
    preview: sidebar.workspaceSidebarPreview,
    sessionTabOpened: sidebar.sessionTabWasOpened,
    closedTabKeys: [...sidebar.closedWorkspaceSessionTabKeys],
    widthIsPositive: sidebar.sidebarWidth > 0
  }))

  assert.equal(state.open, false)
  assert.equal(state.mode, 'conversations')
  assert.equal(state.preview, null)
  assert.equal(state.sessionTabOpened, false)
  assert.deepEqual(state.closedTabKeys, [])
  assert.equal(state.widthIsPositive, true)
})

test('the hook returns setters for every value it owns', () => {
  const kinds = capture((sidebar) => ({
    open: typeof sidebar.setIsSidebarOpen,
    width: typeof sidebar.setSidebarWidth,
    mode: typeof sidebar.setWorkspaceSidebarMode,
    preview: typeof sidebar.setWorkspaceSidebarPreview,
    sessionTab: typeof sidebar.setSessionTabWasOpened,
    closedKeys: typeof sidebar.setClosedWorkspaceSessionTabKeys
  }))

  assert.deepEqual(kinds, {
    open: 'function',
    width: 'function',
    mode: 'function',
    preview: 'function',
    sessionTab: 'function',
    closedKeys: 'function'
  })
})
