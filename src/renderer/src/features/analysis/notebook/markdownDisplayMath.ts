export type DisplayMath = {
  start: number
  bodyStart: number
  bodyEnd: number
  body: string
  closingEnd: number
}

/** Resolve one display formula without including neighboring Markdown blocks. */
export function displayMathAt(source: string, position: number): DisplayMath | null {
  if (position < 0 || position > source.length) return null
  const start = source.lastIndexOf('\n', Math.max(0, position - 1)) + 1
  const openingEnd = source.indexOf('\n', start)
  if (openingEnd < 0) return null
  const opening = /^ {0,3}(\${2,})[ \t]*$/.exec(source.slice(start, openingEnd))
  if (!opening) return null
  const bodyStart = openingEnd + 1
  for (let lineStart = bodyStart; lineStart <= source.length;) {
    const next = source.indexOf('\n', lineStart)
    const lineEnd = next < 0 ? source.length : next
    const closing = /^ {0,3}(\${2,})[ \t]*$/.exec(source.slice(lineStart, lineEnd))
    if (closing && closing[1].length >= opening[1].length) {
      const bodyEnd = Math.max(bodyStart, lineStart - 1)
      return {
        start,
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

export function replaceDisplayMathBody(source: string, start: number, body: string): string {
  const math = displayMathAt(source, start)
  if (!math) return source
  return source.slice(0, math.bodyStart) + body + source.slice(math.bodyEnd)
}

export function paragraphAfterDisplayMath(
  source: string,
  start: number
): { value: string; cursor: number } | null {
  const math = displayMathAt(source, start)
  if (!math) return null
  const after = source.slice(math.closingEnd)
  if (/^\n{2,}$/.test(after)) return { value: source, cursor: source.length }
  if (after.startsWith('\n\n')) return { value: source, cursor: math.closingEnd + 2 }
  if (after.startsWith('\n')) {
    return {
      value: source.slice(0, math.closingEnd + 1) + '\n' + source.slice(math.closingEnd + 1),
      cursor: math.closingEnd + 2
    }
  }
  return {
    value: source.slice(0, math.closingEnd) + '\n\n' + after,
    cursor: math.closingEnd + 2
  }
}

export function removeDisplayMath(
  source: string,
  start: number
): { value: string; cursor: number } | null {
  const math = displayMathAt(source, start)
  if (!math) return null
  const after = source.slice(math.closingEnd)
  const trailing = after.startsWith('\n\n') ? 2 : after.startsWith('\n') ? 1 : 0
  const before = source.slice(0, math.start)
  return {
    value: before + source.slice(math.closingEnd + trailing),
    cursor: before.length
  }
}
