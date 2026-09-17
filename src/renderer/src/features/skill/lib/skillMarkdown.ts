export function skillMarkdownBody(markdown: string): string {
  return markdown.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '')
}
