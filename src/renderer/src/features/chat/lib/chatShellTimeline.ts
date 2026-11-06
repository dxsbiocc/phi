import type { BackgroundShellJob } from '../../../../../shared/backgroundJobTypes'
import { isRecord } from '../../../../../shared/guards'
import type { ChatItem, ChatMessage } from '../../../types'

export type ChatShellJob = Pick<
  BackgroundShellJob,
  'jobId' | 'command' | 'state' | 'output' | 'exitCode' | 'outputTruncated' | 'outputPath'
>

function isActive(state: ChatShellJob['state']): boolean {
  return state === 'queued' || state === 'running'
}

const states = ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'] as const

function chatShellJobFrom(value: unknown): ChatShellJob | null {
  if (!isRecord(value) || typeof value.jobId !== 'string' || typeof value.command !== 'string') {
    return null
  }
  const state = states.find((candidate) => candidate === value.state)
  if (!state) return null
  return {
    jobId: value.jobId,
    command: value.command,
    state,
    ...(typeof value.output === 'string' ? { output: value.output } : {}),
    ...(typeof value.exitCode === 'number' ? { exitCode: value.exitCode } : {}),
    ...(typeof value.outputPath === 'string' ? { outputPath: value.outputPath } : {}),
    ...(value.outputTruncated === true ? { outputTruncated: true } : {})
  }
}

/** Use the same card and position for live events and replayed conversation history. */
export function applyChatShellJobEvent(
  items: ChatItem[],
  event: { type?: string; createdAt?: string; shellJob?: unknown }
): boolean {
  if (event.type !== 'shell_job_started' && event.type !== 'shell_job_finished') return false
  const job = chatShellJobFrom(event.shellJob)
  if (!job) return true
  const id = `chat-shell:${job.jobId}`
  const index = items.findIndex((item) => item.id === id)
  const current = items[index]
  if (
    current?.role === 'warning' &&
    current.shellJob &&
    !isActive(current.shellJob.state) &&
    isActive(job.state)
  )
    return true

  const item: ChatMessage = {
    id,
    role: 'warning',
    content: job.command,
    createdAt: current?.createdAt ?? event.createdAt,
    shellJob: job
  }
  if (index >= 0) items[index] = item
  else items.push(item)
  return true
}
