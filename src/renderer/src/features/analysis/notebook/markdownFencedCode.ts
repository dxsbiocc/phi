export type FencedCode = {
  start: number
  languageStart: number
  languageEnd: number
  language: string
  bodyStart: number
  bodyEnd: number
  body: string
  closingEnd: number
}

/** Locate the Markdown source behind one code block, including an empty body. */
export function fencedCodeAt(source: string, position: number): FencedCode | null {
  if (position < 0 || position > source.length) return null
  const start = source.lastIndexOf('\n', Math.max(0, position - 1)) + 1
  const openingEnd = source.indexOf('\n', start)
  if (openingEnd < 0) return null
  const opening = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/.exec(source.slice(start, openingEnd))
  if (!opening) return null
  const marker = opening[1][0]
  const languageStart = start + opening[0].indexOf(opening[1]) + opening[1].length
  const bodyStart = openingEnd + 1
  for (let lineStart = bodyStart; lineStart <= source.length;) {
    const next = source.indexOf('\n', lineStart)
    const lineEnd = next < 0 ? source.length : next
    const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(source.slice(lineStart, lineEnd))
    if (closing && closing[1][0] === marker && closing[1].length >= opening[1].length) {
      const bodyEnd = Math.max(bodyStart, lineStart - 1)
      return {
        start,
        languageStart,
        languageEnd: openingEnd,
        language: source.slice(languageStart, openingEnd).trim(),
        bodyStart,
        bodyEnd,
        body: source.slice(bodyStart, bodyEnd),
        closingEnd: lineEnd
      }
    }
    if (next < 0) break
    lineStart = next + 1
  }
  return null
}

export function replaceFencedCodeBody(source: string, start: number, body: string): string {
  const block = fencedCodeAt(source, start)
  if (!block) return source
  return source.slice(0, block.bodyStart) + body + source.slice(block.bodyEnd)
}

export function replaceFencedCodeLanguage(source: string, start: number, language: string): string {
  const block = fencedCodeAt(source, start)
  const id = language.trim()
  if (!block || (id && !/^[a-zA-Z0-9+#.-]+$/.test(id))) return source
  return source.slice(0, block.languageStart) + id + source.slice(block.languageEnd)
}

export function paragraphAfterFencedCode(
  source: string,
  start: number
): { value: string; cursor: number } | null {
  const block = fencedCodeAt(source, start)
  if (!block) return null
  const after = source.slice(block.closingEnd)
  if (after.startsWith('\n\n')) return { value: source, cursor: block.closingEnd + 2 }
  if (after.startsWith('\n')) {
    return {
      value: source.slice(0, block.closingEnd + 1) + '\n' + source.slice(block.closingEnd + 1),
      cursor: block.closingEnd + 2
    }
  }
  return {
    value: source.slice(0, block.closingEnd) + '\n\n' + after,
    cursor: block.closingEnd + 2
  }
}
