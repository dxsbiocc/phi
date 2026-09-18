import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { PHI_PROJECT_CONFIG_DIR_NAME } from '../runtime-paths'
import {
  LIBRARY_SCHEMA_VERSION,
  type FullTextStatus,
  type LibraryAuditIssue,
  type LibraryAuditReport,
  type LibraryIndex,
  type LibraryListFilters,
  type PaperIdentifier,
  type PaperLink,
  type PaperXref,
  type PriorityTier,
  type ProcessingStage,
  type RemovePaperResult,
  type SavePaperInput,
  type SavePaperResult,
  type SavedPaper,
  type SavedPaperProvenance,
  type UpdatePaperInput
} from './library-types'

const LIBRARY_DIR = 'library'
const PAPERS_DIR = 'papers'
const INDEX_FILE = 'index.json'
const META_FILE = 'meta.json'
const NOTE_FILE = 'note.md'

const PRIORITY_TIERS: PriorityTier[] = ['must', 'weekly', 'radar', 'drop']
const PROCESSING_STAGES: ProcessingStage[] = ['discovered', 'skimmed', 'deep_read', 'synthesized']
const FULL_TEXT_STATUSES: FullTextStatus[] = ['available', 'unavailable', 'not_attempted']
const PROVENANCE_VALUES: SavedPaperProvenance[] = ['manual', 'auto']

function nowIso(): string {
  return new Date().toISOString()
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function writeJsonFile(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
  renameSync(tmp, path)
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => normalizeWhitespace(item))
        .filter(Boolean)
    )
  )
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : fallback
}

function normalizeDoi(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .toLowerCase()
}

export function normalizeTitleForDedup(title: string): string {
  return title
    .normalize('NFKC')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[{}]/g, '')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .toLowerCase()
    .trim()
}

function sourceIdFromInput(input: SavePaperInput): string | undefined {
  return optionalString(input.sourceId) ?? optionalString(input.id)
}

function canonicalIdFor(input: SavePaperInput): string {
  const doi = optionalString(input.doi)
  if (doi) return `doi:${normalizeDoi(doi)}`

  const source = optionalString(input.source) ?? 'manual'
  const sourceId = sourceIdFromInput(input)
  if (sourceId) return `${source.toLowerCase()}:${sourceId.toLowerCase()}`

  const title = optionalString(input.title)
  if (title) return `title:${sha(normalizeTitleForDedup(title)).slice(0, 16)}`

  throw new Error('Saving a paper requires a title or source id')
}

function storageKeyFor(canonicalId: string): string {
  const slug = canonicalId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return `${slug || 'paper'}-${sha(canonicalId).slice(0, 12)}`
}

function paperIdentifiers(
  input: SavePaperInput,
  source: string,
  sourceId?: string
): PaperIdentifier[] {
  const identifiers = Array.isArray(input.identifiers)
    ? input.identifiers.filter(
        (item): item is PaperIdentifier =>
          typeof item?.kind === 'string' &&
          item.kind.trim().length > 0 &&
          typeof item.value === 'string' &&
          item.value.trim().length > 0
      )
    : []

  const doi = optionalString(input.doi)
  if (doi) identifiers.push({ kind: 'doi', value: normalizeDoi(doi) })
  if (sourceId) identifiers.push({ kind: `source:${source}`, value: sourceId })

  const seen = new Set<string>()
  return identifiers.filter((identifier) => {
    const key = `${identifier.kind.toLowerCase()}\0${identifier.value.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function paperLinks(input: SavePaperInput): PaperLink[] {
  if (!Array.isArray(input.links)) return []
  return input.links.filter(
    (item): item is PaperLink =>
      typeof item?.kind === 'string' &&
      item.kind.trim().length > 0 &&
      typeof item.url === 'string' &&
      item.url.trim().length > 0
  )
}

function paperXrefs(value: unknown): PaperXref[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is PaperXref =>
      typeof item?.targetId === 'string' &&
      item.targetId.trim().length > 0 &&
      typeof item.relation === 'string' &&
      item.relation.trim().length > 0
  )
}

function mergeStrings(current: string[], next: string[]): string[] {
  return Array.from(new Set([...current, ...next]))
}

function mergeIdentifiers(current: PaperIdentifier[], next: PaperIdentifier[]): PaperIdentifier[] {
  const seen = new Set<string>()
  return [...current, ...next].filter((identifier) => {
    const key = `${identifier.kind.toLowerCase()}\0${identifier.value.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function createEmptyIndex(timestamp = nowIso()): LibraryIndex {
  return {
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
    papers: []
  }
}

function getIndexPath(projectCwd: string): string {
  return join(getProjectLibraryDir(projectCwd), INDEX_FILE)
}

function getPaperDir(projectCwd: string, paper: Pick<SavedPaper, 'storageKey'>): string {
  return join(getProjectLibraryDir(projectCwd), PAPERS_DIR, paper.storageKey)
}

function readIndex(projectCwd: string): LibraryIndex {
  const indexPath = getIndexPath(projectCwd)
  if (!existsSync(indexPath)) return createEmptyIndex()
  const parsed = JSON.parse(readFileSync(indexPath, 'utf-8')) as LibraryIndex
  if (parsed.schemaVersion !== LIBRARY_SCHEMA_VERSION || !Array.isArray(parsed.papers)) {
    throw new Error('Unsupported literature library index schema')
  }
  return parsed
}

function writeIndex(projectCwd: string, index: LibraryIndex): void {
  const libraryDir = getProjectLibraryDir(projectCwd)
  ensureDir(join(libraryDir, PAPERS_DIR))
  writeJsonFile(getIndexPath(projectCwd), index)
}

function writePaperProjection(projectCwd: string, paper: SavedPaper): void {
  const paperDir = getPaperDir(projectCwd, paper)
  ensureDir(paperDir)
  writeJsonFile(join(paperDir, META_FILE), paper)
  writeFileSync(join(paperDir, NOTE_FILE), noteMarkdown(paper), 'utf-8')
}

function noteMarkdown(paper: SavedPaper): string {
  const lines = [
    '---',
    `canonicalId: ${JSON.stringify(paper.canonicalId)}`,
    `source: ${JSON.stringify(paper.source)}`,
    paper.sourceId ? `sourceId: ${JSON.stringify(paper.sourceId)}` : undefined,
    paper.doi ? `doi: ${JSON.stringify(paper.doi)}` : undefined,
    `priorityTier: ${paper.priorityTier}`,
    `processingStage: ${paper.processingStage}`,
    `fullTextStatus: ${paper.fullTextStatus}`,
    `tags: ${JSON.stringify(paper.tags)}`,
    paper.collectionId ? `collectionId: ${JSON.stringify(paper.collectionId)}` : undefined,
    '---',
    '',
    `# ${paper.title}`,
    '',
    paper.authors.length > 0 ? `Authors: ${paper.authors.join(', ')}` : undefined,
    paper.abstract ? `\n## Abstract\n\n${paper.abstract}` : undefined,
    `\n## Notes\n\n${paper.notes ?? ''}`
  ].filter((line): line is string => line !== undefined)
  return `${lines.join('\n')}\n`
}

function findExactDuplicate(
  index: LibraryIndex,
  input: SavePaperInput,
  canonicalId: string
): SavedPaper | undefined {
  const titleKey = optionalString(input.title)
    ? normalizeTitleForDedup(optionalString(input.title) ?? '')
    : undefined
  const doi = optionalString(input.doi)
  const normalizedDoi = doi ? normalizeDoi(doi) : undefined

  return index.papers.find((paper) => {
    if (paper.canonicalId === canonicalId || paper.aliases.includes(canonicalId)) return true
    if (normalizedDoi && paper.doi && normalizeDoi(paper.doi) === normalizedDoi) return true
    if (normalizedDoi) {
      const matchesDoi = paper.identifiers.some(
        (identifier) =>
          identifier.kind.toLowerCase() === 'doi' &&
          identifier.value.toLowerCase() === normalizedDoi
      )
      if (matchesDoi) return true
    }
    return Boolean(titleKey && normalizeTitleForDedup(paper.title) === titleKey)
  })
}

function mergePaper(
  existing: SavedPaper,
  input: SavePaperInput,
  canonicalId: string,
  timestamp: string
): SavedPaper {
  const source = optionalString(input.source) ?? existing.source
  const sourceId = sourceIdFromInput(input) ?? existing.sourceId
  const identifiers = paperIdentifiers(input, source, sourceId)
  const aliases =
    existing.canonicalId === canonicalId
      ? existing.aliases
      : mergeStrings(existing.aliases, [canonicalId])

  return {
    ...existing,
    aliases,
    source,
    ...(sourceId ? { sourceId } : {}),
    title: optionalString(input.title) ?? existing.title,
    authors: input.authors !== undefined ? stringArray(input.authors) : existing.authors,
    ...(optionalString(input.abstract) ? { abstract: optionalString(input.abstract) } : {}),
    ...(optionalString(input.doi) ? { doi: normalizeDoi(optionalString(input.doi) ?? '') } : {}),
    identifiers: mergeIdentifiers(existing.identifiers, identifiers),
    links: [...existing.links, ...paperLinks(input)],
    priorityTier: enumValue(input.priorityTier, PRIORITY_TIERS, existing.priorityTier),
    processingStage: enumValue(input.processingStage, PROCESSING_STAGES, existing.processingStage),
    tags: input.tags !== undefined ? stringArray(input.tags) : existing.tags,
    notes: optionalString(input.notes) ?? existing.notes,
    collectionId: optionalString(input.collectionId) ?? existing.collectionId,
    provenance: enumValue(input.provenance, PROVENANCE_VALUES, existing.provenance),
    xrefs: input.xrefs !== undefined ? paperXrefs(input.xrefs) : existing.xrefs,
    updatedAt: timestamp,
    revision: existing.revision + 1,
    fullTextStatus: enumValue(input.fullTextStatus, FULL_TEXT_STATUSES, existing.fullTextStatus)
  }
}

function createPaper(input: SavePaperInput, canonicalId: string, timestamp: string): SavedPaper {
  const source = optionalString(input.source) ?? 'manual'
  const sourceId = sourceIdFromInput(input)
  const title = optionalString(input.title)
  if (!title) throw new Error('Saving a paper requires a title')

  return {
    canonicalId,
    storageKey: storageKeyFor(canonicalId),
    aliases: [],
    source,
    ...(sourceId ? { sourceId } : {}),
    title,
    authors: stringArray(input.authors),
    ...(optionalString(input.abstract) ? { abstract: optionalString(input.abstract) } : {}),
    ...(optionalString(input.doi) ? { doi: normalizeDoi(optionalString(input.doi) ?? '') } : {}),
    identifiers: paperIdentifiers(input, source, sourceId),
    links: paperLinks(input),
    priorityTier: enumValue(input.priorityTier, PRIORITY_TIERS, 'radar'),
    processingStage: enumValue(input.processingStage, PROCESSING_STAGES, 'discovered'),
    tags: stringArray(input.tags),
    ...(optionalString(input.notes) ? { notes: optionalString(input.notes) } : {}),
    ...(optionalString(input.collectionId)
      ? { collectionId: optionalString(input.collectionId) }
      : {}),
    provenance: enumValue(input.provenance, PROVENANCE_VALUES, 'manual'),
    xrefs: paperXrefs(input.xrefs),
    savedAt: timestamp,
    updatedAt: timestamp,
    revision: 1,
    fullTextStatus: enumValue(input.fullTextStatus, FULL_TEXT_STATUSES, 'not_attempted')
  }
}

function matchesFilters(paper: SavedPaper, filters: LibraryListFilters): boolean {
  if (filters.collectionId && paper.collectionId !== filters.collectionId) return false
  if (filters.processingStage && paper.processingStage !== filters.processingStage) return false
  if (filters.priorityTier && paper.priorityTier !== filters.priorityTier) return false
  if (filters.tags?.length) {
    const tags = new Set(paper.tags)
    if (!filters.tags.every((tag) => tags.has(tag))) return false
  }
  return true
}

function matchesPaperId(paper: SavedPaper, id: string): boolean {
  const normalized = id.trim().toLowerCase()
  return (
    paper.canonicalId.toLowerCase() === normalized ||
    paper.aliases.some((alias) => alias.toLowerCase() === normalized) ||
    paper.identifiers.some((identifier) => identifier.value.toLowerCase() === normalized)
  )
}

function searchableText(paper: SavedPaper): string {
  return [
    paper.title,
    ...paper.authors,
    paper.abstract,
    paper.doi,
    paper.notes,
    paper.collectionId,
    ...paper.tags,
    ...paper.identifiers.map((identifier) => `${identifier.kind} ${identifier.value}`)
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

export function getProjectLibraryDir(projectCwd: string): string {
  return join(projectCwd, PHI_PROJECT_CONFIG_DIR_NAME, LIBRARY_DIR)
}

export function listPapers(projectCwd: string, filters: LibraryListFilters = {}): SavedPaper[] {
  return readIndex(projectCwd).papers.filter((paper) => matchesFilters(paper, filters))
}

export function findPapers(
  projectCwd: string,
  query: string,
  filters: LibraryListFilters = {}
): SavedPaper[] {
  const needle = query.trim().toLowerCase()
  return listPapers(projectCwd, filters).filter((paper) => {
    if (!needle) return true
    return searchableText(paper).includes(needle)
  })
}

export function savePaper(projectCwd: string, input: SavePaperInput): SavePaperResult {
  const timestamp = nowIso()
  const index = readIndex(projectCwd)
  const canonicalId = canonicalIdFor(input)
  const existing = findExactDuplicate(index, input, canonicalId)
  const paper = existing
    ? mergePaper(existing, input, canonicalId, timestamp)
    : createPaper(input, canonicalId, timestamp)
  const action: SavePaperResult['action'] = existing ? 'updated' : 'created'
  const papers = existing
    ? index.papers.map((item) => (item.canonicalId === existing.canonicalId ? paper : item))
    : [...index.papers, paper]

  writeIndex(projectCwd, { ...index, updatedAt: timestamp, papers })
  writePaperProjection(projectCwd, paper)
  return { action, paper }
}

export function updatePaper(projectCwd: string, id: string, patch: UpdatePaperInput): SavedPaper {
  const timestamp = nowIso()
  const index = readIndex(projectCwd)
  const existing = index.papers.find((paper) => matchesPaperId(paper, id))
  if (!existing) throw new Error(`Paper not found: ${id}`)

  const next: SavedPaper = {
    ...existing,
    priorityTier: enumValue(patch.priorityTier, PRIORITY_TIERS, existing.priorityTier),
    processingStage: enumValue(patch.processingStage, PROCESSING_STAGES, existing.processingStage),
    tags: patch.tags !== undefined ? stringArray(patch.tags) : existing.tags,
    notes: patch.notes === undefined ? existing.notes : (optionalString(patch.notes) ?? undefined),
    collectionId:
      patch.collectionId === undefined
        ? existing.collectionId
        : (optionalString(patch.collectionId) ?? undefined),
    fullTextStatus: enumValue(patch.fullTextStatus, FULL_TEXT_STATUSES, existing.fullTextStatus),
    xrefs: patch.xrefs !== undefined ? paperXrefs(patch.xrefs) : existing.xrefs,
    updatedAt: timestamp,
    revision: existing.revision + 1
  }

  writeIndex(projectCwd, {
    ...index,
    updatedAt: timestamp,
    papers: index.papers.map((paper) => (paper.canonicalId === existing.canonicalId ? next : paper))
  })
  writePaperProjection(projectCwd, next)
  return next
}

export function removePaper(projectCwd: string, id: string): RemovePaperResult {
  const timestamp = nowIso()
  const index = readIndex(projectCwd)
  const existing = index.papers.find((paper) => matchesPaperId(paper, id))
  if (!existing) return { removed: false }
  writeIndex(projectCwd, {
    ...index,
    updatedAt: timestamp,
    papers: index.papers.filter((paper) => paper.canonicalId !== existing.canonicalId)
  })
  rmSync(getPaperDir(projectCwd, existing), { recursive: true, force: true })
  return { removed: true, paper: existing }
}

export function auditLibrary(projectCwd: string): LibraryAuditReport {
  const index = readIndex(projectCwd)
  const issues: LibraryAuditIssue[] = []
  const ids = new Map<string, number>()
  const validIds = new Set<string>()

  for (const paper of index.papers) {
    ids.set(paper.canonicalId, (ids.get(paper.canonicalId) ?? 0) + 1)
    validIds.add(paper.canonicalId)
    for (const alias of paper.aliases) validIds.add(alias)
  }

  for (const [id, count] of ids) {
    if (count > 1) {
      issues.push({
        code: 'duplicate_canonical_id',
        severity: 'error',
        paperId: id,
        message: `Duplicate canonical id: ${id}`
      })
    }
  }

  for (const paper of index.papers) {
    if (!paper.title.trim()) {
      issues.push({
        code: 'missing_title',
        severity: 'error',
        paperId: paper.canonicalId,
        message: `Paper has no title: ${paper.canonicalId}`
      })
    }
    if (!paper.source.trim()) {
      issues.push({
        code: 'missing_source',
        severity: 'warning',
        paperId: paper.canonicalId,
        message: `Paper has no source: ${paper.canonicalId}`
      })
    }
    for (const xref of paper.xrefs) {
      if (!validIds.has(xref.targetId)) {
        issues.push({
          code: 'orphan_xref',
          severity: 'warning',
          paperId: paper.canonicalId,
          message: `Paper ${paper.canonicalId} references missing paper ${xref.targetId}`
        })
      }
    }
  }

  return {
    checkedAt: nowIso(),
    paperCount: index.papers.length,
    issueCount: issues.length,
    issues
  }
}
