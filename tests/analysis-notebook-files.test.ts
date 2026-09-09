import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createProjectNotebook,
  deleteProjectNotebook,
  openProjectNotebook,
  saveProjectNotebook
} from '../src/main/agent/analysis-notebook-files'
import { updateNotebookCell } from '../src/shared/notebookDocument'

function withProjectDir<T>(callback: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'phi-analysis-notebook-files-'))
  try {
    return callback(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeNotebook(path: string, source = 'x = 1'): void {
  writeFileSync(
    path,
    JSON.stringify(
      {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: { phi: { keep: true } },
        cells: [
          {
            id: 'cell-1',
            cell_type: 'code',
            execution_count: null,
            metadata: {},
            outputs: [],
            source
          }
        ],
        custom: 'preserved'
      },
      null,
      2
    ),
    'utf-8'
  )
}

test('openProjectNotebook parses project notebooks and preserves metadata', () => {
  withProjectDir((root) => {
    mkdirSync(join(root, 'notebooks'))
    writeNotebook(join(root, 'notebooks', 'analysis.ipynb'))

    const file = openProjectNotebook(root, 'notebooks/analysis.ipynb')

    assert.equal(file.relativePath, 'notebooks/analysis.ipynb')
    assert.equal(file.name, 'analysis.ipynb')
    assert.equal(file.document.cells[0].source, 'x = 1')
    assert.deepEqual(file.document.metadata.phi, { keep: true })
    assert.equal(file.document.extra.custom, 'preserved')
    assert.equal(file.savedRevision, file.document.revision)
  })
})

test('saveProjectNotebook writes explicit edits and rejects stale saves', () => {
  withProjectDir((root) => {
    mkdirSync(join(root, 'notebooks'))
    writeNotebook(join(root, 'notebooks', 'analysis.ipynb'))
    const opened = openProjectNotebook(root, 'notebooks/analysis.ipynb')
    const edited = updateNotebookCell(opened.document, 'cell-1', { source: 'x = 2' })

    const saved = saveProjectNotebook(root, {
      path: opened.path,
      document: edited,
      expectedRevision: opened.savedRevision
    })

    assert.equal(saved.document.cells[0].source, 'x = 2')
    assert.match(readFileSync(opened.path, 'utf-8'), /x = 2/)
    writeNotebook(join(root, 'notebooks', 'analysis.ipynb'), 'x = 3')
    assert.throws(
      () =>
        saveProjectNotebook(root, {
          path: opened.path,
          document: edited,
          expectedRevision: opened.savedRevision
        }),
      /Notebook 已在磁盘上变化/
    )
  })
})

test('createProjectNotebook creates unique notebooks without overwriting existing files', () => {
  withProjectDir((root) => {
    const first = createProjectNotebook(root)
    const second = createProjectNotebook(root)

    assert.equal(first.relativePath, 'notebooks/Untitled.ipynb')
    assert.equal(second.relativePath, 'notebooks/Untitled 2.ipynb')
    assert.equal(first.document.cells[0].cellType, 'markdown')
    assert.equal(first.document.cells[1].cellType, 'code')
  })
})

test('deleteProjectNotebook removes project notebooks and returns the deleted path', () => {
  withProjectDir((root) => {
    mkdirSync(join(root, 'notebooks'))
    const notebookPath = join(root, 'notebooks', 'analysis.ipynb')
    writeNotebook(notebookPath)
    const expectedPath = realpathSync(notebookPath)

    const deleted = deleteProjectNotebook(root, 'notebooks/analysis.ipynb')

    assert.equal(deleted.path, expectedPath)
    assert.equal(deleted.relativePath, 'notebooks/analysis.ipynb')
    assert.equal(existsSync(notebookPath), false)
  })
})

test('notebook file service blocks paths outside the project', () => {
  withProjectDir((root) => {
    const outside = mkdtempSync(join(tmpdir(), 'phi-analysis-outside-'))
    try {
      mkdirSync(join(root, 'notebooks'))
      writeNotebook(join(root, 'notebooks', 'safe.ipynb'))
      writeNotebook(join(outside, 'secret.ipynb'))
      symlinkSync(join(outside, 'secret.ipynb'), join(root, 'notebooks', 'link.ipynb'))
      symlinkSync(outside, join(root, 'notebooks', 'outside-dir'))

      assert.throws(() => openProjectNotebook(root, '../secret.ipynb'), /当前项目内/)
      assert.throws(() => openProjectNotebook(root, 'notebooks/link.ipynb'), /当前项目内/)
      assert.throws(() => createProjectNotebook(root, '../bad.ipynb'), /当前项目内/)
      assert.throws(() => deleteProjectNotebook(root, 'notebooks/link.ipynb'), /当前项目内/)
      assert.throws(
        () => createProjectNotebook(root, 'notebooks/outside-dir/bad.ipynb'),
        /当前项目内/
      )
      assert.throws(() => openProjectNotebook(root, 'notebooks/safe.txt'), /.ipynb/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
