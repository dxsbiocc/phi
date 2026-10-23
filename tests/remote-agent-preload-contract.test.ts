import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

import { IPC } from '../src/shared/ipcChannels'
import { createPlanRunApi } from '../src/preload/plan-run-api'

const source = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')

test('preload exposes list, trust and revoke as the only remote agent IPC operations', async () => {
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
    if (specifier === './plan-run-api') return { createPlanRunApi }
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
  const api = exposed.get('api') as {
    listPromptAgents: (cwd: string) => Promise<unknown>
    trustRemoteProjectAgent: (input: unknown) => Promise<unknown>
    revokeRemoteProjectAgentTrust: (input: unknown) => Promise<unknown>
  }
  const request = {
    cwd: '/local/anchor',
    relativePath: '.phi/agents/Reviewer.md',
    contentHash: 'a'.repeat(64)
  }

  await api.listPromptAgents(request.cwd)
  await api.trustRemoteProjectAgent(request)
  await api.revokeRemoteProjectAgentTrust(request)

  assert.deepEqual(calls, [
    { channel: 'agents:list', args: [request.cwd] },
    { channel: 'agents:trustRemoteProject', args: [request] },
    { channel: 'agents:revokeRemoteProjectTrust', args: [request] }
  ])
})
