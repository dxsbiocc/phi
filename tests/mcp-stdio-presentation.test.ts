import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material/styles'
import test from 'node:test'
import type {
  FeaturedMcpConnector,
  McpConnectorSetupPhase
} from '../src/shared/mcpConnectorCatalog'
import { McpFeaturedConnectorCard } from '../src/renderer/src/features/mcp/components/McpFeaturedConnectorCard'
import { McpFeaturedConnectorDetails } from '../src/renderer/src/features/mcp/components/McpFeaturedConnectorDetails'
import { connectorSetupLabel } from '../src/renderer/src/features/mcp/lib/connectorSetupPresentation'

function connector(overrides: Partial<FeaturedMcpConnector> = {}): FeaturedMcpConnector {
  return {
    id: 'biomcp',
    version: '1.0.1',
    name: 'BioMCP',
    description: 'Local biomedical service',
    publisher: 'GenomOncology',
    category: '健康与生命科学',
    transport: 'stdio',
    signIn: '本地服务',
    added: false,
    command: 'python',
    args: ['${package}/server.py'],
    ...overrides
  }
}

const noop = (): void => {}
function renderCard(value: FeaturedMcpConnector): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(McpFeaturedConnectorCard, {
        connector: value,
        installed: value.added,
        busy: false,
        authStatus: 'unauthenticated',
        onOpen: noop,
        onAdd: noop,
        onAuthorize: noop,
        onRetry: noop
      })
    )
  )
}
function renderDetails(value: FeaturedMcpConnector): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(McpFeaturedConnectorDetails, {
        connector: value,
        busy: false,
        authStatus: 'unauthenticated',
        toolNames: value.setup?.toolNames ?? null,
        toolsLoading: false,
        toolsError: null,
        onAdd: noop,
        onRemove: noop,
        onAuthorize: noop,
        onApiKey: noop,
        onRetry: noop,
        onBuildEnvironment: noop
      })
    )
  )
}

test('local details describe installation prerequisites without a remote-connector warning', () => {
  const markup = renderDetails(connector())
  assert.match(markup, /添加连接器并准备本地服务后，可读取服务端工具/)
  assert.match(markup, /首次启动可能需要下载/)
  assert.match(markup, /启动命令/)
  assert.doesNotMatch(markup, /MCP 地址|找不到远程连接器|无法读取当前工具列表/)
})

test('a configured local connector waits for environment readiness without claiming validation', () => {
  const value = connector({ added: true, environmentState: 'not-built' })
  assert.match(renderDetails(value), /准备运行环境后，可启动本地服务并读取工具/)
  assert.doesNotMatch(renderCard(value), /data-phi-connector-state="added"/)
})

for (const phase of ['downloading', 'installing', 'environment', 'starting'] as const) {
  test(`local ${phase} shows its tracked stage instead of the added check`, () => {
    const value = connector({
      added: true,
      environmentState: 'ready',
      setup: {
        id: 'biomcp',
        phase,
        revision: 1,
        updatedAt: '2026-10-08T00:00:00Z'
      }
    })
    assert.match(renderDetails(value), new RegExp(connectorSetupLabel(phase)))
    const card = renderCard(value)
    assert.match(card, /role="status"/)
    assert.doesNotMatch(card, /data-phi-connector-state="added"/)
  })
}

test('failed local setup keeps failure feedback and a retry action', () => {
  const value = connector({
    added: true,
    environmentState: 'ready',
    setup: {
      id: 'biomcp',
      phase: 'failed',
      failedPhase: 'starting',
      error: 'Network unavailable',
      revision: 2,
      updatedAt: '2026-10-08T00:00:00Z'
    }
  })
  assert.match(renderDetails(value), /重试连接|Network unavailable/)
  assert.match(renderCard(value), /aria-label="重试连接 BioMCP"/)
  assert.doesNotMatch(renderCard(value), /data-phi-connector-state="added"/)
})

test('only a successful local probe presents validation and real tool names', () => {
  const value = connector({
    added: true,
    environmentState: 'ready',
    setup: {
      id: 'biomcp',
      phase: 'ready',
      revision: 3,
      updatedAt: '2026-10-08T00:00:00Z',
      toolNames: ['search_article', 'get_gene']
    }
  })
  assert.match(renderCard(value), /data-phi-connector-state="added"/)
  assert.match(renderDetails(value), /连接已验证/)
  assert.match(renderDetails(value), /search_article|服务端工具 · 2/)
})

test('every setup phase has presentation copy', () => {
  const phases: McpConnectorSetupPhase[] = [
    'downloading',
    'installing',
    'environment',
    'starting',
    'ready',
    'installed',
    'removed',
    'failed'
  ]
  for (const phase of phases) assert.ok(connectorSetupLabel(phase))
})

test('removed local connectors do not retain successful validation feedback', () => {
  const value = connector({
    setup: {
      id: 'biomcp',
      phase: 'removed',
      revision: 4,
      updatedAt: '2026-10-08T00:00:00Z'
    }
  })
  assert.doesNotMatch(renderDetails(value), /连接已验证|设置失败/)
  assert.doesNotMatch(renderCard(value), /data-phi-connector-state="added"/)
})

test('Bun user stdio presentation hides the env wrapper and absolute runtime path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-bun-stdio-presentation-'))
  const agentDir = join(root, 'agent')
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  mkdirSync(agentDir)
  writeFileSync(
    join(agentDir, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        mail: {
          type: 'stdio',
          command: '/usr/bin/env',
          args: [
            '-i',
            'PATH=/Applications/Phi.app/Contents/Resources/runtime/bun/darwin-arm64:/usr/bin:/bin',
            'HTTPS_PROXY=https://secret-proxy.example',
            'BUN_INSTALL_CACHE_DIR=/Users/tester/.phi/runtime/cache/bun-user',
            '/Applications/Phi.app/Contents/Resources/runtime/bun/darwin-arm64/bun',
            'x',
            '--bun',
            'qq-email-mcp@0.1.1'
          ],
          env: {},
          phiOrigin: 'user-stdio',
          phiUser: {
            runtime: { kind: 'bun' },
            env: { HTTPS_PROXY: 'https://secret-proxy.example', MODE: 'secret-mode' }
          }
        }
      }
    })
  )
  try {
    const { listGlobalMcpServers } = await import('../src/main/agent/resources')
    const server = (await listGlobalMcpServers()).find((entry) => entry.name === 'mail')
    assert.equal(server?.command, 'bun')
    assert.deepEqual(server?.args, ['x', '--bun', 'qq-email-mcp@0.1.1'])
    assert.deepEqual(server?.envKeys, ['HTTPS_PROXY', 'MODE'])
    assert.doesNotMatch(
      JSON.stringify(server),
      /\/usr\/bin\/env|Applications\/Phi|secret-proxy|secret-mode/
    )
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
})
