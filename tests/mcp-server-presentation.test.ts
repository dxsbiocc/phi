import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const syntax = ts.createSourceFile(
  'src/main/index.ts',
  readFileSync('src/main/index.ts', 'utf8'),
  ts.ScriptTarget.Latest,
  true
)

function serverListHandler(): string {
  let handler: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(syntax) === 'ipcMain.handle' &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === 'mcp:listServers'
    ) {
      handler = node.arguments[1]
    }
    ts.forEachChild(node, visit)
  }
  visit(syntax)
  assert.ok(handler, 'MCP server list IPC handler exists')
  return ts.transpileModule(`(${handler.getText(syntax)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
}

test('configured legacy connectors inherit their verified catalog icons without package installation', async () => {
  const configured = [
    { id: '/user/.phi/mcp.json:composio', name: 'composio', url: 'https://connect.example/mcp' },
    { id: '/user/.phi/mcp.json:notion', name: 'notion', url: 'https://notion.example/mcp' },
    { id: 'unknown', name: 'custom', url: 'https://custom.example/mcp' }
  ]
  const catalog = [
    {
      id: 'composio',
      name: 'Composio Connect',
      url: configured[0].url,
      icon: { key: 'verified-composio' }
    },
    { id: 'notion', name: 'Notion', url: configured[1].url, icon: { key: 'verified-notion' } }
  ]
  const handler = runInNewContext(serverListHandler(), {
    currentCwd: '/project',
    isRemoteResourceScope: () => false,
    listMcpServers: async () => configured,
    connectorCatalog: async () => catalog
  }) as (_: unknown) => Promise<Array<(typeof configured)[number] & { icon?: { key: string } }>>
  const result = await handler(undefined)
  assert.equal(result[0].icon?.key, 'verified-composio')
  assert.equal(result[1].icon?.key, 'verified-notion')
  assert.equal(result[2], configured[2])
})

test('installed connector icons take precedence over catalog previews', async () => {
  const configured = [
    { id: 'cbioportal', packageId: 'cbioportal', icon: { key: 'installed-icon' } }
  ]
  const handler = runInNewContext(serverListHandler(), {
    currentCwd: '/project',
    isRemoteResourceScope: () => true,
    listGlobalMcpServers: async () => configured,
    connectorCatalog: async () => [{ id: 'cbioportal', icon: { key: 'preview-icon' } }]
  }) as (_: unknown) => Promise<typeof configured>
  assert.equal((await handler(undefined))[0].icon.key, 'installed-icon')
})
