export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

const THINKING_LEVEL_ORDER: ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

// Mirrors the runtime model metadata: a level is unsupported if the model's
// thinkingLevelMap explicitly maps it to null, and xhigh/max additionally
// require an explicit mapping because most models do not opt into them.
export function getSupportedThinkingLevels(model: {
  reasoning: boolean
  thinkingLevelMap?: Partial<Record<string, string | null>>
}): ThinkingLevel[] {
  if (!model.reasoning) return []
  return THINKING_LEVEL_ORDER.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}
