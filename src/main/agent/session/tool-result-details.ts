import { uiBlocksDetailsSchema, type UiBlocksDetails } from '../../../shared/uiBlockTypes'

export function toolResultDetailsForSession(
  toolName: unknown,
  result: unknown
): UiBlocksDetails | undefined {
  if (toolName !== 'render_blocks' || !result || typeof result !== 'object') return undefined
  const parsed = uiBlocksDetailsSchema.safeParse((result as { details?: unknown }).details)
  return parsed.success ? parsed.data : undefined
}
