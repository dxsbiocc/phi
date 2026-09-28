import assert from 'node:assert/strict'
import test from 'node:test'
import { toggleWorkspaceSidePanelMode } from '../src/renderer/src/lib/workspaceSidePanelMode'

test('each right-side button opens its panel and closes it on a second click', () => {
  for (const mode of ['jobs', 'terminal', 'browser'] as const) {
    assert.equal(toggleWorkspaceSidePanelMode(null, mode), mode)
    assert.equal(toggleWorkspaceSidePanelMode(mode, mode), null)
  }
})

test('a different right-side button switches the visible panel', () => {
  assert.equal(toggleWorkspaceSidePanelMode('jobs', 'terminal'), 'terminal')
  assert.equal(toggleWorkspaceSidePanelMode('terminal', 'browser'), 'browser')
  assert.equal(toggleWorkspaceSidePanelMode('browser', 'jobs'), 'jobs')
})
