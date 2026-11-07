import { useEffect, useState } from 'react'
import type { AgentExecutionItem } from '../../../types'
import { agentRunControlTarget } from '../../../lib/agentExecutionControl'
import { agentRunLostKey, formatAgentDuration } from '../../../lib/agentRunsOverview'
import { useLostAgentRunsStore } from '../../../stores/lostAgentRunsStore'

function elapsedMs(item: AgentExecutionItem, nowMs: number): number {
  if (item.status !== 'running' && typeof item.durationMs === 'number') {
    return Math.max(0, item.durationMs)
  }
  const start = Date.parse(item.createdAt ?? '')
  const end = item.status === 'running' ? nowMs : Date.parse(item.completedAt ?? '')
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0
}

export function useAgentRunStatus(item: AgentExecutionItem): {
  lost: boolean
  isRunning: boolean
  elapsed: string
  controlTarget: ReturnType<typeof agentRunControlTarget>
  markLost: () => void
} {
  const [nowMs, setNowMs] = useState(() => Date.now())
  const lostKey =
    item.agentRunId && item.agentSessionId
      ? agentRunLostKey({ agentRunId: item.agentRunId, agentSessionId: item.agentSessionId })
      : null
  const lost = useLostAgentRunsStore((state) => lostKey !== null && state.lost.has(lostKey))
  const markLost = useLostAgentRunsStore((state) => state.markLost)
  const isRunning = item.status === 'running' && !lost

  useEffect(() => {
    if (!isRunning) return undefined
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [isRunning])

  return {
    lost,
    isRunning,
    elapsed: formatAgentDuration(elapsedMs(item, nowMs)),
    controlTarget: agentRunControlTarget(item, { lost }),
    markLost: () => {
      if (lostKey) markLost(lostKey)
    }
  }
}
