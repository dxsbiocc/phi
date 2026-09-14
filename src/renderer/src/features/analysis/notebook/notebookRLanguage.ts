import { StreamLanguage, type StreamParser, type StringStream } from '@codemirror/language'

type NotebookRState = Record<string, never>

const R_ATOMS = new Set([
  'NULL',
  'NA',
  'Inf',
  'NaN',
  'NA_integer_',
  'NA_real_',
  'NA_complex_',
  'NA_character_',
  'TRUE',
  'FALSE'
])

const R_BUILTINS = new Set([
  'list',
  'quote',
  'bquote',
  'eval',
  'return',
  'call',
  'parse',
  'deparse'
])

const R_KEYWORDS = new Set([
  'if',
  'else',
  'repeat',
  'while',
  'function',
  'for',
  'in',
  'next',
  'break'
])

function isRMemberAccessStart(source: string, index: number): boolean {
  return (
    source[index - 1] === '$' ||
    source[index - 1] === '@' ||
    source.slice(index - 2, index) === '::' ||
    source.slice(index - 3, index) === ':::'
  )
}

function isFollowedByCall(source: string, index: number): boolean {
  return /^\s*\(/.test(source.slice(index))
}

function readRString(stream: StringStream): string {
  while (!stream.eol()) {
    const next = stream.next()
    if (next === '\\') {
      stream.next()
      continue
    }
    if (next === stream.current()[0]) break
  }
  return 'string'
}

function readRIdentifier(stream: StringStream, tokenStart: number): string {
  stream.eatWhile(/[\w.]/)
  const word = stream.current()
  const isMember = isRMemberAccessStart(stream.string, tokenStart)
  const isCall = isFollowedByCall(stream.string, stream.pos)

  if (R_ATOMS.has(word)) return 'atom'
  if (R_KEYWORDS.has(word)) return 'keyword'
  if (isMember && isCall) return 'propertyName.function'
  if (isMember) return 'propertyName'
  if (R_BUILTINS.has(word) || isCall) return 'variableName.function'
  return 'variableName'
}

export const notebookRParser: StreamParser<NotebookRState> = {
  name: 'r',
  token(stream) {
    if (stream.eatSpace()) return null

    const tokenStart = stream.pos
    const ch = stream.next()

    if (ch === '#') {
      stream.skipToEnd()
      return 'comment'
    }

    if (ch === '"' || ch === "'") return readRString(stream)

    if (ch === '`') {
      stream.match(/^[^`]*`?/)
      return 'string.special'
    }

    if (ch === '0' && stream.eat(/[xX]/)) {
      stream.eatWhile(/[\da-f]/i)
      return 'number'
    }

    if (ch === '.' && stream.eat(/\d/)) {
      stream.match(/^\d*(?:e[+-]?\d+)?/i)
      return 'number'
    }

    if (ch && /\d/.test(ch)) {
      stream.match(/^\d*(?:\.\d+)?(?:e[+-]?\d+)?L?/i)
      return 'number'
    }

    if (ch === '%' && stream.skipTo('%')) {
      stream.next()
      return 'variableName.special'
    }

    if (ch && /[A-Za-z.]/.test(ch)) return readRIdentifier(stream, tokenStart)

    if (ch === ':' && stream.eat(':')) {
      stream.eat(':')
      return 'operator'
    }

    if (ch && /[+\-*/^<>=!&|~$@]/.test(ch)) {
      stream.eatWhile(/[+\-*/^<>=!&|~$@]/)
      return 'operator'
    }

    if (ch && /[()[\]{};,]/.test(ch)) return 'punctuation'

    return null
  },
  languageData: {
    wordChars: '.',
    commentTokens: { line: '#' },
    autocomplete: [...R_ATOMS, ...R_BUILTINS, ...R_KEYWORDS]
  }
}

export const notebookRLanguage = StreamLanguage.define(notebookRParser)
