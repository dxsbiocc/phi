import { AgentRunLimitError } from '../../agents/registry'
import { isRecord } from '../../../../shared/guards'
import { sessions } from './state'

export const MAX_HOST_AGENT_TASK_BYTES = 32 * 1024
export const DEFAULT_HOST_AGENT = 'PlanStep'

function startInput(params: unknown): { sessionId: string; agent: string; task: string } {
  const record = isRecord(params) ? params : {}
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : ''
  if (!sessionId) throw new Error('agentRun.start requires a non-empty sessionId')
  const agent = record.agent === undefined ? DEFAULT_HOST_AGENT : record.agent
  if (typeof agent !== 'string' || !agent.trim()) {
    throw new Error('agentRun.start agent must be a non-empty string')
  }
  const task = typeof record.task === 'string' ? record.task.trim() : ''
  if (!task) throw new Error('agentRun.start requires a non-empty task')
  if (Buffer.byteLength(task, 'utf8') > MAX_HOST_AGENT_TASK_BYTES) {
    throw new Error(`agentRun.start task exceeds the ${MAX_HOST_AGENT_TASK_BYTES}-byte limit`)
  }
  return { sessionId, agent: agent.trim(), task }
}

export function startSessionAgentRun(params: unknown): { runId: string } {
  const input = startInput(params)
  const session = sessions.get(input.sessionId)
  if (!session) throw new Error(`Unknown session: ${input.sessionId}`)
  const runner = session.agentRunners?.get(input.agent)
  if (!runner || !session.agentRuns) {
    throw new Error(`Agent ${input.agent} is not available in session ${input.sessionId}`)
  }
  try {
    const handle = session.agentRuns.launch({
      agent: input.agent,
      task: input.task,
      runner,
      background: true,
      origin: 'host'
    })
    return { runId: handle.id }
  } catch (error) {
    if (error instanceof AgentRunLimitError) {
      throw new Error(`Cannot start ${input.agent}: ${error.message}`)
    }
    throw error
  }
}
