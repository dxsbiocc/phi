import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { FeaturedMcpConnector } from '../src/shared/mcpConnectorCatalog'
import { localConnectorToolsPrerequisite } from '../src/renderer/src/features/mcp/lib/connectorSetupPresentation'

const path = 'src/renderer/src/features/mcp/components/McpConnectorCatalogDialog.tsx'
const source = ts.createSourceFile(
  path,
  readFileSync(path, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
)
let callback: ts.FunctionDeclaration | undefined
function visit(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'openDetail') callback = node
  ts.forEachChild(node, visit)
}
visit(source)
assert.ok(callback)
const code = ts.transpileModule(`${callback.getText(source)}; openDetail(connector, refresh);`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText

function open(overrides: Partial<FeaturedMcpConnector> = {}, refresh = false): string[] {
  const requested: string[] = []
  const connector: FeaturedMcpConnector = {
    id: 'biomcp',
    name: 'BioMCP',
    description: 'Local biomedical service',
    version: '1.0.0',
    publisher: 'GenomOncology',
    category: '健康与生命科学',
    signIn: '本地服务',
    transport: 'stdio',
    command: 'python',
    args: ['${package}/server.py'],
    added: false,
    ...overrides
  }
  const noop = (): void => {}
  const setters = [
    'setSelectedId',
    'setApiKeyInput',
    'setPage',
    'setError',
    'setToolNames',
    'setToolsError',
    'setToolsLoading'
  ]
  runInNewContext(code, {
    connector,
    refresh,
    toolRequestRef: { current: 0 },
    authStatusById: {},
    localConnectorToolsPrerequisite,
    setupById: {},
    cacheFeaturedToolNames: noop,
    clearFeaturedToolNames: noop,
    cachedFeaturedToolNames: () => null,
    ipcErrorMessage: String,
    ...Object.fromEntries(setters.map((name) => [name, noop])),
    window: {
      api: {
        listFeaturedMcpTools: async (id: string) => {
          requested.push(id)
          return ['actual_tool']
        }
      }
    }
  })
  return requested
}

test('uninstalled local stdio details do not invoke remote or local tool discovery', () => {
  assert.deepEqual(open(), [])
})

test('local stdio details wait for their managed environment', () => {
  assert.deepEqual(open({ added: true, environmentState: 'not-built' }), [])
})

test('installed local stdio details read actual tools once their environment is ready', () => {
  assert.deepEqual(open({ added: true, environmentState: 'ready' }), ['biomcp'])
})

test('a local connector being installed waits for its tracked operation', () => {
  assert.deepEqual(
    open({
      added: true,
      environmentState: 'ready',
      setup: {
        id: 'biomcp',
        phase: 'starting',
        revision: 1,
        updatedAt: '2026-10-08T00:00:00Z'
      }
    }),
    []
  )
})

test('a failed local connector waits for an explicit retry before probing again', () => {
  const failed: Partial<FeaturedMcpConnector> = {
    added: true,
    environmentState: 'ready',
    setup: {
      id: 'biomcp',
      phase: 'failed',
      revision: 2,
      updatedAt: '2026-10-08T00:00:00Z',
      error: 'Startup failed'
    }
  }
  assert.deepEqual(open(failed), [])
  assert.deepEqual(open(failed, true), ['biomcp'])
})
