import { formatWrapperRunDuration } from './wrapperRunNotice'

/**
 * The timeline event and the wording used when a background agent run ends.
 * Shared so the chat (renderer) and the OS notification (main) say the same
 * thing. `agentRunId` is deliberately not `runId`: session events already use
 * `runId` for the chat prompt run.
 */

export type AgentRunEndState = 'done' | 'error' | 'cancelled'

export interface AgentRunFinishedEvent {
  type: 'agent_run_finished'
  agentRunId: string
  agent: string
  state: AgentRunEndState
  task: string
  elapsedSeconds: number
  toolCalls?: number
  /** The agent's final report, for `done`. */
  report?: string
  /** Why it stopped, for `error` and `cancelled`. */
  error?: string
}

export function isAgentRunEndState(value: unknown): value is AgentRunEndState {
  return value === 'done' || value === 'error' || value === 'cancelled'
}

const TITLE_SUFFIX: Record<AgentRunEndState, string> = {
  done: '后台任务已完成',
  error: '后台任务失败',
  cancelled: '后台任务已取消'
}

const TASK_PREVIEW = 60
const ERROR_PREVIEW = 200

function preview(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

export function agentRunNotice(event: AgentRunFinishedEvent): { title: string; body: string } {
  const lines = [
    `任务：${preview(event.task, TASK_PREVIEW)}`,
    `用时 ${formatWrapperRunDuration(event.elapsedSeconds)}`
  ]
  if (event.state === 'error' && event.error) lines.push(preview(event.error, ERROR_PREVIEW))
  lines.push(`运行编号：${event.agentRunId}`)
  return { title: `${event.agent} ${TITLE_SUFFIX[event.state]}`, body: lines.join('\n') }
}
