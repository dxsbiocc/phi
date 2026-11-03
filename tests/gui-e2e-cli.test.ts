import assert from 'node:assert/strict'
import test from 'node:test'

import { parseCli } from '../scripts/gui-e2e/cli'
import { SCENARIO_NAMES } from '../scripts/gui-e2e/types'

test('dry-run accepts the requested model', () => {
  const options = parseCli(['--app', 'Phi.app', '--model', 'Grok 4.5 Fast', '--dry-run'])
  assert.equal(options.model, 'Grok 4.5 Fast')
})

test('notebook switching runs after session-creating scenarios by default', () => {
  assert.equal(SCENARIO_NAMES.at(-1), 'notebook-switch')
  assert.ok(SCENARIO_NAMES.slice(0, -1).includes('switch-servers'))
})
