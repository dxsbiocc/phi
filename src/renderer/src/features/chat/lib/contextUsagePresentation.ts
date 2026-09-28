import type { ContextUsageSnapshot } from '../../../../../shared/contextUsageTypes'

function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 1_000_000) return `${Number((tokens / 1000).toFixed(1))}K`
  return `${Number((tokens / 1_000_000).toFixed(1))}M`
}

export function contextUsagePresentation(
  usage: ContextUsageSnapshot | null,
  loading: boolean
): { label: string; detail: string; progress: number | null } {
  if (loading) {
    return { label: '正在读取上下文…', detail: '正在读取当前会话的上下文占用', progress: null }
  }
  if (!usage) {
    return {
      label: '上下文暂不可用',
      detail: '当前会话或模型尚未提供上下文容量',
      progress: null
    }
  }
  const percent = Math.round(usage.percent)
  return {
    label: `${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} (${percent}%)`,
    detail: `已用 ${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} tokens`,
    progress: Math.min(100, Math.max(0, usage.percent))
  }
}
