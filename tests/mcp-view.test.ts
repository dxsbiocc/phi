import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import test from 'node:test'
import { McpSidebar } from '../src/renderer/src/features/mcp/McpView'
import type { McpServerSummary } from '../src/renderer/src/features/mcp/lib/mcpTypes'

test('connector sidebar groups installed services and labels disabled entries', () => {
  const servers: McpServerSummary[] = [
    {
      id: 'pubmed',
      name: 'pubmed',
      connectorId: 'pubmed',
      category: '健康与生命科学',
      url: 'https://pubmed.mcp.claude.com/mcp',
      status: 'configured'
    },
    {
      id: 'drive',
      name: 'google-drive',
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
  assert.match(markup, /3 个已安装/)
  assert.match(markup, /disabled-local-service/)
  assert.match(markup, /已停用/)
  assert.match(markup, /google-drive\.svg/)
  assert.match(markup, /pubmed\.svg/)
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
