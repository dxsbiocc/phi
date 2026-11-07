import assert from 'node:assert/strict'
import test from 'node:test'

import { createAppRemoteSessionManager } from '../src/main/agent/remote-session-routing'

test('remote session manager keeps the Phi locator out of desktop journal opening', () => {
  const fresh = createAppRemoteSessionManager('/local/anchor', 'phi-session-id', false)
  assert.equal(fresh.kind, 'persistent')
  assert.equal(fresh.path, undefined)
  const resumed = createAppRemoteSessionManager('/local/anchor', 'phi-session-id', true)
  assert.equal(resumed.kind, 'open')
  assert.equal(resumed.path, 'phi-session:phi-session-id')
})
