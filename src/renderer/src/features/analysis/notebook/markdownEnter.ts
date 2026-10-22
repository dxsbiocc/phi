import type { MarkdownInsertResult } from './markdownInsert'

function lineBounds(source: string, position: number): { start: number; end: number } {
  const start = source.lastIndexOf('\n', position - 1) + 1
  const next = source.indexOf('\n', position)
  return { start, end: next < 0 ? source.length : next }
}

function insideFencedCode(source: string, lineStart: number): boolean {
  let fence: { mark: string; length: number } | null = null
  for (const line of source.slice(0, lineStart).split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!match) continue
    if (!fence) {
      fence = { mark: match[1][0], length: match[1].length }
    } else if (match[1][0] === fence.mark && match[1].length >= fence.length && !match[2].trim()) {
      fence = null
    }
  }
  return fence !== null
}

function continuedPrefix(quote: string, list: RegExpExecArray | null): string {
  if (!list) return quote
  const marker = /^\d/.test(list[2])
    ? `${Number.parseInt(list[2], 10) + 1}${list[2].at(-1)}`
    : list[2]
  return `${quote}${list[1]}${marker}${list[3]}${list[4] ? '[ ] ' : ''}`
}

/** Preserve the current list or quote marker when Enter starts a new Markdown line. */
export function continueMarkdownOnEnter(
  source: string,
  start: number,
  end: number
): MarkdownInsertResult | null {
  if (start !== end || start < 0 || start > source.length) return null
  const line = lineBounds(source, start)
  if (insideFencedCode(source, line.start)) return null
  const before = source.slice(line.start, start)
  const quote = /^([ \t]*(?:>[ \t]?)+)/.exec(before)?.[1] ?? ''
  const remainder = before.slice(quote.length)
  const list = /^([ \t]*)([-+*]|\d+[.)])([ \t]+)(\[(?: |x|X)\][ \t]+)?/.exec(remainder)
  if (!list && !quote) return null

  const next = continuedPrefix(quote, list)
  const content = list ? remainder.slice(list[0].length) : remainder
  const tail = source.slice(start, line.end)
  if (!content.trim() && !tail.trim()) {
    const retained = list ? `${quote}${list[1]}` : ''
    const value = source.slice(0, line.start) + retained + source.slice(line.end)
    const cursor = line.start + retained.length
    return { value, selectionStart: cursor, selectionEnd: cursor }
  }

  // A space at the split point belongs to the next item, whose marker already has a space.
  const skip = tail.startsWith(' ') ? 1 : 0
  const value = source.slice(0, start) + '\n' + next + source.slice(start + skip)
  const cursor = start + next.length + 1
  return { value, selectionStart: cursor, selectionEnd: cursor }
}

/** Enter after a fence language goes straight to the code body. */
export function moveToFencedCodeBody(
  source: string,
  start: number,
  end: number
): MarkdownInsertResult | null {
  if (start < 0 || end < start || end > source.length) return null
  const line = lineBounds(source, start)
  if (line.end === source.length || end > line.end) return null
  const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*$/.exec(source.slice(line.start, line.end))
  if (!opening || start < line.start + opening[0].indexOf(opening[1]) + opening[1].length)
    return null
  if (insideFencedCode(source, line.start)) return null
  const cursor = line.end + 1
  return { value: source, selectionStart: cursor, selectionEnd: cursor }
}
