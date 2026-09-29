import type {
  ContextUsageCategoryId,
  ContextUsageSnapshot
} from '../../../../../shared/contextUsageTypes'

const CATEGORY_META: Record<ContextUsageCategoryId, { label: string; color: string }> = {
  systemPrompt: { label: '系统提示词', color: '#9CA3AF' },
  toolDefinitions: { label: '工具定义（未细分）', color: '#9684E8' },
  systemTools: { label: '系统工具', color: '#9684E8' },
  mcpTools: { label: 'MCP 工具', color: '#E8604C' },
  systemContext: { label: '系统上下文', color: '#42A574' },
  skills: { label: '技能', color: '#F1B562' },
  conversation: { label: '对话', color: '#DE807C' }
}

export function contextUsageCategories(usage: ContextUsageSnapshot | null): Array<{
  id: ContextUsageCategoryId
  label: string
  color: string
  tokens: number
  windowPercent: number
}> {
  if (!usage?.categories || usage.contextWindow <= 0) return []
  return usage.categories
    .filter((category) => Number.isFinite(category.tokens) && category.tokens >= 0)
    .map((category) => ({
      ...category,
      ...CATEGORY_META[category.id],
      windowPercent: (category.tokens / usage.contextWindow) * 100
    }))
    .sort((left, right) => right.tokens - left.tokens)
}
