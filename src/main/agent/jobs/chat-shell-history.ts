import { randomUUID } from 'node:crypto'
import { isRecord } from '../../../shared/guards'
import type { StoredSessionEvent } from '../session/session-store'

export const CHAT_SHELL_LAUNCH_ID = randomUUID()

function jobKey(event: StoredSessionEvent): string | undefined {
  if (isRecord(event.shellJob) && typeof event.shellJob.jobId === 'string') {
    return `${event.sessionId}:${event.shellJob.jobId}`
  }
  return undefined
}

/** A previous app process cannot report any further updates for an orphaned start. */
export function recoverChatShellHistory(events: StoredSessionEvent[]): StoredSessionEvent[] {
  const finished = new Set(
    events.filter((event) => event.type === 'shell_job_finished').map(jobKey)
  )
  return events.map((event) => {
    if (
      event.type !== 'shell_job_started' ||
      event.shellJobLaunchId === CHAT_SHELL_LAUNCH_ID ||
      !isRecord(event.shellJob) ||
      typeof event.shellJob.jobId !== 'string' ||
      finished.has(jobKey(event))
    ) {
      return event
    }
    return {
      ...event,
      type: 'shell_job_finished',
      shellJob: { ...event.shellJob, state: 'interrupted' }
    }
  })
}
