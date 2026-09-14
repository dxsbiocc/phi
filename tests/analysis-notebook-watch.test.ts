import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  AnalysisNotebookFileWatcher,
  type AnalysisNotebookFileChange
} from '../src/main/agent/notebook/analysis-notebook-watch'
import type { AnalysisNotebookFile } from '../src/main/agent/notebook/analysis-notebook-files'

type WatchCall = {
  directory: string
  closed: boolean
  listener: (eventType: string, filename: string | Buffer | null) => void
}

function delay(ms = 5): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function withProjectDir<T>(callback: (root: string) => T | Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'phi-analysis-notebook-watch-'))
  try {
    return await callback(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function notebookFile(root: string, revision: string): AnalysisNotebookFile {
  return {
    path: join(root, 'notebooks', 'analysis.ipynb'),
    relativePath: 'notebooks/analysis.ipynb',
    name: 'analysis.ipynb',
    bytes: revision.length,
    modifiedAt: '2026-09-14T00:00:00.000Z',
    savedRevision: revision,
    document: {
      nbformat: 4,
      nbformatMinor: 5,
      metadata: {},
      cells: [],
      extra: {},
      revision
    }
  }
}

test('AnalysisNotebookFileWatcher emits changed for external notebook revisions', async () => {
  await withProjectDir(async (root) => {
    mkdirSync(join(root, 'notebooks'))
    writeFileSync(join(root, 'notebooks', 'analysis.ipynb'), '{}', 'utf-8')
    const watchCalls: WatchCall[] = []
    const changes: AnalysisNotebookFileChange[] = []
    let revision = 'nb-initial'
    const watcher = new AnalysisNotebookFileWatcher({
      debounceMs: 0,
      onChange: (change) => changes.push(change),
      openNotebook: () => notebookFile(root, revision),
      watchDirectory: (directory, listener) => {
        const call = { directory, listener, closed: false }
        watchCalls.push(call)
        return {
          close: () => {
            call.closed = true
          }
        }
      }
    })

    watcher.watch(root, 'notebooks/analysis.ipynb')
    revision = 'nb-external'
    watchCalls[0].listener('change', 'analysis.ipynb')
    watchCalls[0].listener('change', 'analysis.ipynb')
    await delay()

    assert.equal(changes.length, 1)
    assert.equal(changes[0].type, 'changed')
    assert.equal(changes[0].path, join(root, 'notebooks', 'analysis.ipynb'))
    assert.equal(changes[0].file.savedRevision, 'nb-external')

    watcher.dispose()
    assert.equal(watchCalls[0].closed, true)
  })
})

test('AnalysisNotebookFileWatcher suppresses Phi local writes', async () => {
  await withProjectDir(async (root) => {
    mkdirSync(join(root, 'notebooks'))
    writeFileSync(join(root, 'notebooks', 'analysis.ipynb'), '{}', 'utf-8')
    const watchCalls: WatchCall[] = []
    const changes: AnalysisNotebookFileChange[] = []
    let revision = 'nb-initial'
    const watcher = new AnalysisNotebookFileWatcher({
      debounceMs: 0,
      onChange: (change) => changes.push(change),
      openNotebook: () => notebookFile(root, revision),
      watchDirectory: (directory, listener) => {
        const call = { directory, listener, closed: false }
        watchCalls.push(call)
        return {
          close: () => {
            call.closed = true
          }
        }
      }
    })

    const opened = watcher.watch(root, 'notebooks/analysis.ipynb')
    revision = 'nb-local-save'
    watcher.noteLocalWrite(root, {
      ...opened,
      savedRevision: revision,
      document: { ...opened.document, revision }
    })
    watchCalls[0].listener('change', 'analysis.ipynb')
    await delay()

    assert.equal(changes.length, 0)
    watcher.dispose()
  })
})

test('AnalysisNotebookFileWatcher emits deleted and closes watcher when file disappears', async () => {
  await withProjectDir(async (root) => {
    mkdirSync(join(root, 'notebooks'))
    const filePath = join(root, 'notebooks', 'analysis.ipynb')
    writeFileSync(filePath, '{}', 'utf-8')
    const watchCalls: WatchCall[] = []
    const changes: AnalysisNotebookFileChange[] = []
    const watcher = new AnalysisNotebookFileWatcher({
      debounceMs: 0,
      onChange: (change) => changes.push(change),
      openNotebook: () => notebookFile(root, 'nb-initial'),
      watchDirectory: (directory, listener) => {
        const call = { directory, listener, closed: false }
        watchCalls.push(call)
        return {
          close: () => {
            call.closed = true
          }
        }
      }
    })

    watcher.watch(root, 'notebooks/analysis.ipynb')
    rmSync(filePath)
    watchCalls[0].listener('rename', 'analysis.ipynb')
    await delay()

    assert.deepEqual(changes, [
      {
        type: 'deleted',
        projectCwd: root,
        path: filePath,
        relativePath: 'notebooks/analysis.ipynb'
      }
    ])
    assert.equal(watchCalls[0].closed, true)
  })
})
