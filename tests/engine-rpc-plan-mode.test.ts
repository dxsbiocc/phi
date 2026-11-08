import assert from 'node:assert/strict'
import test from 'node:test'

import {
  rpcManualPlanDraftRead,
  rpcPlanningToolDecision
} from '../src/main/agent/engine/phi-extension/lib/rpc-prompt-policy'
import { rpcWorkModePrompt } from '../src/main/agent/engine/phi-extension/lib/rpc-plan-prompt'
import {
  assertRpcPlanDraftMutationTarget,
  bindRpcMarkdownPlanProposal,
  rpcMarkdownPlanProposal,
  RPC_PLAN_DRAFT_MAX_BYTES
} from '../src/main/agent/engine/phi-extension/lib/rpc-plan-draft'
import { executionInput } from '../src/main/agent/engine/phi-extension/lib/rpc-execution-protocol'

test('remote plan review permits only reads and its local proposal draft', () => {
  for (const name of ['read', 'glob', 'grep', 'todo']) {
    assert.equal(rpcPlanningToolDecision('plan', name, {}).allowed, true)
  }
  assert.equal(rpcPlanningToolDecision('plan', 'write', { path: 'local://PLAN.md' }).allowed, true)
  assert.equal(rpcManualPlanDraftRead('plan', { path: 'local://PLAN.md' }), true)
  assert.equal(rpcManualPlanDraftRead('auto', { path: 'local://PLAN.md' }), false)
  assert.equal(rpcManualPlanDraftRead('plan', { path: 'local://other.md' }), false)
  assert.equal(rpcManualPlanDraftRead('plan', { path: 'local://PLAN.md', i: '1-10' }), false)
  assert.equal(rpcPlanningToolDecision('plan', 'edit', { path: 'local://PLAN.md' }).allowed, true)
  assert.equal(
    rpcPlanningToolDecision('plan', 'propose_plan_markdown', { title: 'Plan' }).allowed,
    false
  )
  assert.equal(
    rpcPlanningToolDecision('plan', 'propose_plan_markdown', { title: 'Plan' }, true).allowed,
    true
  )
  for (const [name, input] of [
    ['bash', { command: 'git status' }],
    ['write', { path: 'src/file.ts' }],
    ['write', { path: 'xd://unrelated' }],
    ['write', { path: 'xd://propose' }],
    ['write', { path: 'local://notes.md' }],
    ['write', { path: '[local://PLAN.md#ABCD]' }],
    ['edit', { path: 'local://notes.md' }],
    ['edit', { path: 'local://PLAN.md', _path: '../outside.md' }],
    ['write', { path: 'local://PLAN.md', file_path: '../outside.md' }],
    ['task', { agent: 'PlanStep' }]
  ] as const) {
    assert.equal(rpcPlanningToolDecision('plan', name, input).allowed, false)
  }
})

test('manual proposal reads only the current session draft and ignores model paths and content', async (t) => {
  const { mkdtemp, mkdir, realpath, writeFile, rm, symlink } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-rpc-plan-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const session = { getArtifactsDir: () => root, getSessionId: () => 'owned-session' }
  const local = join(root, 'local')
  await mkdir(local)
  await writeFile(join(local, 'PLAN.md'), '# Review this plan\n')
  assert.doesNotThrow(() => assertRpcPlanDraftMutationTarget(session))
  assert.deepEqual(rpcMarkdownPlanProposal(session, { title: 'Review plan' }), {
    title: 'Review plan',
    content: '# Review this plan\n',
    planFilePath: 'local://PLAN.md'
  })
  const modelInput: Record<string, unknown> = { title: 'Review plan' }
  const bound = bindRpcMarkdownPlanProposal(session, modelInput)
  assert.deepEqual(modelInput, bound)
  const signedInput = executionInput(
    {
      name: 'propose_plan_markdown',
      site: 'host',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          content: { type: 'string' },
          planFilePath: { type: 'string' }
        }
      }
    },
    modelInput
  )
  assert.deepEqual(signedInput, bound)
  assert.throws(() => bindRpcMarkdownPlanProposal(session, Object.freeze({ title: 'Review plan' })))
  for (const input of [
    { title: 'Review plan', content: 'replacement' },
    { title: 'Review plan', planFilePath: 'local://other.md' },
    { title: 'bad\ntitle' },
    { title: '' }
  ])
    assert.throws(() => rpcMarkdownPlanProposal(session, input))
  await writeFile(join(local, 'PLAN.md'), 'x'.repeat(RPC_PLAN_DRAFT_MAX_BYTES + 1))
  assert.throws(() => rpcMarkdownPlanProposal(session, { title: 'Review plan' }))
  await rm(join(local, 'PLAN.md'))
  await writeFile(join(root, 'outside.md'), 'Outside content')
  await symlink(join(root, 'outside.md'), join(local, 'PLAN.md'))
  assert.throws(() => assertRpcPlanDraftMutationTarget(session))
  assert.throws(() => rpcMarkdownPlanProposal(session, { title: 'Review plan' }))
  await rm(local, { recursive: true })
  assert.doesNotThrow(() => assertRpcPlanDraftMutationTarget(session))
  await symlink(root, local)
  assert.throws(() => assertRpcPlanDraftMutationTarget(session))
  assert.throws(() => rpcMarkdownPlanProposal(session, { title: 'Review plan' }))
  assert.throws(() =>
    rpcMarkdownPlanProposal({ getArtifactsDir: () => null }, { title: 'Review plan' })
  )
})

test('remote mode guidance appears only with the matching authenticated host tool', () => {
  assert.equal(rpcWorkModePrompt('auto', [], []), undefined)
  assert.equal(rpcWorkModePrompt('auto', ['enter_plan_mode'], []), undefined)
  assert.match(
    rpcWorkModePrompt('auto', ['enter_plan_mode'], ['enter_plan_mode'])!,
    /alone with execute=false/
  )
  assert.equal(
    rpcWorkModePrompt('direct', ['propose_plan_markdown'], ['propose_plan_markdown']),
    undefined
  )
  assert.equal(rpcWorkModePrompt('plan', ['propose_plan_markdown'], []), undefined)
  assert.match(
    rpcWorkModePrompt('plan', ['propose_plan_markdown'], ['propose_plan_markdown'])!,
    /local:\/\/PLAN\.md/
  )
  const planExecute = rpcWorkModePrompt(
    'plan_execute',
    ['propose_plan_steps'],
    ['propose_plan_steps']
  )!
  assert.match(planExecute, /propose_plan_steps/)
  assert.doesNotMatch(planExecute, /xd:\/\/propose/)
  assert.doesNotMatch(planExecute, /local:\/\//)
})

test('remote structured planning cannot write a draft or dispatch a child', () => {
  for (const name of ['read', 'glob', 'grep', 'propose_plan_steps']) {
    assert.equal(rpcPlanningToolDecision('plan_execute', name, {}).allowed, true)
  }
  for (const [name, input] of [
    ['write', { path: 'local://PLAN.md' }],
    ['write', { path: 'xd://propose' }],
    ['edit', { path: 'local://PLAN.md' }],
    ['bash', { command: 'echo unsafe' }],
    ['task', { agent: 'PlanStep' }]
  ] as const) {
    assert.equal(rpcPlanningToolDecision('plan_execute', name, input).allowed, false)
  }
})
