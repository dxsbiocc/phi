import assert from 'node:assert/strict'
import { mkdtempSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  backgroundJobHistoryPath,
  readBackgroundJobHistory,
  writeBackgroundJobHistory
} from '../src/main/agent/jobs/background-job-history-store'

test('background history is durable in Phi-owned storage across renderer profiles', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-background-history-'))
  try {
    const value = JSON.stringify({ schema: 1, records: [], clearedBefore: null, dismissed: {} })
    assert.equal(readBackgroundJobHistory(agentDir), null)
    writeBackgroundJobHistory(value, agentDir)
    assert.equal(readBackgroundJobHistory(agentDir), value)
    assert.equal(statSync(backgroundJobHistoryPath(agentDir)).mode & 0o777, 0o600)
    assert.throws(() => writeBackgroundJobHistory('invalid', agentDir), /Invalid/)
    assert.equal(readBackgroundJobHistory(agentDir), value)
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('background history rejects symlink reads and oversized writes', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-background-history-'))
  try {
    const target = backgroundJobHistoryPath(agentDir)
    writeBackgroundJobHistory(
      JSON.stringify({ schema: 1, records: [], clearedBefore: null, dismissed: {} }),
      agentDir
    )
    const other = join(agentDir, 'link-target.json')
    renameSync(target, other)
    symlinkSync(other, target)
    assert.equal(readBackgroundJobHistory(agentDir), null)
    assert.throws(
      () => writeBackgroundJobHistory('x'.repeat(128 * 1024 + 1), agentDir),
      /size limit/
    )
    assert.throws(() => writeBackgroundJobHistory('任务'.repeat(24_000), agentDir), /size limit/)
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})
