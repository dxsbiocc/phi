import type { ProjectLocation } from '../../../shared/projectLocation'
import type { OfficeDocumentKind } from '../../../shared/officeProtocol'

export type OfficeFileErrorCode =
  | 'remote_not_supported'
  | 'invalid_extension'
  | 'source_not_found'
  | 'source_not_file'
  | 'source_not_allowed'
  | 'symlink_escape'
  | 'file_too_large'
  | 'workbook_too_large'
  | 'document_too_large'
  | 'inspection_failed'
  | 'session_not_found'
  | 'session_identity_mismatch'
  | 'invalid_name'
  | 'artifact_exists'
  | 'create_failed'
  | 'cleanup_failed'
  | 'cleanup_path_mismatch'
  | 'draft_not_found'
  | 'draft_not_file'
  | 'draft_path_mismatch'
  | 'draft_symlink'
  | 'private_draft_path'
  | 'draft_registration_invalid'
  | 'document_kind_mismatch'
  | 'copy_failed'

export class OfficeFileError extends Error {
  readonly code: OfficeFileErrorCode

  constructor(code: OfficeFileErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OfficeFileError'
    this.code = code
  }
}

interface OfficeArtifactIdentity {
  artifactId: string
  sessionId: string
  projectId: string | null
  draftPath: string
  kind: OfficeDocumentKind
  readOnly?: boolean
}

export interface OfficeSourceArtifact extends OfficeArtifactIdentity {
  origin?: 'source'
  sourcePath: string
  sourceHash: string
}

export interface OfficeBlankArtifact extends OfficeArtifactIdentity {
  origin: 'blank'
  sourcePath: null
  sourceHash: null
}

export interface OfficeImportSource {
  path: string
  format: 'csv' | 'tsv'
  delimiter: ',' | '\t'
  rows: number
  columns: number
  sha256: string
}

export interface OfficeImportedArtifact extends OfficeArtifactIdentity {
  kind: 'xlsx'
  origin: 'import'
  sourcePath: string
  sourceHash: string
  importSource: OfficeImportSource
}

export type OfficeCreatedArtifact = OfficeBlankArtifact | OfficeImportedArtifact
export type OfficeArtifact = OfficeSourceArtifact | OfficeBlankArtifact | OfficeImportedArtifact

export interface CreateOfficeDraftInput {
  sessionId: string
  projectId: string | null
  projectLocation?: ProjectLocation
  sourcePath: string
  allowRoots: readonly string[]
}

export interface CreateBlankOfficeDraftInput {
  sessionId: string
  projectId: string | null
  projectLocation?: ProjectLocation
  kind?: OfficeDocumentKind
  name?: string
}

export interface OfficeWorkbookDimensions {
  rows: number
  columns: number
}

export interface OfficeDocumentInspection {
  paragraphs: number
  sampleTexts: readonly string[]
}

export interface OfficePresentationInspection {
  slides: number
}

export interface OfficeFileDependencies {
  inspectWorkbook?: (draftPath: string) => Promise<OfficeWorkbookDimensions>
  inspectDocument?: (
    draftPath: string,
    kind: OfficeDocumentKind
  ) => Promise<OfficeWorkbookDimensions | OfficeDocumentInspection | OfficePresentationInspection>
  validatePackage?: (bytes: Buffer) => void
  artifactId?: () => string
}

export interface BlankOfficeFileDependencies {
  createWorkbook: (draftPath: string) => Promise<void>
  artifactId?: () => string
}
