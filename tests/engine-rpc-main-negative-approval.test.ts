import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { test } from 'node:test'
import type { RpcApprovalReadiness } from '../src/main/agent/engine/phi-extension/extensions/rpc-tool-approval'
import {
  approvalIdentity,
  captureApprovalHook,
  deferred,
  until
} from './helpers/rpcApprovalFixture'

const event = {
  type: 'tool_call' as const,
  toolCallId: 'negative-main',
  toolName: 'write',
  input: { path: 'controlled.txt', content: 'x' }
}

interface PendingMainFixture {
  ready: RpcApprovalReadiness
  lifetime: AbortController
  answer: ReturnType<typeof deferred<boolean>>
  ctx: {
    cwd: string
    agent: { kind: 'main' }
    sessionManager: { getSessionId(): string }
    ui: { confirm(): Promise<boolean> }
  }
  opened(): boolean
}
function pendingMain(): PendingMainFixture {
  const lifetime = new AbortController()
  const ready = { ...approvalIdentity, cwd: realpathSync('.'), signal: lifetime.signal }
  const answer = deferred<boolean>()
  let opened = false
  const ctx = {
    cwd: ready.cwd,
    agent: { kind: 'main' as const },
    sessionManager: { getSessionId: () => ready.ompSessionId },
    ui: {
      confirm: async () => {
        opened = true
        return answer.promise
      }
    }
  }
  return { ready, lifetime, answer, ctx, opened: () => opened }
}

test('R6 MAIN negative decision seals the exact captured current run before returning denial', async () => {
  const f = pendingMain()
  const parent = { runId: f.ready.runId, controlSequence: 7, signal: f.ready.signal }
  const seals: unknown[] = []
  const hook = await captureApprovalHook({
    readiness: () => f.ready,
    classifyTool: () => 'write',
    mainNegativeApproval: {
      parentRun: () => parent,
      sealParent: (run, ctx) => seals.push({ run, ctx })
    }
  })
  const pending = hook(event, f.ctx)
  await until(f.opened)
  assert.equal(seals.length, 0)
  f.answer.resolve(false)
  assert.deepEqual(await pending, {
    block: true,
    reason: 'Phi main RPC approval is unavailable or denied'
  })
  assert.deepEqual(seals, [{ run: parent, ctx: f.ctx }])
})

for (const change of ['run', 'sequence', 'signal', 'identity', 'session'] as const)
  test(`R6 stale MAIN negative decision cannot seal a successor after ${change} changes`, async () => {
    const f = pendingMain()
    let ready = f.ready
    let parent = { runId: ready.runId, controlSequence: 7, signal: ready.signal }
    let seals = 0
    const hook = await captureApprovalHook({
      readiness: () => ready,
      classifyTool: () => 'write',
      mainNegativeApproval: {
        parentRun: () => parent,
        sealParent: () => seals++
      }
    })
    const pending = hook(event, f.ctx)
    await until(f.opened)
    if (change === 'run') {
      ready = { ...ready, runId: 'successor' }
      parent = { ...parent, runId: 'successor' }
    }
    if (change === 'sequence') parent = { ...parent, controlSequence: 8 }
    if (change === 'signal') {
      const signal = new AbortController().signal
      ready = { ...ready, signal }
      parent = { ...parent, signal }
    }
    if (change === 'identity') ready = { ...ready, nonce: 'foreign-nonce' }
    if (change === 'session') f.ctx.sessionManager.getSessionId = () => 'foreign-omp'
    f.answer.resolve(false)
    assert.equal(((await pending) as { block: boolean }).block, true)
    assert.equal(seals, 0)
  })

test('positive R6 MAIN approval does not seal and default-off R5 denial keeps its behavior', async () => {
  for (const optIn of [false, true]) {
    const f = pendingMain()
    let seals = 0
    const hook = await captureApprovalHook({
      readiness: () => f.ready,
      classifyTool: () => 'write',
      ...(optIn
        ? {
            mainNegativeApproval: {
              parentRun: () => ({
                runId: f.ready.runId,
                controlSequence: 7,
                signal: f.ready.signal
              }),
              sealParent: () => seals++
            }
          }
        : {})
    })
    const pending = hook(event, f.ctx)
    await until(f.opened)
    f.answer.resolve(optIn)
    if (optIn) assert.equal(await pending, undefined)
    else assert.equal(((await pending) as { block: boolean }).block, true)
    assert.equal(seals, 0)
  }
})
