import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import test from 'node:test'
import { McpDetail, McpSidebar } from '../src/renderer/src/features/mcp/McpView'
import { McpLocalConnectorForm } from '../src/renderer/src/features/mcp/components/McpLocalConnectorForm'
import { resolveCustomConnectorTab } from '../src/renderer/src/features/mcp/lib/customConnectorTabs'
import type { McpServerSummary } from '../src/renderer/src/features/mcp/lib/mcpTypes'

test('connector sidebar groups installed services and toggles them with a switch', () => {
  const servers: McpServerSummary[] = [
    {
      id: 'pubmed',
      name: 'pubmed',
      title: 'PubMed',
      connectorId: 'pubmed',
      icon: { key: 'owned-pubmed-icon' },
      category: '健康与生命科学',
      url: 'https://pubmed.mcp.claude.com/mcp',
      status: 'configured'
    },
    {
      id: 'drive',
      name: 'google-drive',
      title: 'Google Drive',
      connectorId: 'google-drive',
      icon: { key: 'owned-google-drive-icon' },
      category: '生产力',
      url: 'https://drivemcp.googleapis.com/mcp/v1',
      status: 'configured'
    },
    {
      id: 'disabled',
      name: 'disabled-local-service',
      command: 'local-server',
      enabled: false,
      status: 'configured'
    }
  ]
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(McpSidebar, {
        servers,
        activeServerId: 'drive',
        onSelectServer: () => undefined
      })
    )
  )

  assert.match(markup, /Productivity · 1/)
  assert.match(markup, /Health &amp; Life Sciences · 1/)
  assert.match(markup, /Other · 1/)
  assert.doesNotMatch(markup, /个Configured/)
  assert.match(markup, /Google Drive · Configured · Enabled/)
  assert.match(markup, /disabled-local-service · Configured · Disabled/)
  assert.match(markup, /disabled-local-service/)
  assert.match(markup, /Enable disabled-local-service/)
  assert.match(markup, /Disable Google Drive/)
  assert.match(markup, /Disable PubMed/)
  assert.match(markup, /data-phi-resource-icon-key="owned-google-drive-icon"/)
  assert.match(markup, /data-phi-resource-icon-key="owned-pubmed-icon"/)
  assert.equal(markup.match(/data-phi-resource-icon="mcp"/g)?.length, 3)
  assert.doesNotMatch(markup, /<img/)
  assert.doesNotMatch(markup, /https:\/\/pubmed\.mcp\.claude\.com\/mcp/)
  assert.doesNotMatch(markup, /https:\/\/drivemcp\.googleapis\.com\/mcp\/v1/)
})

test('closing the connector detail leaves no installed row selected', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(McpSidebar, {
        servers: [
          {
            id: 'biorxiv',
            name: 'biorxiv',
            url: 'https://hcls.mcp.claude.com/biorxiv/mcp',
            status: 'configured'
          },
          {
            id: 'pubmed',
            name: 'pubmed',
            url: 'https://pubmed.mcp.claude.com/mcp',
            status: 'configured'
          }
        ],
        activeServerId: null,
        onSelectServer: () => undefined,
        onRefreshServers: async () => undefined
      })
    )
  )

  assert.equal(markup.match(/class="[^"]*Mui-selected[^"]*"/g)?.length ?? 0, 0)
})

test('installed connector detail centers content and retains its catalog introduction and MCP address', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(McpDetail, {
        initialCatalog: [
          {
            id: 'open-targets',
            version: '1.0.0',
            name: 'Open Targets Platform',
            description: '检索靶点、疾病、药物及其关联数据',
            publisher: 'Open Targets',
            category: '健康与生命科学',
            signIn: '无需登录',
            transport: 'http',
            auth: 'none',
            url: 'https://mcp.platform.opentargets.org/mcp',
            added: true
          }
        ],
        selectedServer: {
          id: 'open-targets',
          name: 'open-targets',
          connectorId: 'open-targets',
          url: 'https://mcp.platform.opentargets.org/mcp',
          sourcePath: '/tmp/mcp.json',
          managed: true,
          status: 'configured'
        },
        onRemoveServer: async () => undefined
      })
    )
  )
  const contentRule = markup.match(/\{[^{}]*max-width:1000px;[^{}]*\}/)?.[0] ?? ''
  assert.match(contentRule, /width:100%;/)
  assert.match(contentRule, /margin-left:auto;/)
  assert.match(contentRule, /margin-right:auto;/)
  assert.match(markup, /min-width:0;min-height:0;overflow:auto;/)
  assert.match(markup, /padding-left:24px;padding-right:24px;/)
  assert.match(markup, /padding-left:40px;padding-right:40px;/)
  assert.match(markup, /检索靶点、疾病、药物及其关联数据/)
  assert.match(markup, /https:\/\/mcp\.platform\.opentargets\.org\/mcp/)
  assert.match(markup, /\/tmp\/mcp\.json/)
  assert.match(markup, /Remove/)
  assert.match(markup, /Server tools/)
})

test('local connector form shows host warning and exact argv preview without inline confirmation', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(McpLocalConnectorForm, {
        busy: false,
        runtimes: [{ ref: 'phi:python@1', label: 'Python 1' }],
        runtimesLoading: false,
        draft: {
          name: 'literature',
          runtime: { kind: 'host' },
          command: '/opt/My Server/bin/mcp',
          argsText: '--title\nvalue with spaces',
          envRows: [],
          cwd: ''
        },
        onDraftChange: () => undefined
      })
    )
  )

  assert.match(markup, /Runs directly on this device without a Phi isolated environment/)
  assert.match(
    markup,
    /&#x27;\/opt\/My Server\/bin\/mcp&#x27; --title &#x27;value with spaces&#x27;/
  )
  assert.doesNotMatch(markup, /确认启动并验证|返回修改/)
})

test('custom connector tabs allow local selection only in a local resource scope', () => {
  assert.equal(resolveCustomConnectorTab('local', true), 'local')
  assert.equal(resolveCustomConnectorTab('remote', true), 'remote')
  assert.equal(resolveCustomConnectorTab('local', false), 'remote')
})

test('local Bun draft explains why its runtime is unselected when built-in Bun is unavailable', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(McpLocalConnectorForm, {
        busy: false,
        runtimes: [{ ref: 'phi:r@1', label: 'R' }],
        runtimesLoading: false,
        draft: {
          name: 'qq-email-mcp',
          runtime: { kind: 'environment', ref: '' },
          command: 'x',
          argsText: '--bun\nqq-email-mcp@0.1.1',
          envRows: [],
          cwd: ''
        },
        runtimeHelperText: "Phi's bundled Bun was not found. Check the application installation.",
        onDraftChange: () => undefined
      })
    )
  )
  assert.match(markup, /Phi&#x27;s bundled Bun was not found. Check the application installation./)
})

test('local connector form presents Bun subcommands, compatibility warning, and preview', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(McpLocalConnectorForm, {
        busy: false,
        runtimes: [{ ref: 'bun', label: 'Phi bundled Bun', kind: 'bun' }],
        runtimesLoading: false,
        draft: {
          name: 'qq-email-mcp',
          runtime: { kind: 'bun' },
          command: 'x',
          argsText: '--bun\nqq-email-mcp@0.1.1',
          envRows: [],
          cwd: ''
        },
        onDraftChange: () => undefined
      })
    )
  )

  assert.match(markup, /Phi bundled Bun/)
  assert.match(markup, /run npm package/)
  assert.match(markup, /run runs a script/)
  assert.match(
    markup,
    /Runs with Phi&#x27;s bundled Bun in Node compatibility mode; some dependencies may be incompatible\./
  )
  assert.match(
    markup,
    /The x command resolves dependencies online at every start without locking versions./
  )
  assert.match(markup, /For example, --bun and package@version, one per line/)
  assert.match(markup, /bun x --bun qq-email-mcp@0.1.1/)
})

test('user stdio detail alone exposes its ownership badge and removal action', () => {
  const owned = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(McpDetail, {
        initialCatalog: [],
        selectedServer: {
          id: 'literature',
          name: 'literature',
          command: 'uvx',
          args: ['mcp-server'],
          userStdio: true,
          status: 'configured'
        },
        onRemoveServer: async () => undefined
      })
    )
  )
  const unowned = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(McpDetail, {
        initialCatalog: [],
        selectedServer: {
          id: 'hand-written',
          name: 'hand-written',
          command: 'server',
          status: 'configured'
        },
        onRemoveServer: async () => undefined
      })
    )
  )

  assert.match(owned, /Custom · Local/)
  assert.match(owned, /Remove/)
  assert.doesNotMatch(unowned, /Custom · Local/)
  assert.doesNotMatch(unowned, />Remove</)
})
