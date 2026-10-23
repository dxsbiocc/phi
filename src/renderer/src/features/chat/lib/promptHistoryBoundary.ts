import type { ComposerTextEditorHandle } from '../../../components/chat/ComposerTextEditor'
import type { PromptHistoryDirection } from '../../../lib/promptHistory'

export function isTextInputAtHistoryBoundary(
  inputElement: ComposerTextEditorHandle,
  direction: PromptHistoryDirection
): boolean {
  const { selectionStart, selectionEnd, value } = inputElement
  if (selectionStart === null || selectionEnd === null) return true
  if (selectionStart !== selectionEnd) return false
  if (value.length === 0) return true

  if (direction === 'previous') {
    return value.lastIndexOf('\n', Math.max(0, selectionStart - 1)) === -1
  }
  return value.indexOf('\n', selectionEnd) === -1
}
