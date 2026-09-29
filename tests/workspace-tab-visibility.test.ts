import assert from 'node:assert/strict'
import test from 'node:test'
import {
  visibleWorkspaceTabsForState,
  workspaceSessionTabKey,
  type WorkspaceResourceTab,
  type WorkspaceSessionTab,
  type WorkspaceTab
} from '../src/renderer/src/lib/workspaceResourceTabs'

function sessionTab(path: string | null, generation = 1): WorkspaceSessionTab {
  return {
    key: workspaceSessionTabKey(path, generation),
    kind: 'session',
    itemId: path ?? `fresh:${generation}`,
    title: '新对话',
    sessionPath: path,
    sessionGeneration: generation,
    sidebarMode: 'conversations'
  }
}

function visible(
  currentSessionTab: WorkspaceSessionTab,
  sessionTabWasOpened: boolean,
  options: {
    workspaceTabs?: WorkspaceTab[]
    closedSessionTabKeys?: ReadonlySet<string>
  } = {}
): WorkspaceTab[] {
  return visibleWorkspaceTabsForState({
    currentSessionTab,
    workspaceTabs: options.workspaceTabs ?? [],
    workspaceFileTabs: [],
    closedSessionTabKeys: options.closedSessionTabKeys ?? new Set(),
    shouldShowSessionTab: true,
    sessionTabWasOpened
  })
}

test('startup shows Home instead of an implicit blank conversation', () => {
  assert.deepEqual(visible(sessionTab(null), false), [])
  assert.deepEqual(visible(sessionTab('/saved/empty-session'), false), [])
})

test('an explicit New Chat opens a session tab and closing it returns Home', () => {
  const tab = sessionTab('/saved/new-session')
  assert.deepEqual(visible(tab, true), [tab])
  assert.deepEqual(visible(tab, false, { closedSessionTabKeys: new Set([tab.key]) }), [])
})

test('a later session generation cannot reopen a tab after returning Home', () => {
  assert.deepEqual(visible(sessionTab(null, 2), false), [])
})

test('an opened fresh tab follows its session when the first prompt gives it a path', () => {
  const fresh = sessionTab(null, 1)
  const materialized = sessionTab('/saved/new-session', 1)
  assert.deepEqual(visible(materialized, true, { workspaceTabs: [fresh] }), [materialized])
})

test('Home can coexist with resource tabs without creating a conversation tab', () => {
  const pluginTab: WorkspaceResourceTab = {
    key: 'plugins:example',
    kind: 'plugins',
    itemId: 'example',
    title: 'Example'
  }
  assert.deepEqual(
    visible(sessionTab('/saved/empty-session'), false, { workspaceTabs: [pluginTab] }),
    [pluginTab]
  )
})
