export type InlineMath = {
  from: number
  to: number
  bodyStart: number
  bodyEnd: number
  body: string
}

function codeSpanEnd(source: string, index: number): number {
  const marker = /^`+/.exec(source.slice(index))?.[0] ?? '`'
  const close = source.indexOf(marker, index + marker.length)
  if (close < 0 || source.slice(index, close).includes('\n')) return index
  return close + marker.length - 1
}

function closingMathMarker(source: string, bodyStart: number): number {
  const marker = '$$'
  let close = source.indexOf(marker, bodyStart)
  while (close >= 0 && source[close - 1] === '\\')
    close = source.indexOf(marker, close + marker.length)
  return close
}

function startsInlineMath(source: string, index: number): boolean {
  return source[index] === '$' && source[index + 1] === '$' && source[index + 2] !== '$'
}

/** Find inline $$math$$ spans while leaving currency, escapes and inline code untouched. */
export function inlineMathRanges(source: string, offset = 0): InlineMath[] {
  const ranges: InlineMath[] = []
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\\') {
      index++
      continue
    }
    if (source[index] === '`') {
      index = codeSpanEnd(source, index)
      continue
    }
    if (!startsInlineMath(source, index)) continue
    const marker = '$$'
    if (source[index + marker.length] === '\n') continue
    const bodyStart = index + marker.length
    const close = closingMathMarker(source, bodyStart)
    if (close < 0 || source.slice(bodyStart, close).includes('\n') || close === bodyStart) continue
    ranges.push({
      from: offset + index,
      to: offset + close + marker.length,
      bodyStart: offset + bodyStart,
      bodyEnd: offset + close,
      body: source.slice(bodyStart, close)
    })
    index = close + marker.length - 1
  }
  return ranges
}

export function inlineMathAt(source: string, start: number): InlineMath | null {
  const lineStart = source.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  const lineEnd = source.indexOf('\n', start)
  const end = lineEnd < 0 ? source.length : lineEnd
  return (
    inlineMathRanges(source.slice(lineStart, end), lineStart).find(
      (range) => range.from === start
    ) ?? null
  )
}
