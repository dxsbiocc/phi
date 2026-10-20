import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

import { IPC } from '../src/shared/ipcChannels'

const CHANNELS = Object.values(IPC.sources)
const CHANNEL_REFERENCES = new Map(
  Object.entries(IPC.sources).map(([name, channel]) => [`IPC.sources.${name}`, channel])
)

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
      const channelName = channel ? CHANNEL_REFERENCES.get(channel.getText(source)) : undefined
      if (
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.expression.getText(source) === 'ipcMain' &&
        call.expression.name.text === 'handle' &&
        channelName
      ) {
        registrations.set(channelName, node)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.deepEqual([...registrations.keys()].sort(), CHANNELS.toSorted())
  const program = `const { IPC, previewGithubSource, addGithubSource, checkGithubSourceUpdate, applyGithubSourceUpdate, removeGithubSource, listGithubSources, refreshGithubSourceDependants, writeAppLog, officialRegistryFetch, isRecord, AGENT_DIR } = dependencies;
  const callbacks = new Map();
  const ipcMain = { handle: (channel, callback) => callbacks.set(channel, callback) };
  ${CHANNELS.map((channel) => registrations.get(channel)!.getText(source)).join('\n')}
  return callbacks;`
  const compiled = ts.transpileModule(program, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  return new Function('dependencies', compiled)({ IPC, ...dependencies }) as Map<string, IpcHandler>
}

test('GitHub source IPC validates every input, refreshes mutations, and logs only repo plus sha', async () => {
  const source = {
    id: 'a'.repeat(16),
    repo: 'acme/connectors',
    ref: 'main',
    sha: 'b'.repeat(40),
    registryPath: '/verified/registry',
    addedAt: '2026-10-11T00:00:00.000Z',
    updatedAt: '2026-10-11T00:00:00.000Z'
  }
  const calls: Array<{ operation: string; value?: unknown }> = []
  const callbacks = extractedMainIpc({
    AGENT_DIR: '/verified/agent',
    officialRegistryFetch: async () => new Response(),
    isRecord: (value: unknown) =>
      typeof value === 'object' && value !== null && !Array.isArray(value),
    previewGithubSource: async (url: string, options: unknown) => {
      calls.push({ operation: 'preview', value: { url, options } })
      return {
        repo: source.repo,
        ref: 'main',
        sha: source.sha,
        packages: [],
        skipped: [],
        warnings: []
      }
    },
    addGithubSource: async (input: unknown, options: unknown) => {
      calls.push({ operation: 'add', value: { input, options } })
      return source
    },
    checkGithubSourceUpdate: async (id: string, options: unknown) => {
      calls.push({ operation: 'check', value: { id, options } })
      return { changed: false, source }
    },
    applyGithubSourceUpdate: async (id: string, sha: string, options: unknown) => {
      calls.push({ operation: 'apply', value: { id, sha, options } })
      return source
    },
    removeGithubSource: async (id: string, options: unknown) => {
      calls.push({ operation: 'remove', value: { id, options } })
      return true
    },
    listGithubSources: (options: unknown) => {
      calls.push({ operation: 'list', value: options })
      return { version: 1, sources: [source] }
    },
    refreshGithubSourceDependants: async () => calls.push({ operation: 'refresh' }),
    writeAppLog: (value: unknown) => calls.push({ operation: 'log', value })
  })
  const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
    const callback = callbacks.get(channel)
    assert.ok(callback, `missing ${channel}`)
    return callback(null, ...args)
  }

  const url = 'https://github.com/acme/connectors/tree/main'
  await invoke('sources:previewGithub', url)
  await invoke('sources:addGithub', { url, sha: source.sha })
  await invoke('sources:checkGithubUpdate', source.id)
  await invoke('sources:applyGithubUpdate', { id: source.id, sha: source.sha })
  assert.equal(await invoke('sources:removeGithub', source.id), true)
  assert.deepEqual(await invoke('sources:listGithub'), [source])

  for (const [channel, input] of [
    ['sources:previewGithub', { url }],
    ['sources:addGithub', { url, sha: source.sha, token: 'secret' }],
    ['sources:addGithub', { url, sha: 'bad' }],
    ['sources:checkGithubUpdate', '../bad'],
    ['sources:applyGithubUpdate', { id: source.id, sha: 'bad' }],
    ['sources:removeGithub', 1]
  ] as const) {
    await assert.rejects(invoke(channel, input), /GitHub|参数|标识|SHA|地址/)
  }

  const logs = calls.filter((entry) => entry.operation === 'log').map((entry) => entry.value)
  assert.equal(logs.length, 3)
  for (const log of logs as Array<{ metadata: Record<string, unknown> }>) {
    assert.deepEqual(log.metadata, { repo: source.repo, sha: source.sha })
  }
  assert.equal(calls.filter((entry) => entry.operation === 'refresh').length, 3)
  assert.equal(JSON.stringify(calls).includes('secret'), false)
})

test('preload exposes the six typed GitHub source methods with unchanged payloads', async () => {
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
      if (specifier === '../shared/ipcChannels') return { IPC }
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
  const api = exposed.get('api') as Record<string, (...args: unknown[]) => Promise<unknown>>
  const url = 'https://github.com/acme/connectors'
  const sha = 'a'.repeat(40)
  const id = 'b'.repeat(16)
  await api.previewGithubSource!(url)
  await api.addGithubSource!({ url, sha })
  await api.checkGithubSourceUpdate!(id)
  await api.applyGithubSourceUpdate!({ id, sha })
  await api.removeGithubSource!(id)
  await api.listGithubSources!()
  assert.deepEqual(calls, [
    { channel: 'sources:previewGithub', args: [url] },
    { channel: 'sources:addGithub', args: [{ url, sha }] },
    { channel: 'sources:checkGithubUpdate', args: [id] },
    { channel: 'sources:applyGithubUpdate', args: [{ id, sha }] },
    { channel: 'sources:removeGithub', args: [id] },
    { channel: 'sources:listGithub', args: [] }
  ])
})
