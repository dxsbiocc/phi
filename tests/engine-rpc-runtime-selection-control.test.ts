import assert from 'node:assert/strict'
import test from 'node:test'
import { selectionThinking } from '../src/main/agent/engine/rpc/runtime-selection-control'
import type { RuntimeModel } from '../src/main/agent/engine/types'

const model: RuntimeModel = {
  provider: 'fixture',
  id: 'declared-thinking-efforts',
  name: 'Declared efforts',
  reasoning: true
}
const onlySpecial = {
  minimal: null,
  low: null,
  medium: null,
  high: null,
  xhigh: 'xhigh',
  max: 'max'
} as const

test('automatic reasoning defaults to high before any supported special tiers', () => {
  assert.deepEqual(
    selectionThinking({ ...model, thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } }, undefined),
    { phi: 'high', rpc: 'high' }
  )
})

test('automatic fallback selects the highest supported regular effort instead of max', () => {
  const declared = { ...model, thinkingLevelMap: { high: null, xhigh: 'xhigh', max: 'max' } }
  assert.deepEqual(selectionThinking(declared, undefined), { phi: 'medium', rpc: 'medium' })
  assert.deepEqual(selectionThinking(declared, 'high'), { phi: 'medium', rpc: 'medium' })
})

test('a valid low/xhigh effort declaration defaults to low, never automatically xhigh', () => {
  const declared = { ...model, thinkingLevelMap: { ...onlySpecial, low: 'low', max: null } }
  assert.deepEqual(selectionThinking(declared, undefined), { phi: 'low', rpc: 'low' })
  assert.deepEqual(selectionThinking(declared, 'high'), { phi: 'low', rpc: 'low' })
})

test('without a supported regular effort automatic selection stays off', () => {
  const declared = { ...model, thinkingLevelMap: onlySpecial }
  assert.deepEqual(selectionThinking(declared, undefined), { phi: undefined, rpc: 'off' })
  assert.deepEqual(selectionThinking(declared, 'high'), { phi: undefined, rpc: 'off' })
})

for (const desired of ['xhigh', 'max'] as const)
  test(`saved and explicit supported ${desired} remain selectable without regular efforts`, () => {
    const declared = { ...model, thinkingLevelMap: onlySpecial }
    assert.deepEqual(selectionThinking(declared, desired), { phi: desired, rpc: desired })
    assert.deepEqual(selectionThinking(declared, desired, true), { phi: desired, rpc: desired })
  })

test('nonreasoning and unsupported explicit choices keep their existing validation', () => {
  const ordinary = { ...model, reasoning: false }
  assert.deepEqual(selectionThinking(ordinary, 'high'), { phi: undefined, rpc: 'off' })
  assert.throws(() => selectionThinking(ordinary, 'high', true), /Unsupported thinking level/)
  assert.throws(
    () => selectionThinking({ ...model, thinkingLevelMap: { high: null } }, 'high', true),
    /Unsupported thinking level/
  )
  assert.deepEqual(
    selectionThinking(
      { ...model, thinkingLevelMap: { ...onlySpecial, xhigh: null, max: null } },
      undefined
    ),
    { phi: undefined, rpc: 'off' }
  )
  // Explicit SDK-supported tiers with absent optional metadata remain confirmed by the runtime.
  assert.deepEqual(selectionThinking(model, 'xhigh', true), { phi: 'xhigh', rpc: 'xhigh' })
})
