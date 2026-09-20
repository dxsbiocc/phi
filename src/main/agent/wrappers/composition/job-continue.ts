import type {
  WrapperRunEndState,
  WrapperRunFinishedEvent
} from '../../../../shared/wrapperRunNotice'
import type { WrapperRun } from '../types'

/**
 * When a background run ends, Phi can wake the conversation that started it so
 * the agent continues with the results without the user asking. This module is
 * the policy (should we?) and the message (what does the model read?); the
 * plumbing that actually submits the prompt lives in the main process.
 */

/**
 * How many times in a row Phi may wake one conversation on its own before a real
 * user message is needed. An agent that keeps starting a run whenever it is woken
 * would otherwise loop for as long as runs keep ending.
 */
export const MAX_AUTOMATIC_CONTINUATIONS = 5

export type ContinueDecision =
  { continue: true } | { continue: false; reason: 'disabled' | 'cancelled' | 'limit' }

export function shouldContinueConversation(input: {
  run: WrapperRun
  state: WrapperRunEndState
  /** Automatic wake-ups since the user last wrote in this conversation. */
  automaticCount: number
}): ContinueDecision {
  if (input.run.continueWhenDone === false) return { continue: false, reason: 'disabled' }
  // A cancel is the user's own doing; there is nothing new for the agent to react to.
  if (input.state === 'cancelled') return { continue: false, reason: 'cancelled' }
  if (input.automaticCount >= MAX_AUTOMATIC_CONTINUATIONS)
    return { continue: false, reason: 'limit' }
  return { continue: true }
}

/** English, because the model reads this message (the user-facing notice is Chinese). */
function elapsed(seconds: number): string {
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} m ${seconds % 60} s`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} m`
}

function describe(event: WrapperRunFinishedEvent): string {
  const lines = [
    `- Run ${event.wrapperRunId} · ${event.wrapperId} · ${event.state}${
      event.exitCode !== undefined ? ` (exit ${event.exitCode})` : ''
    } · took ${elapsed(event.elapsedSeconds)}`
  ]
  if (event.outDir) lines.push(`  Output directory: ${event.outDir}`)
  if (event.missingOutputs && event.missingOutputs.length > 0) {
    lines.push(`  Ended without the expected output(s): ${event.missingOutputs.join(', ')}`)
  }
  return lines.join('\n')
}

/** The synthetic message the model receives; it is never shown to the user as their own words. */
export function wrapperRunContinuationPrompt(events: readonly WrapperRunFinishedEvent[]): string {
  const anyFailed = events.some((event) => event.state === 'failed')
  return [
    '<phi_wrapper_run_finished>',
    `This message is from Phi, not from the user. ${
      events.length === 1 ? 'A background wrapper run' : 'Background wrapper runs'
    } you had Wrapper start ${events.length === 1 ? 'has' : 'have'} ended:`,
    ...events.map(describe),
    'Continue with what the user asked for, using these results.',
    ...(anyFailed
      ? [
          'For a failed run, say why (Wrapper can report the log for its run id) and propose the next step. Do not start it again unless the user asked for retries.'
        ]
      : []),
    'Reply in the language the user has been using.',
    '</phi_wrapper_run_finished>'
  ].join('\n')
}
