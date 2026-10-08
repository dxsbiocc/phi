import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import test from 'node:test'
import { WorkspaceResourceTabs } from '../src/renderer/src/components/WorkspaceResourceTabs'
import { ConnectorIcon } from '../src/renderer/src/features/mcp/components/ConnectorIcon'
import {
  activeTabKeyAfterPrompt,
  upsertWorkspaceResourceTab,
  workspaceResourceTabKey,
  type WorkspaceResourceTab
} from '../src/renderer/src/lib/workspaceResourceTabs'

test('opening another item reuses the tab for its resource type', () => {
  const plugin: WorkspaceResourceTab = {
    key: 'plugins:one',
    kind: 'plugins',
    itemId: 'one',
    title: 'Plugin'
  }
  const first: WorkspaceResourceTab = {
    key: workspaceResourceTabKey('mcp'),
    kind: 'mcp',
    itemId: 'open-targets',
    title: 'Open Targets'
  }
  const second: WorkspaceResourceTab = {
    key: workspaceResourceTabKey('mcp'),
    kind: 'mcp',
    itemId: 'firecrawl',
    title: 'Firecrawl',
    connectorUrl: 'https://mcp.firecrawl.dev/v2/mcp'
  }
  assert.equal(first.key, second.key)
  const tabs = upsertWorkspaceResourceTab([plugin, first], second)
  assert.deepEqual(tabs, [plugin, second])
  assert.deepEqual(
    upsertWorkspaceResourceTab([plugin, first, { ...first, key: 'mcp:legacy' }], second),
    [plugin, second]
  )
  const otherPlugin: WorkspaceResourceTab = {
    key: workspaceResourceTabKey('plugins'),
    kind: 'plugins',
    itemId: 'two',
    title: 'Other plugin'
  }
  assert.deepEqual(upsertWorkspaceResourceTab([plugin, second], otherPlugin), [otherPlugin, second])
})

test('connector tabs display the selected connector icon', () => {
  const tab: WorkspaceResourceTab = {
    key: 'mcp',
    kind: 'mcp',
    itemId: 'firecrawl',
    title: 'Firecrawl',
    connectorUrl: 'https://mcp.firecrawl.dev/v2/mcp'
  }
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(WorkspaceResourceTabs, {
        tabs: [tab],
        activeKey: tab.key,
        onSelect: () => undefined,
        onClose: () => undefined,
        connectorIcon: (connectorId) => createElement(ConnectorIcon, { connectorId, size: 20 })
      })
    )
  )
  assert.match(markup, /firecrawl\.png/)
  assert.match(markup, /Firecrawl/)
})

test('connector tabs use the brand identity even when the configured server has a scoped ID', () => {
  for (const [connectorId, asset] of [
    ['cbioportal', 'cbioportal.png'],
    ['firecrawl', 'firecrawl.png'],
    ['open-targets', 'open-targets.svg']
  ]) {
    const tab: WorkspaceResourceTab = {
      key: 'mcp',
      kind: 'mcp',
      itemId: `/Users/test/.phi/mcp.json:${connectorId}`,
      connectorId,
      title: connectorId
    }
    const markup = renderToStaticMarkup(
      createElement(
        ThemeProvider,
        { theme: createTheme() },
        createElement(WorkspaceResourceTabs, {
          tabs: [tab],
          activeKey: tab.key,
          onSelect: () => undefined,
          onClose: () => undefined,
          connectorIcon: (id) => createElement(ConnectorIcon, { connectorId: id, size: 20 })
        })
      )
    )
    assert.ok(markup.includes(asset), `${connectorId} tab should display ${asset}`)
  }
})

test('a modified notebook tab keeps a visible unsaved marker', () => {
  const tab = {
    key: 'file:/project/notes.ipynb',
    kind: 'notebook' as const,
    id: '/project/notes.ipynb',
    itemId: '/project/notes.ipynb',
    name: 'notes.ipynb',
    title: 'notes.ipynb',
    status: '/project/notes.ipynb',
    path: '/project/notes.ipynb',
    pathKind: 'file' as const,
    absolutePath: '/project/notes.ipynb',
    dirty: true
  }
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(WorkspaceResourceTabs, {
        tabs: [tab],
        activeKey: tab.key,
        onSelect: () => undefined,
        onClose: () => undefined
      })
    )
  )
  assert.match(markup, /未保存修改/)
})

test('a finished prompt only moves the active tab off session tabs', () => {
  const session = 'session:/tmp/chat.jsonl'
  assert.equal(activeTabKeyAfterPrompt(null, session), session)
  assert.equal(activeTabKeyAfterPrompt('session:fresh:3', session), session)
  assert.equal(activeTabKeyAfterPrompt('session:/tmp/old.jsonl', session), session)
  // The user is watching an Office draft or another file/resource while the chat sits in the sidebar.
  assert.equal(activeTabKeyAfterPrompt('file:/tmp/book.xlsx', session), 'file:/tmp/book.xlsx')
  assert.equal(activeTabKeyAfterPrompt('skills', session), 'skills')
})
