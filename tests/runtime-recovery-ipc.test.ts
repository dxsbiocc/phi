import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createRuntimeRecoveryController,
  runtimeRecoveryModel,
  runtimeRecoveryTarget,
  type RuntimeRecoveryDependencies,
  type RuntimeRecoveryScope
} from '../src/main/agent/session/runtime-recovery-ipc'
import type {
  RuntimeRecoveryState,
  RuntimeRecoverySummary
} from '../src/shared/runtimeRecoveryTypes'

const target = {
  sessionId: 'source',
  projectId: 'project',
  sessionPath: 'phi-session:source',
  sessionGeneration: 2
}
const summary: RuntimeRecoverySummary = {
  content: 'Explicit context only',
  provenance: {
    kind: 'phi-timeline',
    version: 1,
    sourceSessionId: 'source',
    projectId: 'project',
    throughEventId: 'event1',
    eventCount: 1,
    sha256: 'a'.repeat(64)
  }
}
function fixture(): {
  controller: ReturnType<typeof createRuntimeRecoveryController>
  deps: RuntimeRecoveryDependencies
  calls: string[]
  invalidate(): void
  busy(): void
} {
  const calls: string[] = []
  let current = true
  let idle = true
  const state: RuntimeRecoveryState = {
    target,
    phase: 'recovery-required',
    message: 'Disconnected',
    canResume: true
  }
  const scope: RuntimeRecoveryScope = {
    state,
    assertCurrent() {
      if (!current) throw new Error('stale original owner')
    },
    assertIdle() {
      if (!idle) throw new Error('busy original owner')
    }
  }
  const deps: RuntimeRecoveryDependencies = {
    capture: () => scope,
    resolveModel: async (model) => {
      calls.push('registry')
      return model
    },
    resume: async () => {
      calls.push('resume')
      return { ...state, phase: 'connected', canResume: false }
    },
    summarize: () => summary,
    continueFromSummary: async (_scope, selected) => {
      assert.equal(selected, summary)
      calls.push('newPhi')
      return {
        path: 'phi-session:new',
        phiSessionId: 'new',
        projectId: 'project',
        sessionGeneration: 0,
        sourceSessionId: 'source',
        connected: false
      }
    }
  }
  return {
    controller: createRuntimeRecoveryController(deps),
    deps,
    calls,
    invalidate: () => {
      current = false
    },
    busy: () => {
      idle = false
    }
  }
}
function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  return {
    promise: new Promise<void>((done) => {
      resolve = done
    }),
    resolve: () => resolve()
  }
}

test('recovery IPC: reading state projects a preview without connecting, prompting or creating history', async () => {
  const app = fixture()
  const state = await app.controller.getState(target)
  assert.equal(state.summary, summary)
  assert.deepEqual(app.calls, [])
})
test('recovery IPC: only an explicit current summary hash can create a distinct disconnected Phi session', async () => {
  const app = fixture()
  await assert.rejects(app.controller.continueFromSummary(target, 'b'.repeat(64)), /来源历史已更新/)
  assert.deepEqual(app.calls, [])
  const result = await app.controller.continueFromSummary(target, summary.provenance.sha256)
  assert.equal(result.connected, false)
  assert.notEqual(result.phiSessionId, target.sessionId)
  assert.deepEqual(app.calls, ['newPhi'])
})
test('recovery IPC: replacements are checked against fresh authority before resume and a stale lookup has no effects', async () => {
  const app = fixture()
  const gate = deferred()
  app.deps.resolveModel = async (model) => {
    app.calls.push('registry')
    await gate.promise
    return model
  }
  const pending = app.controller.resume(target, { providerId: 'provider', modelId: 'replacement' })
  const rejected = assert.rejects(pending, /stale original owner/)
  await new Promise<void>((done) => setImmediate(done))
  app.invalidate()
  gate.resolve()
  await rejected
  assert.deepEqual(app.calls, ['registry'])
})
test('recovery IPC: idle is checked again after a replacement lookup before any restore', async () => {
  const app = fixture()
  app.deps.resolveModel = async (model) => {
    app.busy()
    return model
  }
  await assert.rejects(
    app.controller.resume(target, { providerId: 'provider', modelId: 'replacement' }),
    /busy original owner/
  )
  assert.deepEqual(app.calls, [])
})
test('recovery IPC: same-source recovery actions exclude duplicates', async () => {
  const app = fixture()
  const gate = deferred()
  app.deps.resume = async () => {
    await gate.promise
    return { target, phase: 'connected', message: '', canResume: false }
  }
  const pending = app.controller.resume(target)
  await new Promise<void>((done) => setImmediate(done))
  await assert.rejects(
    app.controller.continueFromSummary(target, summary.provenance.sha256),
    /正在进行/
  )
  gate.resolve()
  await pending
  const result = await app.controller.continueFromSummary(target, summary.provenance.sha256)
  assert.equal(result.connected, false)
})
test('recovery IPC: target and model input reject authority-like extra fields and foreign locators', () => {
  assert.deepEqual(runtimeRecoveryTarget(target), target)
  assert.throws(() => runtimeRecoveryTarget({ ...target, sessionPath: '/server/private.jsonl' }))
  assert.throws(() => runtimeRecoveryTarget({ ...target, runtimeRef: {} }))
  assert.throws(() =>
    runtimeRecoveryModel({ providerId: 'provider', modelId: 'model', apiKey: 'private' })
  )
})
