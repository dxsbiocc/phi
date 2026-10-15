/** A terminal report cannot fall back to a previous assistant/tool-call tail. */
export function completedChildReport(messages: readonly unknown[]): string {
  const value = messages.at(-1)
  if (!value || typeof value !== 'object' || !('role' in value) || value.role !== 'assistant')
    return ''
  if (!('content' in value) || !Array.isArray(value.content)) return ''
  if (
    'stopReason' in value &&
    value.stopReason !== undefined &&
    (typeof value.stopReason !== 'string' || !['stop', 'length'].includes(value.stopReason))
  )
    return ''
  if (value.content.some((part) => part && typeof part === 'object' && part.type === 'toolCall'))
    return ''
  return value.content
    .flatMap((part) =>
      part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string'
        ? [part.text]
        : []
    )
    .join('\n')
    .slice(0, 20000)
}
