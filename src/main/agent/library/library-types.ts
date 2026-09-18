export const LIBRARY_SCHEMA_VERSION = 1

export type PriorityTier = 'must' | 'weekly' | 'radar' | 'drop'
export type ProcessingStage = 'discovered' | 'skimmed' | 'deep_read' | 'synthesized'
export type FullTextStatus = 'available' | 'unavailable' | 'not_attempted'
export type SavedPaperProvenance = 'manual' | 'auto'

export interface PaperIdentifier {
  kind: string
  value: string
}

export interface PaperLink {
  kind: string
  url: string
}

export interface PaperXref {
  targetId: string
  relation: string
}

export interface SavedPaper {
  canonicalId: string
  storageKey: string
  aliases: string[]
  source: string
  sourceId?: string
  title: string
  authors: string[]
  abstract?: string
  doi?: string
  identifiers: PaperIdentifier[]
  links: PaperLink[]
  priorityTier: PriorityTier
  processingStage: ProcessingStage
  tags: string[]
  notes?: string
  collectionId?: string
  provenance: SavedPaperProvenance
  xrefs: PaperXref[]
  savedAt: string
  updatedAt: string
  revision: number
  fullTextStatus: FullTextStatus
}

export interface LibraryIndex {
  schemaVersion: typeof LIBRARY_SCHEMA_VERSION
  createdAt: string
  updatedAt: string
  papers: SavedPaper[]
}

export interface SavePaperInput {
  source?: string
  sourceId?: string
  id?: string
  title?: string
  authors?: string[]
  abstract?: string
  doi?: string
  identifiers?: PaperIdentifier[]
  links?: PaperLink[]
  priorityTier?: PriorityTier
  processingStage?: ProcessingStage
  tags?: string[]
  notes?: string
  collectionId?: string
  provenance?: SavedPaperProvenance
  xrefs?: PaperXref[]
  fullTextStatus?: FullTextStatus
}

export interface UpdatePaperInput {
  priorityTier?: PriorityTier
  processingStage?: ProcessingStage
  tags?: string[]
  notes?: string
  collectionId?: string | null
  fullTextStatus?: FullTextStatus
  xrefs?: PaperXref[]
}

export interface LibraryListFilters {
  collectionId?: string
  processingStage?: ProcessingStage
  priorityTier?: PriorityTier
  tags?: string[]
}

export interface SavePaperResult {
  action: 'created' | 'updated'
  paper: SavedPaper
}

export interface RemovePaperResult {
  removed: boolean
  paper?: SavedPaper
}

export type LibraryAuditIssueCode =
  'duplicate_canonical_id' | 'orphan_xref' | 'missing_title' | 'missing_source'

export interface LibraryAuditIssue {
  code: LibraryAuditIssueCode
  severity: 'error' | 'warning'
  paperId?: string
  message: string
}

export interface LibraryAuditReport {
  checkedAt: string
  paperCount: number
  issueCount: number
  issues: LibraryAuditIssue[]
}
