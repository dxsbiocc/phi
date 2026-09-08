import assert from 'node:assert/strict'
import test from 'node:test'

import { getAppShortcutAction } from '../src/renderer/src/lib/appShortcuts'

test('app shortcut helper maps minimal beta shortcuts', () => {
  assert.equal(getAppShortcutAction({ key: 'n', metaKey: true }), 'new-chat')
  assert.equal(getAppShortcutAction({ key: 'k', ctrlKey: true }), 'focus-primary-input')
  assert.equal(getAppShortcutAction({ key: 'Escape' }), 'close-dialogs')
})

test('app shortcut helper ignores composing and expanded shortcut shapes', () => {
  assert.equal(getAppShortcutAction({ key: 'n', metaKey: true, isComposing: true }), null)
  assert.equal(getAppShortcutAction({ key: 'n', metaKey: true, shiftKey: true }), null)
  assert.equal(getAppShortcutAction({ key: 'k', ctrlKey: true, altKey: true }), null)
  assert.equal(getAppShortcutAction({ key: 'p', metaKey: true }), null)
})
