import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  useWorkspaceTabNavigation,
  type WorkspaceTabNavigation,
  type WorkspaceTabNavigationDeps
} from '../src/renderer/src/features/workspace/hooks/useWorkspaceTabNavigation'
import type { WorkspaceTab } from '../src/renderer/src/lib/workspaceResourceTabs'
import type { WorkspaceSidebarMode } from '../src/renderer/src/lib/workspaceSidebar'

type Recorded = {
  key: string | null
  sidebarMode: WorkspaceSidebarMode | null
  view: string
  skill: string | null
  connector: string | null
  wrapper: string | null
  sessionOpened: boolean | null
  selectedSession: string | null
  acknowledged: number
  previewCloses: number
  closedKeys: string[]
  storedTabs: string[]
  fileTabSelected: string | null
  fileTabClosed: string | null
}

function harness(
  options: {
    visibleTabs?: WorkspaceTab[]
    activeKey?: string | null
    activeSkillId?: string | null
    activeMcpServerId?: string | null
    selectedWrapperId?: string | null
    activeSessionPath?: string | null
  } = {}
): { actions: WorkspaceTabNavigation; state: Recorded } {
  const state: Recorded = {
    key: null,
    sidebarMode: null,
    view: '',
    skill: null,
    connector: null,
    wrapper: null,
    sessionOpened: null,
    selectedSession: null,
    acknowledged: 0,
    previewCloses: 0,
    closedKeys: [],
    storedTabs: [],
    fileTabSelected: null,
    fileTabClosed: null
  }
  const deps: WorkspaceTabNavigationDeps = {
    workspaceTabs: [],
    setWorkspaceTabs: (update) => {
      const next = typeof update === 'function' ? update([]) : update
      state.storedTabs = next.map((tab) => tab.key)
    },
    activeWorkspaceTabKey: options.activeKey ?? null,
    setActiveWorkspaceTabKey: (key) => {
      state.key = key
    },
    visibleWorkspaceTabs: options.visibleTabs ?? [],
    effectiveActiveWorkspaceTabKey: options.activeKey ?? options.visibleTabs?.[0]?.key ?? null,
    activeSkillId: options.activeSkillId ?? null,
    activeMcpServerId: options.activeMcpServerId ?? null,
    selectedWrapperId: options.selectedWrapperId ?? null,
    setWorkspaceSidebarMode: (mode) => {
      state.sidebarMode = mode
    },
    setActiveSkillId: (id) => {
      state.skill = id
    },
    setActiveMcpServerId: (id) => {
      state.connector = id
    },
    setSelectedWrapperId: (id) => {
      state.wrapper = id
    },
    setSessionTabWasOpened: (value) => {
      state.sessionOpened = value
    },
    setClosedWorkspaceSessionTabKeys: (update) => {
      const result = update(new Set<string>())
      state.closedKeys = [...result]
    },
    navigateToView: (view) => {
      state.view = view
    },
    onSelectSession: async (path) => {
      state.selectedSession = path
    },
    acknowledgeActiveSession: async () => {
      state.acknowledged += 1
    },
    onSelectWorkspaceFileTab: (tab) => {
      state.fileTabSelected = tab.key
    },
    onCloseWorkspaceFileTab: (tab) => {
      state.fileTabClosed = tab.key
    },
    closeWorkspaceSidebarPreview: () => {
      state.previewCloses += 1
    },
    activeSessionPath: options.activeSessionPath ?? null
  }

  let actions: WorkspaceTabNavigation | undefined
  function Probe(): null {
    actions = useWorkspaceTabNavigation(deps)
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  assert.ok(actions, 'the hook returned its actions')
  return { actions, state }
}

function resourceTab(kind: 'skills' | 'mcp' | 'plugins' | 'wrappers' | 'runtime'): WorkspaceTab {
  return { key: `${kind}:chosen`, kind, itemId: 'chosen', title: kind }
}

test('selecting a resource tab switches the sidebar, the item and the view', () => {
  for (const kind of ['skills', 'mcp', 'plugins', 'wrappers', 'runtime'] as const) {
    const { actions, state } = harness()
    actions.selectTab(resourceTab(kind))
    assert.equal(state.key, `${kind}:chosen`)
    assert.equal(state.sidebarMode, kind)
    assert.equal(state.view, kind)
  }
})

test('selecting a resource tab sets the sidebar item that tab represents', () => {
  const skills = harness()
  skills.actions.selectTab(resourceTab('skills'))
  assert.equal(skills.state.skill, 'chosen')

  const connectors = harness()
  connectors.actions.selectTab(resourceTab('mcp'))
  assert.equal(connectors.state.connector, 'chosen')

  const wrappers = harness()
  wrappers.actions.selectTab(resourceTab('wrappers'))
  assert.equal(wrappers.state.wrapper, 'chosen')
})

test('the tab strip entry point drops the sidebar preview before selecting', () => {
  const { actions, state } = harness()
  actions.selectTabFromChrome(resourceTab('skills'))
  assert.equal(state.previewCloses, 1)
  assert.equal(state.key, 'skills:chosen')
})

test('selecting a tab directly leaves any hover preview alone', () => {
  const { actions, state } = harness()
  actions.selectTab(resourceTab('skills'))
  assert.equal(state.previewCloses, 0)
})

for (const sidebarMode of ['conversations', 'projects'] as const) {
  test(`a ${sidebarMode} session tab moves the view to chat without re-selecting itself`, () => {
    const { actions, state } = harness({ activeSessionPath: '/current' })
    actions.selectTabFromChrome({
      key: 'session:/current',
      kind: 'session',
      itemId: '/current',
      title: 'Current session',
      sessionPath: '/current',
      sessionGeneration: 1,
      sidebarMode
    })

    assert.equal(state.key, 'session:/current')
    assert.equal(state.sidebarMode, sidebarMode)
    assert.equal(state.view, 'chat')
    assert.equal(state.sessionOpened, true)
    assert.equal(state.previewCloses, 1)
    // Same session path: acknowledge instead of selecting it again.
    assert.equal(state.selectedSession, null)
    assert.equal(state.acknowledged, 1)
  })
}

test('selecting a different session loads it and clears its closed marker', () => {
  const { actions, state } = harness({ activeSessionPath: '/current' })
  actions.selectTab({
    key: 'session:/other',
    kind: 'session',
    itemId: '/other',
    title: 'Other session',
    sessionPath: '/other',
    sessionGeneration: 1,
    sidebarMode: 'conversations'
  })

  assert.equal(state.selectedSession, '/other')
  assert.equal(state.acknowledged, 0)
  assert.deepEqual(state.closedKeys, [])
})

test('a file tab hands off to the file workspace instead of navigating', () => {
  const { actions, state } = harness()
  actions.selectTab({
    key: 'file:/p/a.ts',
    kind: 'file',
    itemId: '/p/a.ts',
    title: 'a.ts',
    name: 'a.ts',
    status: 'ready',
    path: '/p/a.ts',
    pathKind: 'file',
    absolutePath: '/p/a.ts'
  })

  assert.equal(state.fileTabSelected, 'file:/p/a.ts')
  assert.equal(state.view, '')
  assert.equal(state.sidebarMode, null)
})

test('closing the active tab falls back to its neighbour', () => {
  const tabs = [resourceTab('skills'), resourceTab('mcp'), resourceTab('plugins')]
  const { actions, state } = harness({
    visibleTabs: tabs,
    activeKey: 'mcp:chosen'
  })

  actions.closeTab(tabs[1])

  assert.equal(state.key, 'plugins:chosen')
  assert.equal(state.view, 'plugins')
  assert.equal(state.previewCloses, 0)
})

test('closing the last tab clears the selection and returns to chat', () => {
  const tabs = [resourceTab('skills')]
  const { actions, state } = harness({ visibleTabs: tabs, activeKey: 'skills:chosen' })

  actions.closeTab(tabs[0])

  assert.equal(state.key, null)
  assert.equal(state.view, 'chat')
})

test('closing a resource tab clears its sidebar highlight even when inactive', () => {
  const tabs = [resourceTab('skills'), resourceTab('mcp')]
  const { actions, state } = harness({
    visibleTabs: tabs,
    activeKey: 'mcp:chosen',
    activeSkillId: 'chosen'
  })

  actions.closeTab(tabs[0])

  // The hover preview must survive: closing a tab is not selecting one.
  assert.equal(state.previewCloses, 0)
  assert.equal(state.skill, null)
  // Inactive tab closed: the active one stays selected.
  assert.equal(state.key, null)
})

test('closing a session tab hides it until it is selected again', () => {
  const tabs: WorkspaceTab[] = [
    {
      key: 'session:/current',
      kind: 'session',
      itemId: '/current',
      title: 'Current session',
      sessionPath: '/current',
      sessionGeneration: 1,
      sidebarMode: 'conversations'
    },
    resourceTab('skills')
  ]
  const { actions, state } = harness({ visibleTabs: tabs, activeKey: 'skills:chosen' })

  actions.closeTab(tabs[0])

  assert.deepEqual(state.closedKeys, ['session:/current'])
  assert.equal(state.sessionOpened, false)
})

test('closing an unknown tab changes nothing', () => {
  const tabs = [resourceTab('skills')]
  const { actions, state } = harness({ visibleTabs: tabs, activeKey: 'skills:chosen' })

  actions.closeTab(resourceTab('mcp'))

  assert.equal(state.key, null)
  assert.equal(state.view, '')
  assert.equal(state.storedTabs.length, 0)
})

test('opening a resource tab both stores and selects it', () => {
  const { actions, state } = harness()

  actions.openResourceTab({ kind: 'plugins', itemId: 'installed', title: 'Plugins' })

  assert.deepEqual(state.storedTabs, ['plugins'])
  assert.equal(state.key, 'plugins')
  assert.equal(state.sidebarMode, 'plugins')
})

test('docking an inactive conversation keeps the selected file and opens its companion directly', () => {
  const path = 'src/renderer/src/App.tsx'
  const syntax = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  let expression: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(syntax) === 'onDockConversationToSidebar' &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      expression = node.initializer.arguments[0]
    }
    ts.forEachChild(node, visit)
  }
  visit(syntax)
  assert.ok(expression, 'onDockConversationToSidebar callback exists')

  const file = { path: '/project/notes.ipynb' },
    state = { file: '', docks: 0, previewCloses: 0 }
  const dock = runInNewContext(
    ts.transpileModule(`const dock=${expression.getText(syntax)};dock`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText,
    {
      currentSessionTab: { key: 'session:/current' },
      activeWorkspaceFileTab: file,
      workspaceFileTabs: [file],
      closeWorkspaceSidebarPreview: () => state.previewCloses++,
      onSelectWorkspaceFileTab: (tab: { path: string }) => {
        state.file = tab.path
      },
      showActiveConversationInSidebar: () => state.docks++
    }
  ) as (tab: { key: string }) => void
  dock({ key: 'session:/current' })
  assert.deepEqual(state, { file: '/project/notes.ipynb', docks: 1, previewCloses: 1 })
  dock({ key: 'session:/old' })
  assert.deepEqual(state, { file: '/project/notes.ipynb', docks: 1, previewCloses: 1 })
})
