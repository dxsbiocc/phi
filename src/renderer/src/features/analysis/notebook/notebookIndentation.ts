import { indentService, indentUnit, type IndentContext } from '@codemirror/language'
import { EditorState, type Extension } from '@codemirror/state'
import type { SyntaxLanguage } from '../../../lib/syntaxHighlight'

export const notebookCodeIndentUnit = '    '

export const notebookIndentOnInput =
  /^\s*(?:[\])}]|(?:elif|else|except|finally)\b.*:?|(?:fi|done|esac)\b.*)$/u

function supportsNotebookIndentation(language: SyntaxLanguage): boolean {
  return (
    language === 'python' ||
    language === 'r' ||
    language === 'javascript' ||
    language === 'typescript' ||
    language === 'shell'
  )
}

function codeBeforeComment(line: string, language: SyntaxLanguage): string {
  let quote: string | null = null
  let escaped = false

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    const next = line[index + 1]

    if (quote) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }

    if ((language === 'python' || language === 'r' || language === 'shell') && char === '#') {
      return line.slice(0, index).trimEnd()
    }

    if ((language === 'javascript' || language === 'typescript') && char === '/' && next === '/') {
      return line.slice(0, index).trimEnd()
    }
  }

  return line.trimEnd()
}

function leadingIndentColumn(context: IndentContext, line: string): number {
  return context.countColumn(line, line.search(/\S|$/u))
}

function previousNonBlankLineText(context: IndentContext, lineNumber: number): string | null {
  for (let currentLineNumber = lineNumber - 1; currentLineNumber >= 1; currentLineNumber -= 1) {
    const line = context.state.doc.line(currentLineNumber).text
    if (line.trim().length > 0) return line
  }
  return null
}

function bracketBalance(line: string, language: SyntaxLanguage): number {
  const source = codeBeforeComment(line, language)
  let balance = 0
  let quote: string | null = null
  let escaped = false

  for (const char of source) {
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }

    if (char === '(' || char === '[' || char === '{') balance += 1
    if (char === ')' || char === ']' || char === '}') balance -= 1
  }
  return balance
}

function opensIndentBlock(line: string, language: SyntaxLanguage): boolean {
  const source = codeBeforeComment(line, language)
  const trimmed = source.trim()
  if (!trimmed) return false
  if (bracketBalance(source, language) > 0) return true

  if (language === 'python') return /:\s*$/u.test(trimmed)

  if (language === 'r') {
    return /(?:[([{]|\+|%>%|\|>)\s*$/u.test(trimmed)
  }

  if (language === 'javascript' || language === 'typescript') {
    return /(?:[([{]|=>)\s*$/u.test(trimmed)
  }

  if (language === 'shell') {
    return /(?:\bthen|\bdo|\belse|\{)\s*$/u.test(trimmed)
  }

  return false
}

function closesIndentBlock(line: string, language: SyntaxLanguage): boolean {
  const trimmed = line.trimStart()

  if (/^[\])}]/u.test(trimmed)) return true

  if (language === 'python') {
    return /^(?:elif|else|except|finally)\b/u.test(trimmed)
  }

  if (language === 'r') {
    return /^else\b/u.test(trimmed)
  }

  if (language === 'shell') {
    return /^(?:fi|done|else|elif|esac)\b/u.test(trimmed)
  }

  return false
}

function indentationAfterLine(
  context: IndentContext,
  line: string,
  language: SyntaxLanguage
): number {
  const baseIndent = leadingIndentColumn(context, line)
  return baseIndent + (opensIndentBlock(line, language) ? context.unit : 0)
}

export function notebookIndentationColumn(
  context: IndentContext,
  pos: number,
  language: SyntaxLanguage
): number | null | undefined {
  if (!supportsNotebookIndentation(language)) return undefined

  if (context.simulatedBreak !== null) {
    const previousLine = context.lineAt(pos, -1).text
    const nextLine = context.lineAt(pos, 1).text
    const indent = indentationAfterLine(context, previousLine, language)
    return closesIndentBlock(nextLine, language) ? Math.max(0, indent - context.unit) : indent
  }

  const line = context.state.doc.lineAt(pos)
  const previousLine = previousNonBlankLineText(context, line.number) ?? ''
  const indent = indentationAfterLine(context, previousLine, language)
  return closesIndentBlock(line.text, language) ? Math.max(0, indent - context.unit) : indent
}

export function notebookIndentationExtensions(language: () => SyntaxLanguage): Extension[] {
  return [
    indentUnit.of(notebookCodeIndentUnit),
    EditorState.tabSize.of(notebookCodeIndentUnit.length),
    indentService.of((context, pos) => notebookIndentationColumn(context, pos, language())),
    EditorState.languageData.of(() => [{ indentOnInput: notebookIndentOnInput }])
  ]
}
