import assert from 'node:assert/strict'
import test from 'node:test'
import {
  browserSidePanelWidthForViewport,
  closeWorkspaceSidePanelMode,
  emptyWorkspaceSidePanelState,
  openWorkspaceSidePanelMode,
  toggleWorkspaceSidePanelMaximized,
  toggleWorkspaceSidePanelMode,
  toggleWorkspaceSidePanelModeForLayout,
  type WorkspaceSidePanelState
} from '../src/renderer/src/lib/workspaceSidePanelMode'

test('each right-side button opens its panel and closes it on a second click', () => {
  for (const mode of ['jobs', 'terminal', 'browser'] as const) {
    const opened = toggleWorkspaceSidePanelMode(emptyWorkspaceSidePanelState, mode)
    assert.deepEqual(opened, { slots: [mode], maximized: null, active: mode })
    assert.deepEqual(toggleWorkspaceSidePanelMode(opened, mode), emptyWorkspaceSidePanelState)
  }
})

test('a second tool opens below the first and a third tool replaces the lower slot', () => {
  const jobs = openWorkspaceSidePanelMode(emptyWorkspaceSidePanelState, 'jobs')
  const jobsAndTerminal = openWorkspaceSidePanelMode(jobs, 'terminal')
  assert.deepEqual(jobsAndTerminal, {
    slots: ['jobs', 'terminal'],
    maximized: null,
    active: 'terminal'
  })
  assert.deepEqual(openWorkspaceSidePanelMode(jobsAndTerminal, 'browser'), {
    slots: ['jobs', 'browser'],
    maximized: null,
    active: 'browser'
  })
})

test('closing a slot preserves the other slot and clears its maximize state', () => {
  const state: WorkspaceSidePanelState = {
    slots: ['browser', 'terminal'],
    maximized: 'browser',
    active: 'browser'
  }
  assert.deepEqual(closeWorkspaceSidePanelMode(state, 'browser'), {
    slots: ['terminal'],
    maximized: null,
    active: 'terminal'
  })
})

test('maximizing a slot is reversible and opening an existing hidden slot restores both', () => {
  const split: WorkspaceSidePanelState = {
    slots: ['browser', 'terminal'],
    maximized: null,
    active: 'terminal'
  }
  const maximized = toggleWorkspaceSidePanelMaximized(split, 'browser')
  assert.deepEqual(maximized, {
    slots: ['browser', 'terminal'],
    maximized: 'browser',
    active: 'browser'
  })
  assert.deepEqual(toggleWorkspaceSidePanelMaximized(maximized, 'browser'), {
    ...maximized,
    maximized: null
  })
  assert.deepEqual(openWorkspaceSidePanelMode(maximized, 'terminal'), split)
})

test('an existing hidden compact slot becomes active before its toolbar button closes it', () => {
  const split: WorkspaceSidePanelState = {
    slots: ['browser', 'terminal'],
    maximized: null,
    active: 'terminal'
  }
  const focused = toggleWorkspaceSidePanelModeForLayout(split, 'browser', false)
  assert.deepEqual(focused, { ...split, active: 'browser' })
  assert.deepEqual(toggleWorkspaceSidePanelModeForLayout(focused, 'browser', false), {
    slots: ['terminal'],
    maximized: null,
    active: 'terminal'
  })
})

test('an open slot closes immediately when both slots are visible', () => {
  const split: WorkspaceSidePanelState = {
    slots: ['browser', 'terminal'],
    maximized: null,
    active: 'terminal'
  }
  assert.deepEqual(toggleWorkspaceSidePanelModeForLayout(split, 'browser', true), {
    slots: ['terminal'],
    maximized: null,
    active: 'terminal'
  })
})

test('browser width preserves useful workspace room before falling back to compact mode', () => {
  const width = (viewportWidth: number, sidebarWidth: number): number =>
    browserSidePanelWidthForViewport({
      preferredWidth: 600,
      viewportWidth,
      navigationWidth: 48 + sidebarWidth
    })

  assert.equal(width(860, 0), 492)
  assert.equal(width(860, 240), 252)
  assert.equal(width(860, 520), 240)
  assert.equal(width(1024, 0), 600)
  assert.equal(width(1024, 240), 416)
  assert.equal(width(1024, 520), 240)
  assert.equal(width(1200, 0), 600)
  assert.equal(width(1200, 240), 592)
  assert.equal(width(1200, 520), 312)
})
