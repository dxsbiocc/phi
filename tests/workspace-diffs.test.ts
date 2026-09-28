import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createPhiSession } from '../src/main/agent/session/session-store'
import { persistWorkspaceDiff, readWorkspaceDiff } from '../src/main/agent/session/workspace-diffs'
import { MAX_WORKSPACE_DIFF_BYTES } from '../src/shared/workspaceChangeTypes'

test('a run diff survives in session artifacts and rejects corrupted content', () => {
  const previous = process.env.PI_CODING_AGENT_DIR
  const phiDir = mkdtempSync(join(tmpdir(), 'phi-workspace-diff-test-'))
  process.env.PI_CODING_AGENT_DIR = phiDir
  try {
    const session = createPhiSession({
      kind: 'project',
      projectId: 'project-1',
      cwd: '/project',
      cwdRealPath: '/project',
      permissionMode: 'ask'
    })
    const patch = '@@ -1 +1 @@\n-before\n+after\n'
    const ref = persistWorkspaceDiff(session.sessionId, patch)
    assert.ok(ref)
    assert.equal(readWorkspaceDiff(ref), patch)
    assert.equal(readFileSync(join(session.dir, 'messages.jsonl'), 'utf8'), '')

    const path = join(session.dir, 'artifacts', 'workspace-diffs', `${ref.id}.diff`)
    writeFileSync(path, 'tampered')
    assert.throws(() => readWorkspaceDiff(ref), /校验失败/)
    assert.throws(() => persistWorkspaceDiff(session.sessionId, patch), /校验失败/)
    assert.throws(
      () => readWorkspaceDiff({ sessionId: session.sessionId, id: '../manifest.json' }),
      /引用无效/
    )
    assert.equal(
      persistWorkspaceDiff(session.sessionId, 'x'.repeat(MAX_WORKSPACE_DIFF_BYTES + 1)),
      null
    )
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    rmSync(phiDir, { recursive: true, force: true })
  }
})
