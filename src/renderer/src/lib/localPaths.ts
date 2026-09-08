export type LocalPathToken =
  { kind: 'text'; text: string } | { kind: 'path'; text: string; absolutePath: string }

const LOCAL_PATH_PATTERN = /((?:\/|\.{1,2}\/)[^\s"'`<>)\]]+)/g
const TRAILING_PUNCTUATION = /[.,;:!?，。；：！？]+$/
const ABSOLUTE_PATH_BOUNDARY = /[\s([{]/

function trimTrailingPunctuation(path: string): { path: string; suffix: string } {
  const match = TRAILING_PUNCTUATION.exec(path)
  if (!match) return { path, suffix: '' }
  return {
    path: path.slice(0, match.index),
    suffix: match[0]
  }
}

function normalizePath(path: string): string {
  const isAbsolute = path.startsWith('/')
  const parts: string[] = []

  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length > 0) {
        parts.pop()
      } else if (!isAbsolute) {
        parts.push(part)
      }
      continue
    }
    parts.push(part)
  }

  return `${isAbsolute ? '/' : ''}${parts.join('/')}` || (isAbsolute ? '/' : '.')
}

export function resolveLocalPath(path: string, cwd: string): string | null {
  if (path.startsWith('/')) return normalizePath(path)
  if (!cwd || (!path.startsWith('./') && !path.startsWith('../'))) return null
  return normalizePath(`${cwd.replace(/\/+$/, '')}/${path}`)
}

export function tokenizeLocalPaths(text: string, cwd: string): LocalPathToken[] {
  const tokens: LocalPathToken[] = []
  let lastIndex = 0

  for (const match of text.matchAll(LOCAL_PATH_PATTERN)) {
    const raw = match[0]
    const index = match.index ?? 0
    if (raw.startsWith('/') && index > 0 && !ABSOLUTE_PATH_BOUNDARY.test(text[index - 1])) {
      continue
    }
    const { path, suffix } = trimTrailingPunctuation(raw)
    const absolutePath = resolveLocalPath(path, cwd)
    if (!absolutePath || path.length === 0) continue

    if (index > lastIndex) {
      tokens.push({ kind: 'text', text: text.slice(lastIndex, index) })
    }
    tokens.push({ kind: 'path', text: path, absolutePath })
    if (suffix) {
      tokens.push({ kind: 'text', text: suffix })
    }
    lastIndex = index + raw.length
  }

  if (lastIndex < text.length) {
    tokens.push({ kind: 'text', text: text.slice(lastIndex) })
  }
  return tokens.length > 0 ? tokens : [{ kind: 'text', text }]
}
