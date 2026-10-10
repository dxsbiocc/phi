import { fileIconForPath } from '../icons'
import { resolveLocalPath } from './localPaths'

export type LocalPathKind = 'file' | 'directory'

export type BareFileReferenceToken =
  | { kind: 'text'; text: string }
  | { kind: 'path'; text: string; absolutePath: string; pathKind: LocalPathKind }

export const LOCAL_PATH_STAT_BATCH_LIMIT = 128

const FILE_REFERENCE_NAME_PATTERN =
  /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}|[A-Z][A-Za-z0-9_-]*file)$/
const DOTFILE_REFERENCE_NAME_PATTERN = /^\.[A-Za-z0-9][A-Za-z0-9._-]*$/
const BARE_FILE_REFERENCE_PATTERN =
  /(^|[^\w./-])(\.[A-Za-z0-9][A-Za-z0-9._-]*|[A-Za-z0-9_-][A-Za-z0-9._-]*\.[A-Za-z][A-Za-z0-9_-]{0,15}|[A-Z][A-Za-z0-9_-]*file)(?=$|[`\s,;:!?。，、；：（()）)\]}+.])/g

function fileNameFromPath(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

export function localPathLabel(text: string, absolutePath: string): string {
  const trimmed = text.trim()
  const isPathLikeLabel =
    trimmed === absolutePath ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    (trimmed.includes('/') && !/\s/.test(trimmed))
  if (!trimmed || isPathLikeLabel) {
    return fileNameFromPath(absolutePath)
  }
  return trimmed
}

function decodedLocalHrefCandidate(href: string | undefined): string | null {
  if (!href) return null

  const withoutHash = href.split('#')[0]
  let decoded = withoutHash
  try {
    decoded = decodeURIComponent(withoutHash)
  } catch {
    decoded = withoutHash
  }

  const lineMatch = /^(.*):\d+$/.exec(decoded)
  return lineMatch?.[1] ?? decoded
}

export function localHrefToPath(href: string | undefined, cwd: string): string | null {
  const candidate = decodedLocalHrefCandidate(href)
  if (!candidate) return null
  return resolveLocalPath(candidate, cwd) ?? bareFileReferencePath(candidate, cwd)
}

export function isLocalPathHref(href: string | undefined): boolean {
  const candidate = decodedLocalHrefCandidate(href)
  if (!candidate || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(candidate)) return false
  return (
    candidate.startsWith('/') ||
    candidate.startsWith('./') ||
    candidate.startsWith('../') ||
    candidate.includes('/') ||
    isBareFileReference(candidate)
  )
}

export function stripLineReference(path: string): string {
  return /^(.*):\d+$/.exec(path)?.[1] ?? path
}

function normalizePathIdentity(path: string): string {
  const stripped = stripLineReference(path.trim())
  if (stripped === '/') return stripped
  return stripped.replace(/\/+$/, '')
}

export function localPathKindForReference(
  text: string,
  absolutePath: string,
  cwd: string,
  inferUnknownExtensionlessDirectory: boolean
): LocalPathKind {
  const visiblePath = stripLineReference(text.trim())
  if (visiblePath.endsWith('/')) return 'directory'

  const normalizedPath = normalizePathIdentity(absolutePath)
  if (cwd && normalizedPath === normalizePathIdentity(cwd)) return 'directory'
  if (!inferUnknownExtensionlessDirectory) return 'file'

  const icon = fileIconForPath(normalizedPath)
  const name = fileNameFromPath(normalizedPath)
  if (icon.kind === 'text' && name && !name.includes('.')) return 'directory'

  return 'file'
}

function isBareFileReference(path: string): boolean {
  if (!path || path.includes('\\') || /\s/.test(path) || path.endsWith('/')) return false
  if (path.startsWith('-')) return false

  const parts = path.split('/')
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) return false

  const name = parts[parts.length - 1]
  return FILE_REFERENCE_NAME_PATTERN.test(name) || DOTFILE_REFERENCE_NAME_PATTERN.test(name)
}

function bareFileReferencePath(text: string, cwd: string): string | null {
  if (!cwd || !isBareFileReference(text)) return null
  return resolveLocalPath(`./${text}`, cwd)
}

function bareFileReferenceCandidatePaths(text: string, cwd: string): string[] {
  const directPath = bareFileReferencePath(text, cwd)
  if (!directPath) return []

  if (!text.includes('/') && text.toLocaleLowerCase().endsWith('.ipynb')) {
    const notebookPath = resolveLocalPath(`./notebooks/${text}`, cwd)
    return notebookPath && notebookPath !== directPath ? [directPath, notebookPath] : [directPath]
  }

  return [directPath]
}

export function collectBareFileReferencePaths(text: string, cwd: string): string[] {
  if (!cwd) return []

  const paths: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(BARE_FILE_REFERENCE_PATTERN)) {
    const candidate = match[2] ?? ''
    for (const absolutePath of bareFileReferenceCandidatePaths(candidate, cwd)) {
      if (seen.has(absolutePath)) continue

      seen.add(absolutePath)
      paths.push(absolutePath)
      if (paths.length >= LOCAL_PATH_STAT_BATCH_LIMIT) break
    }
    if (paths.length >= LOCAL_PATH_STAT_BATCH_LIMIT) break
  }

  return paths
}

export function inlineCodeFilePath(text: string, cwd: string): string | null {
  const trimmed = text.trim()
  if (!trimmed || trimmed !== text || trimmed.includes('\n')) return null

  const withoutLine = stripLineReference(trimmed)
  return resolveLocalPath(withoutLine, cwd)
}

export function inlineCodeBareFilePath(text: string, cwd: string): string | null {
  const trimmed = text.trim()
  if (!trimmed || trimmed !== text || trimmed.includes('\n')) return null

  const withoutLine = stripLineReference(trimmed)
  return bareFileReferencePath(withoutLine, cwd)
}

export function matchedBareFileReference(
  text: string,
  cwd: string,
  localPathKinds: ReadonlyMap<string, LocalPathKind>
): { absolutePath: string; pathKind: LocalPathKind } | null {
  for (const absolutePath of bareFileReferenceCandidatePaths(text, cwd)) {
    const pathKind = localPathKinds.get(absolutePath)
    if (pathKind) return { absolutePath, pathKind }
  }

  return null
}

export function tokenizeBareFileReferences(
  text: string,
  cwd: string,
  localPathKinds: ReadonlyMap<string, LocalPathKind>
): BareFileReferenceToken[] {
  if (!cwd) return [{ kind: 'text', text }]

  const tokens: BareFileReferenceToken[] = []
  let cursor = 0

  for (const match of text.matchAll(BARE_FILE_REFERENCE_PATTERN)) {
    const leading = match[1] ?? ''
    const candidate = match[2] ?? ''
    const start = (match.index ?? 0) + leading.length
    const end = start + candidate.length
    const localPath = matchedBareFileReference(candidate, cwd, localPathKinds)
    if (!localPath) continue

    if (start > cursor) tokens.push({ kind: 'text', text: text.slice(cursor, start) })
    tokens.push({
      kind: 'path',
      text: candidate,
      absolutePath: localPath.absolutePath,
      pathKind: localPath.pathKind
    })
    cursor = end
  }

  if (cursor < text.length) tokens.push({ kind: 'text', text: text.slice(cursor) })
  return tokens.length > 0 ? tokens : [{ kind: 'text', text }]
}
