import assert from 'node:assert/strict'
import test from 'node:test'
import { isNotebookFilePath } from '../src/renderer/src/features/analysis/lib/notebookPaths'

test('notebook path detection only matches ipynb files', () => {
  assert.equal(isNotebookFilePath('/project/notebooks/analysis.ipynb'), true)
  assert.equal(isNotebookFilePath('/project/notebooks/ANALYSIS.IPYNB'), true)
  assert.equal(isNotebookFilePath(' notebooks/qc.ipynb '), true)
  assert.equal(isNotebookFilePath('/project/notebooks/analysis.py'), false)
  assert.equal(isNotebookFilePath('/project/notebooks/ipynb-notes.md'), false)
})
