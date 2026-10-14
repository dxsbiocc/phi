import assert from 'node:assert/strict'
import { facadeMetadataFixture } from './facadeMetadataFixture'
import { createRunId, findPhiSessionById } from '../../src/main/agent/session/session-store'
import { runSelectionBoundary } from './facadeSelectionBoundaries'
import { RemoteSessionRuntime } from '../../src/main/agent/engine/rpc/remote-session-runtime'
import type { PhiAgentDefinition } from '../../src/main/agent/agents/definition'
import { mock } from 'node:test'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'

const mode = process.env.PHI_FACADE_SELECTION_MODE!
let oldInterrupted: ((error: Error) => void) | undefined
const create = RemoteSessionRuntime.create
const runtimeProbe = mock.method(RemoteSessionRuntime, 'create', async (options) => {
  oldInterrupted ??= options.onInterrupted
  return create.call(RemoteSessionRuntime, options)
})
const definition: PhiAgentDefinition = {
  name: 'Checker',
  description: 'One bounded foreground check',
  tools: ['read'],
  skills: [],
  visibility: 'entry',
  warnings: [],
  source: 'phi',
  filePath: '/trusted-fixture/Checker.md',
  systemPrompt: 'PRIVATE_FOREGROUND_CHECKER. Complete only the requested check.'
}
const f = await facadeMetadataFixture({
  isolatedProject: true,
  nonReasoningModel: mode === 'fallback' ? undefined : 'model-b',
  thinkingEfforts: mode === 'fallback' ? { 'model-b': ['low', 'xhigh'] } : undefined,
  applicationRouting:
    mode === 'resource-child'
      ? { agents: [definition], foregroundAgentNames: 'Checker' }
      : { agents: [] }
})
let proxy = (await f.createApplicationSession()).session
async function until(predicate: () => boolean): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    assert.ok(Date.now() - start < 15000, 'selection boundary did not arrive')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
const history = (): unknown =>
  proxy.messages.map((message) => {
    const value = message as Record<string, unknown>
    return {
      role: value.role,
      content: value.content,
      model: value.model,
      provider: value.provider
    }
  })
async function prompt(text: string): Promise<void> {
  const run = f.runners.startRun({
    sessionId: f.phi.sessionId,
    runId: createRunId(),
    execute: () => proxy.prompt(text)
  })
  await run.done
}
try {
  if (mode === 'model' || mode === 'thinking' || mode === 'restore' || mode === 'fallback') {
    f.provider.enqueue({ text: 'Original history remains' })
    await prompt('Before selection')
    const original = history()
    const requests = f.provider.requests.length
    const reference = findPhiSessionById(f.phi.sessionId)!.runtimeRef!
    if (mode === 'thinking') {
      await proxy.setThinkingLevel('medium')
      assert.equal(proxy.thinkingLevel, 'medium')
      assert.equal(findPhiSessionById(f.phi.sessionId)!.thinkingLevel, 'medium')
    } else {
      await proxy.setModel({
        ...f.model('model-b'),
        reasoning: true,
        name: 'Renderer cannot grant metadata'
      })
      assert.equal(proxy.model?.id, 'model-b')
      assert.equal(proxy.thinkingLevel, mode === 'fallback' ? 'low' : undefined)
      assert.equal(proxy.model?.reasoning, mode === 'fallback')
      assert.notEqual(proxy.model?.name, 'Renderer cannot grant metadata')
      assert.deepEqual(findPhiSessionById(f.phi.sessionId)!.model, {
        providerId: f.model('model-b').provider,
        modelId: 'model-b'
      })
      assert.equal(
        findPhiSessionById(f.phi.sessionId)!.thinkingLevel,
        mode === 'fallback' ? 'low' : undefined
      )
    }
    assert.equal(
      f.provider.requests.length,
      requests,
      'control must not invoke the model or replay tools'
    )
    assert.deepEqual(history(), original)
    assert.equal(
      findPhiSessionById(f.phi.sessionId)!.runtimeRef!.journalBasename,
      reference.journalBasename
    )
    assert.equal(
      findPhiSessionById(f.phi.sessionId)!.runtimeRef!.ompSessionId,
      reference.ompSessionId
    )
    assert.ok(f.leases.every((lease) => lease.models.length <= 2))
    if (mode === 'model') {
      const request = RpcConnection.prototype.request
      let sdkState: Record<string, unknown> = {}
      const read = mock.method(
        RpcConnection.prototype,
        'request',
        function (this: RpcConnection, ...args: Parameters<typeof request>) {
          const result = request.apply(this, args)
          return args[0].type === 'get_state'
            ? result.then((value) => {
                sdkState = value as Record<string, unknown>
                return value
              })
            : result
        }
      )
      try {
        assert.deepEqual(await proxy.getContextUsage(), sdkState.contextUsage ?? null)
        const name = 'Confirmed model B 中文 session'
        await f.engine.sessions.rename({ sessionId: proxy.runtimeSessionId, name })
        assert.equal(findPhiSessionById(f.phi.sessionId)!.title, name)
        assert.equal(sdkState.sessionName, name)
        assert.equal((sdkState.model as { id: string }).id, 'model-b')
        assert.equal(sdkState.thinkingLevel, 'off')
        assert.deepEqual(history(), original)
        assert.equal(f.provider.requests.length, requests, 'metadata cannot invoke the provider')
      } finally {
        read.mock.restore()
      }
    }
    if (mode === 'restore') {
      await proxy.dispose()
      f.resume()
      proxy = (await f.createApplicationSession()).session
      assert.equal(proxy.model?.id, 'model-b')
      assert.equal(f.provider.requests.length, requests)
      assert.deepEqual(history(), original)
    }
    f.provider.enqueue({ text: 'After confirmed selection' })
    await prompt('Use the confirmed selection')
    assert.equal(f.provider.requests.length, requests + 1)
    assert.equal(f.provider.requests.at(-1)!.model, mode === 'thinking' ? 'model-a' : 'model-b')
    if (mode === 'model') {
      await proxy.setModel(f.model('model-a'))
      assert.equal(proxy.model?.id, 'model-a')
      assert.equal(proxy.thinkingLevel, 'high')
      assert.equal(findPhiSessionById(f.phi.sessionId)!.thinkingLevel, 'high')
      assert.equal(f.provider.requests.length, requests + 1, 'reverse selection cannot replay')
      f.provider.enqueue({ text: 'Reasoning policy restored' })
      await prompt('Use the confirmed reasoning policy')
      assert.equal(f.provider.requests.at(-1)!.model, 'model-a')
    }
  } else if (mode === 'busy' || mode === 'approval') {
    let approve: ((value: 'approved') => void) | undefined
    if (mode === 'approval')
      f.configureApproval({
        shouldGate: () => true,
        requestToolApproval: () =>
          new Promise((resolve) => {
            approve = resolve
          })
      })
    f.provider.enqueue(
      mode === 'busy'
        ? { text: 'Held active model', hold: true }
        : {
            tool: {
              name: 'write',
              args: { path: 'selection-must-not-write.txt', content: 'blocked' }
            }
          }
    )
    const running = prompt('Keep the original run active')
    await until(() => (mode === 'busy' ? f.provider.requests.length > 0 : !!approve))
    const before = findPhiSessionById(f.phi.sessionId)!
    const channels = f.channels.length
    await assert.rejects(proxy.setModel(f.model('model-b')), /idle|active|running/)
    await assert.rejects(async () => proxy.setThinkingLevel('medium'), /idle|active|running/)
    const after = findPhiSessionById(f.phi.sessionId)!
    assert.deepEqual(after.model, before.model)
    assert.equal(after.thinkingLevel, before.thinkingLevel)
    assert.deepEqual(after.runtimeRef, before.runtimeRef)
    assert.equal(f.channels.length, channels)
    f.runners.stopRun(f.phi.sessionId)
    await proxy.abort()
    approve?.('approved')
    await running
    assert.equal(await f.exists(f.f.scope.projectRoot + '/selection-must-not-write.txt'), false)
  } else await runSelectionBoundary(f, proxy, mode, oldInterrupted)
  console.log(
    JSON.stringify({ mode, requests: f.provider.requests.length, channels: f.channels.length })
  )
} finally {
  runtimeProbe.mock.restore()
  await proxy.dispose().catch(() => undefined)
  await f.close()
}
