import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

import * as promptTarget from '../src/preload/promptTarget'

type LocalRequest = {
  name: string
  runtime: { kind: 'environment'; ref: string } | { kind: 'host' }
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string
  hint?: { readmeUrl?: string; setupCommands?: string[] }
}

const LOCAL_CHANNELS = [
  'mcp:addLocalConnector',
  'mcp:startLocalConnectorAdd',
  'mcp:cancelLocalConnectorAdd',
  'mcp:retryLocalConnectorAdd',
  'mcp:listLocalConnectorJobs',
  'mcp:removeLocalConnector',
  'mcp:listLocalRuntimes'
]

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>

function extractedMainIpc(dependencies: Record<string, unknown>): Map<string, IpcHandler> {
  const source = ts.createSourceFile(
    'main.ts',
    readFileSync(resolve('src/main/index.ts'), 'utf8'),
    ts.ScriptTarget.ES2022,
    true
  )
  const registrations = new Map<string, ts.ExpressionStatement>()
  const visit = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression
      const channel = call.arguments[0]
      if (
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.expression.getText(source) === 'ipcMain' &&
        call.expression.name.text === 'handle' &&
        channel &&
        ts.isStringLiteral(channel) &&
        LOCAL_CHANNELS.includes(channel.text)
      ) {
        registrations.set(channel.text, node)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.deepEqual(
    [...registrations.keys()].sort(),
    LOCAL_CHANNELS.toSorted(),
    'extract every local-connector IPC registration'
  )
  const program = `const { addLocalMcpConnector, localConnectorJobs, removeLocalMcpConnector, listLocalMcpRuntimes, validateLocalConnectorRequest, validateName, connectorCatalog, getOmpBridge, AGENT_DIR, getRuntimeRoot } = dependencies;
  const callbacks = new Map();
  const ipcMain = { handle: (channel, callback) => callbacks.set(channel, callback) };
  ${LOCAL_CHANNELS.map((channel) => registrations.get(channel)!.getText(source)).join('\n')}
  return callbacks;`
  const compiled = ts.transpileModule(program, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  return new Function('dependencies', compiled)(dependencies) as Map<string, IpcHandler>
}

test('local connector IPC validates requests and refreshes running sessions after mutations', async () => {
  const input: LocalRequest = {
    name: 'raw-name',
    runtime: { kind: 'environment', ref: 'phi:python@1' },
    command: 'fixture-server',
    args: ['--stdio'],
    env: { FIXTURE_MODE: 'test' },
    hint: {
      readmeUrl: 'https://github.com/example/fixture/blob/main/README.md',
      setupCommands: ['fixture-server init']
    }
  }
  const validated = { ...input, name: 'validated-name' }
  const calls: Array<{ operation: string; value?: unknown }> = []
  const callbacks = extractedMainIpc({
    AGENT_DIR: '/verified/agent',
    getRuntimeRoot: () => '/verified/runtime',
    connectorCatalog: async () => [{ id: 'official-connector' }],
    validateName: (name: unknown) => {
      assert.equal(name, ' validated-name ')
      return 'validated-name'
    },
    validateLocalConnectorRequest: (raw: unknown, options: unknown) => {
      calls.push({ operation: 'validate', value: { raw, options } })
      return validated
    },
    addLocalMcpConnector: async (
      request: LocalRequest,
      options: {
        agentDir: string
        catalogIds: string[]
        probe: (request: unknown) => Promise<unknown>
      }
    ) => {
      calls.push({
        operation: 'add',
        value: { request, agentDir: options.agentDir, catalogIds: options.catalogIds }
      })
      // The probe must run in the omp worker (Bun); the main process cannot load the MCP client.
      await options.probe({ name: 'probe-target' })
      return { tools: ['fixture_tool'] }
    },
    localConnectorJobs: {
      startLocalConnectorAdd: (request: LocalRequest) => {
        calls.push({ operation: 'start', value: request })
        return { started: true, name: request.name }
      },
      cancelLocalConnectorAdd: async (name: string) => {
        calls.push({ operation: 'cancel', value: name })
      },
      retryLocalConnectorAdd: (name: string) => {
        calls.push({ operation: 'retry', value: name })
        return { started: true, name }
      },
      listLocalConnectorJobs: () => {
        calls.push({ operation: 'list-jobs' })
        return [{ id: 'validated-name', phase: 'starting' }]
      }
    },
    removeLocalMcpConnector: async (name: unknown) => {
      calls.push({ operation: 'remove', value: name })
    },
    listLocalMcpRuntimes: async () => {
      calls.push({ operation: 'list' })
      return [{ ref: 'phi:python@1', label: 'Python 1' }]
    },
    getOmpBridge: () => ({
      request: async (method: string, params: unknown) => {
        calls.push({ operation: method, value: params })
      }
    })
  })
  const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
    const callback = callbacks.get(channel)
    assert.ok(callback, `missing ${channel} callback`)
    return callback(null, ...args)
  }

  assert.deepEqual(await invoke('mcp:addLocalConnector', input), { tools: ['fixture_tool'] })
  assert.deepEqual(await invoke('mcp:startLocalConnectorAdd', input), {
    started: true,
    name: 'validated-name'
  })
  assert.equal(await invoke('mcp:cancelLocalConnectorAdd', ' validated-name '), undefined)
  assert.deepEqual(await invoke('mcp:retryLocalConnectorAdd', ' validated-name '), {
    started: true,
    name: 'validated-name'
  })
  assert.deepEqual(await invoke('mcp:listLocalConnectorJobs'), [
    { id: 'validated-name', phase: 'starting' }
  ])
  assert.equal(await invoke('mcp:removeLocalConnector', ' validated-name '), undefined)
  assert.deepEqual(await invoke('mcp:listLocalRuntimes'), [
    { ref: 'phi:python@1', label: 'Python 1' }
  ])
  assert.deepEqual(calls, [
    {
      operation: 'validate',
      value: { raw: input, options: { catalogIds: ['official-connector'] } }
    },
    {
      operation: 'add',
      value: {
        request: validated,
        agentDir: '/verified/agent',
        catalogIds: ['official-connector']
      }
    },
    { operation: 'mcp.configuredStdioTools', value: { name: 'probe-target' } },
    { operation: 'mcp.applyConnectorEnabled', value: { name: 'validated-name' } },
    {
      operation: 'validate',
      value: { raw: input, options: { catalogIds: ['official-connector'] } }
    },
    { operation: 'start', value: validated },
    { operation: 'cancel', value: 'validated-name' },
    { operation: 'retry', value: 'validated-name' },
    { operation: 'list-jobs' },
    { operation: 'remove', value: 'validated-name' },
    { operation: 'mcp.applyConnectorEnabled', value: { name: 'validated-name' } },
    { operation: 'list' }
  ])
})

test('preload exposes typed local connector methods without changing argv shape', async () => {
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const exposed = new Map<string, unknown>()
  class IpcRenderer extends EventEmitter {
    invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      calls.push({ channel, args })
      return Promise.resolve(undefined)
    }
  }
  const compiled = ts.transpileModule(readFileSync(resolve('src/preload/index.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const ipcRenderer = new IpcRenderer()
  new Function('require', 'exports', 'process', 'window', 'console', compiled)(
    (specifier: string) => {
      if (specifier === './promptTarget') return promptTarget
      assert.equal(specifier, 'electron')
      return {
        contextBridge: {
          exposeInMainWorld: (key: string, value: unknown) => exposed.set(key, value)
        },
        ipcRenderer,
        webUtils: { getPathForFile: () => '' }
      }
    },
    {},
    { contextIsolated: true, platform: 'darwin', env: {} },
    { addEventListener: () => undefined },
    console
  )
  const api = exposed.get('api') as {
    addLocalMcpConnector: (request: LocalRequest) => Promise<{ tools: string[] }>
    startLocalConnectorAdd: (request: LocalRequest) => Promise<{ started: true; name: string }>
    cancelLocalConnectorAdd: (name: string) => Promise<void>
    retryLocalConnectorAdd: (name: string) => Promise<{ started: true; name: string }>
    listLocalConnectorJobs: () => Promise<unknown[]>
    removeLocalMcpConnector: (name: string) => Promise<void>
    listLocalMcpRuntimes: () => Promise<Array<{ ref: string; label: string }>>
  }

  const request: LocalRequest = {
    name: 'fixture',
    runtime: { kind: 'host' },
    command: '/usr/local/bin/fixture-server',
    args: ['--mode', 'stdio'],
    env: { FIXTURE_MODE: 'test' },
    cwd: '/tmp/fixture'
  }
  await api.addLocalMcpConnector(request)
  await api.startLocalConnectorAdd(request)
  await api.cancelLocalConnectorAdd('fixture')
  await api.retryLocalConnectorAdd('fixture')
  await api.listLocalConnectorJobs()
  await api.removeLocalMcpConnector('fixture')
  await api.listLocalMcpRuntimes()
  assert.deepEqual(calls, [
    { channel: 'mcp:addLocalConnector', args: [request] },
    { channel: 'mcp:startLocalConnectorAdd', args: [request] },
    { channel: 'mcp:cancelLocalConnectorAdd', args: ['fixture'] },
    { channel: 'mcp:retryLocalConnectorAdd', args: ['fixture'] },
    { channel: 'mcp:listLocalConnectorJobs', args: [] },
    { channel: 'mcp:removeLocalConnector', args: ['fixture'] },
    { channel: 'mcp:listLocalRuntimes', args: [] }
  ])
})
