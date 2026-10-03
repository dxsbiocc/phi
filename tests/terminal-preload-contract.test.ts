import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

import type {
  TerminalEvent,
  TerminalRendererBridge,
  TerminalWorkspaceRef
} from '../src/shared/terminalTypes'

const source = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')

test('shared, preload, ambient, and renderer types expose one terminal bridge contract', () => {
  const shared = source('src/shared/terminalTypes.ts')
  const preload = source('src/preload/index.ts')
  const ambient = source('src/preload/index.d.ts')
  const renderer = source('src/renderer/src/types.ts')

  assert.match(shared, /export interface TerminalRendererBridge/)
  assert.match(shared, /list\(ref: TerminalWorkspaceRef\)/)
  assert.match(shared, /onEvent\(cb: \(event: TerminalEvent\) => void\): \(\) => void/)
  assert.match(preload, /terminal: TerminalRendererBridge/)
  assert.match(preload, /terminal: terminalBridge/)
  assert.match(ambient, /terminal: TerminalRendererBridge/)
  assert.match(renderer, /terminal: TerminalRendererBridge/)
})

test('preload terminal bridge invokes exact channels and independently unsubscribes listeners', async () => {
  const compiled = ts.transpileModule(source('src/preload/index.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const calls: Array<{ channel: string; args: unknown[] }> = []
  class FakeIpcRenderer extends EventEmitter {
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      calls.push({ channel, args })
      return undefined
    }
  }
  const ipcRenderer = new FakeIpcRenderer()
  const exposed = new Map<string, unknown>()
  const load = (specifier: string): unknown => {
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
    { contextIsolated: true, platform: process.platform },
    { addEventListener: (): void => undefined },
    console
  )
  const api = exposed.get('api') as { terminal: TerminalRendererBridge }
  assert.ok(api.terminal)

  const workspace: TerminalWorkspaceRef = { kind: 'ordinary' }
  const create = { workspace, cols: 80, rows: 24, requestId: 'request_1' }
  await api.terminal.list(workspace)
  await api.terminal.create(create)
  await api.terminal.attach('terminal_123')
  await api.terminal.input('terminal_123', 'echo safe\n')
  await api.terminal.resize('terminal_123', 100, 30)
  await api.terminal.ack('terminal_123', 2, 12)
  await api.terminal.close('terminal_123')
  assert.deepEqual(calls, [
    { channel: 'terminal:list', args: [workspace] },
    { channel: 'terminal:create', args: [create] },
    { channel: 'terminal:attach', args: ['terminal_123'] },
    { channel: 'terminal:input', args: ['terminal_123', 'echo safe\n'] },
    { channel: 'terminal:resize', args: ['terminal_123', 100, 30] },
    { channel: 'terminal:ack', args: ['terminal_123', 2, 12] },
    { channel: 'terminal:close', args: ['terminal_123'] }
  ])

  const terminalEvent: TerminalEvent = {
    type: 'data',
    terminalId: 'terminal_123',
    epoch: 2,
    seq: 7,
    data: 'safe'
  }
  const received: TerminalEvent[] = []
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  const unsubscribeThrowing = api.terminal.onEvent(() => {
    throw new Error('subscriber failure')
  })
  const unsubscribeRejecting = api.terminal.onEvent(async () => {
    throw new Error('async subscriber failure')
  })
  const unsubscribeReceiving = api.terminal.onEvent((event) => received.push(event))
  try {
    assert.doesNotThrow(() => ipcRenderer.emit('terminal:event', {}, terminalEvent))
    await new Promise((resolveMicrotask) => setImmediate(resolveMicrotask))
    assert.deepEqual(received, [terminalEvent])
    assert.deepEqual(unhandled, [])
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
  }

  unsubscribeThrowing()
  unsubscribeThrowing()
  unsubscribeRejecting()
  assert.equal(ipcRenderer.listenerCount('terminal:event'), 1)
  unsubscribeReceiving()
  unsubscribeReceiving()
  assert.equal(ipcRenderer.listenerCount('terminal:event'), 0)
})
