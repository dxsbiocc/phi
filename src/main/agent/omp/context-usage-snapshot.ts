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
type McpUsage = { directTokens: number; deferredTokens: number }

export function partitionMcpTools<T extends { name: string }>(
  activeTools: readonly T[],
  enabledMcpNames: readonly string[],
  findTool: (name: string) => T | undefined
): { directTools: T[]; deferredTools: T[] } {
  const directTools = activeTools.filter((tool) => tool.name.startsWith('mcp__'))
  const directNames = new Set(directTools.map((tool) => tool.name))
  const deferredTools = enabledMcpNames
    .filter((name) => name.startsWith('mcp__') && !directNames.has(name))
    .map(findTool)
    .filter((tool): tool is T => tool !== undefined)
  return { directTools, deferredTools }
}

export function contextUsageSnapshot(
  usage: Usage | null | undefined,
  breakdown?: Breakdown | null,
  firstSystemPromptTokens?: number,
  mcpUsage?: McpUsage
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
  if (mcpUsage && Number.isFinite(mcpUsage.deferredTokens) && mcpUsage.deferredTokens >= 0) {
    snapshot.deferredMcpTokens = mcpUsage.deferredTokens
  }
  if (!breakdown || breakdown.contextWindow !== usage.contextWindow) return snapshot

  // The SDK subtracts skill tokens from systemPrompt[0]. Phi prepends its role
  // to that array, so the skill text lives in later blocks instead.
  const phiPrompt = firstSystemPromptTokens !== undefined
  if (
    phiPrompt &&
    (!Number.isFinite(firstSystemPromptTokens) ||
      firstSystemPromptTokens < 0 ||
      breakdown.systemContextTokens < breakdown.skillsTokens)
  ) {
    return snapshot
  }
  const systemPromptTokens = phiPrompt ? firstSystemPromptTokens : breakdown.systemPromptTokens
  const systemContextTokens = phiPrompt
    ? breakdown.systemContextTokens - breakdown.skillsTokens
    : breakdown.systemContextTokens
  const nonMessageTokens =
    systemPromptTokens + breakdown.systemToolsTokens + systemContextTokens + breakdown.skillsTokens
  const messagesTokens = phiPrompt ? usage.tokens - nonMessageTokens : breakdown.messagesTokens

  const directMcpTokens = mcpUsage?.directTokens
  if (
    directMcpTokens !== undefined &&
    (!Number.isFinite(directMcpTokens) ||
      directMcpTokens < 0 ||
      directMcpTokens > breakdown.systemToolsTokens + 1)
  ) {
    return snapshot
  }
  const mcpTokens =
    directMcpTokens === undefined
      ? undefined
      : Math.min(directMcpTokens, breakdown.systemToolsTokens)

  const categories = [
    { id: 'systemPrompt', tokens: systemPromptTokens },
    ...(mcpTokens === undefined
      ? [{ id: 'toolDefinitions', tokens: breakdown.systemToolsTokens } as const]
      : [
          { id: 'systemTools', tokens: breakdown.systemToolsTokens - mcpTokens } as const,
          { id: 'mcpTools', tokens: mcpTokens } as const
        ]),
    { id: 'systemContext', tokens: systemContextTokens },
    { id: 'skills', tokens: breakdown.skillsTokens },
    { id: 'conversation', tokens: messagesTokens }
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
