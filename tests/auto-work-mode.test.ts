import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createAutoWorkModeExtension,
  createMainSessionExtensions,
  type PhiExtensionConfig,
  type PhiExtensionHost
} from '../src/main/agent/engine/phi-extension'
import {
  enterPlanReviewMode,
  type PlanReviewSession,
  type PlanStepsToolResult
} from '../src/main/agent/plan/plan-review-mode'

type TestSession = PlanReviewSession & {
  activeTools: string[]
  stepsHandler: ((input: unknown) => Promise<PlanStepsToolResult>) | null
}

function session(): TestSession {
  let state: ReturnType<PlanReviewSession['getPlanModeState']>
  return {
    activeTools: ['read', 'glob', 'grep', 'bash', 'write', 'edit', 'todo', 'enter_plan_mode'],
    stepsHandler: null,
    getPlanModeState: () => state,
    setPlanModeState: (next) => {
      state = next
    },
    getActiveToolNames() {
      return [...this.activeTools]
    },
    hasBuiltInTool: (name) => name === 'write',
    async setActiveToolsByName(names) {
      this.activeTools = [...names]
    },
    setPlanProposalHandler: () => undefined,
    setPlanReferencePath: () => undefined
  }
}

function baseHost(overrides: Partial<PhiExtensionHost> = {}): PhiExtensionHost {
  return {
    nextActionSuggestionsEnabled: async () => false,
    planModeActive: () => false,
    planExecuteModeActive: () => false,
    proposePlanSteps: async () => ({ content: [] }),
    requestToolApproval: async () => undefined,
    browserApprovalInput: (_id, input) => input,
    markBrowserTextDenied: () => undefined,
    fallbackReadiness: () => ({ allowed: true, failures: 0 }),
    environmentBinding: () => undefined,
    hostEnvironment: () => ({}),
    ...overrides
  }
}

async function registeredAutoTool(
  host: PhiExtensionHost,
  siblingTool?: string
): Promise<Record<string, unknown>> {
  let tool: Record<string, unknown> | undefined
  let assistantMessage: ((event: Record<string, unknown>) => unknown) | undefined
  await createAutoWorkModeExtension(host)({
    on: (event: string, handler: (event: Record<string, unknown>) => unknown) => {
      if (event === 'assistant_message') assistantMessage = handler
    },
    registerTool: (definition: Record<string, unknown>) => {
      tool = definition
    }
  } as never)
  assert.ok(tool)
  assert.ok(assistantMessage)
  await assistantMessage({
    message: {
      content: [
        { type: 'toolCall', id: 'call-1', name: 'enter_plan_mode', arguments: {} },
        ...(siblingTool
          ? [{ type: 'toolCall', id: 'call-2', name: siblingTool, arguments: {} }]
          : [])
      ]
    }
  })
  return tool
}

async function enterFromTool(execute: boolean): Promise<{
  activeTools: string[]
  state: ReturnType<PlanReviewSession['getPlanModeState']>
  selected: Array<{ execute: boolean; reason: string }>
  result: Record<string, unknown>
}> {
  const current = session()
  const selected: Array<{ execute: boolean; reason: string }> = []
  const host = baseHost({
    planModeActive: () => current.getPlanModeState()?.enabled === true,
    enterAutoPlanMode: async (input) => {
      await enterPlanReviewMode(
        current,
        async () => ({ title: 'plan', content: '# Plan', planFilePath: 'local://PLAN.md' }),
        async () => ({ decision: 'approve' }),
        {
          execute: input.execute,
          reviewSteps: async () => ({ ok: false, errors: ['not submitted'] }),
          setProposalHandler: (handler) => {
            current.stepsHandler = handler
          }
        }
      )
      selected.push(input)
    }
  })
  const tool = await registeredAutoTool(host)
  const run = tool.execute as (id: string, input: unknown) => Promise<Record<string, unknown>>
  const result = await run('call-1', { execute, reason: '任务范围较大' })
  return { activeTools: current.activeTools, state: current.getPlanModeState(), selected, result }
}

test('enter_plan_mode switches the current turn to plan review and records its reason', async () => {
  const result = await enterFromTool(false)
  assert.deepEqual(result.activeTools, ['read', 'glob', 'grep', 'write', 'edit', 'todo'])
  assert.equal(result.state?.execute, undefined)
  assert.deepEqual(result.selected, [{ execute: false, reason: '任务范围较大' }])
  assert.match(JSON.stringify(result.result), /xd:\/\/propose/)
})

test('automatic plan execution activates propose_plan_steps in the next model call', async () => {
  const result = await enterFromTool(true)
  assert.deepEqual(result.activeTools, [
    'read',
    'glob',
    'grep',
    'write',
    'edit',
    'todo',
    'propose_plan_steps'
  ])
  assert.equal(result.state?.execute, true)
  assert.match(JSON.stringify(result.result), /propose_plan_steps/)
})

test('enter_plan_mode is mounted only for automatic main sessions', async () => {
  const config = (workMode: PhiExtensionConfig['workMode']): PhiExtensionConfig => ({
    cwd: '/work',
    projectBound: false,
    enableToolApproval: false,
    sessionId: 'session-1',
    useBrowserTextVault: false,
    workMode,
    phiAgents: []
  })
  const registered = async (workMode: PhiExtensionConfig['workMode']): Promise<string[]> => {
    const names: string[] = []
    const pi = {
      on: () => undefined,
      getAllTools: () => [],
      registerTool: (definition: { name: string }) => names.push(definition.name)
    }
    for (const factory of createMainSessionExtensions(config(workMode), baseHost())) {
      await factory(pi as never)
    }
    return names
  }
  assert.deepEqual(await registered('auto'), ['enter_plan_mode'])
  for (const mode of ['direct', 'plan', 'plan_execute'] as const) {
    assert.deepEqual(await registered(mode), [])
  }
})

test('enter_plan_mode rejects re-entry and overlong reasons', async () => {
  const tool = await registeredAutoTool(baseHost({ planModeActive: () => true }))
  const run = tool.execute as (id: string, input: unknown) => Promise<Record<string, unknown>>
  assert.equal((await run('call-1', { execute: false, reason: 'again' })).isError, true)
  const available = await registeredAutoTool(baseHost({ enterAutoPlanMode: async () => undefined }))
  const execute = available.execute as (
    id: string,
    input: unknown
  ) => Promise<Record<string, unknown>>
  assert.equal((await execute('call-1', { execute: false, reason: 'x'.repeat(201) })).isError, true)
})

test('enter_plan_mode cannot activate when the assistant batches a sibling tool call', async () => {
  let entered = false
  const tool = await registeredAutoTool(
    baseHost({
      enterAutoPlanMode: async () => {
        entered = true
      }
    }),
    'write'
  )
  const execute = tool.execute as (id: string, input: unknown) => Promise<Record<string, unknown>>
  const result = await execute('call-1', { execute: true, reason: 'large task' })
  assert.equal(result.isError, true)
  assert.match(JSON.stringify(result), /only tool call/)
  assert.equal(entered, false)
})
