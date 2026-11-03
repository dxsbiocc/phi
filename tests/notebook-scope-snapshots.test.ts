import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_NOTEBOOK_SCOPE_SNAPSHOTS,
  rememberNotebookScope,
  takeNotebookScope,
  type NotebookScopeSnapshot
} from '../src/renderer/src/features/analysis/lib/notebookScopeSnapshots'
import type { AnalysisNotebookFile } from '../src/renderer/src/types'

function snapshot(path: string): NotebookScopeSnapshot {
  const file = { path, relativePath: path } as AnalysisNotebookFile
  return {
    files: new Map([[path, file]]),
    registry: null,
    kernelDiagnostics: null,
    jupyterStatus: null
  }
}

test('returning to a project hands back what it had loaded, once', () => {
  const gpu = snapshot('/gpu/a.ipynb')
  const remembered = rememberNotebookScope(new Map(), '/projects/gpu', gpu)
  const { snapshot: restored, remaining } = takeNotebookScope(remembered, '/projects/gpu')
  assert.equal(restored, gpu)
  assert.equal(remaining.size, 0)
  assert.equal(takeNotebookScope(remaining, '/projects/gpu').snapshot, undefined)
  assert.equal(remembered.size, 1, 'the input map is not changed')
})

test('a project that loaded nothing is not remembered', () => {
  const empty = { ...snapshot('/x.ipynb'), files: new Map() }
  assert.equal(rememberNotebookScope(new Map(), '/projects/empty', empty).size, 0)
})

test('only the most recently left projects are kept', () => {
  let snapshots = new Map<string, NotebookScopeSnapshot>()
  for (let index = 0; index <= MAX_NOTEBOOK_SCOPE_SNAPSHOTS; index += 1) {
    snapshots = rememberNotebookScope(snapshots, `/p${index}`, snapshot(`/p${index}/n.ipynb`))
  }
  assert.equal(snapshots.size, MAX_NOTEBOOK_SCOPE_SNAPSHOTS)
  assert.equal(snapshots.has('/p0'), false)
  snapshots = rememberNotebookScope(snapshots, '/p1', snapshot('/p1/n.ipynb'))
  snapshots = rememberNotebookScope(snapshots, '/p9', snapshot('/p9/n.ipynb'))
  assert.equal(snapshots.has('/p1'), true, 'leaving a project again makes it the newest')
  assert.equal(snapshots.has('/p2'), false)
})
