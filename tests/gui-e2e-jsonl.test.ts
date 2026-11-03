import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  logEntriesSince,
  parseAppLogJsonl,
  parseJsonl,
  readAppLogDirectory
} from '../scripts/gui-e2e/jsonl'

test('parseJsonl returns records and non-sensitive issue metadata', () => {
  const parsed = parseJsonl(
    ['{"event":"run_started"}', 'not-json secret-token', '["not", "an", "object"]', ''].join('\n')
  )

  assert.deepEqual(parsed.records, [{ lineNumber: 1, value: { event: 'run_started' } }])
  assert.deepEqual(parsed.issues, [
    { lineNumber: 2, reason: 'invalid-json' },
    { lineNumber: 3, reason: 'non-object' }
  ])
  assert.doesNotMatch(JSON.stringify(parsed.issues), /secret-token/)
})

test('parseAppLogJsonl accepts valid app log events and ignores unrelated records', () => {
  const parsed = parseAppLogJsonl(
    [
      JSON.stringify({
        timestamp: '2026-11-02T01:02:03.000Z',
        event: 'run_completed',
        runId: 'run-1',
        metadata: { target: 'gpu' }
      }),
      JSON.stringify({ type: 'assistant_message_finalized' })
    ].join('\n')
  )

  assert.equal(parsed.entries.length, 1)
  assert.equal(parsed.entries[0].event, 'run_completed')
  assert.equal(parsed.entries[0].metadata?.target, 'gpu')
  assert.deepEqual(parsed.issues, [])
})

test('readAppLogDirectory reads dated JSONL files in order and filters by timestamp', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-gui-log-test-'))
  try {
    mkdirSync(root, { recursive: true })
    writeFileSync(
      join(root, '2026-11-01.jsonl'),
      `${JSON.stringify({ timestamp: '2026-11-01T23:59:59.000Z', event: 'run_started' })}\n`
    )
    writeFileSync(
      join(root, '2026-11-02.jsonl'),
      `${JSON.stringify({ timestamp: '2026-11-02T00:00:01.000Z', event: 'run_completed' })}\n`
    )
    writeFileSync(join(root, 'notes.txt'), 'ignored')

    const parsed = readAppLogDirectory(root)
    assert.deepEqual(
      parsed.entries.map((entry) => entry.event),
      ['run_started', 'run_completed']
    )
    assert.deepEqual(
      logEntriesSince(parsed.entries, '2026-11-02T00:00:00.000Z').map((entry) => entry.event),
      ['run_completed']
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
