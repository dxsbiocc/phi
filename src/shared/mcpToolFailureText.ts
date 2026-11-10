const MAX_BODY_EXCERPT_CHARS = 200
// Match an HTML tag opener even if the response body was truncated mid-tag.
const HTML_MARKUP = /<[a-z!/]/i

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function excerpt(value: string): string {
  const text = collapseWhitespace(value)
  return text.length > MAX_BODY_EXCERPT_CHARS
    ? `${text.slice(0, MAX_BODY_EXCERPT_CHARS - 1).trimEnd()}…`
    : text
}

/**
 * Short user-facing MCP tool-list failure text.
 *
 * HTTP transport errors carry the response body, which is often a full HTML
 * error page. Keep only the status and a bounded plain-text reason; a body that
 * looks like HTML is omitted entirely.
 */
export function mcpToolFailureText(error: unknown): string {
  const message = collapseWhitespace(error instanceof Error ? error.message : String(error ?? ''))
  if (!message) return 'Unknown error'

  const httpMatch = /\bHTTP\s+(\d{3})\b(?:\s*[:\-—]\s*)?([\s\S]*)$/i.exec(message)
  if (httpMatch) {
    const status = httpMatch[1]
    const body = collapseWhitespace(httpMatch[2] ?? '')
    if (!body || HTML_MARKUP.test(body)) return `HTTP ${status}`
    return `HTTP ${status}: ${excerpt(body)}`
  }

  const markupIndex = message.search(HTML_MARKUP)
  if (markupIndex >= 0) {
    const prefix = collapseWhitespace(message.slice(0, markupIndex))
    return prefix ? excerpt(prefix) : 'Could not read the tool list'
  }

  return excerpt(message)
}
