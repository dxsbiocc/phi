import assert from 'node:assert/strict'
import test from 'node:test'
import {
  closeWorkspaceSidePanelMode,
  emptyWorkspaceSidePanelState,
  openWorkspaceSidePanelMode,
  toggleWorkspaceSidePanelMaximized,
  toggleWorkspaceSidePanelMode,
  toggleWorkspaceSidePanelModeForLayout,
  workspaceSidePanelSlotPlacement,
  workspaceSidePanelWidthForViewport,
  type WorkspaceSidePanelState
} from '../src/renderer/src/lib/workspaceSidePanelMode'

test('each right-side button opens its panel and closes it on a second click', () => {
  for (const mode of ['jobs', 'messages', 'terminal', 'browser'] as const) {
    const opened = toggleWorkspaceSidePanelMode(emptyWorkspaceSidePanelState, mode)
    assert.deepEqual(opened, { slots: [mode], maximized: null, active: mode })
    assert.deepEqual(toggleWorkspaceSidePanelMode(opened, mode), emptyWorkspaceSidePanelState)
  }
})

test('up to four right-side panels open concurrently without evicting earlier panels', () => {
  const jobs = openWorkspaceSidePanelMode(emptyWorkspaceSidePanelState, 'jobs')
  const two = openWorkspaceSidePanelMode(jobs, 'terminal')
  assert.deepEqual(two, {
    slots: ['jobs', 'terminal'],
    maximized: null,
    active: 'terminal'
  })
  const three = openWorkspaceSidePanelMode(two, 'messages')
  assert.deepEqual(three, {
    slots: ['jobs', 'terminal', 'messages'],
    maximized: null,
    active: 'messages'
  })
  const four = openWorkspaceSidePanelMode(three, 'browser')
  assert.deepEqual(four, {
    slots: ['jobs', 'terminal', 'messages', 'browser'],
    maximized: null,
    active: 'browser'
  })
})

test('slot placement maps 1-2 panels into one column and 3-4 panels into two columns', () => {
  assert.deepEqual(workspaceSidePanelSlotPlacement(0, 1), {
    columnCount: 1,
    rowCount: 1,
    gridColumn: 1,
    gridRow: 1,
    spansFullColumn: true
  })
  assert.deepEqual(workspaceSidePanelSlotPlacement(0, 2), {
    columnCount: 1,
    rowCount: 2,
    gridColumn: 1,
    gridRow: 1,
    spansFullColumn: false
  })
  assert.deepEqual(workspaceSidePanelSlotPlacement(1, 2), {
    columnCount: 1,
    rowCount: 2,
    gridColumn: 1,
    gridRow: 2,
    spansFullColumn: false
  })
  // 3 panels: first two stacked in column 1, third occupies full height of column 2.
  assert.deepEqual(workspaceSidePanelSlotPlacement(0, 3).gridColumn, 1)
  assert.deepEqual(workspaceSidePanelSlotPlacement(1, 3).gridColumn, 1)
  assert.deepEqual(workspaceSidePanelSlotPlacement(2, 3), {
    columnCount: 2,
    rowCount: 2,
    gridColumn: 2,
    gridRow: '1 / -1',
    spansFullColumn: true
  })
  // 4 panels: 2x2 across columns 1 and 2.
  assert.deepEqual(
    [0, 1, 2, 3].map((index) => {
      const p = workspaceSidePanelSlotPlacement(index, 4)
      return [p.gridColumn, p.gridRow]
    }),
    [
      [1, 1],
      [1, 2],
      [2, 1],
      [2, 2]
    ]
  )
})

test('closing a left-column panel when 4 panels are open keeps the remaining left panel on the left and right panels on the right', () => {
  const four: WorkspaceSidePanelState = {
    slots: ['terminal', 'browser', 'messages', 'jobs'],
    maximized: null,
    active: 'jobs'
  }
  const afterClosingLeftBottom = closeWorkspaceSidePanelMode(four, 'browser')
  assert.deepEqual(afterClosingLeftBottom, {
    slots: ['terminal', 'messages', 'jobs'],
    columns: [['terminal'], ['messages', 'jobs']],
    maximized: null,
    active: 'jobs'
  })
  // Left panel spans full height of column 1; right panels stay stacked in column 2.
  assert.deepEqual(workspaceSidePanelSlotPlacement(0, 3, afterClosingLeftBottom.columns), {
    columnCount: 2,
    rowCount: 2,
    gridColumn: 1,
    gridRow: '1 / -1',
    spansFullColumn: true
  })
  assert.deepEqual(workspaceSidePanelSlotPlacement(1, 3, afterClosingLeftBottom.columns), {
    columnCount: 2,
    rowCount: 2,
    gridColumn: 2,
    gridRow: 1,
    spansFullColumn: false
  })
  assert.deepEqual(workspaceSidePanelSlotPlacement(2, 3, afterClosingLeftBottom.columns), {
    columnCount: 2,
    rowCount: 2,
    gridColumn: 2,
    gridRow: 2,
    spansFullColumn: false
  })

  // Reopening browser refills the left column without moving right-column panels.
  assert.deepEqual(openWorkspaceSidePanelMode(afterClosingLeftBottom, 'browser'), {
    slots: ['terminal', 'browser', 'messages', 'jobs'],
    maximized: null,
    active: 'browser'
  })

  // Closing the remaining left panel collapses the two right panels into a single column.
  assert.deepEqual(closeWorkspaceSidePanelMode(afterClosingLeftBottom, 'terminal'), {
    slots: ['messages', 'jobs'],
    maximized: null,
    active: 'jobs'
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
  assert.deepEqual(toggleWorkspaceSidePanelModeForLayout(maximized, 'terminal', true), split)
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

test('workspace panel width preserves useful main-column room for every slot mode', () => {
  const width = (viewportWidth: number, sidebarWidth: number): number =>
    workspaceSidePanelWidthForViewport({
      preferredWidth: 600,
      viewportWidth,
      navigationWidth: 48 + sidebarWidth
    })

  assert.equal(width(860, 0), 492)
  assert.equal(width(860, 240), 252)
  assert.equal(width(860, 520), 240)
  assert.equal(width(1024, 0), 520)
  assert.equal(width(1024, 240), 416)
  assert.equal(width(1024, 520), 240)
  assert.equal(width(1200, 0), 520)
  assert.equal(width(1200, 240), 520)
  assert.equal(width(1200, 520), 312)
})
