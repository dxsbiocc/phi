import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { sidebarStateForFileOpenConversationLayout } from '../src/renderer/src/features/chat/lib/fileOpenConversationLayout'
import {
  previewFileInWorkspaceTab,
  type PathOpenerTargets
} from '../src/renderer/src/features/file-preview/lib/pathOpeners'
import { absoluteWorkspacePath, fileNameFromPath } from '../src/renderer/src/lib/workspacePaths'
import type { WorkspaceSidebarMode } from '../src/renderer/src/lib/workspaceSidebar'

/** Recording surfaces for the path router; each test overrides what it checks. */
function openerTargets(overrides: Partial<PathOpenerTargets> = {}): PathOpenerTargets {
  return {
    applyLayout: () => undefined,
    getActiveCwd: () => '/project',
    setActiveTabKey: () => undefined,
    previewFile: () => undefined,
    previewDirectory: () => undefined,
    openSystemDefault: () => undefined,
    isRemoteProject: () => false,
    getActiveProjectId: () => null,
    getRemoteScope: () => null,
    blockLocalInRemote: () => false,
    notifyError: () => undefined,
    openNotebook: () => undefined,
    wrapper: { scope: null, isActiveUri: () => false, openPath: () => '' },
    ...overrides
  }
}

function callback(path: string, name: string): string {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  let expression: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === name &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      expression = node.initializer.arguments[0]
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(expression, `${name} exists`)
  return ts.transpileModule(`const ${name} = ${expression.getText(source)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
}

const app = 'src/renderer/src/App.tsx'
const files = 'src/renderer/src/useWorkspaceFileTabs.ts'
const callbacks = [
  callback(app, 'applyFileOpenConversationLayout'),
  callback(files, 'openWorkspaceTab'),
  callback(files, 'previewFilePath')
].join('\n')

for (const open of [false, true]) {
  for (const mode of ['conversations', 'files', 'projects', 'skills', 'runtime'] as const) {
    test(`opening a file in tab layout preserves ${open ? 'expanded' : 'collapsed'} ${mode} sidebar`, () => {
      const state = {
        open,
        mode: mode as WorkspaceSidebarMode,
        view: 'chat',
        activePath: '',
        tab: null as { path: string } | null,
        loaded: ''
      }
      const selectRef = { current: 7 }
      const invoke = runInNewContext(
        `${callbacks}\n({ applyFileOpenConversationLayout, previewFilePath })`,
        {
          fileOpenConversationLayout: 'tab',
          sidebarStateForFileOpenConversationLayout,
          projectSidebarSelectionRequestRef: selectRef,
          setIsSidebarOpen: (next: boolean) => {
            state.open = next
          },
          setWorkspaceSidebarMode: (next: WorkspaceSidebarMode) => {
            state.mode = next
          },
          setActiveView: (next: string) => {
            state.view = next
          },
          workspaceFileTabKey: (path: string) => `file:${path}`,
          getActiveCwd: () => '/project',
          absoluteWorkspacePath,
          fileNameFromPath,
          activeWorkspaceFilePath: null,
          filePreview: null,
          upsertWorkspaceFileTab: (tab: { path: string }) => {
            state.tab = tab
          },
          loadFilePreview: (path: string) => {
            state.loaded = path
          }
        }
      ) as { applyFileOpenConversationLayout: () => void; previewFilePath: (path: string) => void }
      previewFileInWorkspaceTab(
        openerTargets({
          applyLayout: invoke.applyFileOpenConversationLayout,
          setActiveTabKey: (key: string) => {
            state.activePath = key
          },
          previewFile: invoke.previewFilePath
        }),
        '/project/sample_qc.tsv'
      )
      assert.equal(state.open, open)
      assert.equal(state.mode, mode)
      assert.equal(selectRef.current, 7)
      assert.equal(state.view, 'analysis')
      assert.equal(state.activePath, 'file:/project/sample_qc.tsv')
      assert.equal(state.tab?.path, '/project/sample_qc.tsv')
      assert.equal(state.loaded, '/project/sample_qc.tsv')
    })
  }
}

test('the preview hook does not reopen the sidebar after an explicit conversation layout decision', () => {
  const state = { open: false, view: 'chat', path: '' }
  const invoke = runInNewContext(`${callback(files, 'openWorkspaceTab')}\nopenWorkspaceTab`, {
    setIsSidebarOpen: (open: boolean) => {
      state.open = open
    },
    setActiveView: (view: string) => {
      state.view = view
    },
    upsertWorkspaceFileTab: (tab: { path: string }) => {
      state.path = tab.path
    }
  }) as (tab: { path: string }) => void
  invoke({ path: 'ssh://cluster/work/result.tsv' })
  assert.equal(state.open, false)
  assert.equal(state.view, 'analysis')
  assert.equal(state.path, 'ssh://cluster/work/result.tsv')
})

test('the explicit side-by-side conversation preference still opens its requested companion', () => {
  const state = { open: false, mode: 'files' as WorkspaceSidebarMode }
  const invoke = runInNewContext(
    `${callback(app, 'applyFileOpenConversationLayout')}\napplyFileOpenConversationLayout`,
    {
      fileOpenConversationLayout: 'sidebar',
      sidebarStateForFileOpenConversationLayout,
      projectSidebarSelectionRequestRef: { current: 0 },
      setIsSidebarOpen: (open: boolean) => {
        state.open = open
      },
      setWorkspaceSidebarMode: (mode: WorkspaceSidebarMode) => {
        state.mode = mode
      }
    }
  ) as () => void
  invoke()
  assert.deepEqual(state, { open: true, mode: 'conversations' })
})

test('opening a notebook in tab layout keeps the selected sidebar folded', () => {
  const state = { open: false, mode: 'projects' as WorkspaceSidebarMode, view: 'chat', path: '' }
  const invoke = runInNewContext(
    `${callback(app, 'applyFileOpenConversationLayout')}\n${callback(app, 'onOpenNotebookWorkspaceFile')}\nonOpenNotebookWorkspaceFile`,
    {
      fileOpenConversationLayout: 'tab',
      sidebarStateForFileOpenConversationLayout,
      projectSidebarSelectionRequestRef: { current: 0 },
      setIsSidebarOpen: (open: boolean) => {
        state.open = open
      },
      setWorkspaceSidebarMode: (mode: WorkspaceSidebarMode) => {
        state.mode = mode
      },
      blockNotebookWorkspaceOpen: () => false,
      useSessionStore: { getState: () => ({ activeCwd: '/project' }) },
      absoluteWorkspacePath,
      fileNameFromPath,
      filePreviewRequestRef: { current: 0 },
      setFilePreview: () => undefined,
      setActiveWorkspaceTabKey: () => undefined,
      workspaceFileTabKey: (path: string) => `file:${path}`,
      setWorkspaceFileTabs: () => undefined,
      setActiveWorkspaceFilePath: (path: string) => {
        state.path = path
      },
      navigateToView: (view: string) => {
        state.view = view
      },
      activateCachedAnalysisNotebook: (path: string) => ({
        path,
        name: 'eda.ipynb',
        relativePath: 'eda.ipynb'
      })
    }
  ) as (path: string) => void
  invoke('/project/eda.ipynb')
  assert.deepEqual(state, {
    open: false,
    mode: 'projects',
    view: 'analysis',
    path: '/project/eda.ipynb'
  })
})

test('explicit remote file reveal still opens the file tree', () => {
  const state = { open: false, mode: 'conversations' as WorkspaceSidebarMode, path: '' }
  const invoke = runInNewContext(
    `${callback(app, 'onRevealPreviewPathInWorkspace')}\nonRevealPreviewPathInWorkspace`,
    {
      setIsSidebarOpen: (open: boolean) => {
        state.open = open
      },
      setWorkspaceSidebarMode: (mode: WorkspaceSidebarMode) => {
        state.mode = mode
      },
      onRevealPreviewPath: (path: string) => {
        state.path = path
      }
    }
  ) as (path: string) => void
  invoke('ssh://cluster/work/result.tsv')
  assert.deepEqual(state, { open: true, mode: 'files', path: 'ssh://cluster/work/result.tsv' })
})
