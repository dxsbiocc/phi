import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import test from 'node:test'
import { McpFeaturedConnectorDetails } from '../src/renderer/src/features/mcp/components/McpFeaturedConnectorDetails'

function render(verified = false, configured = true): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(McpFeaturedConnectorDetails, {
        connector: {
          id: 'firecrawl',
          version: '1.0.0',
          name: 'Firecrawl',
          description: '搜索、抓取和解析网页内容',
          publisher: 'Firecrawl',
          category: '生产力',
          signIn: '需要 API key',
          transport: 'http',
          auth: 'header',
          url: 'https://mcp.firecrawl.dev/v2/mcp',
          apiKey: { header: 'Authorization', obtainUrl: 'https://www.firecrawl.dev/app/api-keys' },
          added: configured
        },
        server: configured
          ? {
              id: 'firecrawl',
              name: 'firecrawl',
              url: 'https://mcp.firecrawl.dev/v2/mcp',
              managed: true,
              enabled: false,
              status: 'configured'
            }
          : undefined,
        authStatus: verified ? 'authenticated' : 'unauthenticated',
        busy: false,
        toolNames: null,
        toolsLoading: false,
        toolsError: null,
        onAdd: () => undefined,
        onRemove: () => undefined,
        onAuthorize: () => undefined,
        onApiKey: () => undefined,
        onEnabledChange: () => undefined,
        onRetry: () => undefined
      })
    )
  )
}

test('a saved connector without a verified key offers verification rather than key replacement', () => {
  const markup = render()
  assert.match(markup, /已配置/)
  assert.match(markup, /API key 未验证/)
  assert.match(markup, /验证 API key/)
  assert.doesNotMatch(markup, /更换密钥/)
  assert.match(markup, /已停用/)
})

test('a previously verified key without a configured connector offers adding the connector', () => {
  const markup = render(true, false)
  assert.match(markup, /添加连接器/)
  assert.match(markup, /可直接添加连接器/)
  assert.doesNotMatch(markup, /更换密钥/)
})

test('a configured disabled connector with valid credentials offers an enable action', () => {
  const markup = render(true, true)
  assert.match(markup, />启用</)
})

test('an unverified API key does not bypass verification through the enable action', () => {
  const markup = render(false, true)
  assert.match(markup, /<button[^>]*disabled=""[^>]*>启用<\/button>/)
})
