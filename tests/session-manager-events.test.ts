import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeEvent } from '../src/main/agent/session/session-manager'

test('auto compaction forwards its post-compaction token estimate to the timeline', () => {
  const summary = summarizeEvent({
    type: 'auto_compaction_end',
    action: 'remote',
    result: { summary: 'Compressed', firstKeptEntryId: 'entry-1', tokensBefore: 24000 },
    tokensAfter: 5000,
    aborted: false,
    willRetry: false
  })

  assert.equal(summary.tokensAfter, 5000)
  assert.equal(summary.action, 'remote')
})

test('SDK compaction notices retain their source for timeline persistence', () => {
  const summary = summarizeEvent({
    type: 'notice',
    source: 'compaction',
    level: 'info',
    message: 'dropped 2 attached images'
  })

  assert.equal(summary.source, 'compaction')
  assert.equal(summary.message, 'dropped 2 attached images')
  assert.equal(summary.level, 'info')
})
