import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AnalysisNotebookSessionRegistry } from '../src/main/agent/notebook/analysis-jupyter-sessions'
import { AnalysisNotebookExecutor } from '../src/main/agent/notebook/analysis-jupyter-execution'
import { openProjectNotebook } from '../src/main/agent/notebook/analysis-notebook-files'
import { AnalysisNotebookToolExecutor } from '../src/main/agent/notebook/notebook-tool-executor'
import { createLocalNotebookWorkspace } from '../src/main/agent/notebook/notebook-workspace'
import { updateNotebookCell } from '../src/shared/notebookDocument'

function withProjectDir<T>(callback: (root: string) => T | Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'phi-notebook-tool-executor-'))
  return Promise.resolve(callback(root)).finally(() =>
    rmSync(root, { recursive: true, force: true })
  )
}

function writeNotebook(path: string, source = 'x = 1'): void {
  writeFileSync(
    path,
    JSON.stringify(
      {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {
          kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' }
        },
        cells: [
          {
            id: 'cell-1',
            cell_type: 'code',
            execution_count: null,
            metadata: {},
            outputs: [],
            source
          }
        ]
      },
      null,
      2
    ),
    'utf-8'
  )
}

function createExecutor(
  root: string,
  onDraftChanged?: ConstructorParameters<typeof AnalysisNotebookToolExecutor>[0]['onDraftChanged']
): AnalysisNotebookToolExecutor {
  return new AnalysisNotebookToolExecutor({
    resolveWorkspaceByCwd: (cwd) =>
      cwd === root ? { workingDirectory: root, name: 'test' } : null,
    ensureJupyterServerReady: async () => undefined,
    notebookSessionRegistry: new AnalysisNotebookSessionRegistry({ getConnection: () => null }),
    notebookExecutor: new AnalysisNotebookExecutor(),
    onDraftChanged
  })
}

test('notebook tool executor edits a live draft and saves only on request', async () => {
  await withProjectDir(async (root) => {
    mkdirSync(join(root, 'notebooks'))
    const notebookPath = join(root, 'notebooks', 'analysis.ipynb')
    writeNotebook(notebookPath)
    const executor = createExecutor(root)

    const opened = await executor.execute({
      action: 'read',
      cwd: root,
      params: { path: 'notebooks/analysis.ipynb' }
    })
    assert.equal(opened.kind, 'notebook_document')
    assert.match(opened.summary, /1 个 cell/)
    const openedCells = opened.cells as Array<{ cellNumber: number; index?: number }>
    assert.equal(openedCells[0]?.cellNumber, 1)
    assert.equal(openedCells[0]?.index, undefined)

    const updated = await executor.execute({
      action: 'update_cell',
      cwd: root,
      params: { path: 'notebooks/analysis.ipynb', cellId: 'cell-1', source: 'x = 2' }
    })
    assert.equal(updated.kind, 'notebook_cell_updated')
    assert.match(updated.summary, /Cell 1/)
    assert.match(readFileSync(notebookPath, 'utf-8'), /x = 1/)

    const draft = await executor.execute({
      action: 'read',
      cwd: root,
      params: { path: 'notebooks/analysis.ipynb', includeOutputs: false }
    })
    const cells = draft.cells as Array<{ source: string }>
    assert.equal(cells[0]?.source, 'x = 2')

    const saved = await executor.execute({
      action: 'save',
      cwd: root,
      params: { path: 'notebooks/analysis.ipynb' }
    })
    assert.equal(saved.kind, 'notebook_saved')
    assert.match(readFileSync(notebookPath, 'utf-8'), /x = 2/)
  })
})

test('notebook tool executor inserts and deletes cells in the live draft', async () => {
  await withProjectDir(async (root) => {
    mkdirSync(join(root, 'notebooks'))
    const notebookPath = join(root, 'notebooks', 'analysis.ipynb')
    writeNotebook(notebookPath)
    const executor = createExecutor(root)

    const inserted = await executor.execute({
      action: 'insert_cell',
      cwd: root,
      params: {
        path: 'notebooks/analysis.ipynb',
        afterCellId: 'cell-1',
        cellType: 'markdown',
        source: '# Notes'
      }
    })
    assert.match(inserted.summary, /Cell 2/)
    assert.equal(inserted.cellNumber, 2)
    const insertedCell = inserted.cell as {
      id: string
      cellNumber: number
      cellType: string
      source: string
    }
    assert.equal(insertedCell.cellNumber, 2)
    assert.equal(insertedCell.cellType, 'markdown')
    assert.equal(insertedCell.source, '# Notes')

    const deleted = await executor.execute({
      action: 'delete_cell',
      cwd: root,
      params: { path: 'notebooks/analysis.ipynb', cellId: insertedCell.id }
    })
    assert.match(deleted.summary, /Cell 2/)
    assert.equal(deleted.cellNumber, 2)
    const draft = await executor.execute({
      action: 'read',
      cwd: root,
      params: { path: 'notebooks/analysis.ipynb' }
    })
    const cells = draft.cells as Array<{ id: string }>
    assert.deepEqual(
      cells.map((cell) => cell.id),
      ['cell-1']
    )
  })
})

test('notebook tool executor accepts one-based cellNumber for insertion', async () => {
  await withProjectDir(async (root) => {
    mkdirSync(join(root, 'notebooks'))
    const notebookPath = join(root, 'notebooks', 'analysis.ipynb')
    writeNotebook(notebookPath)
    const executor = createExecutor(root)

    const inserted = await executor.execute({
      action: 'insert_cell',
      cwd: root,
      params: {
        path: 'notebooks/analysis.ipynb',
        cellNumber: 1,
        cellType: 'code',
        source: 'print("first")'
      }
    })

    assert.match(inserted.summary, /Cell 1/)
    assert.equal(inserted.cellNumber, 1)

    const draft = await executor.execute({
      action: 'read',
      cwd: root,
      params: { path: 'notebooks/analysis.ipynb', includeOutputs: false }
    })
    const cells = draft.cells as Array<{ cellNumber: number; source: string }>
    assert.deepEqual(
      cells.map((cell) => [cell.cellNumber, cell.source]),
      [
        [1, 'print("first")'],
        [2, 'x = 1']
      ]
    )
  })
})

test('notebook tool executor reports changed cells for agent draft updates', async () => {
  await withProjectDir(async (root) => {
    mkdirSync(join(root, 'notebooks'))
    const notebookPath = join(root, 'notebooks', 'analysis.ipynb')
    writeNotebook(notebookPath)
    const changes: Array<{
      source: string
      changeKind?: string
      changedCellId?: string
      focusCellId?: string
    }> = []
    const executor = createExecutor(root, (change) => {
      changes.push({
        source: change.source,
        changeKind: change.changeKind,
        changedCellId: change.changedCellId,
        focusCellId: change.focusCellId
      })
    })

    const inserted = await executor.execute({
      action: 'insert_cell',
      cwd: root,
      params: {
        path: 'notebooks/analysis.ipynb',
        afterCellId: 'cell-1',
        source: 'print("new")'
      }
    })
    const insertedCell = inserted.cell as { id: string }

    await executor.execute({
      action: 'update_cell',
      cwd: root,
      params: { path: 'notebooks/analysis.ipynb', cellId: 'cell-1', source: 'x = 3' }
    })
    await executor.execute({
      action: 'delete_cell',
      cwd: root,
      params: { path: 'notebooks/analysis.ipynb', cellId: insertedCell.id }
    })
    await executor.execute({
      action: 'save',
      cwd: root,
      params: { path: 'notebooks/analysis.ipynb' }
    })

    assert.deepEqual(changes, [
      {
        source: 'agent',
        changeKind: 'inserted',
        changedCellId: insertedCell.id,
        focusCellId: insertedCell.id
      },
      {
        source: 'agent',
        changeKind: 'updated',
        changedCellId: 'cell-1',
        focusCellId: 'cell-1'
      },
      {
        source: 'agent',
        changeKind: 'deleted',
        changedCellId: insertedCell.id,
        focusCellId: undefined
      },
      {
        source: 'agent',
        changeKind: 'saved',
        changedCellId: undefined,
        focusCellId: undefined
      }
    ])
  })
})

test('notebook tool executor syncs renderer drafts into the live agent workspace', async () => {
  await withProjectDir(async (root) => {
    mkdirSync(join(root, 'notebooks'))
    const notebookPath = join(root, 'notebooks', 'analysis.ipynb')
    writeNotebook(notebookPath)
    const executor = createExecutor(root)

    const opened = await executor.execute({
      action: 'read',
      cwd: root,
      params: { path: 'notebooks/analysis.ipynb' }
    })
    const [cell] = opened.cells as Array<{ id: string }>
    assert.equal(cell.id, 'cell-1')

    const syncedDocument = updateNotebookCell(
      openProjectNotebook(root, 'notebooks/analysis.ipynb').document,
      'cell-1',
      { source: 'x = 99' }
    )
    executor.syncDraft({
      cwd: root,
      path: 'notebooks/analysis.ipynb',
      document: syncedDocument,
      source: 'renderer'
    })

    const draft = await executor.execute({
      action: 'read',
      cwd: root,
      params: { path: 'notebooks/analysis.ipynb', includeOutputs: false }
    })
    const cells = draft.cells as Array<{ source: string }>
    assert.equal(cells[0]?.source, 'x = 99')
    assert.match(readFileSync(notebookPath, 'utf-8'), /x = 1/)
  })
})

test('renderer draft sync does not adopt a changed disk hash as the agent save basis', async () => {
  await withProjectDir(async (root) => {
    mkdirSync(join(root, 'notebooks'))
    const notebookPath = join(root, 'notebooks', 'analysis.ipynb')
    writeNotebook(notebookPath)
    const workspace = createLocalNotebookWorkspace(root)
    const original = await workspace.open('notebooks/analysis.ipynb')
    const executor = new AnalysisNotebookToolExecutor({
      resolveWorkspaceByCwd: () => ({ workingDirectory: root }),
      resolveNotebookWorkspaceByCwd: () => workspace,
      ensureJupyterServerReady: async () => undefined,
      notebookSessionRegistry: new AnalysisNotebookSessionRegistry({ getConnection: () => null }),
      notebookExecutor: new AnalysisNotebookExecutor()
    })
    await executor.execute({
      action: 'read',
      cwd: root,
      params: { path: 'notebooks/analysis.ipynb' }
    })

    writeFileSync(notebookPath, JSON.stringify(JSON.parse(readFileSync(notebookPath, 'utf8'))))
    const externallyReformatted = await workspace.open('notebooks/analysis.ipynb')
    assert.equal(externallyReformatted.savedRevision, original.savedRevision)
    assert.notEqual(externallyReformatted.contentHash, original.contentHash)
    executor.syncDraft({
      cwd: root,
      path: original.path,
      file: externallyReformatted,
      document: original.document,
      savedRevision: original.savedRevision,
      source: 'renderer'
    })

    await assert.rejects(
      executor.execute({
        action: 'save',
        cwd: root,
        params: { path: original.path }
      }),
      /磁盘上变化/
    )
  })
})

test('notebook tool executor resolves kernels from the routed backend', async () => {
  await withProjectDir(async (root) => {
    mkdirSync(join(root, 'notebooks'))
    writeNotebook(join(root, 'notebooks', 'analysis.ipynb'))
    const routedKernels = {
      jupyterServer: { available: true, command: 'jupyter' as const, version: 'remote' },
      kernels: [
        {
          name: 'phi-python',
          displayName: 'Remote Python',
          language: 'python' as const,
          rawLanguage: 'python'
        }
      ],
      preferredKernelName: 'phi-python',
      hasPythonKernel: true,
      hasRKernel: false,
      messages: []
    }
    let selectedKernel = ''
    const sessions = {
      ensureSession: async (input: { kernels: typeof routedKernels }) => {
        selectedKernel = input.kernels.preferredKernelName ?? ''
        return { state: 'idle', kernelDisplayName: 'Remote Python' }
      },
      executionTarget: () => ({
        connection: { url: 'http://127.0.0.1:30000/', runtimeId: 'remote-runtime' },
        sessionId: 'session-1',
        kernelId: 'kernel-1',
        kernelName: 'phi-python'
      }),
      updateSessionState: () => ({ state: 'idle', kernelDisplayName: 'Remote Python' })
    }
    const executor = new AnalysisNotebookToolExecutor({
      resolveWorkspaceByCwd: () => ({ workingDirectory: root }),
      resolveKernelsByCwd: () => routedKernels,
      ensureJupyterServerReady: async () => undefined,
      notebookSessionRegistry: sessions as never,
      notebookExecutor: {
        executeCell: async () => ({
          cellId: 'cell-1',
          executionCount: 1,
          outputs: [],
          state: 'idle',
          startedAt: '2026-10-10T00:00:00.000Z',
          completedAt: '2026-10-10T00:00:01.000Z'
        })
      } as never
    })

    await executor.execute({
      action: 'run_cell',
      cwd: root,
      params: { path: 'notebooks/analysis.ipynb', cellId: 'cell-1' }
    })

    assert.equal(selectedKernel, 'phi-python')
  })
})
