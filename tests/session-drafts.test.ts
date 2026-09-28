import assert from 'node:assert/strict'
import test from 'node:test'

import { sessionDraftKey, updateSessionDraft } from '../src/renderer/src/lib/sessionDrafts'

test('sessionDraftKey scopes persisted sessions by runtime path', () => {
  assert.equal(
    sessionDraftKey({ path: 'session-a.jsonl', cwd: '/workspace', sessionGeneration: 1 }),
    'path:session-a.jsonl'
  )
})

test('sessionDraftKey scopes Phi-managed sessions by stable session id', () => {
  assert.equal(
    sessionDraftKey({
      phiSessionId: 'phi-1',
      path: 'session-a.jsonl',
      cwd: '/workspace',
      sessionGeneration: 1
    }),
    'phi:phi-1'
  )
})

test('remote project draft key survives reconnects without depending on the SDK anchor', () => {
  const first = sessionDraftKey({
    phiSessionId: 'remote-session-1',
    path: 'phi-session:remote-session-1',
    cwd: '/home/user/.phi/remote-project-anchors/project-a',
    sessionGeneration: 1
  })
  const restored = sessionDraftKey({
    phiSessionId: 'remote-session-1',
    path: 'phi-session:remote-session-1',
    cwd: '/home/user/.phi/remote-project-anchors/project-a',
    sessionGeneration: 2
  })
  assert.equal(first, restored)
  assert.equal(first, 'phi:remote-session-1')
})

test('sessionDraftKey keeps fresh sessions separated by generation', () => {
  assert.notEqual(
    sessionDraftKey({ path: null, cwd: '/workspace', sessionGeneration: 1 }),
    sessionDraftKey({ path: null, cwd: '/workspace', sessionGeneration: 2 })
  )
})

test('updateSessionDraft stores and clears only the requested session draft', () => {
  const first = updateSessionDraft({}, 'path:a', 'draft a')
  const second = updateSessionDraft(first, 'path:b', 'draft b')
  const cleared = updateSessionDraft(second, 'path:a', '')

  assert.deepEqual(cleared, { 'path:b': 'draft b' })
})
