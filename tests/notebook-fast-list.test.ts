import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createNotebookWorkspace } from '../src/main/agent/notebook/notebook-workspace'
import { LocalHost } from '../src/main/agent/workspace-host/local-host'
import type { CommandResult, WorkspaceHost } from '../src/main/agent/workspace-host/types'

function remoteLike(root: string, calls: string[][], exec?: () => CommandResult): WorkspaceHost {
  const local = new LocalHost(root)
  return {
    fs: {
      ...local.fs,
      list: async () => {
        throw new Error('per-directory list must not be used by the fast path')
      }
    },
    exec: {
      run: async (command, options) => {
        calls.push([...command])
        return exec ? exec() : local.exec.run(command, options)
      },
      spawnBackground: (command, options) => local.exec.spawnBackground(command, options)
    },
    capabilities: () => local.capabilities()
  }
}

test('remote notebook listing uses one bounded find and prunes heavy directories', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-nb-fast-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['notebooks', 'outputs', 'node_modules/pkg', '.git/x', 'data/deep/er']) {
    await mkdir(join(root, dir), { recursive: true })
  }
  for (const file of [
    'notebooks/a.ipynb',
    'data/deep/er/b.ipynb',
    'node_modules/pkg/skip.ipynb',
    '.git/x/skip2.ipynb',
    'top.IPYNB',
    'readme.md'
  ]) {
    await writeFile(join(root, file), '{}')
  }
  const calls: string[][] = []
  const listed = await createNotebookWorkspace({
    projectCwd: root,
    host: remoteLike(root, calls)
  }).list()
  // GNU find answers in one call; BSD find needs a second bare-path call. Never a walk.
  assert.ok(calls.length <= 2)
  assert.deepEqual(
    listed.notebooks.map((notebook) => notebook.relativePath),
    ['notebooks/a.ipynb', 'data/deep/er/b.ipynb', 'top.IPYNB']
  )
  assert.equal(listed.initialized, true)
  assert.equal(listed.truncated, false)
  assert.ok(listed.notebooks.every((notebook) => notebook.bytes === 2))
  assert.ok(calls[0].every((part) => !/jupyter/i.test(part)))
})

test('remote notebook listing never walks per directory after a find timeout', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-nb-fast-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls: string[][] = []
  const timedOut: CommandResult = {
    stdout: '',
    stderr: '',
    code: null,
    signal: null,
    truncated: false,
    terminationReason: 'timeout'
  }
  const listed = await createNotebookWorkspace({
    projectCwd: root,
    host: remoteLike(root, calls, () => timedOut)
  }).list()
  assert.deepEqual(listed.notebooks, [])
  assert.equal(listed.truncated, true)
})

test('GNU find output is parsed without per-notebook stat calls', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-nb-fast-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls: string[][] = []
  const host = remoteLike(root, calls, () => ({
    stdout: '#initialized\n./notebooks/x.ipynb\t12\t1760000000.5\n./y.ipynb\t3\t1760000001.0\n',
    stderr: '',
    code: 0,
    signal: null,
    truncated: false
  }))
  host.fs.stat = async () => {
    throw new Error('stat must not be needed when find reports size and mtime')
  }
  const listed = await createNotebookWorkspace({ projectCwd: root, host }).list()
  assert.equal(calls.length, 1)
  assert.equal(listed.initialized, true)
  assert.deepEqual(
    listed.notebooks.map((notebook) => [notebook.relativePath, notebook.bytes]),
    [
      ['notebooks/x.ipynb', 12],
      ['y.ipynb', 3]
    ]
  )
  assert.equal(listed.notebooks[0].modifiedAt, new Date(1760000000500).toISOString())
})
