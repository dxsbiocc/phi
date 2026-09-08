import assert from 'node:assert/strict'
import test from 'node:test'

import { applyPhiAgentEnvironment, DEFAULT_MOONSHOT_BASE_URL } from '../src/main/agent-env'

test('agent env defaults Moonshot to the current Kimi Open Platform endpoint', () => {
  const env: NodeJS.ProcessEnv = {}

  applyPhiAgentEnvironment(env)

  assert.equal(env.MOONSHOT_BASE_URL, DEFAULT_MOONSHOT_BASE_URL)
})

test('agent env preserves an explicit Moonshot base URL override', () => {
  const env: NodeJS.ProcessEnv = {
    MOONSHOT_BASE_URL: 'https://example.local/v1'
  }

  applyPhiAgentEnvironment(env)

  assert.equal(env.MOONSHOT_BASE_URL, 'https://example.local/v1')
})
