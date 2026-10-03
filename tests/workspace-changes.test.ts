import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { mock } from 'node:test'

import {
  beginWorkspaceChangeCapture,
  finishWorkspaceChangeCapture
} from '../src/main/agent/session/workspace-changes'

async function withRepo(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'phi-workspace-changes-test-'))
  try {
    execFileSync('git', ['init', '-q', root])
    writeFileSync(join(root, 'existing.txt'), 'first\nsecond\n')
    writeFileSync(join(root, 'clean.txt'), 'stable\n')
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Phi Test',
        '-c',
        'user.email=phi@example.invalid',
        'commit',
        '-qm',
        'baseline'
      ],
      { cwd: root }
    )
    await run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('run change summary counts only changes after its baseline, including untracked files', async () => {
  await withRepo(async (root) => {
    writeFileSync(join(root, 'existing.txt'), 'first\npreexisting\n')
    writeFileSync(join(root, 'untracked.txt'), 'before\n')
    writeFileSync(join(root, 'gone.txt'), 'remove me\n')
    const baseline = await beginWorkspaceChangeCapture(root)
    assert.ok(baseline)

    writeFileSync(join(root, 'existing.txt'), 'first\npreexisting\nduring run\n')
    writeFileSync(join(root, 'clean.txt'), 'stable\nduring run\n')
    writeFileSync(join(root, 'untracked.txt'), 'before\nduring run\n')
    writeFileSync(join(root, 'created.txt'), 'new file\n')
    writeFileSync(join(root, 'plot.png'), Buffer.from([0x89, 0, 0x50]))
    rmSync(join(root, 'gone.txt'))

    const summary = await finishWorkspaceChangeCapture(baseline)
    assert.ok(summary)
    assert.equal(summary.totalChanged, 6)
    assert.equal(summary.truncated, false)
    assert.deepEqual(
      summary.files.map((file) => [file.displayPath, file.status, file.added, file.deleted]),
      [
        ['clean.txt', 'modified', 1, 0],
        ['created.txt', 'added', 1, 0],
        ['existing.txt', 'modified', 1, 0],
        ['gone.txt', 'deleted', 0, 1],
        ['plot.png', 'added', null, null],
        ['untracked.txt', 'modified', 1, 0]
      ]
    )
  })
})

test('changes remain visible when the agent commits them during the run', async () => {
  await withRepo(async (root) => {
    const baseline = await beginWorkspaceChangeCapture(root)
    writeFileSync(join(root, 'clean.txt'), 'stable\ncommitted\n')
    execFileSync('git', ['add', 'clean.txt'], { cwd: root })
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Phi Test',
        '-c',
        'user.email=phi@example.invalid',
        'commit',
        '-qm',
        'during run'
      ],
      { cwd: root }
    )
    const summary = await finishWorkspaceChangeCapture(baseline)
    assert.deepEqual(
      summary?.files.map((file) => [file.displayPath, file.added]),
      [['clean.txt', 1]]
    )
  })
})

test('captured text diffs describe this run without temporary file paths', async () => {
  await withRepo(async (root) => {
    writeFileSync(join(root, 'existing.txt'), 'first\npreexisting\n')
    const baseline = await beginWorkspaceChangeCapture(root)
    writeFileSync(join(root, 'existing.txt'), 'first\npreexisting\nduring run\n')
    let capturedPatch = ''
    const ref = { sessionId: 'session-1', id: 'a'.repeat(64), bytes: 40 }
    const summary = await finishWorkspaceChangeCapture(baseline, {
      onTextDiff: async (_name, patch) => {
        capturedPatch = patch
        return ref
      }
    })
    assert.deepEqual(summary?.files[0]?.diff, ref)
    assert.match(capturedPatch, /^@@ /)
    assert.match(capturedPatch, /^\+during run$/m)
    assert.doesNotMatch(capturedPatch, /^\+preexisting$/m)
    assert.doesNotMatch(capturedPatch, /phi-workspace-changes-/)
  })
})

test('deleted text files retain a reviewable removal diff', async () => {
  await withRepo(async (root) => {
    const baseline = await beginWorkspaceChangeCapture(root)
    rmSync(join(root, 'clean.txt'))
    let capturedPatch = ''
    const ref = { sessionId: 'session-1', id: 'b'.repeat(64), bytes: 40 }
    const summary = await finishWorkspaceChangeCapture(baseline, {
      onTextDiff: async (_name, patch) => {
        capturedPatch = patch
        return ref
      }
    })
    assert.equal(summary?.files[0]?.status, 'deleted')
    assert.deepEqual(summary?.files[0]?.diff, ref)
    assert.match(capturedPatch, /^-stable$/m)
  })
})

test('unchanged preexisting work does not appear in the run summary', async () => {
  await withRepo(async (root) => {
    writeFileSync(join(root, 'existing.txt'), 'already changed\n')
    const baseline = await beginWorkspaceChangeCapture(root)
    const summary = await finishWorkspaceChangeCapture(baseline)
    assert.deepEqual(summary, { files: [], totalChanged: 0, truncated: false })
  })
})

test('a session bound to a repository subfolder reports only files inside that project', async () => {
  await withRepo(async (root) => {
    const project = join(root, 'project')
    mkdirSync(project)
    writeFileSync(join(project, 'local.txt'), 'before\n')
    execFileSync('git', ['add', 'project/local.txt'], { cwd: root })
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Phi Test',
        '-c',
        'user.email=phi@example.invalid',
        'commit',
        '-qm',
        'add project'
      ],
      { cwd: root }
    )
    const baseline = await beginWorkspaceChangeCapture(project)
    writeFileSync(join(project, 'local.txt'), 'after\n')
    writeFileSync(join(root, 'clean.txt'), 'changed outside project\n')
    const summary = await finishWorkspaceChangeCapture(baseline)
    assert.deepEqual(
      summary?.files.map((file) => file.displayPath),
      ['project/local.txt']
    )
  })
})

test('non-Git folders do not produce a misleading run summary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-workspace-no-git-'))
  try {
    assert.equal(await beginWorkspaceChangeCapture(root), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an unborn Git repository still records files created and changed during a run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-workspace-unborn-'))
  try {
    execFileSync('git', ['init', '-q', root])
    writeFileSync(join(root, 'existing.txt'), 'before\n')
    writeFileSync(join(root, 'staged.txt'), 'staged before\n')
    execFileSync('git', ['add', 'staged.txt'], { cwd: root })

    const baseline = await beginWorkspaceChangeCapture(root)
    assert.ok(baseline)
    writeFileSync(join(root, 'existing.txt'), 'after\n')
    writeFileSync(join(root, 'staged.txt'), 'staged after\n')
    writeFileSync(join(root, 'result.tsv'), 'gene\tpadj\nTHRSP\t0.1\n')

    const summary = await finishWorkspaceChangeCapture(baseline)
    assert.deepEqual(
      summary?.files.map((file) => [file.displayPath, file.status]),
      [
        ['existing.txt', 'modified'],
        ['result.tsv', 'added'],
        ['staged.txt', 'modified']
      ]
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('change summaries cap the visible file list while retaining the total', async () => {
  await withRepo(async (root) => {
    const baseline = await beginWorkspaceChangeCapture(root)
    for (let index = 0; index < 55; index += 1) {
      writeFileSync(join(root, `result-${String(index).padStart(2, '0')}.txt`), 'new\n')
    }
    // Scanning 55 files spawns a git diff each; on a loaded machine that outlasts the
    // capture's wall-clock budget and the scan stops early. That budget is not what this
    // test measures, so freeze the clock it reads (only Date; real timers still run).
    mock.timers.enable({ apis: ['Date'], now: Date.now() })
    try {
      const summary = await finishWorkspaceChangeCapture(baseline)
      assert.equal(summary?.totalChanged, 55)
      assert.equal(summary?.files.length, 50)
      assert.equal(summary?.truncated, true)
    } finally {
      mock.timers.reset()
    }
  })
})
