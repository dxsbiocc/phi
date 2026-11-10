import assert from 'node:assert/strict'
import test from 'node:test'

import type { FeaturedMcpConnector } from '../src/shared/mcpConnectorCatalog'
import { OFFICIAL_WEBSITE_BASE_URL } from '../src/shared/officialWebsite'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import { connectorSourceLabel } from '../src/renderer/src/features/mcp/lib/connectorSourceLabel'

function connector(overrides: Partial<FeaturedMcpConnector> = {}): FeaturedMcpConnector {
  return {
    id: 'biorender',
    version: '1.0.0',
    name: 'BioRender',
    description: 'Scientific illustration service',
    publisher: 'BioRender',
    category: '设计创作',
    signIn: '需要登录',
    transport: 'http',
    auth: 'oauth',
    url: 'https://mcp.biorender.com/mcp',
    added: false,
    source: { kind: 'official', label: 'Phi 官网', trust: 'imported' },
    ...overrides
  }
}

function labelIn(language: 'en' | 'zh-CN', value: FeaturedMcpConnector): string {
  setUiLanguage(language)
  return connectorSourceLabel(value)
}

test.afterEach(() => setUiLanguage('en'))

test('official connectors hosted by Phi keep the Phi website label', () => {
  const value = connector({
    url: new URL('/api/connectors/biorender/mcp', OFFICIAL_WEBSITE_BASE_URL).href
  })
  assert.equal(labelIn('en', value), 'Phi Website')
  assert.equal(labelIn('zh-CN', value), 'Phi 官网')
})

test('official connectors hosted by a vendor name the connector publisher', () => {
  const value = connector({ publisher: 'BioRender' })
  assert.equal(labelIn('en', value), 'BioRender Website')
  assert.equal(labelIn('zh-CN', value), 'BioRender 官网')
})

test('a missing publisher falls back to the MCP URL host name', () => {
  const value = connector({ publisher: '' })
  assert.equal(labelIn('en', value), 'mcp.biorender.com Website')
  assert.equal(labelIn('zh-CN', value), 'mcp.biorender.com 官网')
})

test('official stdio connectors without a URL keep the current source label', () => {
  const value = connector({
    publisher: 'GenomOncology',
    transport: 'stdio',
    auth: undefined,
    url: undefined,
    command: 'biomcp',
    args: ['serve']
  })
  assert.equal(labelIn('en', value), 'Phi Website')
  assert.equal(labelIn('zh-CN', value), 'Phi 官网')
})

test('non-official source kinds keep their existing source label', () => {
  const cases = [
    {
      source: {
        kind: 'github' as const,
        label: 'GitHub · acme/connectors@abcdef0',
        trust: 'imported' as const
      },
      en: 'GitHub · acme/connectors@abcdef0',
      zh: 'GitHub · acme/connectors@abcdef0'
    },
    {
      source: { kind: 'directory' as const, label: '用户软件源', trust: 'imported' as const },
      en: 'User source',
      zh: '用户软件源'
    },
    {
      source: { kind: 'installed' as const, label: '已安装', trust: 'builtin' as const },
      en: 'Installed',
      zh: '已安装'
    }
  ]

  for (const current of cases) {
    const value = connector({ source: current.source })
    assert.equal(labelIn('en', value), current.en)
    assert.equal(labelIn('zh-CN', value), current.zh)
  }
})
