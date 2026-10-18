import { chatCopy } from './chatCopy'
import type { ContextUsageSnapshot } from '../../../../../shared/contextUsageTypes'

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 1_000_000) return `${Number((tokens / 1000).toFixed(1))}K`
  return `${Number((tokens / 1_000_000).toFixed(1))}M`
}

export function contextUsagePresentation(
  usage: ContextUsageSnapshot | null,
  loading: boolean
): { label: string; detail: string; progress: number | null } {
  if (loading) {
    return {
      label: chatCopy.loadingContext,
      detail: chatCopy.loadingContextUsageForThisConversation,
      progress: null
    }
  }
  if (!usage) {
    return {
      label: chatCopy.contextUnavailable,
      detail: chatCopy.contextCapacityIsNotYetAvailableForThisConversationOr,
      progress: null
    }
  }
  const percent = Math.round(usage.percent)
  return {
    label: `${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} (${percent}%)`,
    detail: chatCopy.valueValueTokensUsed(
      formatTokens(usage.tokens),
      formatTokens(usage.contextWindow)
    ),
    progress: Math.min(100, Math.max(0, usage.percent))
  }
}
