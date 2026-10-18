import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import test from 'node:test'
import { WorkspaceResourceTabs } from '../src/renderer/src/components/WorkspaceResourceTabs'
import { ConnectorIcon } from '../src/renderer/src/features/mcp/components/ConnectorIcon'
import { cacheResourceIconFixture } from './helpers/resourceIconFixture'
import {
  activeTabKeyAfterPrompt,
  resolveWorkspaceResourceTabIcons,
  upsertWorkspaceResourceTab,
  workspaceResourceTabKey,
  type WorkspaceResourceTab,
  type WorkspaceSessionTab
} from '../src/renderer/src/lib/workspaceResourceTabs'

// Keep the existing Chinese behavior assertions explicit; English switching has dedicated coverage.
setUiLanguage('zh-CN')

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

test('connector tabs display the selected resource-owned icon', async () => {
  const key = 'owned-firecrawl-tab-icon'
  await cacheResourceIconFixture(key)
  const tab: WorkspaceResourceTab = {
    key: 'mcp',
    kind: 'mcp',
    itemId: 'firecrawl',
    title: 'Firecrawl',
    icon: { key },
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
        connectorIcon: (icon) => createElement(ConnectorIcon, { icon, size: 20 })
      })
    )
  )
  assert.match(markup, /data-phi-resource-icon-key="owned-firecrawl-tab-icon"/)
  assert.match(markup, /<img[^>]*src="data:image\/png;base64,iVBORw0KGgo="/)
  assert.match(markup, /Firecrawl/)
})

test('connector tab icons follow metadata even when the configured server has a scoped ID', async () => {
  for (const connectorId of ['cbioportal', 'firecrawl', 'third-party-resource']) {
    const key = `owned-tab-icon-${connectorId}`
    await cacheResourceIconFixture(key)
    const tab: WorkspaceResourceTab = {
      key: 'mcp',
      kind: 'mcp',
      itemId: `/Users/test/.phi/mcp.json:${connectorId}`,
      connectorId,
      icon: { key },
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
          connectorIcon: (icon) => createElement(ConnectorIcon, { icon, size: 20 })
        })
      )
    )
    assert.ok(markup.includes(`data-phi-resource-icon-key="${key}"`))
    assert.match(markup, /<img[^>]*src="data:image\/png;base64,iVBORw0KGgo="/)
  }
})

test('plugin, skill and wrapper tabs render their resource-owned images', async () => {
  for (const kind of ['plugins', 'skills', 'wrappers'] as const) {
    const key = `owned-${kind}-tab-icon`
    await cacheResourceIconFixture(key)
    const tab: WorkspaceResourceTab = {
      key: kind,
      kind,
      itemId: 'selected',
      title: kind,
      icon: { key }
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
    assert.ok(markup.includes(`data-phi-resource-icon-key="${key}"`), kind)
    assert.match(markup, /<img[^>]*src="data:image\/png;base64,iVBORw0KGgo="/)
  }
})

test('already-open resource tabs receive fresh icons from current metadata', () => {
  const kinds = ['plugins', 'skills', 'mcp', 'wrappers'] as const
  const tabs: WorkspaceResourceTab[] = kinds.map((kind, index) => ({
    key: kind,
    kind,
    itemId: `${kind}-selected`,
    title: kind,
    ...(index % 2 ? { icon: { key: 'old-process-icon' } } : {})
  }))
  const resources = Object.fromEntries(
    kinds.map((kind) => [kind, [{ id: `${kind}-selected`, icon: { key: `current-${kind}` } }]])
  ) as Record<(typeof kinds)[number], Array<{ id: string; icon: { key: string } }>>
  const refreshed = resolveWorkspaceResourceTabIcons(tabs, resources) as WorkspaceResourceTab[]
  assert.deepEqual(
    refreshed.map((tab) => tab.icon?.key),
    kinds.map((kind) => `current-${kind}`)
  )
  assert.deepEqual(
    refreshed.map((tab) => tab.itemId),
    tabs.map((tab) => tab.itemId)
  )
  assert.equal(tabs[1].icon?.key, 'old-process-icon', 'tab state is not mutated')
  resources.mcp[0].icon = { key: 'new-process-mcp' }
  const reloaded = resolveWorkspaceResourceTabIcons(refreshed, resources) as WorkspaceResourceTab[]
  assert.equal(reloaded[2].icon?.key, 'new-process-mcp')
  assert.equal(reloaded[0], refreshed[0], 'unchanged metadata keeps the existing tab')
  const removed = resolveWorkspaceResourceTabIcons(reloaded, {
    plugins: [],
    skills: [],
    mcp: [],
    wrappers: []
  }) as WorkspaceResourceTab[]
  assert.ok(
    removed.every((tab) => tab.icon === undefined),
    'removed resources cannot retain stale keys'
  )
})

test('modified text and notebook tabs show an unsaved marker until saved', () => {
  for (const kind of ['file', 'notebook'] as const) {
    const path = kind === 'file' ? '/project/README.md' : '/project/notes.ipynb'
    for (const dirty of [true, false]) {
      const tab = {
        key: `file:${path}`,
        kind,
        id: path,
        itemId: path,
        name: path.split('/').at(-1)!,
        title: path.split('/').at(-1)!,
        status: path,
        path,
        pathKind: 'file' as const,
        absolutePath: path,
        dirty
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
      assert.equal(markup.includes('aria-label="未保存的修改"'), dirty, `${kind}: ${dirty}`)
      assert.equal(markup.includes('data-phi-tab-unsaved="true"'), dirty)
      assert.match(markup, /aria-label="关闭 /, 'the marker preserves the close action')
    }
  }
})

test('active and inactive conversation tabs expose the same in-place dock action', () => {
  const tab: WorkspaceSessionTab = {
    key: 'session:/tmp/chat.jsonl',
    kind: 'session',
    itemId: '/tmp/chat.jsonl',
    title: 'Conversation',
    sessionPath: '/tmp/chat.jsonl',
    sessionGeneration: 1,
    sidebarMode: 'conversations'
  }
  for (const activeKey of [tab.key, 'file:/tmp/notes.ipynb']) {
    const markup = renderToStaticMarkup(
      createElement(
        ThemeProvider,
        { theme: createTheme() },
        createElement(WorkspaceResourceTabs, {
          tabs: [tab],
          activeKey,
          onSelect: () => undefined,
          onClose: () => undefined,
          onDockSessionTab: () => undefined
        })
      )
    )

    assert.match(markup, /workspace-session-tab-icon/)
    assert.match(markup, /data-phi-session-tab-dock-action="true"/)
    assert.match(markup, /aria-label="移到左侧边栏"/)
    assert.match(markup, /workspace-session-tab-dock-action/)
  }
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
