import assert from 'node:assert/strict'
import test from 'node:test'

import {
  agentAvatarUrlForDisplayName,
  agentDisplayLabel
} from '../src/renderer/src/lib/agentAvatar'

test('Greek run names use their letter avatar and symbol', () => {
  assert.notEqual(agentAvatarUrlForDisplayName('Gamma'), agentAvatarUrlForDisplayName('Agent'))
  assert.equal(agentDisplayLabel('Gamma'), 'γ')
})

test('overflow run names reuse their letter avatar and append the run number to the symbol', () => {
  assert.equal(agentAvatarUrlForDisplayName('Alpha 2'), agentAvatarUrlForDisplayName('Alpha'))
  assert.equal(agentDisplayLabel('Alpha 2'), 'α2')
})

test('specialists, placeholders, and unknown names use the Phi avatar and keep their labels', () => {
  const fallback = agentAvatarUrlForDisplayName('Agent')
  assert.equal(agentAvatarUrlForDisplayName('Wrapper'), fallback)
  assert.equal(agentAvatarUrlForDisplayName('unknown'), fallback)
  assert.equal(agentDisplayLabel('Wrapper'), 'Wrapper')
  assert.equal(agentDisplayLabel('Agent'), 'Agent')
  assert.equal(agentDisplayLabel('unknown'), 'unknown')
})
