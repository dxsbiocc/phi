import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RpcPlanPhase,
  type RpcPlanRunBinding
} from '../src/main/agent/engine/phi-extension/lib/rpc-plan-phase'
import { bindExclusiveRpcPlanEntry } from '../src/main/agent/engine/phi-extension/extensions/rpc-plan-policy'
import { executionInput } from '../src/main/agent/engine/phi-extension/lib/rpc-execution-protocol'
import { rpcPlanningToolDecision } from '../src/main/agent/engine/phi-extension/lib/rpc-prompt-policy'

function binding(overrides: Partial<RpcPlanRunBinding> = {}): RpcPlanRunBinding {
  return {
    generation: 1,
    phiSessionId: 'phi',
    projectId: 'project',
    cwd: '/remote/project',
    ompSessionId: 'omp',
    runId: 'run-1',
    signal: new AbortController().signal,
    ...overrides
  }
}

const installed = (): boolean => true

test('manual review lifts write gate only in the next assistant response of the same run', () => {
  const phase = new RpcPlanPhase('plan')
  const run = binding()
  assert.equal(phase.mode(run), 'plan')
  phase.assistantMessage(run, ['propose_plan_markdown', 'write'])
  assert.equal(phase.toolCall(run, 'mixed', 'write', {}, installed).allowed, false)
  phase.assistantMessage(run, ['propose_plan_markdown'])
  assert.equal(
    phase.toolCall(run, 'proposal-1', 'propose_plan_markdown', { title: 'Draft' }, installed)
      .allowed,
    true
  )
  phase.verifiedResult(run, 'proposal-1', 'propose_plan_markdown', {
    details: { decision: 'revise', title: 'Draft', planFilePath: 'local://PLAN.md' }
  })
  assert.equal(phase.mode(run), 'plan')
  phase.assistantMessage(run, ['propose_plan_markdown'])
  assert.equal(
    phase.toolCall(run, 'proposal-2', 'propose_plan_markdown', { title: 'Draft' }, installed)
      .allowed,
    true
  )
  phase.verifiedResult(run, 'proposal-2', 'propose_plan_markdown', {
    details: { decision: 'approve', title: 'Draft', planFilePath: 'local://PLAN.md' }
  })
  assert.equal(phase.toolCall(run, 'same-response', 'write', {}, installed).allowed, false)
  phase.assistantMessage(run, ['write'])
  assert.equal(phase.mode(run), 'direct')
  assert.equal(phase.toolCall(run, 'next-response', 'write', {}, installed).allowed, true)
  assert.equal(phase.mode(binding({ runId: 'run-2' })), 'plan')
  assert.equal(phase.mode(binding({ generation: 2 })), 'plan')
  assert.equal(phase.mode(binding({ cwd: '/remote/other' })), 'plan')
})

test('approved manual write permission expires before the next user prompt run', () => {
  const phase = new RpcPlanPhase('plan')
  const currentRun = binding()
  phase.assistantMessage(currentRun, ['propose_plan_markdown'])
  assert.equal(
    phase.toolCall(currentRun, 'review', 'propose_plan_markdown', { title: 'Draft' }, installed)
      .allowed,
    true
  )
  phase.verifiedResult(currentRun, 'review', 'propose_plan_markdown', {
    details: { decision: 'approve', title: 'Draft', planFilePath: 'local://PLAN.md' }
  })
  phase.assistantMessage(currentRun, ['write'])
  assert.equal(phase.mode(currentRun), 'direct')
  const nextUserRun = binding({ runId: 'next-user-prompt' })
  assert.equal(phase.mode(nextUserRun), 'plan')
  assert.equal(
    rpcPlanningToolDecision(phase.mode(nextUserRun) as 'plan', 'write', {
      path: 'src/implementation.ts',
      content: 'unsafe'
    }).allowed,
    false
  )
})

test('structured approval needs a host-confirmed plan run and ends this run', () => {
  const phase = new RpcPlanPhase('plan_execute')
  const run = binding()
  phase.assistantMessage(run, ['propose_plan_steps'])
  assert.equal(phase.toolCall(run, 'steps-1', 'propose_plan_steps', {}, installed).allowed, true)
  assert.throws(() =>
    phase.verifiedResult(run, 'steps-1', 'propose_plan_steps', { details: { decision: 'approve' } })
  )
  assert.equal(phase.mode(run), 'plan_execute')
  phase.assistantMessage(run, ['propose_plan_steps'])
  assert.equal(
    phase.toolCall(run, 'steps-blank', 'propose_plan_steps', {}, installed).allowed,
    true
  )
  assert.throws(() =>
    phase.verifiedResult(run, 'steps-blank', 'propose_plan_steps', {
      details: { decision: 'approve', planRunId: '   ' }
    })
  )
  phase.assistantMessage(run, ['propose_plan_steps'])
  assert.equal(phase.toolCall(run, 'steps-2', 'propose_plan_steps', {}, installed).allowed, true)
  phase.verifiedResult(run, 'steps-2', 'propose_plan_steps', {
    details: { decision: 'approve', planRunId: 'host-plan-run' }
  })
  assert.equal(phase.toolCall(run, 'after', 'read', {}, installed).allowed, false)
})

test('cancel ends the current run while a revised structured proposal stays read-only', () => {
  const phase = new RpcPlanPhase('plan_execute')
  const run = binding()
  phase.assistantMessage(run, ['propose_plan_steps'])
  assert.equal(phase.toolCall(run, 'steps-1', 'propose_plan_steps', {}, installed).allowed, true)
  phase.verifiedResult(run, 'steps-1', 'propose_plan_steps', { details: { decision: 'revise' } })
  assert.equal(phase.mode(run), 'plan_execute')
  phase.assistantMessage(run, ['propose_plan_steps'])
  assert.equal(phase.toolCall(run, 'steps-2', 'propose_plan_steps', {}, installed).allowed, true)
  phase.verifiedResult(run, 'steps-2', 'propose_plan_steps', { details: { decision: 'cancel' } })
  phase.assistantMessage(run, ['read'])
  assert.equal(phase.toolCall(run, 'after-cancel', 'read', {}, installed).allowed, false)
})

test('automatic plan entry requires sole call and matching signed result', () => {
  const phase = new RpcPlanPhase('auto')
  const run = binding()
  phase.assistantMessage(run, ['enter_plan_mode', 'read'])
  assert.equal(
    phase.toolCall(run, 'mixed', 'enter_plan_mode', { execute: false, reason: 'Broad' }, installed)
      .allowed,
    false
  )
  phase.assistantMessage(run, ['enter_plan_mode'])
  assert.equal(
    phase.toolCall(
      run,
      'extra',
      'enter_plan_mode',
      { execute: false, reason: 'Broad', soleCall: true },
      installed
    ).allowed,
    false
  )
  assert.equal(
    phase.toolCall(
      run,
      'enter-1',
      'enter_plan_mode',
      { execute: false, reason: 'Broad' },
      installed
    ).allowed,
    true
  )
  assert.throws(() =>
    phase.verifiedResult(run, 'enter-1', 'enter_plan_mode', {
      details: { decision: 'plan_execute', reason: 'Broad' }
    })
  )
  assert.equal(phase.mode(run), 'auto')
  phase.assistantMessage(run, ['enter_plan_mode'])
  assert.equal(
    phase.toolCall(
      run,
      'enter-2',
      'enter_plan_mode',
      { execute: false, reason: 'Broad' },
      installed
    ).allowed,
    true
  )
  phase.verifiedResult(run, 'enter-2', 'enter_plan_mode', {
    details: { decision: 'plan', reason: 'Broad' }
  })
  assert.equal(phase.mode(run), 'plan')
  assert.equal(phase.toolCall(run, 'same-response', 'read', {}, installed).allowed, false)
  phase.assistantMessage(run, ['read'])
  assert.equal(phase.toolCall(run, 'next-response', 'read', {}, installed).allowed, true)
  assert.equal(phase.mode(binding({ runId: 'new-run' })), 'auto')
  // An automatic plan decision is process-local today. Keep the remote auto
  // capability disabled until the host persists pending-plan taint across recovery.
  assert.equal(phase.mode(binding({ generation: 2, runId: 'recovered-run' })), 'auto')
})

test('exclusive plan entry marker is signed before host projection', () => {
  const input = { execute: false, reason: 'Broad' } as Record<string, unknown>
  bindExclusiveRpcPlanEntry(input)
  assert.deepEqual(
    executionInput(
      {
        name: 'enter_plan_mode',
        site: 'host',
        parameters: {
          type: 'object',
          properties: {
            execute: { type: 'boolean' },
            reason: { type: 'string' },
            soleCall: { type: 'boolean' }
          }
        }
      },
      input
    ),
    { execute: false, reason: 'Broad', soleCall: true }
  )
  assert.throws(() => bindExclusiveRpcPlanEntry(Object.freeze({ execute: false, reason: 'Broad' })))
})
