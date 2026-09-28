import { useEffect, useState } from 'react'
import type {
  ContextUsageSnapshot,
  CurrentContextUsage
} from '../../../../../shared/contextUsageTypes'
import { getRendererApi } from '../../../lib/rendererApi'
import type { AgentEventSummary } from '../../../types'

export type ContextUsageTarget = {
  sessionPath: string | null
  phiSessionId: string | null
  sessionGeneration: number
}

type UsageState = {
  key: string
  usage: ContextUsageSnapshot | null
}

function shouldRefreshForEvent(
  event: AgentEventSummary,
  sessionPath: string | null,
  phiSessionId: string | null,
  sessionGeneration: number
): boolean {
  if (
    event.type !== 'tool_execution_end' &&
    event.type !== 'agent_end' &&
    event.type !== 'auto_compaction_end' &&
    event.type !== 'context_compacted' &&
    !(event.type === 'message_end' && event.message?.role === 'assistant')
  ) {
    return false
  }
  if (
    typeof event.sessionGeneration === 'number' &&
    event.sessionGeneration !== sessionGeneration
  ) {
    return false
  }
  return typeof event.phiSessionId === 'string'
    ? event.phiSessionId === phiSessionId
    : event.sessionPath === sessionPath
}

export function useContextUsage(
  target: ContextUsageTarget | undefined,
  modelKey: string | null,
  isGenerating: boolean,
  refreshKey = 0
): { usage: ContextUsageSnapshot | null; loading: boolean } {
  const sessionPath = target?.sessionPath ?? null
  const phiSessionId = target?.phiSessionId ?? null
  const sessionGeneration = target?.sessionGeneration ?? 0
  const key = JSON.stringify([sessionPath, phiSessionId, sessionGeneration, modelKey, refreshKey])
  const [state, setState] = useState<UsageState | null>(null)
  const available = Boolean(sessionPath && modelKey)

  useEffect(() => {
    if (!available) return undefined
    let cancelled = false
    let refreshing = false
    let refreshPending = false
    const refresh = async (): Promise<void> => {
      if (refreshing) {
        refreshPending = true
        return
      }
      refreshing = true
      try {
        const api = getRendererApi()
        const result: CurrentContextUsage | null =
          typeof api.getCurrentContextUsage === 'function'
            ? await api.getCurrentContextUsage()
            : null
        if (cancelled) return
        const matches =
          result?.sessionPath === sessionPath &&
          result?.phiSessionId === phiSessionId &&
          result?.sessionGeneration === sessionGeneration
        setState({ key, usage: matches ? (result?.usage ?? null) : null })
      } catch {
        if (!cancelled) setState({ key, usage: null })
      } finally {
        refreshing = false
        if (refreshPending && !cancelled) {
          refreshPending = false
          void refresh()
        }
      }
    }
    void refresh()
    const unsubscribe = getRendererApi().onAgentEvent((event) => {
      if (shouldRefreshForEvent(event, sessionPath, phiSessionId, sessionGeneration)) {
        void refresh()
      }
    })
    const timer = window.setInterval(() => void refresh(), isGenerating ? 3000 : 15000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      unsubscribe()
    }
  }, [available, isGenerating, key, phiSessionId, sessionGeneration, sessionPath])

  if (!available) return { usage: null, loading: false }
  if (state?.key !== key) return { usage: null, loading: true }
  return { usage: state.usage, loading: false }
}
