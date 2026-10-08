import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import {
  isWorkspaceFileTabKind,
  workspaceResourceKindToSidebarMode,
  type WorkspaceTab
} from '../src/renderer/src/lib/workspaceResourceTabs'
import type { WorkspaceSidebarMode } from '../src/renderer/src/lib/workspaceSidebar'

const path = 'src/renderer/src/App.tsx'
const syntax = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)

function callback(name: string): string {
  let expression: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(syntax) === name &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      expression = node.initializer.arguments[0]
    }
    ts.forEachChild(node, visit)
  }
  visit(syntax)
  assert.ok(expression, `${name} callback exists`)
  return expression.getText(syntax)
}

function headerSelect(): string {
  let expression: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(syntax) === 'WorkspaceResourceHeader'
    ) {
      for (const property of node.attributes.properties) {
        if (
          ts.isJsxAttribute(property) &&
          property.name.getText(syntax) === 'onSelect' &&
          property.initializer &&
          ts.isJsxExpression(property.initializer)
        ) {
          expression = property.initializer.expression
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(syntax)
  assert.ok(expression)
  return expression.getText(syntax)
}

function navigation(open: boolean): {
  state: {
    open: boolean
    key: string
    mode: WorkspaceSidebarMode
    view: string
    skill: string
    connector: string
    wrapper: string
    previewCloses: number
    sessionOpened: boolean
  }
  selectWorkspaceTab: (tab: WorkspaceTab) => void
  selectFromHeader: (tab: WorkspaceTab) => void
} {
  const state = {
    open,
    key: '',
    mode: 'skills' as WorkspaceSidebarMode,
    view: '',
    skill: '',
    connector: '',
    wrapper: '',
    previewCloses: 0,
    sessionOpened: false
  }
  const code = ts.transpileModule(
    `const selectWorkspaceTab = ${callback('selectWorkspaceTab')};
     const selectFromHeader = ${headerSelect()};
     ({selectWorkspaceTab, selectFromHeader})`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
  ).outputText
  const actions = runInNewContext(code, {
    setActiveWorkspaceTabKey: (key: string) => (state.key = key),
    setWorkspaceSidebarMode: (mode: WorkspaceSidebarMode) => (state.mode = mode),
    setIsSidebarOpen: (value: boolean) => (state.open = value),
    setActiveSkillId: (id: string) => (state.skill = id),
    setActiveMcpServerId: (id: string) => (state.connector = id),
    setSelectedWrapperId: (id: string) => (state.wrapper = id),
    navigateToView: (view: string) => (state.view = view),
    workspaceResourceKindToSidebarMode,
    isWorkspaceFileWorkspaceTab: (tab: WorkspaceTab) => isWorkspaceFileTabKind(tab.kind),
    onSelectWorkspaceFileTab: () => (state.view = 'analysis'),
    setSessionTabWasOpened: (value: boolean) => (state.sessionOpened = value),
    setClosedWorkspaceSessionTabKeys: (update: (keys: Set<string>) => Set<string>) =>
      update(new Set()),
    useSessionStore: { getState: () => ({ activeSessionPath: '/current' }) },
    onSelectSession: async () => undefined,
    acknowledgeActiveSession: async () => undefined,
    closeWorkspaceSidebarPreview: () => state.previewCloses++
  }) as {
    selectWorkspaceTab: (tab: WorkspaceTab) => void
    selectFromHeader: (tab: WorkspaceTab) => void
  }
  return { state, ...actions }
}

for (const kind of ['skills', 'mcp', 'plugins', 'wrappers', 'runtime'] as const) {
  for (const open of [false, true]) {
    test(`${kind} tab preserves its ${open ? 'expanded' : 'collapsed'} sidebar and clears previews`, () => {
      const { state, selectFromHeader } = navigation(open)
      selectFromHeader({ key: kind, kind, itemId: 'chosen', title: kind })
      assert.equal(state.open, open)
      assert.equal(state.key, kind)
      assert.equal(state.mode, kind)
      assert.equal(state.view, kind)
      assert.equal(state.previewCloses, 1)
      if (kind === 'skills') assert.equal(state.skill, 'chosen')
      if (kind === 'mcp') assert.equal(state.connector, 'chosen')
      if (kind === 'wrappers') assert.equal(state.wrapper, 'chosen')
    })
  }
}

for (const mode of ['conversations', 'projects'] as const) {
  test(`${mode} session tab preserves a collapsed sidebar`, () => {
    const { state, selectFromHeader } = navigation(false)
    selectFromHeader({
      key: 'session:/current',
      kind: 'session',
      itemId: '/current',
      title: 'Current session',
      sessionPath: '/current',
      sessionGeneration: 1,
      sidebarMode: mode
    })
    assert.equal(state.open, false)
    assert.equal(state.mode, mode)
    assert.equal(state.view, 'chat')
    assert.equal(state.sessionOpened, true)
    assert.equal(state.previewCloses, 1)
  })
}

test('resource selection from an existing sidebar does not dismiss its hover preview', () => {
  const { state, selectWorkspaceTab } = navigation(false)
  selectWorkspaceTab({ key: 'skills', kind: 'skills', itemId: 'chosen', title: 'Skill' })
  assert.equal(state.open, false)
  assert.equal(state.previewCloses, 0)
})
