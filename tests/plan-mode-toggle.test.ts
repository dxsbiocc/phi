import assert from 'node:assert/strict'
import test from 'node:test'

import {
  planModeSendOptions,
  setDraftPlanMode
} from '../src/renderer/src/features/plan/hooks/usePlanModeToggle'

test('draft plan mode keeps three states independently and maps them to prompt flags', () => {
  let modes = setDraftPlanMode({}, 'draft-a', 'review')
  modes = setDraftPlanMode(modes, 'draft-b', 'execute')

  assert.deepEqual(planModeSendOptions(modes['draft-a']), { planMode: true })
  assert.deepEqual(planModeSendOptions(modes['draft-b']), { planExecute: true })
  assert.deepEqual(planModeSendOptions('execute', true), {})
  assert.deepEqual(modes, { 'draft-a': 'review', 'draft-b': 'execute' })
  assert.deepEqual(planModeSendOptions('off'), {})
  assert.deepEqual(setDraftPlanMode(modes, 'draft-a', 'off'), { 'draft-b': 'execute' })
})
