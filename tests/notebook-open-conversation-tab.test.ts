import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { sidebarStateForFileOpenConversationLayout } from '../src/renderer/src/features/chat/lib/fileOpenConversationLayout'
import { isNotebookFilePath } from '../src/renderer/src/features/analysis/lib/notebookPaths'
import { absoluteWorkspacePath, fileNameFromPath } from '../src/renderer/src/lib/workspacePaths'
import {
  visibleWorkspaceTabsForState,
  workspaceFileTabKey,
  type WorkspaceFileWorkspaceTab,
  type WorkspaceSessionTab
} from '../src/renderer/src/lib/workspaceResourceTabs'
import {
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

const script = ts.transpileModule(
  `${['applyFileOpenConversationLayout', 'onOpenNotebookWorkspaceFile', 'onOpenLocalPath']
    .map((name) => `const ${name} = ${expression(name)};`)
    .join('\n')}
  ({ open: onOpenLocalPath, showSession: () => (${expression('shouldShowSessionWorkspaceTab')}) })`,
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
      getState: () => ({ activeCwd: '/project', activeProjectLocation: { kind: 'local' } })
    },
    blockNotebookWorkspaceOpen: () => false,
    blockRemoteLocalFileAction: () => false,
    openActiveWrapperResultPath: () => false,
    openRemoteNotebookPath: () => false,
    absoluteWorkspacePath,
    fileNameFromPath,
    workspaceFileTabKey,
    isNotebookFilePath,
    upsertReusableWorkspaceFileTab,
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
    open: (path: string, kind: 'file') => void
    showSession: () => boolean
  }
  actions.open('notebooks/01_merge_and_qc.ipynb', 'file')
  await Promise.resolve()
  const workspaceFiles: WorkspaceFileWorkspaceTab[] = files.map((tab) => ({
    ...tab,
    key: workspaceFileTabKey(tab.path),
    itemId: tab.path,
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
    assert.deepEqual(state.keys, [
      conversation.key,
      'file:/project/notebooks/01_merge_and_qc.ipynb'
    ])
    assert.equal(state.activeKey, 'file:/project/notebooks/01_merge_and_qc.ipynb')
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
  assert.deepEqual(state.keys, ['file:/project/notebooks/01_merge_and_qc.ipynb'])
})
