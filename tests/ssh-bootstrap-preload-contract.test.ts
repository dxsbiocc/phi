import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

import * as promptTarget from '../src/preload/promptTarget'

const source = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')

test('SSH bootstrap uses one shared preload bridge without extending renderer types', () => {
  const shared = source('src/shared/sshBootstrapTypes.ts')
  const preload = source('src/preload/index.ts')
  const ambient = source('src/preload/index.d.ts')
  const rendererTypes = source('src/renderer/src/types.ts')

  assert.match(shared, /export interface SshBootstrapRendererBridge/)
  assert.match(shared, /inspectTarget\(/)
  assert.match(shared, /confirmHostKey\(/)
  assert.match(shared, /verifyPassword\(/)
  assert.match(shared, /completeWithKeyProtection\(/)
  assert.doesNotMatch(shared, /completeWithCredentials\(/)
  assert.match(shared, /saveConfig\(/)
  assert.match(shared, /declineConfig\(/)
  assert.match(shared, /cancel\(/)
  assert.match(preload, /sshBootstrap: SshBootstrapRendererBridge/)
  assert.match(preload, /sshBootstrap: sshBootstrapBridge/)
  assert.doesNotMatch(preload, /sshBootstrap:completeWithCredentials/)
  assert.match(ambient, /sshBootstrap: SshBootstrapRendererBridge/)
  assert.doesNotMatch(rendererTypes, /sshBootstrap/)
})

test('preload SSH bootstrap bridge invokes only the staged renderer channels', async () => {
  const compiled = ts.transpileModule(source('src/preload/index.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const calls: Array<{ channel: string; args: unknown[] }> = []

  class FakeIpcRenderer extends EventEmitter {
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      calls.push({ channel, args })
      return { status: 'cancelled' }
    }
  }

  const ipcRenderer = new FakeIpcRenderer()
  const exposed = new Map<string, unknown>()
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

  const bridge = (
    exposed.get('api') as {
      sshBootstrap: {
        inspectTarget: (input: unknown) => Promise<unknown>
        confirmHostKey: (attemptId: string) => Promise<unknown>
        verifyPassword: (attemptId: string, input: unknown) => Promise<unknown>
        completeWithKeyProtection: (attemptId: string, input: unknown) => Promise<unknown>
        saveConfig: (operationId: string) => Promise<unknown>
        declineConfig: (operationId: string) => Promise<unknown>
        cancel: (id: string) => Promise<unknown>
      }
    }
  ).sshBootstrap
  const target = {
    alias: 'lab-hpc',
    hostname: 'compute.example.invalid',
    user: 'scientist',
    port: 22022
  }
  await bridge.inspectTarget(target)
  await bridge.confirmHostKey('attempt-1')
  await bridge.verifyPassword('attempt-1', { password: 'renderer-only-secret' })
  await bridge.completeWithKeyProtection('attempt-1', {
    keyProtection: 'passphrase',
    passphrase: 'renderer-only-passphrase'
  })
  await bridge.saveConfig('operation-1')
  await bridge.declineConfig('operation-2')
  await bridge.cancel('attempt-2')

  assert.deepEqual(calls, [
    { channel: 'sshBootstrap:inspectTarget', args: [target] },
    { channel: 'sshBootstrap:confirmHostKey', args: ['attempt-1'] },
    {
      channel: 'sshBootstrap:verifyPassword',
      args: ['attempt-1', { password: 'renderer-only-secret' }]
    },
    {
      channel: 'sshBootstrap:completeWithKeyProtection',
      args: ['attempt-1', { keyProtection: 'passphrase', passphrase: 'renderer-only-passphrase' }]
    },
    { channel: 'sshBootstrap:saveConfig', args: ['operation-1'] },
    { channel: 'sshBootstrap:declineConfig', args: ['operation-2'] },
    { channel: 'sshBootstrap:cancel', args: ['attempt-2'] }
  ])
})
