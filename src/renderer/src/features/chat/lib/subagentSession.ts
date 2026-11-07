import { errorMessage } from '../../../../../shared/errorCodes'
import type { AgentExecutionItem, ChatItem } from '../../../types'
import { stepAsToolCall } from '../../../lib/agentStepPresentation'
import { outputPreviewText } from '../../../lib/toolOutputPresentation'

/** The delegation's original instruction, before any one-line task preview. */
export function subagentPrompt(item: Pick<AgentExecutionItem, 'task' | 'argsJson'>): string {
  try {
    const args: unknown = JSON.parse(item.argsJson)
    if (args && typeof args === 'object' && 'task' in args && typeof args.task === 'string') {
      if (args.task.trim()) return args.task
    }
  } catch {
    // Restored legacy executions may have no serialized arguments.
  }
  return item.task
}

export function agentControlErrorText(error: unknown): string {
  const message = errorMessage(error)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** Project an execution into the same timeline model consumed by ordinary conversations. */
export function subagentSessionMessages(item: AgentExecutionItem): ChatItem[] {
  const runId = item.agentRunId ?? item.id
  const messages: ChatItem[] = [
    {
      id: `${item.id}:assignment`,
      role: 'user',
      content: subagentPrompt(item),
      runId,
      createdAt: item.createdAt
    }
  ]
  if (item.createdAt)
    messages.push({
      id: `${item.id}:started`,
      role: 'run',
      event: 'started',
      runId,
      createdAt: item.createdAt
    })
  const progress: ChatItem[] = item.steps.flatMap((step): ChatItem[] => {
    const tool = { ...stepAsToolCall(step), runId }
    return step.error
      ? [
          tool,
          {
            id: `${step.id}:error`,
            role: 'error',
            content: step.error,
            runId,
            createdAt: step.completedAt ?? step.createdAt
          }
        ]
      : [tool]
  })
  for (const [index, steer] of (item.steers ?? []).entries())
    progress.push({
      id: `${item.id}:steer:${index}`,
      role: 'user',
      content: steer.text,
      runId,
      createdAt: steer.createdAt
    })
  // Timestamped steering sits among the tools it guided. Legacy undated records retain order.
  if (progress.every((entry) => Number.isFinite(Date.parse(entry.createdAt ?? '')))) {
    progress.sort((a, b) => Date.parse(a.createdAt!) - Date.parse(b.createdAt!))
  }
  messages.push(...progress)
  if (item.status !== 'running' && item.completedAt)
    messages.push({
      id: `${item.id}:ended`,
      role: 'run',
      event: item.cancelled ? 'interrupted' : item.status === 'error' ? 'failed' : 'completed',
      runId,
      createdAt: item.completedAt,
      durationMs: item.durationMs
    })
  if (item.finalReport)
    messages.push({
      id: `${item.id}:report`,
      role: 'assistant',
      runId,
      content: outputPreviewText({
        output: item.finalReport,
        outputPath: item.finalReportPath,
        outputTruncated: item.finalReportTruncated
      }),
      createdAt: item.completedAt
    })
  if (item.error)
    messages.push({
      id: `${item.id}:error`,
      role: 'error',
      content: item.error,
      runId,
      createdAt: item.completedAt
    })
  return messages
}
