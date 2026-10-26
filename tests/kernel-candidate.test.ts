import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { assertCandidateWorktreeClean, reserveEvidencePath } from '../scripts/kernel-candidate'

test('candidate cleanliness allows only explicitly named untracked docs', () => {
  assert.deepEqual(
    assertCandidateWorktreeClean(['?? docs/release-note.md'], ['docs/release-note.md']),
    ['docs/release-note.md']
  )
  for (const entries of [
    ['?? docs/unlisted.md'],
    [' M docs/release-note.md'],
    ['?? scripts/untracked.ts'],
    ['?? docs/nested/other.md']
  ]) {
    assert.throws(
      () => assertCandidateWorktreeClean(entries, ['docs/release-note.md']),
      /candidate requires a clean worktree/i
    )
  }
  assert.throws(() => assertCandidateWorktreeClean([], ['outside.md']), /must be under docs/i)
})

test('candidate evidence attempts are reserved without overwriting prior records', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'phi-candidate-attempts-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'perf'), { recursive: true })
  writeFileSync(join(root, 'perf', 'attempt-001.json'), 'first')

  const second = await reserveEvidencePath(root, 'perf', 'json')
  const third = await reserveEvidencePath(root, 'perf', 'json')
  assert.equal(second.path, join(root, 'perf', 'attempt-002.json'))
  assert.equal(second.attempt, 2)
  assert.equal(third.path, join(root, 'perf', 'attempt-003.json'))
  assert.equal(third.attempt, 3)
})
