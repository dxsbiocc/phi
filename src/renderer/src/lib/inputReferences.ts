import { absoluteWorkspacePath } from './workspacePaths'
import type { FileTreeEntry, PluginCatalogItem, PromptAgentSummary, SkillSummary } from '../types'

export type InputFileReferenceQuery = {
  start: number
  end: number
  query: string
}

export type InputReferenceReplacement = {
  value: string
  cursor: number
}

export type ParsedInputFileReferences = {
  references: string[]
  body: string
}

type DroppedInputFile = File & {
  path?: unknown
}

const INPUT_FILE_REFERENCE_LIMIT = 8
const INPUT_FILE_REFERENCE_STOP_CHARS = /[\s`]/
const INPUT_FILE_REFERENCE_LABEL = '引用文件：'
const INPUT_FILE_REFERENCE_BULLET_PATTERN = /^\s*-\s*`([^`]+)`\s*$/
const INPUT_FILE_REFERENCE_INLINE_PATTERN = /`([^`]+)`/g

function quotedPath(path: string): string {
  return `\`${path}\``
}

function uniqueReferences(references: string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const reference of references) {
    const trimmed = reference.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    unique.push(trimmed)
  }
  return unique
}

function trimLeadingBodyBoundaryNewlines(body: string): string {
  return body.replace(/^\n+/, '')
}

function removeInputReferenceQuery(input: string, range: InputFileReferenceQuery): string {
  const before = input.slice(0, range.start)
  let after = input.slice(range.end)

  if (!before) {
    after = after.replace(/^\s+/, '')
  } else if (/\s$/.test(before) && /^\s/.test(after)) {
    after = after.replace(/^\s+/, '')
  }

  return `${before}${after}`
}

function normalizeInputFileReferencePath(path: string): string | null {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\/+/, '')
  if (normalized.startsWith('/')) return null

  const parts = normalized.split('/')
  if (parts.some((part) => part === '.' || part === '..')) return null
  if (parts.some((part) => part.startsWith('.'))) return null
  return normalized
}

function splitInputFileReferenceQuery(query: string): { directory: string; leaf: string } | null {
  const normalized = normalizeInputFileReferencePath(query)
  if (normalized === null) return null
  if (!normalized) return { directory: '', leaf: '' }

  const parts = normalized.split('/')
  const endsWithSlash = normalized.endsWith('/')
  const directoryParts = endsWithSlash ? parts.filter(Boolean) : parts.slice(0, -1)
  const leaf = endsWithSlash ? '' : (parts.at(-1) ?? '')

  if (directoryParts.some((part) => !part)) return null
  return {
    directory: directoryParts.join('/'),
    leaf
  }
}

export function appendInputReference(input: string, reference: string): string {
  const trimmedReference = reference.trim()
  if (!trimmedReference) return input
  if (!input.trim()) return trimmedReference
  return `${input}${input.endsWith('\n') ? '' : '\n'}${trimmedReference}`
}

export function findActiveInputFileReference(
  input: string,
  cursorIndex: number
): InputFileReferenceQuery | null {
  const cursor = Math.max(0, Math.min(cursorIndex, input.length))
  const beforeCursor = input.slice(0, cursor)
  const atIndex = beforeCursor.lastIndexOf('@')
  if (atIndex === -1) return null

  const queryBeforeCursor = input.slice(atIndex + 1, cursor)
  if (INPUT_FILE_REFERENCE_STOP_CHARS.test(queryBeforeCursor)) return null

  return {
    start: atIndex,
    end: cursor,
    query: queryBeforeCursor
  }
}

export function inputFileReferenceDirectoryPath(cwd: string, query: string): string | null {
  const parts = splitInputFileReferenceQuery(query)
  if (!cwd || !parts) return null
  if (!parts.directory) return cwd
  return absoluteWorkspacePath(cwd, parts.directory)
}

export function inputFileReferenceLeafQuery(query: string): string {
  return splitInputFileReferenceQuery(query)?.leaf ?? ''
}

export function replaceInputReferenceRange(
  input: string,
  range: InputFileReferenceQuery,
  reference: string
): InputReferenceReplacement {
  const trimmedReference = reference.trim()
  if (!trimmedReference) return { value: input, cursor: range.end }

  const before = input.slice(0, range.start)
  const after = input.slice(range.end)
  if (trimmedReference.startsWith(INPUT_FILE_REFERENCE_LABEL)) {
    const body = removeInputReferenceQuery(input, range)
    return {
      value: body ? `${trimmedReference}\n${body}` : trimmedReference,
      cursor: Math.min(range.start, body.length)
    }
  }

  const leadingSeparator = before && !/\s$/.test(before) ? ' ' : ''
  const trailingSeparator = after && !/^\s/.test(after) ? ' ' : ''
  const value = `${before}${leadingSeparator}${trimmedReference}${trailingSeparator}${after}`

  return {
    value,
    cursor: before.length + leadingSeparator.length + trimmedReference.length
  }
}

export function formatInputFileReferences(paths: string[], cwd = ''): string {
  const references = uniqueReferences(
    paths.filter((path) => isVisibleInputFileReferencePath(path, cwd))
  )
  if (references.length === 0) return ''
  if (references.length === 1) return `${INPUT_FILE_REFERENCE_LABEL}${quotedPath(references[0])}`
  return [INPUT_FILE_REFERENCE_LABEL, ...references.map((path) => `- ${quotedPath(path)}`)].join(
    '\n'
  )
}

export function parseInputFileReferences(input: string): ParsedInputFileReferences {
  const references: string[] = []
  const bodyLines: string[] = []
  const lines = input.split('\n')

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmedLine = line.trim()
    if (!trimmedLine.startsWith(INPUT_FILE_REFERENCE_LABEL)) {
      bodyLines.push(line)
      continue
    }

    const inlineReferences = [...line.matchAll(INPUT_FILE_REFERENCE_INLINE_PATTERN)]
      .map((match) => match[1]?.trim() ?? '')
      .filter(Boolean)
    if (inlineReferences.length > 0) {
      references.push(...inlineReferences)
      continue
    }

    let consumedBullet = false
    while (index + 1 < lines.length) {
      const bulletMatch = INPUT_FILE_REFERENCE_BULLET_PATTERN.exec(lines[index + 1])
      if (!bulletMatch) break
      references.push(bulletMatch[1])
      index += 1
      consumedBullet = true
    }

    if (!consumedBullet && trimmedLine !== INPUT_FILE_REFERENCE_LABEL) {
      bodyLines.push(line)
    }
  }

  const unique = uniqueReferences(references)
  const body = bodyLines.join('\n')

  return {
    references: unique,
    body: unique.length > 0 ? trimLeadingBodyBoundaryNewlines(body) : body
  }
}

export function composeInputWithFileReferences(references: string[], body: string): string {
  const referenceText = formatInputFileReferences(references)
  if (!referenceText) return body
  if (body.length === 0) return referenceText
  return `${referenceText}\n${body}`
}

export function mergeInputFileReferences(existing: string[], next: string[]): string[] {
  return uniqueReferences([...existing, ...next])
}

export function inputFileReferencePathsFromDroppedFiles(
  files: File[],
  getPathForFile?: (file: File) => string
): string[] {
  return uniqueReferences(
    files
      .map((file) => inputFileReferencePathFromDroppedFile(file, getPathForFile))
      .filter((path): path is string => Boolean(path))
  )
}

export function formatInputFileReferenceTarget(entry: FileTreeEntry): string {
  const rawPath = entry.displayPath.trim() || entry.path.trim()
  const path =
    rawPath.startsWith('/') || rawPath.startsWith('./') || rawPath.startsWith('../')
      ? rawPath
      : `./${rawPath}`
  const directoryPath = entry.kind === 'directory' && !path.endsWith('/') ? `${path}/` : path
  return `引用文件：${quotedPath(directoryPath)}`
}

export function filterInputFileReferenceCandidates(
  entries: FileTreeEntry[],
  query: string,
  limit = INPUT_FILE_REFERENCE_LIMIT
): FileTreeEntry[] {
  const normalizedQuery = query.trim().toLowerCase()
  const visibleEntries = entries.filter((entry) => !isHiddenInputFileReferenceEntry(entry))
  const candidates = normalizedQuery
    ? visibleEntries.filter(
        (entry) =>
          entry.name.toLowerCase().includes(normalizedQuery) ||
          entry.displayPath.toLowerCase().includes(normalizedQuery)
      )
    : visibleEntries

  return candidates.slice(0, limit)
}

function isHiddenInputFileReferenceEntry(entry: FileTreeEntry): boolean {
  const relativePath = entry.displayPath.trim() || entry.name.trim()
  const segments = inputFileReferencePathSegments(relativePath)
  if (entry.name) {
    segments.unshift(entry.name)
  }
  return segments.some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..')
}

function isVisibleInputFileReferencePath(path: string, cwd: string): boolean {
  const normalizedPath = path.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalizedPath) return false

  const normalizedCwd = cwd.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  let pathForHiddenCheck = normalizedPath
  if (normalizedCwd && normalizedPath.startsWith(`${normalizedCwd}/`)) {
    pathForHiddenCheck = normalizedPath.slice(normalizedCwd.length + 1)
  } else if (normalizedPath.startsWith('/')) {
    pathForHiddenCheck = normalizedPath.split('/').filter(Boolean).pop() ?? normalizedPath
  }

  return !inputFileReferencePathSegments(pathForHiddenCheck).some(
    (segment) => segment.startsWith('.') && segment !== '.' && segment !== '..'
  )
}

function inputFileReferencePathFromDroppedFile(
  file: File,
  getPathForFile?: (file: File) => string
): string | null {
  try {
    const bridgedPath = getPathForFile?.(file).trim()
    if (bridgedPath) return bridgedPath
  } catch {
    // Fall through to Electron's legacy File.path fallback.
  }

  const fallbackPath = (file as DroppedInputFile).path
  return typeof fallbackPath === 'string' && fallbackPath.trim() ? fallbackPath.trim() : null
}

function inputFileReferencePathSegments(path: string): string[] {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .split('/')
    .filter(Boolean)
}

export function formatSkillPromptReference(skill: Pick<SkillSummary, 'name'>): string {
  return `$${skill.name}`
}

export function formatPromptAgentReference(
  agent: Pick<PromptAgentSummary, 'name' | 'trigger'>
): string {
  return agent.trigger || `/prompts:${agent.name}`
}

export function formatPluginPromptReference(
  plugin: Pick<PluginCatalogItem, 'name' | 'source'>
): string {
  return `引用插件：${plugin.name}（${plugin.source}）`
}
