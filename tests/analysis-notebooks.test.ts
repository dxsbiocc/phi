import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  initializeProjectAnalysis,
  listProjectNotebooks,
  projectAnalysisInitialized
} from '../src/main/agent/notebook/analysis-notebooks'

function withProjectDir<T>(callback: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'phi-analysis-notebooks-'))
  try {
    return callback(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeNotebook(path: string): void {
  writeFileSync(
    path,
    JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }),
    'utf-8'
  )
}

test('listProjectNotebooks discovers local notebooks with analysis-first ordering', () => {
  withProjectDir((root) => {
    mkdirSync(join(root, 'notebooks'))
    mkdirSync(join(root, 'reports'))
    writeNotebook(join(root, 'reports', 'summary.ipynb'))
    writeNotebook(join(root, 'notebooks', 'exploration.ipynb'))

    const registry = listProjectNotebooks(root)

    assert.equal(registry.truncated, false)
    assert.deepEqual(
      registry.notebooks.map((notebook) => notebook.relativePath),
      ['notebooks/exploration.ipynb', 'reports/summary.ipynb']
    )
    assert.equal(registry.notebooks[0].name, 'exploration.ipynb')
    assert.match(registry.notebooks[0].modifiedAt, /^\d{4}-\d{2}-\d{2}T/)
  })
})

test('listProjectNotebooks skips bulky and checkpoint directories by default', () => {
  withProjectDir((root) => {
    mkdirSync(join(root, '.git'))
    mkdirSync(join(root, '.ipynb_checkpoints'))
    mkdirSync(join(root, 'node_modules'))
    mkdirSync(join(root, 'notebooks'))
    writeNotebook(join(root, '.git', 'hidden.ipynb'))
    writeNotebook(join(root, '.ipynb_checkpoints', 'checkpoint.ipynb'))
    writeNotebook(join(root, 'node_modules', 'dependency.ipynb'))
    writeNotebook(join(root, 'notebooks', 'visible.ipynb'))

    const registry = listProjectNotebooks(root)

    assert.deepEqual(
      registry.notebooks.map((notebook) => notebook.relativePath),
      ['notebooks/visible.ipynb']
    )
  })
})

test('listProjectNotebooks reports truncation without scanning unbounded trees', () => {
  withProjectDir((root) => {
    mkdirSync(join(root, 'notebooks'))
    writeNotebook(join(root, 'notebooks', 'a.ipynb'))
    writeNotebook(join(root, 'notebooks', 'b.ipynb'))

    const registry = listProjectNotebooks(root, { maxNotebooks: 1 })

    assert.equal(registry.truncated, true)
    assert.deepEqual(
      registry.notebooks.map((notebook) => notebook.relativePath),
      ['notebooks/a.ipynb']
    )
  })
})

test('analysis discovery is side-effect free until explicit initialization', () => {
  withProjectDir((root) => {
    assert.equal(projectAnalysisInitialized(root), false)

    const registry = listProjectNotebooks(root)

    assert.deepEqual(registry.notebooks, [])
    assert.equal(registry.initialized, false)
    assert.equal(projectAnalysisInitialized(root), false)

    const initialized = initializeProjectAnalysis(root)
    const realRoot = realpathSync(root)

    assert.equal(initialized.notebooksDir, join(realRoot, 'notebooks'))
    assert.equal(initialized.outputsDir, join(realRoot, 'outputs'))
    assert.equal(projectAnalysisInitialized(root), true)
    assert.equal(listProjectNotebooks(root).initialized, true)
  })
})
