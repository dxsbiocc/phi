/**
 * Whether a source conversation is still answering and so cannot be forked yet.
 *
 * A prompt is admitted, written to the conversation and shown as running before its run
 * starts. In that gap the manifest and the runner both still read idle, and a fork would ask
 * the runtime to cut at a message its history does not have yet. The prompt registry covers
 * the gap.
 */
interface ForkSourceStatus {
  runnerGetActiveRun(sessionId: string): unknown
  activePromptEntries(): Array<[string, { phiSessionId: string; cancelled?: boolean }]>
}

const RUNNING_STATUSES = new Set(['running', 'needs_approval', 'needs_input'])

export function forkSourceBusy(
  source: { sessionId: string; status?: string },
  status: ForkSourceStatus
): boolean {
  if (source.status && RUNNING_STATUSES.has(source.status)) return true
  if (status.runnerGetActiveRun(source.sessionId)) return true
  return status
    .activePromptEntries()
    .some(([, run]) => run.phiSessionId === source.sessionId && run.cancelled !== true)
}
