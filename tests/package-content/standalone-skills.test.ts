import assert from 'node:assert/strict'
import test from 'node:test'

import { validateSkill } from '../../src/main/agent/content/skill'
import { packageContentPath } from '../helpers/packageContent'

test('distributed scripted meta skill skill-creator validates with phi:python@1', () => {
  const dir = packageContentPath('skills', 'skill-creator')
  const result = validateSkill(dir)
  assert.equal(result.ok, true, `skill-creator: ${JSON.stringify(result.errors)}`)
  assert.deepEqual(result.errors, [])
  assert.ok(result.skill)
  assert.equal(result.skill.phi?.environment, 'phi:python@1')
})

test('distributed zero-dependency research workflow skills validate cleanly', () => {
  for (const name of [
    'study-design',
    'statistical-review',
    'literature-review',
    'grant-proposal',
    'manuscript-writing',
    'manuscript-polishing',
    'manuscript-review',
    'peer-review-response',
    'humanizer',
    'paper-to-slides'
  ]) {
    const dir = packageContentPath('skills', name)
    const result = validateSkill(dir)
    assert.equal(result.ok, true, `${name}: ${JSON.stringify(result.errors)}`)
    assert.deepEqual(result.errors, [])
    assert.ok(result.skill)
    assert.equal(result.skill.phi?.environment, undefined)
  }
})
