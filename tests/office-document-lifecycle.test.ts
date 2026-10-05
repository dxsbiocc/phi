import assert from 'node:assert/strict'
import { test } from 'node:test'

import { hasOfficeDocumentKeepAlive } from '../src/main/agent/office/office-document-lifecycle'

test('panel, run, and queued operation references independently keep a document alive', () => {
  const states = [
    { panelReferences: 1, runReferences: 0, queueIdle: true },
    { panelReferences: 0, runReferences: 1, queueIdle: true },
    { panelReferences: 0, runReferences: 0, queueIdle: false },
    { panelReferences: 2, runReferences: 3, queueIdle: false }
  ]
  for (const state of states) assert.equal(hasOfficeDocumentKeepAlive(state), true)
  assert.equal(
    hasOfficeDocumentKeepAlive({ panelReferences: 0, runReferences: 0, queueIdle: true }),
    false
  )
})
