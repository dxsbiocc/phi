import assert from 'node:assert/strict'
import test from 'node:test'

import type { TerminalEvent, TerminalSnapshot } from '../src/shared/terminalTypes'
import {
  TerminalIpcCoordinator,
  registerTerminalRendererIpc,
  type TerminalIpcEventLike,
  type TerminalManagerLike,
  type TerminalRendererSenderLike
} from '../src/main/terminal/terminal-ipc'

const snapshot: TerminalSnapshot = {
  terminalId: 'terminal_123',
  workspaceKey: 'ordinary',
  title: 'Terminal 1',
  host: 'local',
  initialCwd: '/tmp',
  shell: '/bin/zsh',
  state: 'open',
  createdAt: '2026-10-03T00:00:00.000Z',
  cols: 80,
  rows: 24
}

class FakeSender implements TerminalRendererSenderLike {
  readonly mainFrame = {}
  readonly sent: Array<{ channel: string; payload: unknown }> = []
  destroyed = false

  isDestroyed(): boolean {
    return this.destroyed
  }

  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload })
  }
}

function fakeManager(overrides: Partial<TerminalManagerLike> = {}): TerminalManagerLike {
  return {
    list: async () => [snapshot],
    create: async () => snapshot,
    attach: async () => ({ epoch: 1, snapshot, records: [], nextSeq: 1 }),
    input: async () => undefined,
    resize: async () => undefined,
    ack: async () => undefined,
    close: async () => undefined,
    ...overrides
  }
}

function event(sender: FakeSender, senderFrame: unknown = sender.mainFrame): TerminalIpcEventLike {
  return { sender, senderFrame }
}

function registeredHarness(
  options: {
    trusted?: FakeSender | null
    manager?: TerminalManagerLike
    platform?: NodeJS.Platform
  } = {}
): {
  trusted: FakeSender | null
  coordinator: TerminalIpcCoordinator
  handlers: Map<string, (event: TerminalIpcEventLike, ...args: unknown[]) => unknown>
} {
  const trusted = options.trusted === undefined ? new FakeSender() : options.trusted
  const manager = options.manager ?? fakeManager()
  const coordinator = new TerminalIpcCoordinator({
    getManager: () => manager,
    getTrustedRenderer: () => trusted,
    platform: options.platform ?? 'darwin'
  })
  const handlers = new Map<string, (event: TerminalIpcEventLike, ...args: unknown[]) => unknown>()
  registerTerminalRendererIpc(
    {
      handle: (channel, handler) => {
        handlers.set(channel, handler)
      }
    },
    coordinator
  )
  return { trusted, coordinator, handlers }
}

async function invoke(
  handlers: Map<string, (event: TerminalIpcEventLike, ...args: unknown[]) => unknown>,
  channel: string,
  ipcEvent: TerminalIpcEventLike,
  ...args: unknown[]
): Promise<unknown> {
  const handler = handlers.get(channel)
  assert.ok(handler, `${channel} was not registered`)
  return await handler(ipcEvent, ...args)
}

test('registers the complete namespaced terminal IPC surface', () => {
  const { handlers } = registeredHarness()
  assert.deepEqual([...handlers.keys()].sort(), [
    'terminal:ack',
    'terminal:attach',
    'terminal:close',
    'terminal:create',
    'terminal:input',
    'terminal:list',
    'terminal:resize'
  ])
})

test('rejects unknown, destroyed, iframe, and browser-view senders', async () => {
  const { trusted, handlers } = registeredHarness()
  assert.ok(trusted)
  const stranger = new FakeSender()
  const browserView = new FakeSender()

  for (const rejectedEvent of [
    event(stranger),
    event(browserView),
    event(trusted, {}),
    (() => {
      trusted.destroyed = true
      return event(trusted)
    })()
  ]) {
    const result = await invoke(handlers, 'terminal:list', rejectedEvent, { kind: 'ordinary' })
    assert.deepEqual(result, {
      ok: false,
      code: 'unavailable',
      message: 'Terminal renderer is not authorized'
    })
  }
})

test('rejects extra keys, bad dimensions, oversized input, and NUL input as invalid', async () => {
  const calls: string[] = []
  const manager = fakeManager({
    create: async () => {
      calls.push('create')
      return snapshot
    },
    input: async () => {
      calls.push('input')
    }
  })
  const { trusted, handlers } = registeredHarness({ manager })
  assert.ok(trusted)
  const trustedEvent = event(trusted)

  const invalidCalls: Array<[string, unknown[]]> = [
    [
      'terminal:create',
      [{ workspace: { kind: 'ordinary' }, cols: 80, rows: 24, requestId: 'request_1', cwd: '/x' }]
    ],
    [
      'terminal:create',
      [{ workspace: { kind: 'ordinary', cwd: '/x' }, cols: 80, rows: 24, requestId: 'request_2' }]
    ],
    [
      'terminal:create',
      [{ workspace: { kind: 'ordinary' }, cols: 19, rows: 24, requestId: 'request_3' }]
    ],
    ['terminal:resize', ['terminal_123', 501, 24]],
    ['terminal:close', ['terminal_123', 'unexpected-extra-argument']],
    ['terminal:input', ['terminal_123', 'x'.repeat(64 * 1024 + 1)]],
    ['terminal:input', ['terminal_123', 'secret\0text']]
  ]

  for (const [channel, args] of invalidCalls) {
    const result = (await invoke(handlers, channel, trustedEvent, ...args)) as {
      ok: boolean
      code?: string
    }
    assert.equal(result.ok, false, channel)
    assert.equal(result.code, 'invalid', channel)
  }
  assert.deepEqual(calls, [])
})

test('sends events only to the current live trusted renderer', () => {
  let current: FakeSender | null = new FakeSender()
  const coordinator = new TerminalIpcCoordinator({
    getManager: () => fakeManager(),
    getTrustedRenderer: () => current,
    platform: 'darwin'
  })
  const first = current
  const terminalEvent: TerminalEvent = { type: 'state', snapshot }

  assert.equal(coordinator.sendEvent(terminalEvent), true)
  assert.deepEqual(first.sent, [{ channel: 'terminal:event', payload: terminalEvent }])

  current = new FakeSender()
  assert.equal(coordinator.sendEvent(terminalEvent), true)
  assert.equal(first.sent.length, 1)
  assert.equal(current.sent.length, 1)

  current.destroyed = true
  assert.equal(coordinator.sendEvent(terminalEvent), false)
  current = null
  assert.equal(coordinator.sendEvent(terminalEvent), false)
})

test('returns unsupported_platform for create and an empty list outside macOS', async () => {
  let managerCalls = 0
  const manager = fakeManager({
    list: async () => {
      managerCalls += 1
      return [snapshot]
    },
    create: async () => {
      managerCalls += 1
      return snapshot
    }
  })
  const { trusted, handlers } = registeredHarness({ manager, platform: 'linux' })
  assert.ok(trusted)
  const trustedEvent = event(trusted)

  assert.deepEqual(await invoke(handlers, 'terminal:list', trustedEvent, { kind: 'ordinary' }), {
    ok: true,
    value: []
  })
  assert.deepEqual(
    await invoke(handlers, 'terminal:create', trustedEvent, {
      workspace: { kind: 'ordinary' },
      cols: 80,
      rows: 24,
      requestId: 'request_9'
    }),
    {
      ok: false,
      code: 'unsupported_platform',
      message: 'Terminal is not supported on this platform'
    }
  )
  assert.equal(managerCalls, 0)
})
