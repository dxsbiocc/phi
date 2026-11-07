import assert from 'node:assert/strict'
import test from 'node:test'

import { greekSymbolForRunName } from '../src/shared/agentAvatar'

test('Greek run names map to lowercase symbols without changing specialist names', () => {
  assert.equal(greekSymbolForRunName('Gamma'), 'γ')
  assert.equal(greekSymbolForRunName('Alpha 2'), 'α2')
  assert.equal(greekSymbolForRunName('Omega 12'), 'ω12')
  assert.equal(greekSymbolForRunName('Phi'), undefined)
  assert.equal(greekSymbolForRunName('Wrapper'), undefined)
  assert.equal(greekSymbolForRunName('Agent'), undefined)
  assert.equal(greekSymbolForRunName('unknown'), undefined)
})

test('only generated overflow suffixes are recognized as Greek run names', () => {
  assert.equal(greekSymbolForRunName('Alpha 1'), undefined)
  assert.equal(greekSymbolForRunName('Alpha 02'), undefined)
  assert.equal(greekSymbolForRunName('Alpha2'), undefined)
  assert.equal(greekSymbolForRunName(' Alpha 2'), undefined)
})
