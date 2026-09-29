/** Older Phi builds appended this guidance to the SDK's user message history. */
export function visibleRuntimeUserText(text: string): string {
  const marker = '\n\n<phi_next_action_instruction>\n'
  const start = text.lastIndexOf(marker)
  if (start < 0) return text
  const suffix = text.slice(start + 2)
  if (
    !suffix.includes('当这次回复有明确、有用的后续操作时') ||
    !suffix.trimEnd().endsWith('</phi_next_action_instruction>')
  ) {
    return text
  }
  return text.slice(0, start)
}
