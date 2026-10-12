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
}

type PlanToolResult = {
  content: Array<{ type: 'text'; text: string }>
  details: { title: string; planFilePath: string; planExists: true; decision: PlanReviewDecision }
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

const PLAN_TOOLS = new Set(['read', 'glob', 'grep', 'write', 'edit', 'todo', 'ask_user_question'])

/** Return false when this session is already waiting in plan mode. */
export async function enterPlanReviewMode(
  session: PlanReviewSession,
  resolveProposal: (title: string, planFilePath: string) => Promise<PlanReviewProposal>,
  requestDecision: (proposal: PlanReviewProposal) => Promise<PlanReviewChoice>
): Promise<boolean> {
  if (session.getPlanModeState()?.enabled) return false
  if (!session.hasBuiltInTool('write'))
    throw new Error('Plan mode requires the built-in write tool')
  const previousTools = session.getActiveToolNames()
  const planTools = [...new Set([...previousTools.filter((name) => PLAN_TOOLS.has(name)), 'write'])]
  const previousState = session.getPlanModeState()
  session.setPlanModeState({ enabled: true, planFilePath: 'local://PLAN.md', workflow: 'parallel' })
  try {
    await session.setActiveToolsByName(planTools)
  } catch (error) {
    session.setPlanModeState(previousState)
    throw error
  }

  session.setPlanProposalHandler(async (title) => {
    const state = session.getPlanModeState()
    if (!state?.enabled) throw new Error('Plan mode is not active')
    const proposal = await resolveProposal(title, state.planFilePath)
    const choice = await requestDecision(proposal)
    if (choice.decision === 'cancel') {
      await session.setActiveToolsByName(previousTools)
      session.setPlanProposalHandler(null)
      session.setPlanModeState(undefined)
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
      await session.setActiveToolsByName(previousTools)
      session.setPlanReferencePath(proposal.planFilePath)
      session.setPlanProposalHandler(null)
      session.setPlanModeState(undefined)
      return {
        content: [
          { type: 'text', text: 'Plan approved. Plan mode exited; proceed with implementation.' }
        ],
        details: { ...proposal, planExists: true, decision: 'approve' }
      }
    }
    session.setPlanModeState({ ...state, planFilePath: proposal.planFilePath })
    const note = choice.note?.trim()
    const instruction = `Plan refinement requested.${note ? ` User feedback: ${note}` : ''} Update the plan and submit it again through xd://propose.`
    return {
      content: [{ type: 'text', text: instruction }],
      details: { ...proposal, planExists: true, decision: choice.decision }
    }
  })
  return true
}
