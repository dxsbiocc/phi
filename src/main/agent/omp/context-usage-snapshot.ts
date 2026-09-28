import type { ContextUsageSnapshot } from '../../../shared/contextUsageTypes'

type Usage = { tokens: number; contextWindow: number; percent: number }
type Breakdown = {
  contextWindow: number
  usedTokens: number
  systemPromptTokens: number
  systemToolsTokens: number
  systemContextTokens: number
  skillsTokens: number
  messagesTokens: number
}

export function contextUsageSnapshot(
  usage: Usage | null | undefined,
  breakdown?: Breakdown | null
): ContextUsageSnapshot | null {
  if (
    !usage ||
    !Number.isFinite(usage.tokens) ||
    usage.tokens < 0 ||
    !Number.isFinite(usage.contextWindow) ||
    usage.contextWindow <= 0 ||
    !Number.isFinite(usage.percent) ||
    usage.percent < 0
  ) {
    return null
  }

  const snapshot: ContextUsageSnapshot = {
    tokens: usage.tokens,
    contextWindow: usage.contextWindow,
    percent: usage.percent
  }
  if (!breakdown || breakdown.contextWindow !== usage.contextWindow) return snapshot

  const categories = [
    { id: 'systemPrompt', tokens: breakdown.systemPromptTokens },
    { id: 'toolDefinitions', tokens: breakdown.systemToolsTokens },
    { id: 'systemContext', tokens: breakdown.systemContextTokens },
    { id: 'skills', tokens: breakdown.skillsTokens },
    { id: 'conversation', tokens: breakdown.messagesTokens }
  ] as const
  if (
    !Number.isFinite(breakdown.usedTokens) ||
    Math.abs(breakdown.usedTokens - usage.tokens) > 1 ||
    categories.some(({ tokens }) => !Number.isFinite(tokens) || tokens < 0) ||
    Math.abs(categories.reduce((sum, category) => sum + category.tokens, 0) - usage.tokens) > 1
  ) {
    return snapshot
  }

  return { ...snapshot, categories: [...categories] }
}
