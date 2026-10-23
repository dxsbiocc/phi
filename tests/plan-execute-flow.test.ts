import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentRunCompletion } from '../src/main/agent/plan/execution/agent-run-completions'
import {
  createPlanStepsExtension,
  type PhiExtensionHost
} from '../src/main/agent/engine/phi-extension'
import { createPlanReviewRequest } from '../src/main/agent/host-requests/plan-review-request'
import {
  enterPlanReviewMode,
  PLAN_STEPS_TOOL_NAME,
  type PlanReviewSession,
  type PlanStepsToolResult
} from '../src/main/agent/plan/plan-review-mode'
import { createPlanRunService } from '../src/main/agent/plan/plan-run-service'
import { validatePlanSpec } from '../src/main/agent/plan/model/plan-spec'
import type {
  PlanRunFinishedEvent,
  PlanRunState,
  PlanSpec,
  PlanStep
} from '../src/shared/planRunTypes'

interface FakeSession extends PlanReviewSession {
  activeTools: string[]
  structured: ((input: unknown) => Promise<PlanStepsToolResult>) | null
}

function fakeSession(): FakeSession {
  let state: ReturnType<PlanReviewSession['getPlanModeState']>
  return {
    activeTools: ['read', 'glob', 'grep', 'write', 'edit', 'bash'],
    structured: null,
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

function diamondPlan(): PlanSpec {
  const step = (id: string, dependsOn: string[]): PlanStep => ({
    id,
    title: `Step ${id}`,
    instructions: `Complete ${id}`,
    acceptance: `${id} is complete`,
    dependsOn,
    access: 'read' as const
  })
  return {
    version: 1,
    goal: 'Complete a diamond dependency plan',
    steps: [step('a', []), step('b', ['a']), step('c', ['a']), step('d', ['b', 'c'])]
  }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.fail('Timed out waiting for plan execution')
}

test('planExecute validates, reviews, executes a diamond and wakes the main agent', async () => {
  const persisted = new Map<string, PlanRunState>()
  const timeline: string[] = []
  const started: string[] = []
  const waiters = new Map<string, (run: AgentRunCompletion) => void>()
  const wakes: PlanRunFinishedEvent[] = []
  let runSequence = 0
  const service = createPlanRunService({
    engine: {
      agentRuns: {
        async start() {
          const runId = `agent-${++runSequence}`
          started.push(runId)
          return { runId }
        },
        async stop() {
          return undefined
        }
      }
    },
    completions: {
      expect: (_runtimeSessionId, runId) =>
        new Promise((resolve) => {
          waiters.set(runId, resolve)
        }),
      deliver: (_runtimeSessionId, run) => {
        const resolve = waiters.get(run.id)
        if (!resolve) return false
        waiters.delete(run.id)
        resolve(run)
        return true
      },
      abandonSession: () => undefined
    },
    resolveRuntimeSessionId: () => 'runtime-1',
    store: {
      write: (state) => {
        persisted.set(state.id, state)
      },
      read: (_sessionId, runId) => persisted.get(runId) ?? null,
      list: () => [...persisted.values()],
      listUnfinished: () => []
    },
    timeline: {
      append: (_sessionId, event) => {
        timeline.push(event.type)
        return event
      },
      broadcast: () => undefined
    },
    continueConversation: (_sessionId, event) => wakes.push(event),
    logError: (error) => assert.fail(String(error)),
    ids: () => 'plan-1',
    clock: (() => {
      let tick = 0
      return () => new Date(Date.UTC(2026, 9, 23, 0, 0, tick++)).toISOString()
    })()
  })
  const session = fakeSession()
  const review = createPlanReviewRequest({
    fields: {
      optionalStringField: (record, key) =>
        typeof record[key] === 'string' ? record[key].trim() : undefined
    },
    runs: {
      findByRuntimeSessionId: (runtimeSessionId) =>
        runtimeSessionId === 'runtime-1'
          ? {
              phiSessionId: 'phi-1',
              runId: 'prompt-1',
              cwd: '/workspace',
              sessionGeneration: 1,
              cancelled: false
            }
          : null
    },
    projects: { getById: () => undefined },
    sessions: {
      findById: () => ({ projectLocation: { kind: 'local' } }),
      sessionPath: () => 'phi-session:phi-1'
    },
    renderer: {
      getActiveWindow: () => ({}) as never,
      canRequest: (window): window is NonNullable<typeof window> => Boolean(window),
      waitForResponse: async () =>
        ({ answers: [{ question: 'plan_review', answer: 'approve' }] }) as never
    },
    timeline: {
      append: (_sessionId, event) => {
        timeline.push(event.type)
        return event
      },
      broadcast: () => undefined
    },
    state: {
      createId: () => 'review-1',
      markNeedsInput: () => undefined,
      markInputCancelled: () => undefined,
      markInputAnswered: () => undefined,
      notifySessionChanged: () => undefined
    },
    planRuns: service
  })
  await enterPlanReviewMode(
    session,
    async () => ({ title: 'unused', content: 'unused', planFilePath: 'local://PLAN.md' }),
    async () => ({ decision: 'approve' }),
    {
      execute: true,
      setProposalHandler: (handler) => {
        session.structured = handler
      },
      reviewSteps: async (input) => {
        const validated = validatePlanSpec(input)
        if (!validated.ok) return validated
        const choice = await review({
          runtimeSessionId: 'runtime-1',
          title: 'Diamond plan',
          planContent: '# Diamond plan',
          planFilePath: 'local://PLAN.md',
          steps: validated.spec
        })
        return { ok: true, spec: validated.spec, choice }
      }
    }
  )

  const extensionHost: PhiExtensionHost = {
    nextActionSuggestionsEnabled: async () => false,
    planModeActive: () => session.getPlanModeState()?.enabled === true,
    planExecuteModeActive: () => session.getPlanModeState()?.execute === true,
    proposePlanSteps: async (input) => {
      if (!session.structured) throw new Error('Structured plan handler is missing')
      return session.structured(input)
    },
    requestToolApproval: async () => undefined,
    browserApprovalInput: (_toolCallId, input) => input,
    markBrowserTextDenied: () => undefined,
    fallbackReadiness: () => ({ allowed: true, failures: 0 }),
    environmentBinding: () => undefined,
    hostEnvironment: () => ({})
  }
  let executePlanTool:
    ((toolCallId: string, input: unknown) => Promise<PlanStepsToolResult>) | undefined
  await createPlanStepsExtension(extensionHost)({
    registerTool: (definition: {
      execute(toolCallId: string, input: unknown): Promise<PlanStepsToolResult>
    }) => {
      executePlanTool = (toolCallId, input) => definition.execute(toolCallId, input)
    }
  } as never)

  assert.equal(session.getPlanModeState()?.execute, true)
  assert.ok(session.activeTools.includes(PLAN_STEPS_TOOL_NAME))
  assert.ok(executePlanTool)
  const invalid = await executePlanTool('invalid-plan', { version: 1, goal: 'bad', steps: [] })
  assert.equal(invalid.isError, true)
  assert.match(invalid.content[0]?.text ?? '', /between 1 and 20 steps/)

  const approved = await executePlanTool('approved-plan', diamondPlan())
  assert.match(approved.content[0]?.text ?? '', /handed to Phi/)
  assert.equal(session.getPlanModeState(), undefined)
  assert.deepEqual(started, ['agent-1'])

  const complete = (runId: string, report: string): void => {
    const resolve = waiters.get(runId)
    assert.ok(resolve, `missing completion waiter for ${runId}`)
    waiters.delete(runId)
    resolve({ id: runId, state: 'done', origin: 'host', report })
  }
  complete('agent-1', 'A complete')
  await until(() => started.length === 3)
  assert.deepEqual(started, ['agent-1', 'agent-2', 'agent-3'])
  complete('agent-2', 'B complete')
  complete('agent-3', 'C complete')
  await until(() => started.length === 4)
  complete('agent-4', 'D complete')
  await until(() => wakes.length === 1)

  assert.equal(wakes[0]?.state.status, 'completed')
  assert.deepEqual(
    diamondPlan().steps.map((step) => wakes[0]?.state.steps[step.id]?.status),
    ['done', 'done', 'done', 'done']
  )
  assert.equal(timeline[0], 'plan_review_submitted')
  assert.ok(timeline.includes('plan_review_decided'))
  assert.equal(timeline.at(-1), 'plan_run_finished')
  assert.ok(
    timeline
      .filter((type) => type.startsWith('plan_run_'))
      .slice(0, -1)
      .every((type) => type === 'plan_run_updated')
  )
  assert.equal(timeline.filter((type) => type === 'plan_run_finished').length, 1)
})
