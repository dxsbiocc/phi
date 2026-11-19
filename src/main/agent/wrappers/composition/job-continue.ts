import { restoreResearchQc } from './research-qc'
import type {
  WrapperRunEndState,
  WrapperRunFinishedEvent
} from '../../../../shared/wrapperRunNotice'
import type { WrapperRun } from '../types'
import { isResearchQcGated, researchQcSummaryLine } from '../../../../shared/wrapperResearchQcTypes'

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
  if (event.researchQc) {
    lines.push(`  ${researchQcSummaryLine(event.researchQc)}`)
  } else if (event.researchQcExpected) {
    lines.push(
      '  Research QC was declared but not verified by Phi; do not claim these results are QC-verified.'
    )
  }
  return lines.join('\n')
}

/** The synthetic message the model receives; it is never shown to the user as their own words. */
export function wrapperRunContinuationPrompt(input: readonly WrapperRunFinishedEvent[]): string {
  const events = input.map((event) => {
    if (event.researchQc === undefined) return event
    const researchQc = restoreResearchQc(event.researchQc)
    const state =
      event.state === 'completed' &&
      (researchQc.disposition === 'invalid' || researchQc.disposition === 'needs_input')
        ? ('failed' as const)
        : event.state
    return { ...event, state, researchQc }
  })
  const plainFailed = events.some((event) => event.state === 'failed' && !isResearchQcGated(event))
  const anyNeedsInput = events.some((event) => event.researchQc?.disposition === 'needs_input')
  const qcFailed = events.some(
    (event) =>
      event.state === 'failed' &&
      isResearchQcGated(event) &&
      event.researchQc?.disposition !== 'needs_input'
  )
  const anyQcVerdict = events.some((event) => event.researchQc !== undefined)
  const anySkip = events.some((event) => event.researchQc?.disposition === 'skip')
  const allQcInvalid =
    events.length > 0 &&
    events.every((event) => event.state === 'failed' && isResearchQcGated(event))
  return [
    '<phi_wrapper_run_finished>',
    `This message is from Phi, not from the user. ${
      events.length === 1 ? 'A background wrapper run' : 'Background wrapper runs'
    } you had Wrapper start ${events.length === 1 ? 'has' : 'have'} ended:`,
    ...events.map(describe),
    allQcInvalid
      ? 'Continue with what the user asked for.'
      : 'Continue with what the user asked for, using these results.',
    ...(anyQcVerdict
      ? [
          'For research QC results, stay within the analysis scope the user already approved; ask the user before starting any new or broader analysis. Have the domain specialist verify the published report against its artifacts before interpretation or enrichment. Continue an applicable next step only when the original question authorizes it.'
        ]
      : []),
    ...(anySkip
      ? [
          'A skip disposition means no genes passed the thresholds. Skip candidate-list enrichment (ORA). Deliver the zero-hit result if it answers the question. Ask a specific question only if an unresolved aim needs a new method or input.'
        ]
      : []),
    ...(anyNeedsInput
      ? [
          "A run stopped before inference and published a research_input question. Relay it now with ask_user_question using exactly the header, question and options listed above, and wait for the user's choice before any further analysis. Do not retry the run, read its log or use its outputs. Start a fresh run into a new output directory only if the user chooses to correct the mapping and supplies it; if they choose the descriptive report, stay within that descriptive scope. Never remove or guess the pairing yourself."
        ]
      : []),
    ...(qcFailed
      ? [
          'A QC-gated research run ended without verified results. Do not request or read the raw run log for it, and do not use or interpret its outputs. Report the fixed invalid status and ask the user how to proceed (for example, a fresh run into a new output directory). Do not start it again unless the user asked for retries.'
        ]
      : []),
    ...(plainFailed
      ? [
          'For a failed run, say why (Wrapper can report the log for its run id) and propose the next step. Do not start it again unless the user asked for retries.'
        ]
      : []),
    'Reply in the language the user has been using.',
    '</phi_wrapper_run_finished>'
  ].join('\n')
}
