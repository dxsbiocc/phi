import { chatCopy } from './chatCopy'
import type {
  ContextUsageCategoryId,
  ContextUsageSnapshot
} from '../../../../../shared/contextUsageTypes'

const CATEGORY_META: Record<ContextUsageCategoryId, { label: string; color: string }> = {
  systemPrompt: {
    get label() {
      return chatCopy.systemPrompt
    },
    color: '#9CA3AF'
  },
  toolDefinitions: {
    get label() {
      return chatCopy.toolDefinitionsNotItemized
    },
    color: '#9684E8'
  },
  systemTools: {
    get label() {
      return chatCopy.systemTools
    },
    color: '#9684E8'
  },
  mcpTools: {
    get label() {
      return chatCopy.mCPTools
    },
    color: '#E8604C'
  },
  systemContext: {
    get label() {
      return chatCopy.systemContext
    },
    color: '#42A574'
  },
  skills: {
    get label() {
      return chatCopy.skills
    },
    color: '#F1B562'
  },
  conversation: {
    get label() {
      return chatCopy.conversation
    },
    color: '#DE807C'
  }
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
