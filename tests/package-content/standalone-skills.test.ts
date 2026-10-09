import assert from 'node:assert/strict'
import test from 'node:test'

import { validateSkill } from '../../src/main/agent/content/skill'
import { packageContentPath } from '../helpers/packageContent'

test('distributed scanpy validates with phi:python@1', () => {
  const dir = packageContentPath('skills', 'scanpy')
  const result = validateSkill(dir)
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.warnings, [])
  assert.ok(result.skill)
  assert.equal(result.skill.phi?.environment, 'phi:python@1')
})
