import type { ToolCallItem } from '../types'
import type { AgentExecutionStep } from './agentExecutionTypes'

/**
 * How one tool step of a delegated agent is shown inside its card: as an ordinary tool call,
 * folded to a single line. These are the rules for when that line is open.
 */

/**
 * `userChoice` is what the user last did to this row (`null`: nothing yet). Without a choice a
 * running step is open, so its output can be followed as it streams, and folds itself when it
 * finishes. A failed step stays open so the reason is in view. A finished one is folded.
 */
export function agentStepExpanded(
  step: Pick<AgentExecutionStep, 'status'>,
  userChoice: boolean | null
): boolean {
  if (userChoice !== null) return userChoice
  return step.status === 'running' || step.status === 'error'
}

export function stepAsToolCall(step: AgentExecutionStep): ToolCallItem {
  return {
    id: step.id,
    role: 'tool',
    toolName: step.toolName,
    argsPreview: step.argsPreview,
    argsJson: step.argsJson,
    output: step.output,
    status: step.status,
    ...(step.createdAt ? { createdAt: step.createdAt } : {}),
    ...(step.completedAt ? { completedAt: step.completedAt } : {}),
    ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
    ...(step.outputPath ? { outputPath: step.outputPath } : {}),
    ...(step.outputBytes !== undefined ? { outputBytes: step.outputBytes } : {}),
    ...(step.outputTruncated ? { outputTruncated: step.outputTruncated } : {}),
    ...(step.outputArtifact ? { outputArtifact: step.outputArtifact } : {})
  }
}

/** The tallest a step's arguments and output grow before the panel scrolls instead. */
export const AGENT_STEP_DETAIL_MAX_HEIGHT_PX = 320

const FOLLOW_THRESHOLD_PX = 24

/**
 * Whether a scrollable view is at its end, give or take a few pixels. A step's output that is
 * still streaming is followed only while the user has not scrolled up to read something.
 */
export function isScrolledToEnd(view: {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
}): boolean {
  return view.scrollHeight - view.scrollTop - view.clientHeight <= FOLLOW_THRESHOLD_PX
}
