import { analysisCopy } from '../lib/analysisUiCopy'

export const markdownInsertKinds = [
  'bold',
  'italic',
  'link',
  'formula',
  'codeBlock',
  'image',
  'list',
  'quote',
  'table'
] as const

export type MarkdownInsertKind = (typeof markdownInsertKinds)[number]

export function markdownInsertLabel(kind: MarkdownInsertKind): string {
  const labels = {
    bold: analysisCopy.insertBold,
    italic: analysisCopy.insertItalic,
    link: analysisCopy.insertLink,
    formula: analysisCopy.insertFormula,
    codeBlock: analysisCopy.insertCodeBlock,
    image: analysisCopy.insertImage,
    list: analysisCopy.insertList,
    quote: analysisCopy.insertQuote,
    table: analysisCopy.insertTable
  }
  return labels[kind]
}

export function markdownInsertSamples(): MarkdownInsertSamples {
  return {
    text: analysisCopy.markdownSampleText,
    link: analysisCopy.markdownSampleLink,
    formula: analysisCopy.markdownSampleFormula,
    image: analysisCopy.markdownSampleImage,
    list: analysisCopy.markdownSampleList,
    quote: analysisCopy.markdownSampleQuote,
    columnA: analysisCopy.markdownSampleColumnA,
    columnB: analysisCopy.markdownSampleColumnB
  }
}

export type MarkdownInsertSamples = {
  text: string
  link: string
  formula: string
  image: string
  list: string
  quote: string
  columnA: string
  columnB: string
}

export type MarkdownInsertResult = {
  value: string
  selectionStart: number
  selectionEnd: number
}

function clamp(value: number, length: number): number {
  if (!Number.isFinite(value)) return length
  return Math.min(length, Math.max(0, Math.trunc(value)))
}

function atLineStart(source: string, index: number): boolean {
  return index <= 0 || source[index - 1] === '\n'
}

function blankLineBefore(source: string, index: number): string {
  const before = source.slice(0, index)
  if (!before || before.endsWith('\n\n')) return ''
  return before.endsWith('\n') ? '\n' : '\n\n'
}

type Range = { source: string; start: number; end: number }
type Span = { text: string; selectionStart: number; selectionEnd: number }

function place(range: Range, span: Span): MarkdownInsertResult {
  return {
    value: range.source.slice(0, range.start) + span.text + range.source.slice(range.end),
    selectionStart: range.start + span.selectionStart,
    selectionEnd: range.start + span.selectionEnd
  }
}

function wrap(
  range: Range,
  before: string,
  after: string,
  emptyInner: string
): MarkdownInsertResult {
  const selected = range.source.slice(range.start, range.end)
  const inner = selected || emptyInner
  const text = `${before}${inner}${after}`
  if (selected)
    return place(range, { text, selectionStart: text.length, selectionEnd: text.length })
  const innerStart = before.length
  return place(range, { text, selectionStart: innerStart, selectionEnd: innerStart + inner.length })
}

function insertBlock(
  range: Range,
  body: string,
  innerStart: number,
  innerEnd: number
): MarkdownInsertResult {
  const prefix = atLineStart(range.source, range.start) ? '' : '\n\n'
  const suffix = range.end < range.source.length && range.source[range.end] !== '\n' ? '\n' : ''
  const text = `${prefix}${body}${suffix}`
  return place(range, {
    text,
    selectionStart: prefix.length + innerStart,
    selectionEnd: prefix.length + innerEnd
  })
}

function prefixLines(range: Range, prefix: string, emptyLine: string): MarkdownInsertResult {
  if (range.start === range.end) {
    const body = `${prefix}${emptyLine}`
    return insertBlock(range, body, prefix.length, prefix.length + emptyLine.length)
  }
  const lineStart = range.source.lastIndexOf('\n', Math.max(0, range.start - 1)) + 1
  const newline = range.source.indexOf('\n', range.end)
  const lineEnd = newline === -1 ? range.source.length : newline
  const prefixed = range.source
    .slice(lineStart, lineEnd)
    .split('\n')
    .map((line) => (line.startsWith(prefix) ? line : `${prefix}${line}`))
    .join('\n')
  return place(
    { source: range.source, start: lineStart, end: lineEnd },
    { text: prefixed, selectionStart: prefixed.length, selectionEnd: prefixed.length }
  )
}

export function insertMarkdown(
  source: string,
  rawStart: number,
  rawEnd: number,
  kind: MarkdownInsertKind,
  samples: MarkdownInsertSamples
): MarkdownInsertResult {
  const length = source.length
  const start = clamp(Math.min(rawStart, rawEnd), length)
  const end = clamp(Math.max(rawStart, rawEnd), length)
  const range = { source, start, end }
  const selected = source.slice(start, end)
  return inserters[kind](range, selected, samples)
}

export function insertMarkdownLink(
  source: string,
  rawStart: number,
  rawEnd: number,
  title: string,
  url: string
): MarkdownInsertResult {
  const start = clamp(Math.min(rawStart, rawEnd), source.length)
  const end = clamp(Math.max(rawStart, rawEnd), source.length)
  const label = title.trim().replace(/\\/g, '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]')
  const destination = url
    .trim()
    .replace(/\s/g, '%20')
    .replace(/([()])/g, '\\$1')
  const text = `[${label}](${destination})`
  const cursor = start + text.length
  return {
    value: source.slice(0, start) + text + source.slice(end),
    selectionStart: cursor,
    selectionEnd: cursor
  }
}

export function paragraphAfterMarkdown(source: string): MarkdownInsertResult {
  if (!source) return { value: '', selectionStart: 0, selectionEnd: 0 }
  const trailingNewlines = source.match(/\n*$/)?.[0].length ?? 0
  const value = source + '\n'.repeat(Math.max(0, 2 - trailingNewlines))
  return { value, selectionStart: value.length, selectionEnd: value.length }
}

/** Complete a freshly typed $$ line without treating subsequent blocks as formula content. */
export function expandDisplayFormulaShortcut(
  source: string,
  cursor: number
): MarkdownInsertResult | null {
  if (cursor < 1 || cursor > source.length) return null
  const lineStart = source.lastIndexOf('\n', cursor - 1) + 1
  if (source.slice(lineStart, cursor) !== '$') return null
  const remaining = source.slice(cursor)
  if (!/^[ \t]*(?:\n|$)/.test(remaining)) return null
  const before = source.slice(0, lineStart)
  const separator = blankLineBefore(source, lineStart)
  const after = remaining.replace(/^[ \t]*\n*/, '')
  const opening = `${before}${separator}$$\n`
  return {
    value: `${opening}\n$$\n\n\n${after}`,
    selectionStart: opening.length,
    selectionEnd: opening.length
  }
}

const inserters: Record<
  MarkdownInsertKind,
  (range: Range, selected: string, samples: MarkdownInsertSamples) => MarkdownInsertResult
> = {
  bold: (range, _selected, samples) => wrap(range, '**', '**', samples.text),
  italic: (range, _selected, samples) => wrap(range, '*', '*', samples.text),
  link: (range, selected, samples) => linked(range, selected || samples.link, 'https://', 3),
  image: (range, selected, samples) => linked(range, selected || samples.image, 'image.png', 4),
  list: (range, _selected, samples) => prefixLines(range, '- ', samples.list),
  quote: (range, _selected, samples) => prefixLines(range, '> ', samples.quote),
  formula: (range, selected, samples) => formula(range, selected, samples.formula),
  codeBlock: (range, selected) => fenced(range, selected),
  table: (range, _selected, samples) => table(range, samples)
}

function linked(range: Range, label: string, target: string, marker: number): MarkdownInsertResult {
  const text = `${marker === 4 ? '!' : ''}[${label}](${target})`
  const targetStart = label.length + marker
  const selected = range.source.slice(range.start, range.end)
  return place(range, {
    text,
    selectionStart: selected && marker === 3 ? text.length : targetStart,
    selectionEnd: selected && marker === 3 ? text.length : targetStart + target.length
  })
}

function formula(range: Range, selected: string, sample: string): MarkdownInsertResult {
  if (!selected.includes('\n') && !atLineStart(range.source, range.start)) {
    return wrap(range, '$$', '$$', sample)
  }
  const body = selected || sample
  const prefix = blankLineBefore(range.source, range.start)
  const following = range.source.slice(range.end)
  const suffix = following.startsWith('\n') ? '\n\n' : '\n\n\n'
  const text = `${prefix}$$\n${body}\n$$${suffix}`
  return place(range, {
    text,
    selectionStart: prefix.length + 3,
    selectionEnd: prefix.length + 3 + body.length
  })
}

function fenced(range: Range, body: string): MarkdownInsertResult {
  const prefix = atLineStart(range.source, range.start) ? '' : '\n\n'
  const following = range.source.slice(range.end)
  const suffix = following.startsWith('\n') ? '\n\n' : '\n\n\n'
  const text = `${prefix}\`\`\`\n${body}\n\`\`\`${suffix}`
  const cursor = prefix.length + 4 + body.length
  return place(range, { text, selectionStart: cursor, selectionEnd: cursor })
}

function table(range: Range, samples: MarkdownInsertSamples): MarkdownInsertResult {
  const header = `| ${samples.columnA} | ${samples.columnB} |`
  const rule = '| --- | --- |'
  const body = `${header}\n${rule}\n|  |  |`
  const cellStart = header.length + rule.length + 4
  return insertBlock(range, body, cellStart, cellStart)
}
