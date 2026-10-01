import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cacheAnalysisNotebookFile,
  notebookEnvironmentErrorMessage,
  removeAnalysisNotebookFileCacheEntry
} from '../src/renderer/src/features/analysis/lib/analysisNotebookRuntimeUtils'
import {
  cacheWorkspaceFilePreviewState,
  removeWorkspaceFilePreviewState,
  workspaceFileRoute,
  type WorkspaceFilePreviewCache
} from '../src/renderer/src/useWorkspaceFileTabs'
import type { FilePreviewPanelState } from '../src/renderer/src/features/file-preview/FilePreviewPanel'
import type { AnalysisNotebookFile } from '../src/renderer/src/types'
import { shouldClearWorkspaceFilesForRemoteSwitch } from '../src/renderer/src/lib/workspacePaths'

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

test('remote project switches invalidate file previews while local navigation keeps them', () => {
  const clusterA = 'project-a:cluster-a:/data/project'
  const clusterB = 'project-b:cluster-b:/data/project'
  assert.equal(shouldClearWorkspaceFilesForRemoteSwitch(null, clusterA), true)
  assert.equal(shouldClearWorkspaceFilesForRemoteSwitch(clusterA, clusterB), true)
  assert.equal(shouldClearWorkspaceFilesForRemoteSwitch(clusterA, null), true)
  assert.equal(shouldClearWorkspaceFilesForRemoteSwitch(clusterA, clusterA), false)
  assert.equal(shouldClearWorkspaceFilesForRemoteSwitch(null, null), false)
})

test('wrapper result URIs use run-scoped APIs and never become local file previews', () => {
  const resultScope = {
    projectId: 'project-a',
    hostProfileId: 'host-a',
    runId: 'wrun_a',
    hostAlias: 'cluster-a',
    scope: 'output' as const,
    root: '/scratch/results-a'
  }
  const projectScope = {
    sessionId: 'session-a',
    projectId: 'project-a',
    hostAlias: 'cluster-a',
    canonicalRoot: '/cluster/work'
  }
  assert.deepEqual(
    workspaceFileRoute('ssh://cluster-a/scratch/results-a/report.html', resultScope, projectScope),
    {
      kind: 'wrapper-result',
      request: {
        projectId: 'project-a',
        hostProfileId: 'host-a',
        runId: 'wrun_a',
        scope: 'output',
        path: 'report.html'
      }
    }
  )
  assert.equal(
    workspaceFileRoute('ssh://cluster-a/cluster/work/readme.md', resultScope, projectScope).kind,
    'remote-project'
  )
  assert.equal(workspaceFileRoute('/local/readme.md', resultScope, projectScope).kind, 'local')
  assert.throws(() => workspaceFileRoute('ssh://cluster-b/etc/passwd', resultScope, projectScope))
  assert.throws(() =>
    workspaceFileRoute('ssh://cluster-a/scratch/results-a/report.html', null, null)
  )
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

test('notebook environment errors point to the managed environment settings section', () => {
  assert.equal(
    notebookEnvironmentErrorMessage(new Error('环境 phi:python@1 尚未构建。'), '运行失败'),
    '环境 phi:python@1 尚未构建。 请前往“设置 → 环境”的“托管环境”构建后重试。'
  )
  assert.equal(
    notebookEnvironmentErrorMessage(new Error('kernel 启动失败'), '运行失败'),
    'kernel 启动失败'
  )
  assert.equal(
    notebookEnvironmentErrorMessage(
      new Error('environment phi:python@1 is not ready; the user must build it first'),
      '运行失败'
    ),
    'environment phi:python@1 is not ready; the user must build it first 请前往“设置 → 环境”的“托管环境”构建后重试。'
  )
})
