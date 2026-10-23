import type { PlanSpec } from '../../../shared/planRunTypes'

export type PlanReviewDecision = 'approve' | 'revise' | 'cancel'

export type PlanReviewProposal = {
  title: string
  content: string
  planFilePath: string
}

export type PlanReviewChoice = {
  decision: PlanReviewDecision
  note?: string
}

type PlanModeState = {
  enabled: boolean
  planFilePath: string
  workflow?: 'parallel' | 'iterative'
  reentry?: boolean
  execute?: boolean
}

type PlanToolResult = {
  content: Array<{ type: 'text'; text: string }>
  details: { title: string; planFilePath: string; planExists: true; decision: PlanReviewDecision }
}

export type PlanStepsToolResult = {
  content: Array<{ type: 'text'; text: string }>
  details?: {
    decision?: PlanReviewDecision
    plan?: PlanSpec
    validationErrors?: string[]
  }
  isError?: boolean
}

export type PlanStepsReviewResult =
  | { ok: false; errors: string[] }
  | {
      ok: true
      spec: PlanSpec
      choice: PlanReviewChoice
    }

export interface PlanExecuteModeOptions {
  execute?: boolean
  reviewSteps?: (input: unknown) => Promise<PlanStepsReviewResult>
  setProposalHandler?: (handler: ((input: unknown) => Promise<PlanStepsToolResult>) | null) => void
}

export type PlanReviewSession = {
  getPlanModeState: () => PlanModeState | undefined
  setPlanModeState: (state: PlanModeState | undefined) => void
  getActiveToolNames: () => string[]
  hasBuiltInTool: (name: string) => boolean
  setActiveToolsByName: (names: string[]) => Promise<void>
  setPlanProposalHandler: (handler: ((title: string) => Promise<PlanToolResult>) | null) => void
  setPlanReferencePath: (path: string) => void
}

export const PLAN_STEPS_TOOL_NAME = 'propose_plan_steps'
const PLAN_TOOLS = new Set([
  'read',
  'glob',
  'grep',
  'write',
  'edit',
  'todo',
  'ask_user_question',
  PLAN_STEPS_TOOL_NAME
])

async function leavePlanMode(
  session: PlanReviewSession,
  previousTools: string[],
  options: PlanExecuteModeOptions
): Promise<void> {
  await session.setActiveToolsByName(previousTools)
  session.setPlanProposalHandler(null)
  options.setProposalHandler?.(null)
  session.setPlanModeState(undefined)
}

function revisionInstruction(choice: PlanReviewChoice, target: string): string {
  const note = choice.note?.trim()
  return `Plan refinement requested.${note ? ` User feedback: ${note}` : ''} ${target}`
}

function installStructuredProposalHandler(
  session: PlanReviewSession,
  previousTools: string[],
  options: PlanExecuteModeOptions
): void {
  if (!options.reviewSteps || !options.setProposalHandler) {
    throw new Error('Plan execution mode requires a structured proposal handler')
  }
  const reviewSteps = options.reviewSteps
  options.setProposalHandler(async (input) => {
    const reviewed = await reviewSteps(input)
    if (!reviewed.ok) {
      return {
        content: [{ type: 'text', text: reviewed.errors.join('\n') }],
        details: { validationErrors: [...reviewed.errors] },
        isError: true
      }
    }
    if (reviewed.choice.decision === 'revise') {
      return {
        content: [
          {
            type: 'text',
            text: revisionInstruction(
              reviewed.choice,
              'Submit a corrected structured plan through propose_plan_steps.'
            )
          }
        ],
        details: { decision: 'revise', plan: reviewed.spec }
      }
    }
    await leavePlanMode(session, previousTools, options)
    const approved = reviewed.choice.decision === 'approve'
    return {
      content: [
        {
          type: 'text',
          text: approved
            ? 'Plan approved. Execution has been handed to Phi. End this turn now and do not implement any plan step yourself.'
            : 'Plan execution cancelled. Do not implement; wait for a new user request.'
        }
      ],
      details: { decision: reviewed.choice.decision, plan: reviewed.spec }
    }
  })
}

function executeMarkdownResult(title: string, planFilePath: string): PlanToolResult {
  return {
    content: [
      {
        type: 'text',
        text: 'This session requires a structured plan. Submit it through propose_plan_steps.'
      }
    ],
    details: { title, planFilePath, planExists: true, decision: 'revise' }
  }
}

async function applyMarkdownDecision(
  session: PlanReviewSession,
  proposal: PlanReviewProposal,
  choice: PlanReviewChoice,
  previousTools: string[],
  options: PlanExecuteModeOptions
): Promise<PlanToolResult> {
  if (choice.decision === 'cancel') {
    await leavePlanMode(session, previousTools, options)
    return {
      content: [
        {
          type: 'text',
          text: 'Plan review cancelled. Do not implement; wait for a new user request.'
        }
      ],
      details: { ...proposal, planExists: true, decision: 'cancel' }
    }
  }
  if (choice.decision === 'approve') {
    await leavePlanMode(session, previousTools, options)
    session.setPlanReferencePath(proposal.planFilePath)
    return {
      content: [
        { type: 'text', text: 'Plan approved. Plan mode exited; proceed with implementation.' }
      ],
      details: { ...proposal, planExists: true, decision: 'approve' }
    }
  }
  const state = session.getPlanModeState()
  if (state?.enabled) session.setPlanModeState({ ...state, planFilePath: proposal.planFilePath })
  return {
    content: [
      {
        type: 'text',
        text: revisionInstruction(
          choice,
          'Update the plan and submit it again through xd://propose.'
        )
      }
    ],
    details: { ...proposal, planExists: true, decision: 'revise' }
  }
}

function installMarkdownProposalHandler(
  session: PlanReviewSession,
  previousTools: string[],
  resolveProposal: (title: string, planFilePath: string) => Promise<PlanReviewProposal>,
  requestDecision: (proposal: PlanReviewProposal) => Promise<PlanReviewChoice>,
  options: PlanExecuteModeOptions
): void {
  session.setPlanProposalHandler(async (title) => {
    const state = session.getPlanModeState()
    if (!state?.enabled) throw new Error('Plan mode is not active')
    if (state.execute) return executeMarkdownResult(title, state.planFilePath)
    const proposal = await resolveProposal(title, state.planFilePath)
    return applyMarkdownDecision(
      session,
      proposal,
      await requestDecision(proposal),
      previousTools,
      options
    )
  })
}

/** Return false when this session is already waiting in plan mode. */
export async function enterPlanReviewMode(
  session: PlanReviewSession,
  resolveProposal: (title: string, planFilePath: string) => Promise<PlanReviewProposal>,
  requestDecision: (proposal: PlanReviewProposal) => Promise<PlanReviewChoice>,
  options: PlanExecuteModeOptions = {}
): Promise<boolean> {
  if (session.getPlanModeState()?.enabled) return false
  if (!session.hasBuiltInTool('write'))
    throw new Error('Plan mode requires the built-in write tool')
  if (options.execute && (!options.reviewSteps || !options.setProposalHandler)) {
    throw new Error('Plan execution mode requires a structured proposal handler')
  }
  const previousTools = session.getActiveToolNames()
  const planTools = [
    ...new Set([
      ...previousTools.filter((name) => PLAN_TOOLS.has(name)),
      'write',
      ...(options.execute ? [PLAN_STEPS_TOOL_NAME] : [])
    ])
  ]
  const previousState = session.getPlanModeState()
  session.setPlanModeState({
    enabled: true,
    planFilePath: 'local://PLAN.md',
    workflow: 'parallel',
    ...(options.execute ? { execute: true } : {})
  })
  try {
    await session.setActiveToolsByName(planTools)
  } catch (error) {
    session.setPlanModeState(previousState)
    throw error
  }

  if (options.execute) installStructuredProposalHandler(session, previousTools, options)
  installMarkdownProposalHandler(session, previousTools, resolveProposal, requestDecision, options)
  return true
}
