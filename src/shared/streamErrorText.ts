function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Some providers stream their error text as assistant text. A streamed answer is the error
 * itself when it equals the final error message or contains it; an empty body has nothing to keep.
 */
export function isStreamedErrorText(text: string, errorMessage: string | undefined): boolean {
  const body = collapseWhitespace(text)
  const error = collapseWhitespace(errorMessage ?? '')
  if (!body || !error) return true
  return body === error || body.includes(error)
}
