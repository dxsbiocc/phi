import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

import { IPC } from '../src/shared/ipcChannels'

const source = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')

function loadPreload(): {
  api: {
    trustRemoteProjectMcp(input: unknown): Promise<unknown>
    revokeRemoteProjectMcpTrust(input: unknown): Promise<unknown>
  }
  calls: Array<{ channel: string; args: unknown[] }>
} {
  const compiled = ts.transpileModule(source('src/preload/index.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const calls: Array<{ channel: string; args: unknown[] }> = []
  class FakeIpcRenderer extends EventEmitter {
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      calls.push({ channel, args })
      return []
    }
  }
  const exposed = new Map<string, unknown>()
  const ipcRenderer = new FakeIpcRenderer()
  const load = (specifier: string): unknown => {
    if (specifier === '../shared/ipcChannels') return { IPC }
    assert.equal(specifier, 'electron')
    return {
      contextBridge: {
        exposeInMainWorld: (name: string, value: unknown): void => {
          exposed.set(name, value)
        }
      },
      ipcRenderer,
      webUtils: { getPathForFile: (): string => '' }
    }
  }
  new Function('require', 'exports', 'process', 'window', 'console', compiled)(
    load,
    {},
    { contextIsolated: true, platform: 'darwin' },
    { addEventListener: (): void => undefined },
    console
  )
  return {
    api: exposed.get('api') as {
      trustRemoteProjectMcp(input: unknown): Promise<unknown>
      revokeRemoteProjectMcpTrust(input: unknown): Promise<unknown>
    },
    calls
  }
}

test('preload exposes only content-bound trust mutations for remote project MCP', async () => {
  const { api, calls } = loadPreload()
  const request = {
    cwd: '/local/anchor',
    relativePath: '.phi/mcp.json',
    contentHash: 'a'.repeat(64),
    confirmedItemIds: ['analysis:command']
  }
  await api.trustRemoteProjectMcp(request)
  await api.revokeRemoteProjectMcpTrust(request)
  assert.deepEqual(calls, [
    { channel: 'mcp:trustRemoteProject', args: [request] },
    { channel: 'mcp:revokeRemoteProjectTrust', args: [request] }
  ])
})
