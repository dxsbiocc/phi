import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { sidebarStateForFileOpenConversationLayout } from '../src/renderer/src/features/chat/lib/fileOpenConversationLayout'
import {
  openLocalPath,
  type PathOpenerTargets
} from '../src/renderer/src/features/file-preview/lib/pathOpeners'
import { isNotebookFilePath } from '../src/renderer/src/features/analysis/lib/notebookPaths'
import { absoluteWorkspacePath, fileNameFromPath } from '../src/renderer/src/lib/workspacePaths'
import {
  visibleWorkspaceTabsForState,
  workspaceFileTabKey,
  type WorkspaceFileWorkspaceTab,
  type WorkspaceSessionTab
} from '../src/renderer/src/lib/workspaceResourceTabs'
import {
  notebookWorkspaceTabId,
  upsertReusableWorkspaceFileTab,
  type WorkspaceFileTab
} from '../src/renderer/src/useWorkspaceFileTabs'

const source = ts.createSourceFile(
  'App.tsx',
  readFileSync('src/renderer/src/App.tsx', 'utf8'),
  ts.ScriptTarget.Latest,
  true
)

function expression(name: string): string {
  let value: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name)
      value = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(value, `${name} must exist`)
  return (ts.isCallExpression(value) ? value.arguments[0] : value).getText(source)
}

function pendingNotebookTabEffect(): string {
  let effect: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'useEffect' &&
      node.arguments[0]?.getText(source).includes('pendingNotebookTab.ownerCwd') &&
      node.arguments[0]?.getText(source).includes('workspaceFileTabs.some')
    ) {
      effect = node.arguments[0]
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(effect, 'Notebook tab restoration effect must exist')
  return effect.getText(source)
}

const script = ts.transpileModule(
  `${['applyFileOpenConversationLayout', 'onOpenNotebookWorkspaceFile']
    .map((name) => `const ${name} = ${expression(name)};`)
    .join('\n')}
  ({ applyFileOpenConversationLayout, onOpenNotebookWorkspaceFile, showSession: () => (${expression('shouldShowSessionWorkspaceTab')}) })`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText

const conversation: WorkspaceSessionTab = {
  key: 'session:phi-session:current',
  kind: 'session',
  itemId: 'phi-session:current',
  title: '帮我整理这个项目',
  sessionPath: 'phi-session:current',
  sessionGeneration: 4,
  sidebarMode: 'projects'
}
const notebookKey = workspaceFileTabKey(
  notebookWorkspaceTabId('project-1', '/project/notebooks/01_merge_and_qc.ipynb')
)

async function openNotebook(options: {
  cached: boolean
  open: boolean
  layout: 'tab' | 'sidebar'
  mode: 'conversations' | 'projects'
}): Promise<{ keys: string[]; activeKey: string; open: boolean }> {
  let files: WorkspaceFileTab[] = []
  let activeKey = conversation.key
  const path = '/project/notebooks/01_merge_and_qc.ipynb'
  const file = {
    path,
    name: '01_merge_and_qc.ipynb',
    relativePath: 'notebooks/01_merge_and_qc.ipynb'
  }
  const state = {
    activeView: 'chat',
    isSidebarOpen: options.open,
    workspaceSidebarMode: options.mode,
    fileOpenConversationLayout: options.layout,
    sidebarStateForFileOpenConversationLayout,
    projectSidebarSelectionRequestRef: { current: 0 },
    filePreviewRequestRef: { current: 0 },
    useSessionStore: {
      getState: () => ({
        activeCwd: '/project',
        activeProjectId: 'project-1',
        activeSessionPath: 'phi-session:current',
        activeProjectLocation: { kind: 'local' }
      })
    },
    blockNotebookWorkspaceOpen: () => false,
    openActiveWrapperResultPath: () => false,
    openRemoteNotebookPath: () => false,
    absoluteWorkspacePath,
    fileNameFromPath,
    workspaceFileTabKey,
    isNotebookFilePath,
    upsertReusableWorkspaceFileTab,
    notebookWorkspaceTabId,
    setFilePreview: () => undefined,
    setActiveWorkspaceFilePath: () => undefined,
    setActiveWorkspaceTabKey: (key: string) => {
      activeKey = key
    },
    setWorkspaceFileTabs: (update: (tabs: WorkspaceFileTab[]) => WorkspaceFileTab[]) => {
      files = update(files)
    },
    setIsSidebarOpen: (open: boolean) => {
      state.isSidebarOpen = open
    },
    setWorkspaceSidebarMode: (mode: typeof options.mode) => {
      state.workspaceSidebarMode = mode
    },
    navigateToView: (view: string) => {
      state.activeView = view
    },
    activateCachedAnalysisNotebook: () => (options.cached ? file : null),
    onOpenAnalysisNotebook: async () => file,
    refreshAnalysisNotebooks: () => undefined,
    refreshAnalysisKernels: () => undefined,
    refreshAnalysisJupyterStatus: () => undefined
  }
  const actions = runInNewContext(script, state) as {
    applyFileOpenConversationLayout: () => void
    onOpenNotebookWorkspaceFile: (path: string) => void
    showSession: () => boolean
  }
  const targets: PathOpenerTargets = {
    applyLayout: actions.applyFileOpenConversationLayout,
    getActiveCwd: () => '/project',
    setActiveTabKey: (key: string) => {
      activeKey = key
    },
    previewFile: () => undefined,
    previewDirectory: () => undefined,
    openSystemDefault: () => undefined,
    isRemoteProject: () => false,
    getActiveProjectId: () => null,
    getRemoteScope: () => null,
    blockLocalInRemote: () => false,
    notifyError: () => undefined,
    openNotebook: actions.onOpenNotebookWorkspaceFile,
    wrapper: { scope: null, isActiveUri: () => false, openPath: () => '' }
  }
  openLocalPath(targets, 'notebooks/01_merge_and_qc.ipynb', 'file')
  await Promise.resolve()
  const workspaceFiles: WorkspaceFileWorkspaceTab[] = files.map((tab) => ({
    ...tab,
    key: workspaceFileTabKey(tab.id),
    itemId: tab.id,
    title: tab.name,
    absolutePath: tab.path
  }))
  const tabs = visibleWorkspaceTabsForState({
    currentSessionTab: conversation,
    workspaceTabs: [conversation],
    workspaceFileTabs: workspaceFiles,
    closedSessionTabKeys: new Set(),
    shouldShowSessionTab: actions.showSession(),
    sessionTabWasOpened: true
  })
  return { keys: tabs.map((tab) => tab.key), activeKey, open: state.isSidebarOpen }
}

for (const cached of [false, true]) {
  test(`a chat Notebook link keeps the conversation tab with a collapsed conversation sidebar (${cached ? 'cached' : 'first open'})`, async () => {
    const state = await openNotebook({ cached, open: false, layout: 'tab', mode: 'conversations' })
    assert.deepEqual(state.keys, [conversation.key, notebookKey])
    assert.equal(state.activeKey, notebookKey)
    assert.equal(state.open, false)
  })
}

test('an expanded project sidebar also preserves the separate conversation tab', async () => {
  const state = await openNotebook({ cached: true, open: true, layout: 'tab', mode: 'projects' })
  assert.ok(state.keys.includes(conversation.key))
})

test('an explicitly docked conversation stays in its expanded sidebar', async () => {
  const state = await openNotebook({
    cached: false,
    open: false,
    layout: 'sidebar',
    mode: 'projects'
  })
  assert.equal(state.open, true)
  assert.deepEqual(state.keys, [notebookKey])
})

test('reopening one notebook from another session in the same project selects one tab', () => {
  const path = '/project/notebooks/eda.ipynb'
  const session = {
    activeProjectId: 'project-1',
    activeCwd: '/project',
    activeSessionPath: 'session-a'
  }
  let files: WorkspaceFileTab[] = []
  let activeKey = ''
  const open = runInNewContext(
    ts.transpileModule(`(${expression('onOpenNotebookWorkspaceFile')})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText,
    {
      useSessionStore: { getState: () => session },
      blockNotebookWorkspaceOpen: () => false,
      applyFileOpenConversationLayout: () => undefined,
      absoluteWorkspacePath,
      notebookWorkspaceTabId,
      fileNameFromPath,
      workspaceFileTabKey,
      upsertReusableWorkspaceFileTab,
      filePreviewRequestRef: { current: 0 },
      setFilePreview: () => undefined,
      setActiveWorkspaceTabKey: (key: string) => {
        activeKey = key
      },
      setWorkspaceFileTabs: (update: (tabs: WorkspaceFileTab[]) => WorkspaceFileTab[]) => {
        files = update(files)
      },
      setActiveWorkspaceFilePath: () => undefined,
      navigateToView: () => undefined,
      activateCachedAnalysisNotebook: (notebookPath: string) => ({
        path: notebookPath,
        name: fileNameFromPath(notebookPath),
        relativePath: notebookPath
      })
    }
  ) as (notebookPath: string) => void

  open(path)
  session.activeSessionPath = 'session-b'
  session.activeCwd = '/project/analysis'
  open(path)
  assert.equal(files.length, 1)
  assert.equal(files[0].ownerSessionPath, 'session-b')
  assert.equal(activeKey, workspaceFileTabKey(files[0].id))

  open('/project/other/eda.ipynb')
  assert.equal(files.length, 2, 'different files with the same basename need separate tabs')

  session.activeProjectId = 'project-2'
  open(path)
  assert.equal(files.length, 3, 'the same remote path in another project needs a separate tab')
})

test('reopening a notebook removes old session-scoped duplicate tabs and keeps dirty state', () => {
  const path = '/project/notebooks/eda.ipynb'
  const oldTabs: WorkspaceFileTab[] = ['session-a', 'session-b'].map((sessionPath) => ({
    id: `notebook:${JSON.stringify([sessionPath, '/project', path])}`,
    path,
    name: 'eda.ipynb',
    status: path,
    kind: 'notebook',
    pathKind: 'file',
    ownerSessionPath: sessionPath,
    ownerCwd: '/project',
    dirty: sessionPath === 'session-b'
  }))
  const reopened: WorkspaceFileTab = {
    ...oldTabs[0],
    id: notebookWorkspaceTabId('project-1', path),
    ownerProjectId: 'project-1',
    ownerSessionPath: 'session-c',
    dirty: undefined
  }
  const tabs = upsertReusableWorkspaceFileTab(oldTabs, reopened)
  assert.equal(tabs.length, 1)
  assert.equal(tabs[0].id, reopened.id)
  assert.equal(tabs[0].ownerSessionPath, 'session-c')
  assert.equal(tabs[0].dirty, true)
})

test('selecting an inactive remote notebook tab switches to its owning session before opening it', async () => {
  const path = '/remote/notebooks/quicksort.ipynb'
  const tab: WorkspaceFileTab = {
    id: notebookWorkspaceTabId('remote-project', path),
    path,
    name: 'quicksort.ipynb',
    status: path,
    kind: 'notebook',
    pathKind: 'file',
    ownerSessionPath: 'remote-session',
    ownerCwd: '/remote/anchor'
  }
  const selectedSessions: string[] = []
  const pending: unknown[] = []
  const opened: string[] = []
  const callback = runInNewContext(
    ts.transpileModule(`(${expression('onSelectWorkspaceFileTab')})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText,
    {
      workspaceFileTabs: [tab],
      activeCwd: '/local/project',
      setPendingNotebookTab: (value: unknown) => pending.push(value),
      onOpenSessionFromSidebar: async (sessionPath: string) => {
        selectedSessions.push(sessionPath)
      },
      onOpenNotebookWorkspaceFile: (notebookPath: string) => opened.push(notebookPath),
      showSnackbarError: () => assert.fail('switch should succeed'),
      appCopy: { openNotebookFailed: 'Could not open notebook' }
    }
  ) as (tab: WorkspaceFileTab) => void

  callback(tab)
  await Promise.resolve()
  assert.deepEqual(selectedSessions, ['remote-session'])
  assert.equal(pending.length, 1)
  assert.equal((pending[0] as { ownerCwd: string }).ownerCwd, '/remote/anchor')
  assert.deepEqual(opened, [], 'the old local workspace must not open a remote file')
})

test('selecting a notebook tab in the current project keeps this session active', () => {
  const path = '/project/notebooks/eda.ipynb'
  const tab: WorkspaceFileTab = {
    id: notebookWorkspaceTabId('project-1', path),
    path,
    name: 'eda.ipynb',
    status: path,
    kind: 'notebook',
    pathKind: 'file',
    ownerProjectId: 'project-1',
    ownerSessionPath: 'session-a',
    ownerCwd: '/project'
  }
  let tabs = [tab]
  let activeKey: string | null = null
  const select = runInNewContext(
    ts.transpileModule(`(${expression('onSelectWorkspaceFileTab')})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText,
    {
      workspaceFileTabs: tabs,
      activeProjectId: 'project-1',
      activeCwd: '/project/analysis',
      activeSessionPath: 'session-b',
      setWorkspaceFileTabs: (update: (current: WorkspaceFileTab[]) => WorkspaceFileTab[]) => {
        tabs = update(tabs)
      },
      setActiveWorkspaceTabKey: (key: string) => {
        activeKey = key
      },
      setActiveWorkspaceFilePath: () => undefined,
      navigateToView: () => undefined,
      workspaceFileTabKey,
      activateCachedAnalysisNotebook: () => true,
      onOpenSessionFromSidebar: () => assert.fail('do not switch to the previous session'),
      onOpenNotebookWorkspaceFile: () => assert.fail('cached notebook should remain open')
    }
  ) as (tab: WorkspaceFileTab) => void

  select(tab)
  assert.equal(activeKey, workspaceFileTabKey(tab.id))
  assert.equal(tabs[0].ownerSessionPath, 'session-b')
  assert.equal(tabs[0].ownerCwd, '/project/analysis')
})

test('a switched session restores its pending notebook tab only inside the owning workspace', async () => {
  const path = '/remote/notebooks/quicksort.ipynb'
  const pendingNotebookTab = {
    id: notebookWorkspaceTabId('remote-project', path),
    path,
    ownerSessionPath: 'remote-session',
    ownerCwd: '/remote/anchor'
  }
  const opened: string[] = []
  const cleared: unknown[] = []
  const context = {
    pendingNotebookTab,
    activeCwd: '/local/project',
    activeSessionPath: 'local-session',
    workspaceFileTabs: [pendingNotebookTab],
    useSessionStore: {
      getState: () => ({ activeCwd: '/remote/anchor', activeSessionPath: 'remote-session' })
    },
    setPendingNotebookTab: (value: unknown) => cleared.push(value),
    onOpenNotebookWorkspaceFile: (notebookPath: string) => opened.push(notebookPath)
  }
  const effect = runInNewContext(
    ts.transpileModule(`(${pendingNotebookTabEffect()})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText,
    context
  ) as () => (() => void) | undefined

  effect()
  await Promise.resolve()
  assert.deepEqual(opened, [])
  context.activeCwd = '/remote/anchor'
  context.activeSessionPath = 'remote-session'
  effect()
  await Promise.resolve()
  assert.deepEqual(cleared, [null])
  assert.deepEqual(opened, [path])
})

test('closing an inactive notebook tab does not close another host tab with the same path', () => {
  const path = '/shared/notebooks/demo.ipynb'
  const local: WorkspaceFileTab = {
    id: notebookWorkspaceTabId('local-project', path),
    path,
    name: 'demo.ipynb',
    status: path,
    kind: 'notebook',
    pathKind: 'file',
    ownerSessionPath: 'local-session',
    ownerCwd: '/local/project'
  }
  const remote: WorkspaceFileTab = {
    ...local,
    id: notebookWorkspaceTabId('remote-project', path),
    ownerSessionPath: 'remote-session',
    ownerCwd: '/remote/anchor'
  }
  let tabs = [local, remote]
  const close = runInNewContext(
    ts.transpileModule(`(${expression('onCloseWorkspaceFileTab')})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText,
    {
      workspaceFileTabs: tabs,
      activeCwd: '/local/project',
      activeWorkspaceFilePath: path,
      effectiveActiveWorkspaceTabKey: workspaceFileTabKey(local.id),
      workspaceFileTabKey,
      setWorkspaceFileTabs: (next: WorkspaceFileTab[]) => {
        tabs = next
      },
      textFileHasUnsavedChanges: () => false,
      filePreview: null
    }
  ) as (tab: WorkspaceFileTab) => void

  close(remote)
  assert.deepEqual(tabs, [local])
})

test('a dirty notebook tab stays open until it is saved', () => {
  const tab: WorkspaceFileTab = {
    id: notebookWorkspaceTabId('remote-project', '/remote/demo.ipynb'),
    path: '/remote/demo.ipynb',
    name: 'demo.ipynb',
    status: 'demo.ipynb',
    kind: 'notebook',
    pathKind: 'file',
    dirty: true,
    ownerSessionPath: 'remote-session',
    ownerCwd: '/remote/anchor'
  }
  const warnings: string[] = []
  const close = runInNewContext(
    ts.transpileModule(`(${expression('onCloseWorkspaceFileTab')})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText,
    {
      workspaceFileTabs: [tab],
      appCopy: { saveFileFirst: 'Save first' },
      showSnackbar: (message: string) => warnings.push(message)
    }
  ) as (tab: WorkspaceFileTab) => void

  close(tab)
  assert.deepEqual(warnings, ['Save first'])
})
