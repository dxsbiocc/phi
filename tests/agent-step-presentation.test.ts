import assert from 'node:assert/strict'
import test from 'node:test'

import { agentStepExpanded, stepAsToolCall } from '../src/renderer/src/lib/agentStepPresentation'
import type { AgentExecutionStep } from '../src/renderer/src/lib/agentExecutionTypes'

const step = (overrides: Partial<AgentExecutionStep> = {}): AgentExecutionStep => ({
  id: 's1',
  toolName: 'db_search',
  argsPreview: 'THRSP UniProt',
  argsJson: '{"query":"THRSP"}',
  output: 'found it',
  status: 'done',
  ...overrides
})

// ── when a step row is open ──────────────────────────────────────────────

test('a finished step is folded, a running one is open so its output can be followed', () => {
  assert.equal(agentStepExpanded(step({ status: 'done' }), null), false)
  assert.equal(agentStepExpanded(step({ status: 'running' }), null), true)
})

test('a failed step stays open so the reason is in view', () => {
  assert.equal(agentStepExpanded(step({ status: 'error' }), null), true)
})

test('the user’s own choice wins over the automatic one, in both directions', () => {
  assert.equal(agentStepExpanded(step({ status: 'done' }), true), true)
  assert.equal(agentStepExpanded(step({ status: 'running' }), false), false)
  assert.equal(agentStepExpanded(step({ status: 'error' }), false), false)
})

test('a step folds itself when it finishes, unless the user opened it', () => {
  // The same step, before and after it finishes.
  assert.equal(agentStepExpanded(step({ status: 'running' }), null), true)
  assert.equal(agentStepExpanded(step({ status: 'done' }), null), false)
  assert.equal(agentStepExpanded(step({ status: 'done' }), true), true)
})

// ── a step as a tool call ────────────────────────────────────────────────

test('a step becomes a tool call the ordinary tool card can show', () => {
  const item = stepAsToolCall(
    step({
      createdAt: '2026-09-20T10:00:00.000Z',
      completedAt: '2026-09-20T10:00:04.000Z',
      durationMs: 4000,
      outputPath: '/tmp/out.txt',
      outputBytes: 42,
      outputTruncated: true,
      outputArtifact: { kind: 'tool_output', path: '/tmp/out.txt', bytes: 42 }
    })
  )
  assert.equal(item.role, 'tool')
  assert.equal(item.id, 's1')
  assert.equal(item.toolName, 'db_search')
  assert.equal(item.argsPreview, 'THRSP UniProt')
  assert.equal(item.output, 'found it')
  assert.equal(item.status, 'done')
  assert.equal(item.durationMs, 4000)
  assert.equal(item.completedAt, '2026-09-20T10:00:04.000Z')
  assert.equal(item.outputPath, '/tmp/out.txt')
  assert.equal(item.outputBytes, 42)
  assert.equal(item.outputTruncated, true)
  assert.deepEqual(item.outputArtifact, { kind: 'tool_output', path: '/tmp/out.txt', bytes: 42 })
})

test('optional parts of a step are left out, not set to undefined', () => {
  const item = stepAsToolCall(step())
  for (const key of ['createdAt', 'completedAt', 'durationMs', 'outputPath', 'outputBytes']) {
    assert.equal(key in item, false, key)
  }
})
