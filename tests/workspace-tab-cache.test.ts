import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cacheAnalysisNotebookFile,
  removeAnalysisNotebookFileCacheEntry
} from '../src/renderer/src/features/analysis/lib/analysisNotebookRuntimeUtils'
import {
  cacheWorkspaceFilePreviewState,
  removeWorkspaceFilePreviewState,
  type WorkspaceFilePreviewCache
} from '../src/renderer/src/useWorkspaceFileTabs'
import type { FilePreviewPanelState } from '../src/renderer/src/features/file-preview/FilePreviewPanel'
import type { AnalysisNotebookFile } from '../src/renderer/src/types'

const readyPreview: FilePreviewPanelState = {
  status: 'ready',
  file: {
    path: '/project/src/App.tsx',
    name: 'App.tsx',
    displayPath: 'src/App.tsx',
    rootPath: '/project',
    rootLabel: 'project',
    kind: 'text',
    mimeType: 'text/plain',
    content: 'export const value = 1',
    bytes: 22,
    previewBytes: 22,
    truncated: false
  }
}

const directoryPreview: FilePreviewPanelState = {
  status: 'directory',
  directory: {
    path: '/project/src',
    name: 'src',
    displayPath: 'src',
    rootPath: '/project',
    rootLabel: 'project',
    entries: [],
    truncated: false
  }
}

function notebookFile(revision: string): AnalysisNotebookFile {
  return {
    path: '/project/notebooks/eda.ipynb',
    relativePath: 'notebooks/eda.ipynb',
    name: 'eda.ipynb',
    bytes: 120,
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

test('workspace file preview cache is keyed by the rendered path', () => {
  const empty: WorkspaceFilePreviewCache = {}
  const withFile = cacheWorkspaceFilePreviewState(empty, readyPreview)
  const withDirectory = cacheWorkspaceFilePreviewState(withFile, directoryPreview)

  assert.equal(withFile['/project/src/App.tsx'], readyPreview)
  assert.equal(withDirectory['/project/src/App.tsx'], readyPreview)
  assert.equal(withDirectory['/project/src'], directoryPreview)
  assert.deepEqual(Object.keys(empty), [])

  const removed = removeWorkspaceFilePreviewState(withDirectory, '/project/src/App.tsx')

  assert.equal(removed['/project/src/App.tsx'], undefined)
  assert.equal(removed['/project/src'], directoryPreview)
})

test('analysis notebook cache resolves absolute and relative tab paths', () => {
  const cached = cacheAnalysisNotebookFile(new Map(), notebookFile('draft-1'))

  assert.equal(cached.get('/project/notebooks/eda.ipynb')?.document.revision, 'draft-1')
  assert.equal(cached.get('notebooks/eda.ipynb')?.document.revision, 'draft-1')

  const updated = cacheAnalysisNotebookFile(cached, notebookFile('draft-2'))

  assert.equal(updated.get('/project/notebooks/eda.ipynb')?.document.revision, 'draft-2')
  assert.equal(updated.get('notebooks/eda.ipynb')?.document.revision, 'draft-2')

  const removed = removeAnalysisNotebookFileCacheEntry(updated, '/project/notebooks/eda.ipynb')

  assert.equal(removed.get('/project/notebooks/eda.ipynb'), undefined)
  assert.equal(removed.get('notebooks/eda.ipynb'), undefined)
})
