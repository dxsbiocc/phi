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

const SUGGESTED_ACTION_LABEL_PATTERN =
  '(?:推荐(?:的)?下一步(?:操作)?|下一步(?:操作|行动)?|建议(?:下一步)?|Recommended next steps?|Next steps?)'

const INLINE_SUGGESTED_ACTION_RE = new RegExp(
  `${SUGGESTED_ACTION_LABEL_PATTERN}(?:\\s*[,，][^:：]*)?(?:\\*\\*)?\\s*[:：](?:\\*\\*)?\\s*(.+)$`,
  'i'
)

const STANDALONE_INLINE_SUGGESTED_ACTION_RE = new RegExp(
  `^(?:>\\s*)?(?:[-*+]\\s+)?(?:#+\\s*)?(?:\\*\\*)?${SUGGESTED_ACTION_LABEL_PATTERN}(?:\\s*[,，][^:：]*)?(?:\\*\\*)?\\s*[:：](?:\\*\\*)?\\s*(.+)$`,
  'i'
)

const SUGGESTED_ACTION_HEADING_RE = new RegExp(
  `^(?:#+\\s*)?(?:\\*\\*)?${SUGGESTED_ACTION_LABEL_PATTERN}(?:\\*\\*)?\\s*[:：]?(?:\\*\\*)?\\s*$`,
  'i'
)

function inlineSuggestedActionText(line: string): string | null {
  const match = line.match(INLINE_SUGGESTED_ACTION_RE)
  if (!match) return null
  return cleanSuggestedActionLine(match[1] ?? '')
}

function isSuggestedActionHeading(line: string): boolean {
  return SUGGESTED_ACTION_HEADING_RE.test(line.trim())
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

/**
 * Removes a trailing suggested-next-action line or section from final assistant replies
 * because the same suggestion is already surfaced in the chat composer placeholder.
 */
export function stripSuggestedNextActionFromText(content: string): string {
  const lines = content.split(/\r?\n/)
  let lastNonEmptyIndex = lines.length - 1
  while (lastNonEmptyIndex >= 0 && !lines[lastNonEmptyIndex].trim()) {
    lastNonEmptyIndex -= 1
  }
  if (lastNonEmptyIndex < 0) return content

  const trailingLine = lines[lastNonEmptyIndex].trim()
  if (STANDALONE_INLINE_SUGGESTED_ACTION_RE.test(trailingLine)) {
    const inline = inlineSuggestedActionText(trailingLine)
    if (inline && isUsableSuggestedAction(inline)) {
      const stripped = lines.slice(0, lastNonEmptyIndex).join('\n').trimEnd()
      if (stripped.length > 0) return stripped
    }
  }

  const headingIndex = lines.findLastIndex(isSuggestedActionHeading)
  if (headingIndex > 0) {
    const tailLines = lines.slice(headingIndex + 1, lastNonEmptyIndex + 1)
    let hasUsableAction = false
    let hasOtherSection = false
    for (const rawLine of tailLines) {
      const trimmed = rawLine.trim()
      if (!trimmed) continue
      if (/^#+\s+/.test(trimmed) || /^```/.test(trimmed)) {
        hasOtherSection = true
        break
      }
      const action = cleanSuggestedActionLine(trimmed)
      if (action && isUsableSuggestedAction(action)) hasUsableAction = true
    }
    if (hasUsableAction && !hasOtherSection) {
      const stripped = lines.slice(0, headingIndex).join('\n').trimEnd()
      if (stripped.length > 0) return stripped
    }
  }

  return content
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
 * neither selects nor copies. Tab or ArrowRight on an empty input turns it into
 * real, editable text; returns that text, or null when the key should keep its
 * normal behaviour.
 */
export function suggestedNextActionToAccept(
  event: SuggestionKeyEvent,
  input: string,
  suggestion: string | null
): string | null {
  if (!suggestion || input !== '') return null
  if ((event.key !== 'Tab' && event.key !== 'ArrowRight') || event.isComposing) return null
  if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return null
  return suggestion
}
