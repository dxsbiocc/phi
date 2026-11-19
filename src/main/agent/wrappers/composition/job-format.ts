import { TERMINAL_RUN_STATES, type WrapperJobStatus, type WrapperJobSummary } from './job-types'
import { isResearchQcGated, researchQcSummaryLine } from '../../../../shared/wrapperResearchQcTypes'

const LOG_TAIL_IN_REPORT = 1500

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function progressLine(status: WrapperJobStatus): string {
  const { started, total, current } = status.progress
  if (started === 0) return 'Progress: no process has started yet'
  const counted = total ? `${started} of ${total}` : `${started}`
  return `Progress: ${counted} processes started${current ? ` (current: ${current})` : ''}`
}

function researchQcLines(status: WrapperJobStatus): string[] {
  if (status.researchQc) {
    const lines = [researchQcSummaryLine(status.researchQc)]
    if (status.researchQc.disposition === 'eligible' || status.researchQc.disposition === 'skip')
      lines.push(
        'Ask the domain specialist to verify the published evidence before interpretation. Continue only an applicable step already approved by the user.'
      )
    return lines
  }
  if (!status.researchQcExpected) return []
  if (status.remote) {
    return ['Research QC: declared by the wrapper but not verified by Phi (remote run).']
  }
  return TERMINAL_RUN_STATES.includes(status.state)
    ? ['Research QC: not verified for this run; do not use its results.']
    : ['Research QC: verification pending until the run ends.']
}

/** A compact report of one run for the agent: enough to act on, never the whole log. */
export function formatJobStatus(status: WrapperJobStatus): string {
  const exit = status.exitCode !== undefined ? ` (exit ${status.exitCode})` : ''
  const lines = [
    `Run ${status.runId} — ${status.wrapperId}`,
    `State: ${status.state}${exit} · ${duration(status.elapsedSeconds)} · profile ${status.profile}`,
    ...(status.remote
      ? [`Host: ${status.remote.host} (run directory ${status.remote.runDir})`]
      : []),
    ...(status.targetReason ? [`Target: ${status.targetReason}`] : []),
    progressLine(status),
    `Output directory: ${status.outDir}${status.remote ? ` (on ${status.remote.host})` : ''}`
  ]
  if (status.outputs && status.outputs.length > 0) {
    lines.push('Outputs:')
    for (const output of status.outputs) {
      const flags = [output.primary ? 'primary' : undefined, output.exists ? 'present' : 'MISSING']
      lines.push(`- ${output.id}: ${output.path} (${flags.filter(Boolean).join(', ')})`)
    }
  }
  if (status.missingOutputs && status.missingOutputs.length > 0) {
    lines.push(`Missing primary outputs: ${status.missingOutputs.join(', ')}`)
  }
  lines.push(...researchQcLines(status))
  // QC-gated runs never surface the raw log: the verified summary is the report.
  const tail = isResearchQcGated(status) ? '' : status.logTail.trim()
  if (tail) {
    lines.push(
      'Log tail:',
      tail.length > LOG_TAIL_IN_REPORT ? `…${tail.slice(-LOG_TAIL_IN_REPORT)}` : tail
    )
  }
  return lines.join('\n')
}

export function formatJobList(runs: WrapperJobSummary[]): string {
  if (runs.length === 0) return 'No wrapper runs have been started yet.'
  return [
    'Recent wrapper runs (newest first):',
    ...runs.map(
      (run) => `- ${run.runId} · ${run.wrapperId} · ${run.state} · ${duration(run.elapsedSeconds)}`
    )
  ].join('\n')
}
