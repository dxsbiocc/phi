import assert from 'node:assert/strict'
import test from 'node:test'
import {
  initialNavigationHistory,
  navigationHistoryTargetIndex,
  navigationRestorationSettled,
  recordNavigationEntry,
  type NavigationHistoryEntry
} from '../src/renderer/src/lib/navigationHistory'

function entry(
  view: NavigationHistoryEntry['view'],
  sessionPath: string | null = null
): NavigationHistoryEntry {
  return { view, sessionPath }
}

test('a fresh history starts with just the initial entry, nothing to go back/forward to', () => {
  const history = initialNavigationHistory(entry('chat'))

  assert.equal(history.entries.length, 1)
  assert.equal(navigationHistoryTargetIndex(history, 'back'), null)
  assert.equal(navigationHistoryTargetIndex(history, 'forward'), null)
})

test('recording a new entry appends it and moves the index to the end', () => {
  let history = initialNavigationHistory(entry('chat'))
  history = recordNavigationEntry(history, entry('runtime'))

  assert.deepEqual(history.entries, [entry('chat'), entry('runtime')])
  assert.equal(history.index, 1)
  assert.equal(navigationHistoryTargetIndex(history, 'back'), 0)
})

test('recording the same entry as the current one is a no-op (identical object returned)', () => {
  const history = initialNavigationHistory(entry('chat'))
  const next = recordNavigationEntry(history, entry('chat'))

  assert.equal(
    next,
    history,
    'expected the exact same state, not a new object, when nothing changed'
  )
})

test('recording after going back drops the forward entries, like a real browser', () => {
  let history = initialNavigationHistory(entry('chat'))
  history = recordNavigationEntry(history, entry('runtime'))
  history = recordNavigationEntry(history, entry('plugins'))
  // back to 'runtime'
  const backIndex = navigationHistoryTargetIndex(history, 'back')
  assert.equal(backIndex, 1)
  history = { ...history, index: backIndex! }

  // Now navigate somewhere new from the middle of the stack.
  history = recordNavigationEntry(history, entry('skills'))

  assert.deepEqual(history.entries, [entry('chat'), entry('runtime'), entry('skills')])
  assert.equal(history.index, 2)
  assert.equal(
    navigationHistoryTargetIndex(history, 'forward'),
    null,
    'the dropped "plugins" entry is gone'
  )
})

test('chat session switches are tracked as distinct entries, not just top-level view switches', () => {
  let history = initialNavigationHistory(entry('chat', 'session-a'))
  history = recordNavigationEntry(history, entry('chat', 'session-b'))

  assert.equal(history.entries.length, 2)
  assert.equal(navigationHistoryTargetIndex(history, 'back'), 0)
})

test('navigationRestorationSettled: a pure view change (no session in the target) settles as soon as the view matches', () => {
  const target = entry('runtime')
  assert.equal(navigationRestorationSettled(target, entry('plugins')), false)
  assert.equal(navigationRestorationSettled(target, entry('runtime')), true)
})

test('navigationRestorationSettled: a session-carrying target waits for both the view and the async session switch to land', () => {
  const target = entry('chat', 'session-b')

  // View has committed (synchronous setActiveView) but the IPC session
  // switch hasn't landed yet -- must not report settled.
  assert.equal(navigationRestorationSettled(target, entry('chat', 'session-a')), false)
  // Both now match.
  assert.equal(navigationRestorationSettled(target, entry('chat', 'session-b')), true)
})
