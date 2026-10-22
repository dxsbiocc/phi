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
  notebookWorkspaceTabId(
    'phi-session:current',
    '/project',
    '/project/notebooks/01_merge_and_qc.ipynb'
  )
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

test('selecting an inactive remote notebook tab switches to its owning session before opening it', async () => {
  const path = '/remote/notebooks/quicksort.ipynb'
  const tab: WorkspaceFileTab = {
    id: notebookWorkspaceTabId('remote-session', '/remote/anchor', path),
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

test('a switched session restores its pending notebook tab only inside the owning workspace', async () => {
  const path = '/remote/notebooks/quicksort.ipynb'
  const pendingNotebookTab = {
    id: notebookWorkspaceTabId('remote-session', '/remote/anchor', path),
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
    id: notebookWorkspaceTabId('local-session', '/local/project', path),
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
    id: notebookWorkspaceTabId('remote-session', '/remote/anchor', path),
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
    id: notebookWorkspaceTabId('remote-session', '/remote/anchor', '/remote/demo.ipynb'),
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
