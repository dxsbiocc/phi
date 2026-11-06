import assert from 'node:assert/strict'
import test from 'node:test'

import { forkSourceBusy } from '../src/main/agent/session/fork-source-busy'

const idle = {
  runnerGetActiveRun: () => undefined,
  activePromptEntries: (): Array<[string, { phiSessionId: string; cancelled?: boolean }]> => []
}

test('an idle source session can be forked', () => {
  assert.equal(forkSourceBusy({ sessionId: 's1', status: 'idle' }, idle), false)
})

test('a prompt admitted for the source counts as running before its run starts', () => {
  const status = {
    ...idle,
    activePromptEntries: () =>
      [['key', { phiSessionId: 's1' }]] as Array<[string, { phiSessionId: string }]>
  }
  assert.equal(forkSourceBusy({ sessionId: 's1', status: 'idle' }, status), true)
})

test('a cancelled prompt or a prompt for another session does not block the fork', () => {
  const status = {
    ...idle,
    activePromptEntries: () =>
      [
        ['a', { phiSessionId: 's1', cancelled: true }],
        ['b', { phiSessionId: 's2' }]
      ] as Array<[string, { phiSessionId: string; cancelled?: boolean }]>
  }
  assert.equal(forkSourceBusy({ sessionId: 's1', status: 'idle' }, status), false)
})

test('a running, waiting or runner-tracked source is busy', () => {
  for (const state of ['running', 'needs_approval', 'needs_input']) {
    assert.equal(forkSourceBusy({ sessionId: 's1', status: state }, idle), true)
  }
  assert.equal(
    forkSourceBusy(
      { sessionId: 's1', status: 'idle' },
      { ...idle, runnerGetActiveRun: () => ({}) }
    ),
    true
  )
})
