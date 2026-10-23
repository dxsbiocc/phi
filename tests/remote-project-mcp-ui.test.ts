import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { RemoteProjectMcpTrustDialog } from '../src/renderer/src/features/mcp/components/RemoteProjectMcpTrustPanel'
import { McpDetailPanel } from '../src/renderer/src/features/mcp/components/McpDetailPanel'
import {
  isRemoteProjectMcpServer,
  remoteProjectMcpTrustRequest,
  type TrustedRemoteProjectMcpServer
} from '../src/renderer/src/features/mcp/lib/remoteProjectMcpTrust'

const server = {
  id: 'ssh://lab/project/.phi/mcp.json:analysis',
  name: 'analysis',
  command: '/opt/mcp server',
  args: ['--root', 'data set'],
  envKeys: ['API_MODE'],
  sourcePath: 'ssh://lab/project/.phi/mcp.json',
  enabled: false,
  status: 'configured',
  trustState: 'pending' as const,
  available: false,
  diagnostics: ['来自Server project，未Trust'],
  relativePath: '.phi/mcp.json',
  contentHash: 'a'.repeat(64),
  remoteProjectCwd: '/local/anchor',
  confirmationItems: [
    {
      id: 'analysis:command',
      serverName: 'analysis',
      kind: 'stdio-command',
      value: '/opt/mcp server'
    },
    {
      id: 'analysis:arg:0',
      serverName: 'analysis',
      kind: 'stdio-arg',
      value: '--root',
      index: 0
    },
    {
      id: 'analysis:arg:1',
      serverName: 'analysis',
      kind: 'stdio-arg',
      value: 'data set',
      index: 1
    },
    {
      id: 'analysis:env:API_MODE',
      serverName: 'analysis',
      kind: 'stdio-env',
      value: 'API_MODE'
    }
  ]
} satisfies TrustedRemoteProjectMcpServer

test('remote MCP trust dialog discloses every command field and requires every checkbox', () => {
  assert.equal(isRemoteProjectMcpServer(server), true)
  const markup = renderToStaticMarkup(
    createElement(RemoteProjectMcpTrustDialog, {
      open: true,
      server,
      onClose: () => undefined,
      onTrusted: async () => undefined
    })
  )
  assert.match(markup, /arbitrary commands/)
  assert.match(markup, /\/opt\/mcp server/)
  assert.match(markup, /--root/)
  assert.match(markup, /data set/)
  assert.match(markup, /API_MODE/)
  assert.equal((markup.match(/type="checkbox"/g) ?? []).length, 4)
  assert.match(markup, /<button[^>]*disabled=""[^>]*>Confirm and trust<\/button>/)
})

test('remote MCP trust request is bound to cwd, path, hash and exact confirmation ids', () => {
  assert.deepEqual(
    remoteProjectMcpTrustRequest(
      server,
      server.confirmationItems.map((item) => item.id)
    ),
    {
      cwd: '/local/anchor',
      relativePath: '.phi/mcp.json',
      contentHash: 'a'.repeat(64),
      confirmedItemIds: [
        'analysis:command',
        'analysis:arg:0',
        'analysis:arg:1',
        'analysis:env:API_MODE'
      ]
    }
  )
})

test('catalog-matched HTTPS entries still render the server-project trust gate', () => {
  const remoteHttp = {
    ...server,
    id: 'ssh://lab/project/.phi/mcp.json:literature',
    name: 'literature',
    command: undefined,
    args: undefined,
    envKeys: undefined,
    url: 'https://mcp.example.test/api',
    transport: 'http',
    confirmationItems: [
      {
        id: 'literature:url',
        serverName: 'literature',
        kind: 'https-url' as const,
        value: 'https://mcp.example.test/api'
      }
    ]
  }
  const markup = renderToStaticMarkup(
    createElement(McpDetailPanel, {
      selectedServer: remoteHttp,
      initialCatalog: [
        {
          id: 'literature',
          version: '1.0.0',
          name: 'Literature',
          description: 'Literature MCP',
          publisher: 'Lab',
          category: '科研数据',
          signIn: '无需登录',
          transport: 'http',
          auth: 'none',
          url: 'https://mcp.example.test/api',
          registryDir: '/catalog',
          added: false
        }
      ]
    })
  )
  assert.match(markup, /Server project MCP/)
  assert.match(markup, />Trust</)
  assert.match(markup, /disabled/)
})
