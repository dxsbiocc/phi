import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRpcHostResultExtension } from '../src/main/agent/engine/phi-extension/extensions/rpc-host-result'
import { RpcPlanPhase } from '../src/main/agent/engine/phi-extension/lib/rpc-plan-phase'
import {
  encodeHostResult,
  encodeHostResultEnvelope,
  hostResultLookupId,
  hostResultPlaceholder,
  signHostResultReceipt
} from '../src/main/agent/engine/phi-extension/lib/rpc-host-result-protocol'

type ExtensionAPI = Parameters<ReturnType<typeof createRpcHostResultExtension>>[0]

function fixture(t: TestContext): {
  phase: RpcPlanPhase
  ready: {
    leaseId: string
    generation: number
    phiSessionId: string
    projectId: string
    cwd: string
    ompSessionId: string
    runId: string
    signal: AbortSignal
  }
  call(): void
  result(
    content: Array<
      { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
    >,
    details?: unknown
  ): unknown
  publish(result: {
    content: Array<{ type: 'text'; text: string }>
    details?: unknown
    isError?: boolean
  }): void
  consumed(): number
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phi-plan-result-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const generationDirectory = join(root, 'generation')
  const directory = join(generationDirectory, `host-results-${'a'.repeat(64)}`)
  mkdirSync(generationDirectory, { mode: 0o700 })
  mkdirSync(directory, { mode: 0o700 })
  const capability = randomBytes(32).toString('hex')
  const ready = Object.freeze({
    leaseId: 'lease',
    generation: 1,
    phiSessionId: 'phi',
    projectId: 'project',
    cwd: root,
    ompSessionId: 'omp',
    runId: 'run',
    signal: new AbortController().signal
  })
  const manager = { getSessionId: () => 'omp' }
  const tool = { execute: async (): Promise<unknown> => ({ content: [] }) }
  const session = { sessionManager: manager, getToolByName: () => tool }
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
  const phase = new RpcPlanPhase('plan')
  let consumed = 0
  createRpcHostResultExtension({
    generationDirectory,
    directory,
    capability,
    readiness: () => ready,
    isHostTool: (name) => name === 'propose_plan_markdown',
    requiresSignedResult: (name) => name === 'propose_plan_markdown',
    onConsumedResult: (binding, toolCallId, name, result) => {
      consumed++
      phase.verifiedResult(binding, toolCallId, name, result)
    }
  })({
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(name, handler)
    },
    pi: { AgentRegistry: { global: () => ({ get: () => ({ session }) }) } }
  } as unknown as ExtensionAPI)
  const ctx = { agent: { id: 'Main', kind: 'main' }, cwd: root, sessionManager: manager }
  const event = { toolCallId: 'call', toolName: 'propose_plan_markdown' }
  return {
    phase,
    ready,
    consumed: () => consumed,
    call: () => {
      phase.assistantMessage(ready, ['propose_plan_markdown'])
      assert.equal(
        phase.toolCall(ready, 'call', 'propose_plan_markdown', { title: 'Draft' }, () => true)
          .allowed,
        true
      )
      assert.equal(
        handlers.get('tool_call')?.({ ...event, input: { title: 'Draft' } }, ctx),
        undefined
      )
    },
    result: (content, details) =>
      handlers.get('tool_result')?.({ ...event, content, details }, ctx),
    publish: (result) => {
      const payload = encodeHostResult(result)
      const identity = {
        leaseId: ready.leaseId,
        generation: ready.generation,
        phiSessionId: ready.phiSessionId,
        projectId: ready.projectId,
        cwd: ready.cwd,
        runId: ready.runId,
        toolCallId: 'call',
        toolName: 'propose_plan_markdown'
      }
      const receipt = signHostResultReceipt(
        {
          type: 'phi_host_result_receipt',
          version: 1,
          ...identity,
          invocationId: 'invocation',
          receiptId: hostResultLookupId(identity, capability),
          bytes: payload.length,
          sha256: createHash('sha256').update(payload).digest('hex')
        },
        capability
      )
      writeFileSync(
        join(directory, `${receipt.receiptId}.json`),
        encodeHostResultEnvelope(receipt, payload),
        {
          mode: 0o600
        }
      )
    }
  }
}

test('inline plan decision never advances phase', (t) => {
  const f = fixture(t)
  f.call()
  const result = f.result([{ type: 'text', text: 'approved' }], {
    decision: 'approve',
    title: 'Draft',
    planFilePath: 'local://PLAN.md'
  }) as { isError?: boolean }
  assert.equal(result.isError, true)
  assert.equal(f.consumed(), 0)
  assert.equal(f.phase.toolCall(f.ready, 'write', 'write', {}, () => true).allowed, false)
})

test('small signed plan success advances only after private receipt consumption', (t) => {
  const f = fixture(t)
  f.call()
  const approved = {
    content: [{ type: 'text' as const, text: 'approved' }],
    details: { decision: 'approve', title: 'Draft', planFilePath: 'local://PLAN.md' }
  }
  f.publish(approved)
  assert.equal(f.consumed(), 0)
  assert.deepEqual(f.result(hostResultPlaceholder().content), { ...approved, isError: false })
  assert.equal(f.consumed(), 1)
  assert.equal(f.phase.toolCall(f.ready, 'same', 'write', {}, () => true).allowed, false)
  f.phase.assistantMessage(f.ready, ['write'])
  assert.equal(f.phase.mode(f.ready), 'direct')
})

test('small signed host error cannot approve a plan', (t) => {
  const f = fixture(t)
  f.call()
  f.publish({ content: [{ type: 'text', text: 'failed' }], isError: true })
  const result = f.result(hostResultPlaceholder().content) as { isError?: boolean }
  assert.equal(result.isError, true)
  assert.equal(f.consumed(), 1)
  assert.equal(f.phase.mode(f.ready), 'plan')
})
