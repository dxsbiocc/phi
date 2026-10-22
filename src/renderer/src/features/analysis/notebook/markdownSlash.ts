import {
  insertMarkdown,
  markdownInsertKinds,
  type MarkdownInsertKind,
  type MarkdownInsertResult,
  type MarkdownInsertSamples
} from './markdownInsert'

export type MarkdownSlashMatch = { start: number; end: number; query: string }

const aliases: Record<MarkdownInsertKind, readonly string[]> = {
  bold: ['bold'],
  italic: ['italic'],
  link: ['link'],
  formula: ['formula', 'math'],
  codeBlock: ['code', 'code block'],
  image: ['image', 'photo'],
  list: ['list', 'bullet'],
  quote: ['quote'],
  table: ['table']
}

export function activeMarkdownSlash(source: string, cursor: number): MarkdownSlashMatch | null {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > source.length) return null
  const lineStart = source.lastIndexOf('\n', cursor - 1) + 1
  const before = source.slice(lineStart, cursor)
  const match = /(^|\s)\/([^/\n]*)$/.exec(before)
  if (!match) return null
  return {
    start: lineStart + match.index + match[1].length,
    end: cursor,
    query: match[2]
  }
}

export function filterMarkdownInsertKinds(
  query: string,
  labelFor: (kind: MarkdownInsertKind) => string
): MarkdownInsertKind[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return [...markdownInsertKinds]
  const prefixed: MarkdownInsertKind[] = []
  const contained: MarkdownInsertKind[] = []
  for (const kind of markdownInsertKinds) {
    const words = [labelFor(kind).toLocaleLowerCase(), ...aliases[kind]]
    if (words.some((word) => word.startsWith(needle))) prefixed.push(kind)
    else if (words.some((word) => word.includes(needle))) contained.push(kind)
  }
  return [...prefixed, ...contained]
}

export function insertFromMarkdownSlash(
  source: string,
  match: MarkdownSlashMatch,
  kind: MarkdownInsertKind,
  samples: MarkdownInsertSamples
): MarkdownInsertResult {
  if (source[match.start] !== '/')
    return insertMarkdown(source, match.end, match.end, kind, samples)
  const withoutCommand = source.slice(0, match.start) + source.slice(match.end)
  return insertMarkdown(withoutCommand, match.start, match.start, kind, samples)
}
