import assert from 'node:assert/strict'
import test from 'node:test'

import { sessionDraftKey, updateSessionDraft } from '../src/renderer/src/lib/sessionDrafts'

test('sessionDraftKey scopes persisted sessions by runtime path', () => {
  assert.equal(
    sessionDraftKey({ path: 'session-a.jsonl', cwd: '/workspace', sessionGeneration: 1 }),
    'path:session-a.jsonl'
  )
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
