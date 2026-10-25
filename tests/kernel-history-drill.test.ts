import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runKernelHistoryDrill } from '../scripts/kernel-history-drill'

test('drill refuses a missing output directory reached through a symlink into ~/.phi', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-history-drill-output-'))
  const sessions = join(root, 'sessions')
  const link = join(root, 'phi-link')
  const unique = `k2-4-must-not-create-${randomUUID()}`
  const forbiddenDirectory = join(homedir(), '.phi', unique)
  mkdirSync(sessions)
  symlinkSync(join(homedir(), '.phi'), link)
  assert.equal(existsSync(forbiddenDirectory), false)
  try {
    await assert.rejects(
      runKernelHistoryDrill({
        phiSessions: sessions,
        out: join(link, unique, 'report.json'),
        copyFirst: true
      }),
      /refusing to write a drill report inside ~\/\.phi/i
    )
    assert.equal(existsSync(forbiddenDirectory), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
