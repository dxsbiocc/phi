import type { ChatItem } from '../types'

function cleanSuggestedActionLine(line: string): string {
  return line
    .trim()
    .replace(/^>\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\[[ xX]\]\s+/, '')
    .replace(/^(?:\d+[).]|[（(]\d+[)）])\s*/, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
}

function inlineSuggestedActionText(line: string): string | null {
  const match = line.match(
    /(?:推荐(?:的)?下一步(?:操作)?|下一步(?:操作|行动)?|建议(?:下一步)?|Recommended next steps?|Next steps?)(?:\s*[,，][^:：]*)?\s*[:：]\s*(.+)$/i
  )
  if (!match) return null
  return cleanSuggestedActionLine(match[1] ?? '')
}

function isSuggestedActionHeading(line: string): boolean {
  return /^(?:#+\s*)?(?:推荐(?:的)?下一步(?:操作)?|下一步(?:操作|行动)?|建议(?:下一步)?|Recommended next steps?|Next steps?)\s*[:：]?\s*$/i.test(
    line.trim()
  )
}

function isUsableSuggestedAction(value: string): boolean {
  return value.length >= 2 && value.length <= 140 && !/^```/.test(value)
}

function suggestedNextActionFromText(content: string): string | null {
  const lines = content.split(/\r?\n/)

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const inline = inlineSuggestedActionText(lines[index])
    if (inline && isUsableSuggestedAction(inline)) return inline
  }

  const headingIndex = lines.findLastIndex(isSuggestedActionHeading)
  if (headingIndex >= 0) {
    for (const line of lines.slice(headingIndex + 1)) {
      const action = cleanSuggestedActionLine(line)
      if (!action) continue
      if (isSuggestedActionHeading(action)) break
      if (isUsableSuggestedAction(action)) return action
    }
  }

  return null
}

export function suggestedNextActionPlaceholderFromMessages(messages: ChatItem[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index]
    if (item.role !== 'assistant') continue
    const action = suggestedNextActionFromText(item.content)
    if (action) return action
    return null
  }
  return null
}

type SuggestionKeyEvent = {
  key: string
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  isComposing: boolean
}

/**
 * The suggested next action is shown as the input's placeholder, which the browser
 * neither selects nor copies. Tab on an empty input turns it into real, editable
 * text; returns that text, or null when the key should keep its normal behaviour.
 */
export function suggestedNextActionToAccept(
  event: SuggestionKeyEvent,
  input: string,
  suggestion: string | null
): string | null {
  if (!suggestion || input !== '') return null
  if (event.key !== 'Tab' || event.isComposing) return null
  if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return null
  return suggestion
}
