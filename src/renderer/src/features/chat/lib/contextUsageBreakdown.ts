import type {
  ContextUsageCategoryId,
  ContextUsageSnapshot
} from '../../../../../shared/contextUsageTypes'

const CATEGORY_META: Record<ContextUsageCategoryId, { label: string; color: string }> = {
  systemPrompt: { label: '系统提示词', color: '#9CA3AF' },
  toolDefinitions: { label: '工具定义', color: '#9684E8' },
  systemContext: { label: '系统上下文', color: '#42A574' },
  skills: { label: '技能', color: '#F1B562' },
  conversation: { label: '对话', color: '#DE807C' }
}

export function contextUsageCategories(usage: ContextUsageSnapshot | null): Array<{
  id: ContextUsageCategoryId
  label: string
  color: string
  tokens: number
  usedPercent: number
}> {
  if (!usage?.categories || usage.contextWindow <= 0) return []
  return usage.categories
    .filter((category) => Number.isFinite(category.tokens) && category.tokens >= 0)
    .map((category) => ({
      ...category,
      ...CATEGORY_META[category.id],
      usedPercent: usage.tokens > 0 ? (category.tokens / usage.tokens) * 100 : 0
    }))
    .sort((left, right) => right.tokens - left.tokens)
}
