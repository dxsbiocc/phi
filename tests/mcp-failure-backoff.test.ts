import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MCP_BACKOFF_STEPS_MS,
  clearMcpServerBackoff,
  isMcpServerBackedOff,
  mcpConfigFingerprint,
  recordMcpServerFailure,
  recordMcpServerSuccess,
  resetMcpBackoffForTests
} from '../src/main/agent/engine/in-process/mcp-failure-backoff'

const [first, second, cap] = MCP_BACKOFF_STEPS_MS
const fp = mcpConfigFingerprint({ type: 'http', url: 'https://example.invalid/mcp' })

test('a failed server is skipped inside the window and retried after it', () => {
  resetMcpBackoffForTests()
  recordMcpServerFailure('a', 'srv', fp, 1000)
  assert.equal(isMcpServerBackedOff('a', 'srv', fp, 1000 + first - 1), true)
  assert.equal(isMcpServerBackedOff('a', 'srv', fp, 1000 + first), false)
})

test('repeated failures lengthen the window up to the cap', () => {
  resetMcpBackoffForTests()
  recordMcpServerFailure('a', 'srv', fp, 0)
  recordMcpServerFailure('a', 'srv', fp, 0)
  assert.equal(isMcpServerBackedOff('a', 'srv', fp, second - 1), true)
  assert.equal(isMcpServerBackedOff('a', 'srv', fp, second), false)
  for (let i = 0; i < 5; i++) recordMcpServerFailure('a', 'srv', fp, 0)
  assert.equal(isMcpServerBackedOff('a', 'srv', fp, cap - 1), true)
  assert.equal(isMcpServerBackedOff('a', 'srv', fp, cap), false)
})

test('a config change retries at once and restarts the schedule', () => {
  resetMcpBackoffForTests()
  recordMcpServerFailure('a', 'srv', fp, 0)
  recordMcpServerFailure('a', 'srv', fp, 0)
  const edited = mcpConfigFingerprint({ type: 'http', url: 'https://example.invalid/v2' })
  assert.equal(isMcpServerBackedOff('a', 'srv', edited, 1), false)
  recordMcpServerFailure('a', 'srv', edited, 0)
  assert.equal(isMcpServerBackedOff('a', 'srv', edited, first), false)
})

test('success and user actions clear the back-off', () => {
  resetMcpBackoffForTests()
  recordMcpServerFailure('a', 'srv', fp, 0)
  recordMcpServerSuccess('a', 'srv')
  assert.equal(isMcpServerBackedOff('a', 'srv', fp, 1), false)
  recordMcpServerFailure('a', 'srv', fp, 0)
  recordMcpServerFailure('b', 'srv', fp, 0)
  clearMcpServerBackoff('srv')
  assert.equal(isMcpServerBackedOff('a', 'srv', fp, 1), false)
  assert.equal(isMcpServerBackedOff('b', 'srv', fp, 1), false)
})
