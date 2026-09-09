export type SyntaxLanguage =
  | 'css'
  | 'javascript'
  | 'json'
  | 'markdown'
  | 'python'
  | 'r'
  | 'shell'
  | 'toml'
  | 'typescript'
  | 'yaml'
  | 'plain'

export type SyntaxTokenKind =
  | 'boolean'
  | 'comment'
  | 'function'
  | 'keyword'
  | 'number'
  | 'operator'
  | 'plain'
  | 'property'
  | 'punctuation'
  | 'string'
  | 'type'

export type SyntaxToken = {
  kind: SyntaxTokenKind
  value: string
}

const SCRIPT_KEYWORDS = new Set([
  'abstract',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'constructor',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'finally',
  'for',
  'from',
  'function',
  'get',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'of',
  'private',
  'protected',
  'public',
  'readonly',
  'return',
  'set',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'try',
  'type',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield'
])

const SCRIPT_TYPES = new Set([
  'Array',
  'Boolean',
  'Error',
  'Map',
  'Number',
  'Object',
  'Promise',
  'Record',
  'Set',
  'String',
  'React',
  'unknown',
  'never',
  'string',
  'number',
  'boolean',
  'object',
  'undefined'
])

const PYTHON_KEYWORDS = new Set([
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield'
])

const R_KEYWORDS = new Set([
  'break',
  'else',
  'FALSE',
  'for',
  'function',
  'if',
  'in',
  'Inf',
  'NA',
  'NaN',
  'next',
  'NULL',
  'repeat',
  'return',
  'TRUE',
  'while'
])

const SHELL_KEYWORDS = new Set([
  'case',
  'do',
  'done',
  'elif',
  'else',
  'esac',
  'export',
  'fi',
  'for',
  'function',
  'if',
  'in',
  'local',
  'readonly',
  'return',
  'select',
  'set',
  'shift',
  'then',
  'until',
  'while'
])

const TOML_KEYWORDS = new Set(['true', 'false'])
const JSON_KEYWORDS = new Set(['true', 'false', 'null'])

const WORD_RE = /^[A-Za-z_$][\w$.-]*/
const NUMBER_RE = /^-?(?:0x[\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/
const OPERATOR_RE =
  /^(?:=>|->|<-|\|>|::|:::|==={0,1}|!==?|<=|>=|\+\+|--|\|\||&&|[+\-*/%=&|!<>~^$@?:]+)/
const PUNCTUATION_RE = /^[()[\]{}.,;]/

function pushToken(tokens: SyntaxToken[], kind: SyntaxTokenKind, value: string): void {
  if (!value) return
  const previous = tokens[tokens.length - 1]
  if (previous?.kind === kind) {
    previous.value += value
    return
  }
  tokens.push({ kind, value })
}

function readQuotedString(line: string, start: number, quote: string): number {
  let index = start + 1
  while (index < line.length) {
    if (line[index] === '\\') {
      index += 2
      continue
    }
    if (line[index] === quote) return index + 1
    index += 1
  }
  return line.length
}

function startsLineComment(line: string, index: number, language: SyntaxLanguage): boolean {
  if (language === 'typescript' || language === 'javascript') return line.startsWith('//', index)
  if (language === 'python' || language === 'r' || language === 'shell') {
    return line[index] === '#'
  }
  return false
}

function keywordKind(word: string, language: SyntaxLanguage): SyntaxTokenKind | null {
  if (language === 'typescript' || language === 'javascript') {
    if (word === 'true' || word === 'false') return 'boolean'
    if (word === 'null' || word === 'undefined') return 'type'
    if (SCRIPT_KEYWORDS.has(word)) return 'keyword'
    if (SCRIPT_TYPES.has(word)) return 'type'
    return null
  }

  if (language === 'python') {
    if (word === 'True' || word === 'False') return 'boolean'
    if (word === 'None') return 'type'
    if (PYTHON_KEYWORDS.has(word)) return 'keyword'
    return null
  }

  if (language === 'r') {
    if (word === 'TRUE' || word === 'FALSE') return 'boolean'
    if (word === 'NULL' || word === 'NA' || word === 'NaN' || word === 'Inf') return 'type'
    if (R_KEYWORDS.has(word)) return 'keyword'
    return null
  }

  if (language === 'shell') {
    if (SHELL_KEYWORDS.has(word)) return 'keyword'
    return null
  }

  return null
}

function tokenizeScriptLine(line: string, language: SyntaxLanguage): SyntaxToken[] {
  const tokens: SyntaxToken[] = []
  let index = 0

  while (index < line.length) {
    const char = line[index]

    if (startsLineComment(line, index, language)) {
      pushToken(tokens, 'comment', line.slice(index))
      break
    }

    if (
      (language === 'typescript' || language === 'javascript' || language === 'css') &&
      line.startsWith('/*', index)
    ) {
      const end = line.indexOf('*/', index + 2)
      const nextIndex = end === -1 ? line.length : end + 2
      pushToken(tokens, 'comment', line.slice(index, nextIndex))
      index = nextIndex
      continue
    }

    if (char === '"' || char === "'" || char === '`') {
      const nextIndex = readQuotedString(line, index, char)
      pushToken(tokens, 'string', line.slice(index, nextIndex))
      index = nextIndex
      continue
    }

    const rest = line.slice(index)
    const numberMatch = rest.match(NUMBER_RE)
    if (numberMatch) {
      pushToken(tokens, 'number', numberMatch[0])
      index += numberMatch[0].length
      continue
    }

    const wordMatch = rest.match(WORD_RE)
    if (wordMatch) {
      const word = wordMatch[0]
      const lookAhead = line.slice(index + word.length)
      const kind = keywordKind(word, language)
      if (kind) {
        pushToken(tokens, kind, word)
      } else if (/^\s*\(/.test(lookAhead)) {
        pushToken(tokens, 'function', word)
      } else {
        pushToken(tokens, 'plain', word)
      }
      index += word.length
      continue
    }

    const operatorMatch = rest.match(OPERATOR_RE)
    if (operatorMatch) {
      pushToken(tokens, 'operator', operatorMatch[0])
      index += operatorMatch[0].length
      continue
    }

    const punctuationMatch = rest.match(PUNCTUATION_RE)
    if (punctuationMatch) {
      pushToken(tokens, 'punctuation', punctuationMatch[0])
      index += punctuationMatch[0].length
      continue
    }

    pushToken(tokens, 'plain', char)
    index += 1
  }

  return tokens
}

function tokenizeJsonLine(line: string): SyntaxToken[] {
  const tokens: SyntaxToken[] = []
  let index = 0

  while (index < line.length) {
    const char = line[index]
    const rest = line.slice(index)
    const propertyMatch = rest.match(/^"([^"\\]|\\.)*"\s*:/)
    if (propertyMatch) {
      const propertyEnd = propertyMatch[0].lastIndexOf(':')
      pushToken(tokens, 'property', propertyMatch[0].slice(0, propertyEnd))
      pushToken(tokens, 'punctuation', propertyMatch[0].slice(propertyEnd))
      index += propertyMatch[0].length
      continue
    }

    if (char === '"') {
      const nextIndex = readQuotedString(line, index, char)
      pushToken(tokens, 'string', line.slice(index, nextIndex))
      index = nextIndex
      continue
    }

    const numberMatch = rest.match(NUMBER_RE)
    if (numberMatch) {
      pushToken(tokens, 'number', numberMatch[0])
      index += numberMatch[0].length
      continue
    }

    const wordMatch = rest.match(/^[A-Za-z]+/)
    if (wordMatch && JSON_KEYWORDS.has(wordMatch[0])) {
      pushToken(
        tokens,
        wordMatch[0] === 'true' || wordMatch[0] === 'false' ? 'boolean' : 'type',
        wordMatch[0]
      )
      index += wordMatch[0].length
      continue
    }

    if (/^[{}[\],:]/.test(char)) {
      pushToken(tokens, 'punctuation', char)
    } else {
      pushToken(tokens, 'plain', char)
    }
    index += 1
  }

  return tokens
}

function tokenizeKeyValueLine(line: string, language: SyntaxLanguage): SyntaxToken[] {
  const commentIndex = line.search(language === 'toml' ? /#/ : /#/)
  const source = commentIndex >= 0 ? line.slice(0, commentIndex) : line
  const comment = commentIndex >= 0 ? line.slice(commentIndex) : ''
  const separatorMatch = source.match(/^(\s*[^:=#]+?)(\s*[:=]\s*)(.*)$/)

  if (!separatorMatch) {
    const tokens = tokenizeScriptLine(source, language)
    if (comment) pushToken(tokens, 'comment', comment)
    return tokens
  }

  const [, key, separator, value] = separatorMatch
  const tokens: SyntaxToken[] = []
  pushToken(tokens, 'property', key)
  pushToken(tokens, 'operator', separator)
  pushToken(tokens, 'plain', value)

  const normalized = value.trim()
  if (TOML_KEYWORDS.has(normalized)) {
    tokens[tokens.length - 1] = { kind: 'boolean', value }
  } else if (/^["']/.test(normalized)) {
    tokens[tokens.length - 1] = { kind: 'string', value }
  } else if (NUMBER_RE.test(normalized)) {
    tokens[tokens.length - 1] = { kind: 'number', value }
  }

  if (comment) pushToken(tokens, 'comment', comment)
  return tokens
}

function tokenizeCssLine(line: string): SyntaxToken[] {
  if (/^\s*\/\*/.test(line)) return [{ kind: 'comment', value: line }]

  const propertyMatch = line.match(/^(\s*[-\w]+\s*)(:)(.*?)(;?\s*)$/)
  if (propertyMatch) {
    const [, property, separator, value, suffix] = propertyMatch
    return [
      { kind: 'property', value: property },
      { kind: 'operator', value: separator },
      ...tokenizeScriptLine(value, 'css'),
      { kind: 'punctuation', value: suffix }
    ]
  }

  const selectorMatch = line.match(/^(\s*[^{}]+)([{}])(\s*)$/)
  if (selectorMatch) {
    return [
      { kind: 'function', value: selectorMatch[1] },
      { kind: 'punctuation', value: selectorMatch[2] },
      { kind: 'plain', value: selectorMatch[3] }
    ]
  }

  return tokenizeScriptLine(line, 'css')
}

function tokenizeMarkdownLine(line: string): SyntaxToken[] {
  const headingMatch = line.match(/^(\s{0,3}#{1,6})(\s+.*)$/)
  if (headingMatch) {
    return [
      { kind: 'keyword', value: headingMatch[1] },
      { kind: 'plain', value: headingMatch[2] }
    ]
  }

  const listMatch = line.match(/^(\s*)([-*+]|\d+\.)(\s+.*)$/)
  if (listMatch) {
    return [
      { kind: 'plain', value: listMatch[1] },
      { kind: 'operator', value: listMatch[2] },
      { kind: 'plain', value: listMatch[3] }
    ]
  }

  const fenceMatch = line.match(/^(\s*`{3,}|~~~)(.*)$/)
  if (fenceMatch) {
    return [
      { kind: 'operator', value: fenceMatch[1] },
      { kind: 'type', value: fenceMatch[2] }
    ]
  }

  const linkMatch = line.match(/^(.*?)(!?)(\[[^\]]+\])(\([^)]+\))(.*)$/)
  if (linkMatch) {
    return [
      { kind: 'plain', value: linkMatch[1] },
      { kind: 'operator', value: linkMatch[2] },
      { kind: 'property', value: linkMatch[3] },
      { kind: 'string', value: linkMatch[4] },
      { kind: 'plain', value: linkMatch[5] }
    ]
  }

  return [{ kind: 'plain', value: line }]
}

export function languageForPath(path: string): SyntaxLanguage {
  const name = path.split('/').pop()?.toLowerCase() ?? path.toLowerCase()
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''

  if (extension === 'ts' || extension === 'tsx') return 'typescript'
  if (extension === 'js' || extension === 'jsx' || extension === 'mjs' || extension === 'cjs') {
    return 'javascript'
  }
  if (extension === 'py' || name === '.python-version') return 'python'
  if (extension === 'r') return 'r'
  if (extension === 'sh' || extension === 'bash' || extension === 'zsh') return 'shell'
  if (extension === 'json' || extension === 'jsonc') return 'json'
  if (extension === 'yaml' || extension === 'yml') return 'yaml'
  if (extension === 'toml') return 'toml'
  if (extension === 'css' || extension === 'scss' || extension === 'sass') return 'css'
  if (extension === 'md' || extension === 'markdown') return 'markdown'
  if (name === 'dockerfile' || name.endsWith('.dockerfile')) return 'shell'

  return 'plain'
}

export function highlightLine(line: string, language: SyntaxLanguage): SyntaxToken[] {
  if (!line) return [{ kind: 'plain', value: ' ' }]

  if (language === 'json') return tokenizeJsonLine(line)
  if (language === 'yaml' || language === 'toml') return tokenizeKeyValueLine(line, language)
  if (language === 'css') return tokenizeCssLine(line)
  if (language === 'markdown') return tokenizeMarkdownLine(line)
  if (
    language === 'typescript' ||
    language === 'javascript' ||
    language === 'python' ||
    language === 'r' ||
    language === 'shell'
  ) {
    return tokenizeScriptLine(line, language)
  }

  return [{ kind: 'plain', value: line }]
}
