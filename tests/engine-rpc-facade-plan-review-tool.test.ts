import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createFacadePlanMarkdownTool,
  createFacadePlanReviewTool,
  createFacadePlanReviewTools,
  remotePlanModeAllowed
} from '../src/main/agent/engine/rpc/facade-plan-review-tool'
import {
  recoveredFacadeAutoPolicy,
  sameFacadeSessionPolicy
} from '../src/main/agent/engine/rpc/facade-session-policy'
import { writePendingRemoteAutoPlan } from '../src/main/agent/session/pending-remote-auto-plan'
import type { SessionRun } from '../src/main/agent/session/session-runner-registry'
import type { PhiSessionManifest } from '../src/main/agent/session/session-store'

const spec = {
  version: 1,
  goal: 'Finish E5',
  steps: [
    {
      id: 'e5',
      title: 'Bridge',
      instructions: 'Build the bridge.',
      acceptance: 'Tests pass.',
      dependsOn: [],
      access: 'read'
    }
  ]
}

test('remote planning stays closed without a separate execution capability', () => {
  assert.equal(remotePlanModeAllowed('auto'), true)
  assert.equal(remotePlanModeAllowed('direct'), true)
  assert.equal(remotePlanModeAllowed('plan'), false)
  assert.equal(remotePlanModeAllowed('plan', true), false)
  assert.equal(remotePlanModeAllowed('plan', false, true), true)
  assert.equal(remotePlanModeAllowed('plan_execute'), false)
  assert.equal(remotePlanModeAllowed('plan_execute', true), true)
})

test('recovered auto mode locks exact marker phase and fails closed on mismatch or corruption', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'phi-remote-auto-policy-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const manifest = {
    sessionId: 'phi-1',
    currentRunId: 'run-1',
    workMode: 'auto',
    permissionMode: 'auto'
  } as PhiSessionManifest
  const fresh = recoveredFacadeAutoPolicy(manifest, directory)
  assert.deepEqual({ mode: fresh.mode, tainted: fresh.tainted }, { mode: 'auto', tainted: false })
  writePendingRemoteAutoPlan(directory, {
    version: 1,
    phiSessionId: 'phi-1',
    runId: 'run-1',
    sessionGeneration: 3,
    mode: 'plan_execute'
  })
  assert.throws(() => fresh.assertCurrent(), /标记已改变/)
  fresh.adoptSelection('run-1', 'plan_execute')
  fresh.assertCurrent()
  assert.deepEqual(fresh.generation(), { mode: 'plan_execute', tainted: true })
  assert.equal(recoveredFacadeAutoPolicy(manifest, directory).mode, 'plan_execute')
  assert.equal(
    recoveredFacadeAutoPolicy({ ...manifest, currentRunId: 'run-2' }, directory).mode,
    'plan'
  )
  await writeFile(join(directory, 'pending-remote-auto-plan.json'), '{invalid')
  assert.equal(recoveredFacadeAutoPolicy(manifest, directory).mode, 'plan')
  assert.throws(() => fresh.assertCurrent(), /标记已改变/)
})

test('missing session directory never restores saved automatic authority', async () => {
  const manifest = {
    sessionId: 'phi-1',
    workMode: 'auto',
    permissionMode: 'auto'
  } as PhiSessionManifest
  const policy = recoveredFacadeAutoPolicy(manifest, join(tmpdir(), `missing-phi-${Date.now()}`))
  assert.deepEqual({ mode: policy.mode, tainted: policy.tainted }, { mode: 'plan', tainted: true })
  assert.deepEqual(policy.generation(), { mode: 'plan', tainted: true })
})

test('remote markdown review accepts only the signed session draft fields', async () => {
  const run = {
    runId: 'run-1',
    sessionId: 'phi-1',
    signal: new AbortController().signal
  } as SessionRun
  const requests: Array<{ params: unknown; context: Record<string, unknown> }> = []
  const tool = createFacadePlanMarkdownTool({
    runtimeSessionId: 'runtime-1',
    phiSessionId: 'phi-1',
    host: {
      invoke: async (_method, params, context) => {
        requests.push({ params, context: context as Record<string, unknown> })
        return { decision: 'approve' }
      }
    },
    currentRun: () => run,
    assertCurrent: () => undefined
  })
  const context = { cwd: '/remote', recentUserImages: () => [] }
  assert.deepEqual(tool.parameters.required, ['title'])
  for (const input of [
    { title: 'Draft' },
    { title: ' Draft', content: '# Draft', planFilePath: 'local://PLAN.md' },
    { title: 'Draft', content: '# Draft', planFilePath: 'local://OTHER.md' },
    { title: 'Draft', content: '  ', planFilePath: 'local://PLAN.md' },
    {
      title: 'Draft',
      content: '# Draft',
      planFilePath: 'local://PLAN.md',
      runtimeSessionId: 'other'
    }
  ]) {
    assert.equal((await tool.execute('call-invalid', input, undefined, context)).isError, true)
  }
  assert.equal(requests.length, 0)
  const approved = await tool.execute(
    'call-1',
    { title: 'Draft', content: '# Draft', planFilePath: 'local://PLAN.md' },
    undefined,
    context
  )
  assert.equal((approved.details as { decision: string }).decision, 'approve')
  assert.deepEqual(requests[0].params, {
    runtimeSessionId: 'runtime-1',
    title: 'Draft',
    planContent: '# Draft',
    planFilePath: 'local://PLAN.md'
  })
  assert.equal(requests[0].context.remoteOriginAuthenticated, true)
  assert.equal(requests[0].context.remotePlanPhase, 'plan')
  assert.equal(requests[0].context.toolCallId, 'call-1')
})

test('mode changes during remote selection invalidate the captured session policy', () => {
  const captured = {
    cwd: '/remote',
    cwdRealPath: '/remote',
    permissionMode: 'auto',
    workMode: 'plan_execute'
  } as PhiSessionManifest
  assert.equal(sameFacadeSessionPolicy({ ...captured }, captured), true)
  assert.equal(sameFacadeSessionPolicy({ ...captured, workMode: 'direct' }, captured), false)
  assert.equal(sameFacadeSessionPolicy({ ...captured, permissionMode: 'full' }, captured), false)
})

test('remote proposal uses only the active main run and trusted host identity', async () => {
  const run = {
    runId: 'run-1',
    sessionId: 'phi-1',
    signal: new AbortController().signal
  } as SessionRun
  let current: SessionRun | undefined = run
  const requests: Array<{ params: unknown; context: Record<string, unknown> }> = []
  const tool = createFacadePlanReviewTool({
    runtimeSessionId: 'runtime-1',
    phiSessionId: 'phi-1',
    host: {
      invoke: async (_method, params, context) => {
        requests.push({ params, context: context as Record<string, unknown> })
        return { decision: 'approve', planRunId: 'plan-1' }
      }
    },
    currentRun: () => current,
    assertCurrent: () => undefined
  })
  const context = { cwd: '/remote', recentUserImages: () => [] }
  const result = await tool.execute(
    'call-1',
    { ...spec, runtimeSessionId: 'forged', replanRequestId: 'forged' },
    undefined,
    context
  )
  assert.equal(result.isError, true)
  assert.equal(requests.length, 0)
  const approved = await tool.execute('call-2', spec, undefined, context)
  assert.equal(approved.details && (approved.details as { decision: string }).decision, 'approve')
  assert.equal((approved.details as { planRunId: string }).planRunId, 'plan-1')
  assert.deepEqual(requests[0].params, {
    runtimeSessionId: 'runtime-1',
    title: 'Finish E5',
    planContent:
      '# Finish E5\n\n## 1. Bridge (e5)\n\naccess: read · depends on: none · agent: PlanStep\n\nBuild the bridge.\n\nAcceptance: Tests pass.',
    planFilePath: 'local://PLAN.md',
    steps: spec
  })
  assert.equal(requests[0].context.originSessionId, 'runtime-1')
  assert.equal(requests[0].context.agentRunId, 'run-1')
  assert.equal(requests[0].context.toolCallId, 'call-2')
  assert.equal(requests[0].context.remoteOriginAuthenticated, true)
  assert.equal(requests[0].context.remotePlanPhase, 'plan_execute')
  current = undefined
  await assert.rejects(
    () => tool.execute('call-3', spec, undefined, context),
    /active Phi prompt run/
  )
})

test('auto plan phase requires a signed sole call and stays bound to its original run', async () => {
  const run = {
    runId: 'run-1',
    sessionId: 'phi-1',
    signal: new AbortController().signal
  } as SessionRun
  const successor = {
    runId: 'run-2',
    sessionId: 'phi-1',
    signal: new AbortController().signal
  } as SessionRun
  let current = run
  const calls: Array<{ method: string; context: Record<string, unknown> }> = []
  const tools = createFacadePlanReviewTools('auto', {
    runtimeSessionId: 'runtime-1',
    phiSessionId: 'phi-1',
    host: {
      invoke: async (method, _params, context) => {
        calls.push({ method, context: context as Record<string, unknown> })
        return method === 'workMode.selected'
          ? { ok: true, mode: 'plan_execute', reason: 'Independent steps' }
          : { decision: 'approve', planRunId: 'plan-1' }
      }
    },
    runners: { getActiveRun: () => current },
    submittedRun: () => current,
    assertCurrent: () => undefined,
    autoPlanEnabled: true,
    planExecutionEnabled: true,
    planDraftEnabled: true
  })
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['enter_plan_mode', 'propose_plan_steps', 'propose_plan_markdown']
  )
  const context = { cwd: '/remote', recentUserImages: () => [] }
  const enter = tools[0]!
  assert.equal(
    (
      await enter.execute(
        'call-0',
        { execute: true, reason: 'Independent steps' },
        undefined,
        context
      )
    ).isError,
    true
  )
  assert.equal(calls.length, 0)
  const selected = await enter.execute(
    'call-1',
    { execute: true, reason: 'Independent steps', soleCall: true },
    undefined,
    context
  )
  assert.deepEqual(selected.details, { decision: 'plan_execute', reason: 'Independent steps' })
  assert.equal(calls[0].context.agentRunId, 'run-1')
  await assert.rejects(
    () =>
      tools[2]!.execute(
        'call-2',
        { title: 'Draft', content: '# Draft', planFilePath: 'local://PLAN.md' },
        undefined,
        context
      ),
    /active Phi prompt run/
  )
  const approved = await tools[1]!.execute('call-3', spec, undefined, context)
  assert.deepEqual(
    approved.details && (approved.details as { decision: string; planRunId: string }).planRunId,
    'plan-1'
  )
  assert.equal(calls[1].context.remotePlanPhase, 'plan_execute')
  current = successor
  await assert.rejects(
    () => tools[1]!.execute('call-4', spec, undefined, context),
    /active Phi prompt run/
  )
})

test('structured approval without a started plan run fails closed', async () => {
  const run = {
    runId: 'run-1',
    sessionId: 'phi-1',
    signal: new AbortController().signal
  } as SessionRun
  const tool = createFacadePlanReviewTool({
    runtimeSessionId: 'runtime-1',
    phiSessionId: 'phi-1',
    host: { invoke: async () => ({ decision: 'approve' }) },
    currentRun: () => run,
    assertCurrent: () => undefined
  })
  const result = await tool.execute('call-1', spec, undefined, {
    cwd: '/remote',
    recentUserImages: () => []
  })
  assert.equal(result.isError, true)
  assert.equal(result.details, undefined)
})

test('proposal fails closed when active run changes before approval returns', async () => {
  const run = {
    runId: 'run-1',
    sessionId: 'phi-1',
    signal: new AbortController().signal
  } as SessionRun
  let current: SessionRun | undefined = run
  const tool = createFacadePlanReviewTool({
    runtimeSessionId: 'runtime-1',
    phiSessionId: 'phi-1',
    host: {
      invoke: async () => {
        current = undefined
        return { decision: 'approve' }
      }
    },
    currentRun: () => current,
    assertCurrent: () => undefined
  })
  await assert.rejects(
    () => tool.execute('call-1', spec, undefined, { cwd: '/remote', recentUserImages: () => [] }),
    /active Phi prompt run/
  )
})
