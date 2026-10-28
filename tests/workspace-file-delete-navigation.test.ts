import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { useWorkspaceFileActions } from '../src/renderer/src/features/file-preview/hooks/useWorkspaceFileActions'
import type { FileTreeActions } from '../src/renderer/src/features/file-preview/lib/fileTreeActions'
import type { RendererApi } from '../src/renderer/src/types'
import type { WorkspaceFileTab } from '../src/renderer/src/useWorkspaceFileTabs'

function fileTab(path: string): WorkspaceFileTab {
  return {
    id: path,
    path,
    name: path.split('/').pop() ?? path,
    status: 'ready',
    kind: 'file',
    pathKind: 'file'
  }
}

test('deleting the only open file reports that no file tabs remain', async () => {
  const open = fileTab('/project/readme.md')
  let remaining: WorkspaceFileTab[] | null = null
  let actions!: FileTreeActions
  const workspace = {
    filePreview: null,
    filePreviewCache: {},
    workspaceFileTabs: [open],
    activeWorkspaceFilePath: open.path,
    setFilePreview: () => undefined,
    clearCachedFilePreview: () => undefined,
    setWorkspaceFileTabs: () => undefined,
    setActiveWorkspaceFilePath: () => undefined,
    filePreviewRequestRef: { current: 0 }
  }
  function Harness(): null {
    actions = useWorkspaceFileActions({
      rootPath: '/project',
      rendererApi: {
        deleteWorkspaceFile: async () => undefined
      } as unknown as RendererApi,
      getActiveCwd: () => '/project',
      getActiveRemoteProject: () => null,
      workspace,
      onChanged: () => undefined,
      onOpenFile: () => undefined,
      onOpenDirectory: () => undefined,
      onDownloadFile: () => undefined,
      onRevealFile: () => undefined,
      onDeletedActiveFile: (tabs) => {
        remaining = tabs
      }
    })
    return null
  }
  renderToStaticMarkup(createElement(Harness))
  await actions.onDeleteFile?.(open.path)
  assert.deepEqual(remaining, [])
})

test('deleting one open file keeps the other file tab selected', async () => {
  const removed = fileTab('/project/readme.md')
  const kept = fileTab('/project/src/main.py')
  let remaining: WorkspaceFileTab[] | null = null
  let actions!: FileTreeActions
  const workspace = {
    filePreview: null,
    filePreviewCache: {},
    workspaceFileTabs: [kept, removed],
    activeWorkspaceFilePath: removed.path,
    setFilePreview: () => undefined,
    clearCachedFilePreview: () => undefined,
    setWorkspaceFileTabs: () => undefined,
    setActiveWorkspaceFilePath: () => undefined,
    filePreviewRequestRef: { current: 0 }
  }
  function Harness(): null {
    actions = useWorkspaceFileActions({
      rootPath: '/project',
      rendererApi: {
        deleteWorkspaceFile: async () => undefined
      } as unknown as RendererApi,
      getActiveCwd: () => '/project',
      getActiveRemoteProject: () => null,
      workspace,
      onChanged: () => undefined,
      onOpenFile: () => undefined,
      onOpenDirectory: () => undefined,
      onDownloadFile: () => undefined,
      onRevealFile: () => undefined,
      onDeletedActiveFile: (tabs) => {
        remaining = tabs
      }
    })
    return null
  }
  renderToStaticMarkup(createElement(Harness))
  await actions.onDeleteFile?.(removed.path)
  assert.deepEqual(remaining, [kept])
})
