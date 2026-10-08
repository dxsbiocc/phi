import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import test from 'node:test'
import { McpDetail, McpSidebar } from '../src/renderer/src/features/mcp/McpView'
import type { McpServerSummary } from '../src/renderer/src/features/mcp/lib/mcpTypes'

test('connector sidebar groups installed services and toggles them with a switch', () => {
  const servers: McpServerSummary[] = [
    {
      id: 'pubmed',
      name: 'pubmed',
      title: 'PubMed',
      connectorId: 'pubmed',
      category: '健康与生命科学',
      url: 'https://pubmed.mcp.claude.com/mcp',
      status: 'configured'
    },
    {
      id: 'drive',
      name: 'google-drive',
      title: 'Google Drive',
      connectorId: 'google-drive',
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

  assert.match(markup, /生产力 · 1/)
  assert.match(markup, /健康与生命科学 · 1/)
  assert.match(markup, /其他 · 1/)
  assert.doesNotMatch(markup, /个已配置/)
  assert.match(markup, /Google Drive · 已配置 · 已启用/)
  assert.match(markup, /disabled-local-service · 已配置 · 已停用/)
  assert.match(markup, /disabled-local-service/)
  assert.match(markup, /启用 disabled-local-service/)
  assert.match(markup, /关闭 Google Drive/)
  assert.match(markup, /关闭 PubMed/)
  assert.match(markup, /google-drive\.svg/)
  assert.match(markup, /pubmed\.svg/)
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

test('installed connector detail retains its catalog introduction and MCP address', () => {
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
  assert.match(markup, /检索靶点、疾病、药物及其关联数据/)
  assert.match(markup, /https:\/\/mcp\.platform\.opentargets\.org\/mcp/)
  assert.match(markup, /\/tmp\/mcp\.json/)
  assert.match(markup, /移除/)
  assert.match(markup, /服务端工具/)
})
