import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

import * as promptTarget from '../src/preload/promptTarget'

test('preload exposes trust and revoke operations for remote project Skills', async () => {
  const compiled = ts.transpileModule(
    readFileSync(resolve(process.cwd(), 'src/preload/index.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
  ).outputText
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
    if (specifier === './promptTarget') return promptTarget
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
    trustRemoteProjectSkill: (input: unknown) => Promise<unknown>
    revokeRemoteProjectSkillTrust: (input: unknown) => Promise<unknown>
  }
  const request = {
    cwd: '/local/anchor',
    relativePath: '.phi/skills/demo/SKILL.md',
    contentHash: 'a'.repeat(64)
  }

  await api.trustRemoteProjectSkill(request)
  await api.revokeRemoteProjectSkillTrust(request)

  assert.deepEqual(calls, [
    { channel: 'skills:trustRemoteProject', args: [request] },
    { channel: 'skills:revokeRemoteProjectTrust', args: [request] }
  ])
})
