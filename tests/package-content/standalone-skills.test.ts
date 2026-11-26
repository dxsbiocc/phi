import assert from 'node:assert/strict'
import test from 'node:test'

import { validateSkill } from '../../src/main/agent/content/skill'
import { packageContentPath } from '../helpers/packageContent'

test('distributed general Python skills validate with phi:python@1', () => {
  for (const name of ['matplotlib', 'scikit-learn', 'skill-creator']) {
    const dir = packageContentPath('skills', name)
    const result = validateSkill(dir)
    assert.equal(result.ok, true, `${name}: ${JSON.stringify(result.errors)}`)
    assert.deepEqual(result.errors, [])
    assert.ok(result.skill)
    assert.equal(result.skill.phi?.environment, 'phi:python@1')
  }
})

test('distributed domain skill rdkit validates with skill-local ./environment.yml', () => {
  const dir = packageContentPath('skills', 'rdkit')
  const result = validateSkill(dir)
  assert.equal(result.ok, true, `rdkit: ${JSON.stringify(result.errors)}`)
  assert.deepEqual(result.errors, [])
  assert.ok(result.skill)
  assert.equal(result.skill.phi?.environment, './environment.yml')
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
