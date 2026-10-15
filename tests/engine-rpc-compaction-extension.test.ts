import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { createRpcCompactionExtension } from '../src/main/agent/engine/phi-extension/extensions/rpc-compaction-control'
import {
  compactionPolicy,
  RPC_COMPACTION_COMMAND
} from '../src/main/agent/engine/phi-extension/lib/rpc-compaction-control'
import type { RpcRuntimeConfig } from '../src/main/agent/engine/phi-extension/lib/rpc-runtime-config'

type ExtensionAPI = Parameters<ReturnType<typeof createRpcCompactionExtension>['extension']>[0]
type ExtensionContext = Parameters<Parameters<ExtensionAPI['registerCommand']>[1]['handler']>[1]

for (const thresholdTokens of [-1, 25000])
  test(`owned policy accepts the SDK default percent sentinel with tokens ${thresholdTokens}`, () => {
    const policy = { enabled: true, thresholdPercent: -1, thresholdTokens, methodOrder: ['soft'] }
    assert.deepEqual(compactionPolicy(policy), policy)
  })

test('owned policy still rejects unsupported negative, zero, and oversized percentages', () => {
  for (const thresholdPercent of [-2, 0, 101, NaN, Infinity])
    assert.throws(() =>
      compactionPolicy({
        enabled: true,
        thresholdPercent,
        thresholdTokens: -1,
        methodOrder: ['soft']
      })
    )
})

async function fixture(t: TestContext): Promise<{
  call(): Promise<void>
  notifications: Array<Record<string, unknown>>
  settings: {
    revision: number
    overrides: Record<string, unknown>
    reloads: number
    reloadFromDisk(): Promise<void>
  }
  path: string
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-compaction-readback-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'startup-policy.json')
  const policy = { enabled: true, thresholdPercent: 70, thresholdTokens: -1, methodOrder: [] }
  await writeFile(
    path,
    JSON.stringify({ compaction: { ...policy, modelThresholdsEnabled: false } })
  )
  let handler!: (args: string, context: ExtensionContext) => Promise<void>
  const notifications: Array<Record<string, unknown>> = []
  const manager = { getSessionId: () => 'omp' }
  const settings = {
    revision: 1,
    overrides: {} as Record<string, unknown>,
    reloads: 0,
    async reloadFromDisk(): Promise<void> {
      this.reloads++
      this.revision++
    },
    getConfigFiles: () => [path],
    overlayLayers() {
      return { overrides: this.overrides }
    }
  }
  const session = {
    settings,
    sessionManager: manager,
    sessionId: 'omp',
    sessionFile: '/owned/journal',
    autoCompactionEnabled: false
  }
  const extension = createRpcCompactionExtension(
    {
      nonce: 'owned',
      phiSessionId: 'phi',
      generation: 1,
      generationDirectory: root,
      projectRoot: root
    } as RpcRuntimeConfig,
    new AbortController().signal
  )
  extension.extension({
    pi: { AgentRegistry: { global: () => ({ get: () => ({ kind: 'main', session }) }) } },
    registerCommand(name: string, options: { handler: typeof handler }) {
      assert.equal(name, RPC_COMPACTION_COMMAND)
      handler = options.handler
    }
  } as unknown as ExtensionAPI)
  const context = {
    agent: { id: 'main', kind: 'main' },
    cwd: root,
    sessionManager: manager,
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: { notify: (message: string) => notifications.push(JSON.parse(message)) }
  } as unknown as ExtensionContext
  return {
    notifications,
    settings,
    path,
    call: () =>
      handler(
        JSON.stringify({
          nonce: 'owned',
          phiSessionId: 'phi',
          generation: 1,
          ompSessionId: 'omp',
          journalPath: '/owned/journal',
          requestId: 'one',
          operation: 'settings',
          expectedPolicy: policy
        }),
        context
      )
  }
}

test('strict loaded policy drains an earlier reload then attests empty methods and sentinel tokens exactly', async (t) => {
  const f = await fixture(t)
  await f.call()
  assert.equal(f.settings.reloads, 2)
  assert.deepEqual(f.notifications[0].policy, {
    enabled: true,
    thresholdPercent: 70,
    thresholdTokens: -1,
    methodOrder: []
  })
})

for (const override of [
  null,
  { enabled: null },
  { thresholdPercent: null },
  { modelThresholdsEnabled: true },
  { modelThresholds: {} },
  { keepRecentTokens: 99 }
])
  test(`loaded policy rejects ambiguous or unprojected runtime overrides: ${JSON.stringify(override)}`, async (t) => {
    const f = await fixture(t)
    f.settings.overrides = { compaction: override }
    await assert.rejects(f.call(), /Ambiguous|Invalid owned|Unsupported/)
    assert.deepEqual(f.notifications, [])
  })

test('publication changes during strict reload cannot be echoed as confirmed loaded settings', async (t) => {
  const f = await fixture(t)
  f.settings.reloadFromDisk = async () => {
    await writeFile(f.path, JSON.stringify({ compaction: { enabled: false } }))
  }
  await assert.rejects(f.call(), /publication changed/)
  assert.deepEqual(f.notifications, [])
})
