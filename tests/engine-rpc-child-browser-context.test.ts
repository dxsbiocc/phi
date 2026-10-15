import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BrowserToolHostCoordinator,
  type BrowserToolDispatchControl
} from '../src/main/agent/browser/browser-tool-host'
import { BrowserIpcCoordinator, type BrowserWorkspaceLike } from '../src/main/browser/browser-ipc'
import type { BrowserActor, BrowserWorkspaceSnapshot } from '../src/shared/browserTypes'
import { BrowserTextVault } from '../src/main/agent/browser/browser-text-vault'

const snapshot: BrowserWorkspaceSnapshot = {
  sessionId: 'phi-one',
  activeTabId: null,
  tabs: [],
  revision: 0,
  capabilities: {
    presentation: 'native',
    screenshot: false,
    coordinateInput: false,
    semanticInspection: false,
    downloads: false,
    recording: false,
    persistentProfile: false
  }
}
const request = (id: string): Record<string, unknown> => ({
  originSessionId: 'root-runtime',
  requestId: id,
  toolCallId: `tool-${id}`,
  command: { type: 'open', requestId: id, url: 'https://example.org/' }
})
function fixture(workspaceReady: Promise<void> = Promise.resolve()): {
  host: BrowserToolHostCoordinator
  calls: BrowserActor[]
  child: AbortController
  control: BrowserToolDispatchControl
  retire(): void
} {
  const child = new AbortController()
  let current = true
  const calls: BrowserActor[] = []
  const workspace: BrowserWorkspaceLike = {
    async execute(actor) {
      calls.push(actor)
      return { ok: true, snapshot }
    },
    snapshot: () => snapshot,
    async setViewport(): Promise<void> {
      return undefined
    },
    subscribe: () => (): void => {}
  }
  const ipc = new BrowserIpcCoordinator({
    getRegistry: () => ({
      async getOrCreate() {
        await workspaceReady
        return workspace
      },
      async disposeSession(): Promise<void> {
        return undefined
      }
    }),
    getTrustedRenderer: () => null,
    resolveHumanSession: () => undefined,
    resolveAgentSession: () => ({
      sessionId: 'phi-one',
      owner: {
        kind: 'project',
        location: {
          kind: 'ssh',
          hostProfileId: 'profile-one',
          remoteRoot: '/srv/project',
          canonicalRoot: '/srv/project'
        }
      }
    })
  })
  const host = new BrowserToolHostCoordinator({
    resolveActiveRun: () => undefined,
    executeAgent: (input, signal, control) => ipc.executeAgent(input, signal, control)
  })
  const control: BrowserToolDispatchControl = {
    runId: 'private-child-a',
    signal: child.signal,
    allowTypeText: false,
    assertCurrent() {
      if (!current) throw new Error('child ownership ended')
    }
  }
  return {
    host,
    calls,
    child,
    control,
    retire: () => {
      current = false
    }
  }
}

test('a verified background browser request retains child and Phi ownership after its parent ended', async () => {
  const f = fixture()
  assert.equal((await f.host.execute(request('child-open'), f.control)).ok, true)
  assert.deepEqual(f.calls, [
    { kind: 'agent', sessionId: 'phi-one', runId: 'private-child-a', toolCallId: 'tool-child-open' }
  ])
})
test('browser workspace selection rechecks child ownership before the real dispatcher', async () => {
  let release!: () => void
  const f = fixture(
    new Promise<void>((resolve) => {
      release = resolve
    })
  )
  const result = f.host.execute(request('late-open'), f.control)
  await Promise.resolve()
  f.retire()
  release()
  await assert.rejects(result)
  assert.equal(f.calls.length, 0)
})
test('expert browser typing cannot consume the root privacy input channel', async () => {
  const f = fixture()
  await assert.rejects(
    f.host.execute(
      {
        originSessionId: 'root-runtime',
        requestId: 'typing',
        toolCallId: 'typing-tool',
        command: {
          type: 'typeText',
          requestId: 'typing',
          tabId: 'tab-one',
          expectedDocumentRevision: 1,
          requireActive: true,
          text: 'private value',
          consequence: 'write'
        }
      },
      f.control
    ),
    /Expert browser text input is unavailable/
  )
  assert.equal(f.calls.length, 0)
  const vault = new BrowserTextVault({ allowTypeText: false })
  const sanitized = vault.sanitize('child-private', {
    action: 'typeText',
    tabId: 'tab-one',
    expectedDocumentRevision: 1,
    consequence: 'write',
    text: 'must never be stored'
  })
  assert.deepEqual(sanitized, { action: 'invalid' })
  assert.equal(vault.take('child-private', 'unissued-placeholder'), undefined)
})
test('late browser cancellation remains bound to its original child and refuses a peer', async () => {
  const child = new AbortController()
  let current = true
  let dispatched!: () => void
  const started = new Promise<void>((resolve) => {
    dispatched = resolve
  })
  const host = new BrowserToolHostCoordinator({
    resolveActiveRun: () => undefined,
    executeAgent: async (_input, signal) =>
      new Promise((_resolve, reject) => {
        dispatched()
        signal.addEventListener(
          'abort',
          () => reject(new Error('original child browser stopped')),
          { once: true }
        )
      })
  })
  const control: BrowserToolDispatchControl = {
    runId: 'child-a',
    signal: child.signal,
    allowTypeText: false,
    assertCurrent() {
      assert.ok(current)
    }
  }
  const input = request('held-child')
  const result = host.execute(input, control)
  await started
  const cancel = {
    originSessionId: input.originSessionId,
    requestId: input.requestId,
    toolCallId: input.toolCallId
  }
  assert.throws(() => host.cancel(cancel, { runId: 'child-b' }), /another expert/)
  current = false
  host.cancel(cancel, { runId: 'child-a' })
  await assert.rejects(result, /original child browser stopped/)
})
