import assert from 'node:assert/strict'
import test from 'node:test'

import {
  fieldsFromMode,
  modeFromFields,
  SESSION_MODE_PRESETS,
  type SessionMode
} from '../src/shared/sessionMode'

const expected = {
  auto: { workMode: 'auto', permissionMode: 'auto' },
  ask: { workMode: 'direct', permissionMode: 'ask' },
  plan: { workMode: 'plan', permissionMode: 'auto' },
  plan_execute: { workMode: 'plan_execute', permissionMode: 'auto' },
  full: { workMode: 'direct', permissionMode: 'full' }
} as const

test('session mode presets map every public mode to its persisted fields', () => {
  assert.deepEqual(SESSION_MODE_PRESETS, expected)
  for (const mode of Object.keys(expected) as SessionMode[]) {
    assert.deepEqual(fieldsFromMode(mode), expected[mode])
    assert.equal(modeFromFields(expected[mode]), mode)
  }
})

test('legacy records infer their session mode from permissionMode without workMode', () => {
  assert.equal(modeFromFields({ permissionMode: 'ask' }), 'ask')
  assert.equal(modeFromFields({ permissionMode: 'auto' }), 'auto')
  assert.equal(modeFromFields({ permissionMode: 'full' }), 'full')
})

test('plan work modes win over permission fields while direct preserves approval intent', () => {
  for (const permissionMode of ['ask', 'auto', 'full'] as const) {
    assert.equal(modeFromFields({ workMode: 'plan', permissionMode }), 'plan')
    assert.equal(modeFromFields({ workMode: 'plan_execute', permissionMode }), 'plan_execute')
  }
  assert.equal(modeFromFields({ workMode: 'direct', permissionMode: 'ask' }), 'ask')
  assert.equal(modeFromFields({ workMode: 'direct', permissionMode: 'auto' }), 'auto')
  assert.equal(modeFromFields({ workMode: 'direct', permissionMode: 'full' }), 'full')
  assert.equal(modeFromFields({ workMode: 'auto', permissionMode: 'ask' }), 'auto')
  assert.equal(modeFromFields({ workMode: 'auto', permissionMode: 'full' }), 'auto')
})

test('fieldsFromMode returns independent immutable values', () => {
  const first = fieldsFromMode('plan')
  const second = fieldsFromMode('plan')
  assert.notEqual(first, second)
  assert.deepEqual(first, expected.plan)
})
