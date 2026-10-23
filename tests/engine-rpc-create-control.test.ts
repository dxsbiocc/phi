import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import {
  SessionRoutingEngine,
  type RoutedSessionDriver
} from '../src/main/agent/engine/session-routing-engine'
import { createInProcessEngine } from '../src/main/agent/engine/in-process-engine'
import { OmpBridge } from '../src/main/agent/engine/omp-bridge'
import type { PhiSessionCreateParams, WorkerSessionState } from '../src/main/agent/engine/types'

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((done) => {
      resolve = done
    }),
    resolve: (value) => resolve(value)
  }
}
function params(t: TestContext, sessionId: string): PhiSessionCreateParams {
  const root = mkdtempSync(join(tmpdir(), 'phi-create-control-'))
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  })
  return {
    sessionId,
    cwd: root,
    agentDir: root,
    enableToolApproval: false,
    sessionManager: { kind: 'open', cwd: root, path: 'phi-session:control-phi' },
    remoteProject: {
      phiSessionId: 'control-phi',
      projectId: 'control-project',
      location: {
        kind: 'ssh',
        hostProfileId: 'control-host',
        remoteRoot: '/server/project',
        canonicalRoot: '/server/project'
      },
      contextFiles: []
    }
  }
}
function driver(): { value: RoutedSessionDriver; counts: { dispose: number; prompt: number } } {
  const counts = { dispose: 0, prompt: 0 }
  const state: WorkerSessionState = { cwd: '/desktop/anchor', messages: [] }
  let live = true
  return {
    counts,
    value: {
      get isLive() {
        return live
      },
      state: () => state,
      prompt: async () => {
        counts.prompt++
        return state
      },
      contextUsage: async () => null,
      rename: async () => state,
      abort: async () => state,
      dispose: async () => {
        counts.dispose++
        live = false
      }
    }
  }
}
const legacy = (): ReturnType<typeof createInProcessEngine> =>
  createInProcessEngine(
    new OmpBridge(() => {
      throw new Error('Legacy worker must never start')
    })
  )

test('router disposes a returned driver once when its captured creation owner became stale', async (t) => {
  const held = deferred<RoutedSessionDriver>(),
    entered = deferred<void>(),
    actual = driver()
  const router = new SessionRoutingEngine(legacy(), () => ({
    create: async () => {
      entered.resolve()
      return held.promise
    }
  }))
  const input = params(t, 'stale-runtime')
  const primary = new Error('captured creation owner changed')
  let stale = false
  const creating = router.sessions.create(input, {
    assertCurrent: () => {
      if (stale) throw primary
    }
  })
  await entered.promise
  stale = true
  held.resolve(actual.value)
  await assert.rejects(creating, (error) => error === primary)
  assert.equal(actual.counts.dispose, 1)
  assert.equal(router.sessions.has(input.sessionId), false)
})

test('router rejects host-started agent runs for a remote session', async (t) => {
  const actual = driver()
  const router = new SessionRoutingEngine(legacy(), () => ({
    create: async () => actual.value
  }))
  const input = params(t, 'remote-agent-start')
  await router.sessions.create(input)

  assert.throws(
    () => router.agentRuns.start({ sessionId: input.sessionId, task: 'run one plan step' }),
    /agentRuns\.start/
  )
  await router.sessions.dispose({ sessionId: input.sessionId })
})

test('preparation abort reaches only its owned router signal and rejects the late returned driver', async (t) => {
  const held = deferred<RoutedSessionDriver>(),
    entered = deferred<void>(),
    actual = driver()
  let owned: AbortSignal | undefined
  const router = new SessionRoutingEngine(legacy(), () => ({
    create: async (_input, signal) => {
      owned = signal
      entered.resolve()
      return held.promise
    }
  }))
  const input = params(t, 'cancelled-runtime'),
    controller = new AbortController()
  const creating = router.sessions.create(input, {
    signal: controller.signal,
    assertCurrent: () => controller.signal.throwIfAborted()
  })
  await entered.promise
  controller.abort(new Error('stop preparation'))
  assert.equal(owned?.aborted, true)
  held.resolve(actual.value)
  await assert.rejects(creating)
  assert.equal(actual.counts.dispose, 1)
  assert.equal(router.sessions.has(input.sessionId), false)
})

for (const mode of ['late-signal', 'stale-guard'] as const)
  test(`accepted router driver does not retain preparation authority: ${mode}`, async (t) => {
    const actual = driver(),
      controller = new AbortController()
    let owned: AbortSignal | undefined,
      checks = 0,
      stale = false
    const router = new SessionRoutingEngine(legacy(), () => ({
      create: async (_input, signal) => {
        owned = signal
        return actual.value
      }
    }))
    const input = params(t, 'accepted-' + mode)
    await router.sessions.create(input, {
      signal: controller.signal,
      assertCurrent: () => {
        checks++
        if (stale) throw new Error('old preparation ended')
      }
    })
    const acceptedChecks = checks
    if (mode === 'late-signal') controller.abort(new Error('old preparation cancelled late'))
    else stale = true
    assert.equal(owned?.aborted, false)
    assert.equal(router.sessions.has(input.sessionId), true)
    await router.sessions.prompt({ sessionId: input.sessionId, text: 'new explicit user prompt' })
    assert.equal(checks, acceptedChecks)
    assert.equal(actual.counts.prompt, 1)
    assert.equal(actual.counts.dispose, 0)
    await router.sessions.dispose({ sessionId: input.sessionId })
  })
