import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mock } from 'node:test'
import { facadeMetadataFixture } from './facadeMetadataFixture'
import { t15AttachedReadback } from './t15RecoveryObservation'
import { createAppRemoteSessionManager } from '../../src/main/agent/remote-session-routing'
import {
  createRuntimeAgentSession,
  type CreateAgentSessionResult,
  type RuntimeAgentSession
} from '../../src/main/agent/runtime/runtime-adapter'
import { createRunId, findPhiSessionById } from '../../src/main/agent/session/session-store'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'
import { RemoteSessionRuntime } from '../../src/main/agent/engine/rpc/remote-session-runtime'
import { RemoteRecoveryError } from '../../src/main/agent/engine/rpc/session-recovery'
import { RPC_SESSION_VERIFICATION_TYPE } from '../../src/main/agent/engine/phi-extension/lib/rpc-session-verification-protocol'
import type { RpcCommand, RpcRequestOptions } from '../../src/main/agent/engine/rpc/types'

function gate(): { promise: Promise<void>; release(): void } {
  let release!: () => void
  return {
    promise: new Promise((resolve) => {
      release = resolve
    }),
    release: () => release()
  }
}
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))
const f = await facadeMetadataFixture({
  isolatedProject: true,
  nonReasoningModel: 'model-b',
  applicationRouting: { agents: [] }
})
let proxy: RuntimeAgentSession | undefined
const disposers: Array<() => void> = []
const released = gate()
const accepted = gate()
const agentDir = process.env.PI_CODING_AGENT_DIR!
const modelsPath = join(agentDir, 'models.yml')
let modelsFile: string | undefined
let recovering = false
let savedProofModel: string | undefined
let readbackObserved = false
let executionEvents = 0
let creationChecks = 0
let creationEnded = false
const controller = new AbortController()
try {
  proxy = (await f.createApplicationSession()).session
  const prompt = async (text: string): Promise<void> => {
    const run = f.runners.startRun({
      sessionId: f.phi.sessionId,
      runId: createRunId(),
      execute: () => proxy!.prompt(text)
    })
    await run.done
  }
  f.provider.enqueue({ text: 'Original A history is retained once.' })
  await prompt('Record this original A history; do not replay it during recovery.')
  const before = findPhiSessionById(f.phi.sessionId)!
  assert.equal(before.model?.modelId, 'model-a')
  assert.ok(before.runtimeRef)
  const originalReference = structuredClone(before.runtimeRef)
  const originalHistory = proxy.messages.map((message) => {
    const item = message as Record<string, unknown>
    return { role: item.role, content: item.content, model: item.model, provider: item.provider }
  })
  assert.equal(f.provider.requests.length, 1)
  await proxy.dispose()
  proxy = undefined
  f.resume()

  // This is the genuine Main lookup. Its result is immutable while the fresh worker catalog changes.
  const lookup = await f.engine.models.snapshot({ agentDir })
  const lookedUpB = lookup.models.find(
    (model) => model.provider === f.model('model-b').provider && model.id === 'model-b'
  )
  assert.ok(lookedUpB)
  const params = f.params('t15-recovery-runtime', 'model-b')
  const replacement = { providerId: lookedUpB.provider, modelId: lookedUpB.id }
  const createReplacement = (): Promise<CreateAgentSessionResult> =>
    createRuntimeAgentSession(
      {
        cwd: params.cwd,
        agentDir: params.agentDir,
        model: lookedUpB,
        thinkingLevel: before.thinkingLevel,
        autoCompaction: before.autoCompaction,
        projectBound: true,
        sessionManager: createAppRemoteSessionManager(params.cwd, f.phi.sessionId, true),
        remoteProject: params.remoteProject,
        remoteRecovery: { replacementModel: replacement }
      },
      {
        signal: controller.signal,
        assertCurrent: () => {
          creationChecks++
          if (creationEnded) throw new Error('Preparation authority has ended')
        }
      }
    )

  // Remove B from actual SDK configuration, restart only this isolated fixture's desktop worker,
  // and let the production factory request a fresh public model registry snapshot.
  modelsFile = await readFile(modelsPath, 'utf8')
  const catalog = JSON.parse(modelsFile) as {
    providers: Record<string, { models: Array<{ id: string }> }>
  }
  catalog.providers[lookedUpB.provider].models = catalog.providers[
    lookedUpB.provider
  ].models.filter((model) => model.id !== lookedUpB.id)
  await writeFile(modelsPath, JSON.stringify(catalog), { mode: 0o600 })
  await f.bridge.stop()
  const channelsBeforeMissing = f.channels.length
  await assert.rejects(
    createReplacement(),
    (error) => error instanceof RemoteRecoveryError && error.code === 'MODEL_UNAVAILABLE'
  )
  assert.equal(
    f.channels.length,
    channelsBeforeMissing,
    'missing B cannot start another RPC process'
  )
  assert.deepEqual(findPhiSessionById(f.phi.sessionId)!.model, before.model)
  assert.deepEqual(findPhiSessionById(f.phi.sessionId)!.runtimeRef, originalReference)
  assert.equal(f.provider.requests.length, 1)
  await writeFile(modelsPath, modelsFile, { mode: 0o600 })
  await f.bridge.stop()

  const createRuntime = RemoteSessionRuntime.create
  const runtimeSpy = mock.method(RemoteSessionRuntime, 'create', async (options) => {
    assert.equal(options.action.type, 'resume')
    if (options.action.type !== 'resume') throw new Error('Expected explicit recovery')
    assert.deepEqual(options.action.savedModel, { provider: lookedUpB.provider, id: 'model-a' })
    assert.deepEqual(options.action.replacement, { provider: lookedUpB.provider, id: 'model-b' })
    assert.equal(options.action.reference.ompSessionId, originalReference.ompSessionId)
    return createRuntime.call(RemoteSessionRuntime, options)
  })
  disposers.push(() => runtimeSpy.mock.restore())
  const binding = RpcConnection.prototype.bindControl
  const observed = new WeakMap<RpcConnection, Set<number>>()
  const bindSpy = mock.method(
    RpcConnection.prototype,
    'bindControl',
    function (this: RpcConnection) {
      const channel = binding.call(this)
      const generations = observed.get(this) ?? new Set<number>()
      observed.set(this, generations)
      if (!generations.has(channel.generation)) {
        generations.add(channel.generation)
        disposers.push(
          channel.onFrame((frame) => {
            if (!recovering) return
            if (frame.type === 'agent_start' || frame.type === 'tool_execution_start')
              executionEvents++
            if (
              frame.type !== 'extension_ui_request' ||
              frame.method !== 'notify' ||
              typeof frame.message !== 'string'
            )
              return
            let notification: unknown
            try {
              notification = JSON.parse(frame.message)
            } catch {
              return
            }
            if (
              !record(notification) ||
              notification.type !== RPC_SESSION_VERIFICATION_TYPE ||
              !record(notification.request) ||
              notification.request.action !== 'saved'
            )
              return
            assert.ok(record(notification.proof) && record(notification.proof.model))
            savedProofModel = String(notification.proof.model.id)
            assert.equal(
              savedProofModel,
              'model-a',
              'verify the original journal model, not its intended replacement'
            )
          })
        )
      }
      return channel
    }
  )
  disposers.push(() => bindSpy.mock.restore())
  const request = RpcConnection.prototype.request
  const requestSpy = mock.method(
    RpcConnection.prototype,
    'request',
    function (this: RpcConnection, command: RpcCommand, options?: RpcRequestOptions) {
      const response = request.call(this, command, options)
      if (command.type !== 'get_state') return response
      return response.then(async (value) => {
        if (
          !recovering ||
          readbackObserved ||
          !t15AttachedReadback(value, originalReference, {
            provider: lookedUpB.provider,
            id: 'model-b'
          })
        )
          return value
        readbackObserved = true
        assert.equal(savedProofModel, 'model-a')
        assert.deepEqual(
          findPhiSessionById(f.phi.sessionId)!.model,
          before.model,
          'Phi cannot publish B before actual B readback is accepted'
        )
        assert.deepEqual(findPhiSessionById(f.phi.sessionId)!.runtimeRef, originalReference)
        accepted.release()
        await released.promise
        return value
      })
    }
  )
  disposers.push(() => requestSpy.mock.restore())
  recovering = true
  const creating = createReplacement()
  await Promise.race([
    accepted.promise,
    creating.then(() => {
      throw new Error('Recovery returned before the held readback')
    })
  ])
  assert.equal(f.provider.requests.length, 1, 'verification/metadata must not invoke a provider')
  assert.equal(executionEvents, 0, 'recovery must not replay an agent turn or tool')
  released.release()
  proxy = (await creating).session
  recovering = false
  assert.equal(proxy.model?.id, 'model-b')
  const after = findPhiSessionById(f.phi.sessionId)!
  assert.deepEqual(after.model, replacement)
  assert.equal(after.runtimeRef!.ompSessionId, originalReference.ompSessionId)
  assert.equal(after.runtimeRef!.journalBasename, originalReference.journalBasename)
  assert.deepEqual(
    proxy.messages.map((message) => {
      const item = message as Record<string, unknown>
      return { role: item.role, content: item.content, model: item.model, provider: item.provider }
    }),
    originalHistory
  )
  assert.equal(f.provider.requests.length, 1)
  const checksAtReturn = creationChecks
  creationEnded = true
  controller.abort(new Error('Old preparation operation completed'))
  f.provider.enqueue({ text: 'The first explicit post-recovery prompt completed on B.' })
  await prompt('This is the next explicit user prompt after successful recovery.')
  assert.equal(
    creationChecks,
    checksAtReturn,
    'future runs must not consult the old creation guard'
  )
  assert.equal(f.provider.requests.length, 2)
  assert.equal(f.provider.requests.at(-1)!.model, 'model-b')
  console.log(
    JSON.stringify({
      vanishedModelRejected: true,
      savedProofModel,
      recoveredModel: proxy.model?.id,
      noProviderDuringRestore: true,
      noAgentOrToolReplay: executionEvents === 0,
      firstExplicitPromptCompleted: true,
      providerRequests: f.provider.requests.length,
      channels: f.channels.length
    })
  )
} finally {
  recovering = false
  released.release()
  for (const dispose of disposers.reverse()) dispose()
  await proxy?.dispose().catch(() => undefined)
  if (modelsFile) await writeFile(modelsPath, modelsFile, { mode: 0o600 }).catch(() => undefined)
  await f.close()
}
