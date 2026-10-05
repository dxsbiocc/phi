import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { isLocalFilePathAllowedByRoots } from '../local-file-access'
import { getSessionDir } from '../session/session-store'
import type { OfficeDocumentKind } from '../../../shared/officeProtocol'
import {
  type BlankOfficeFileDependencies,
  type CreateBlankOfficeDraftInput,
  type CreateOfficeDraftInput,
  type OfficeArtifact,
  type OfficeBlankArtifact,
  type OfficeCreatedArtifact,
  type OfficeFileDependencies,
  OfficeFileError,
  type OfficeFileErrorCode,
  type OfficeDocumentInspection,
  type OfficePresentationInspection,
  type OfficeWorkbookDimensions
} from './office-file-contract'
import {
  OFFICE_DOCUMENT_LIMITS,
  OFFICE_PRESENTATION_LIMITS,
  OFFICE_WORKBOOK_ADMISSION_LIMITS
} from './office-limits'
import { officeDocumentKindFromPath, parseOfficeDocumentKind } from './office-document-kind'
import { officeKindAdapter } from './office-kind-adapters'
import { OfficePptxPackageError } from './office-pptx-package'
import {
  assertOfficeSessionIdentity,
  assertOfficeSourcePathIsNotPrivate,
  remoteOfficeNotSupported
} from './office-registered-draft'

export type {
  BlankOfficeFileDependencies,
  CreateBlankOfficeDraftInput,
  CreateOfficeDraftInput,
  OfficeArtifact,
  OfficeBlankArtifact,
  OfficeCreatedArtifact,
  OfficeImportedArtifact,
  OfficeFileDependencies,
  OfficeFileErrorCode,
  OfficeDocumentInspection,
  OfficePresentationInspection,
  OfficeSourceArtifact,
  OfficeWorkbookDimensions
} from './office-file-contract'
export { OfficeFileError } from './office-file-contract'
export {
  assertOfficeSourcePathIsNotPrivate,
  loadRegisteredBlankOfficeDraft,
  validateRegisteredOfficeDraft
} from './office-registered-draft'

export const MAX_OFFICE_FILE_BYTES = 25 * 1024 * 1024
export const MAX_OFFICE_ROWS = OFFICE_WORKBOOK_ADMISSION_LIMITS.maxRows
export const MAX_OFFICE_COLUMNS = OFFICE_WORKBOOK_ADMISSION_LIMITS.maxColumns
export const MAX_OFFICE_CELLS = OFFICE_WORKBOOK_ADMISSION_LIMITS.maxCells
export const MAX_OFFICE_PARAGRAPHS = OFFICE_DOCUMENT_LIMITS.maxParagraphs
export const MAX_OFFICE_SLIDES = OFFICE_PRESENTATION_LIMITS.maxSlides

function assertArtifactId(artifactId: string, code: OfficeFileErrorCode): void {
  if (!/^[A-Za-z0-9_-]+$/.test(artifactId)) {
    throw new OfficeFileError(code, 'Office 草稿编号无效')
  }
}

function artifactFor(
  input: CreateOfficeDraftInput,
  artifactId: string,
  sourceHash: string
): OfficeArtifact {
  assertArtifactId(artifactId, 'copy_failed')
  const artifactDir = join(getSessionDir(input.sessionId), 'artifacts', 'office', artifactId)
  return {
    artifactId,
    sessionId: input.sessionId,
    projectId: input.projectId,
    kind: officeDocumentKindFromPath(input.sourcePath),
    sourcePath: input.sourcePath,
    sourceHash,
    draftPath: join(artifactDir, basename(input.sourcePath))
  }
}

function blankArtifactFor(
  input: CreateBlankOfficeDraftInput,
  artifactId: string,
  filename: string
): OfficeBlankArtifact {
  assertArtifactId(artifactId, 'create_failed')
  const artifactDir = join(getSessionDir(input.sessionId), 'artifacts', 'office', artifactId)
  return {
    artifactId,
    sessionId: input.sessionId,
    projectId: input.projectId,
    kind: parseOfficeDocumentKind(input.kind),
    origin: 'blank',
    sourcePath: null,
    sourceHash: null,
    draftPath: join(artifactDir, filename)
  }
}

function blankDraftFilename(kind: OfficeDocumentKind, name: string | undefined): string {
  const adapter = officeKindAdapter(kind)
  if (name === undefined) return adapter.defaultName
  const trimmed = name.trim()
  if (!trimmed) throw new OfficeFileError('invalid_name', `${adapter.displayName}名称不能为空`)
  if ([...trimmed].length > 64) {
    throw new OfficeFileError('invalid_name', `${adapter.displayName}名称不能超过 64 个字符`)
  }
  if (/[\\/]/.test(trimmed)) {
    throw new OfficeFileError('invalid_name', `${adapter.displayName}名称不能包含路径分隔符`)
  }
  if (/\p{Cc}/u.test(trimmed)) {
    throw new OfficeFileError('invalid_name', `${adapter.displayName}名称不能包含控制字符`)
  }
  if (trimmed.includes('..')) {
    throw new OfficeFileError('invalid_name', `${adapter.displayName}名称不能包含 ..`)
  }
  const extension = adapter.extension
  const lowerName = trimmed.toLowerCase()
  if (
    ['.xlsx', '.docx', '.pptx'].some((candidate) => lowerName.endsWith(candidate)) &&
    !lowerName.endsWith(extension)
  ) {
    throw new OfficeFileError('invalid_extension', `文件名必须使用 ${extension} 扩展名`)
  }
  return lowerName.endsWith(extension) ? trimmed : `${trimmed}${extension}`
}

async function sourceStats(sourcePath: string): Promise<Awaited<ReturnType<typeof stat>>> {
  try {
    return await stat(sourcePath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new OfficeFileError('source_not_found', 'Office 文件不存在', { cause: error })
    }
    throw error
  }
}

async function allowedRealSource(sourcePath: string, roots: readonly string[]): Promise<string> {
  const realSource = await realpath(sourcePath)
  for (const root of roots) {
    try {
      const realRoot = await realpath(root)
      if (isLocalFilePathAllowedByRoots(realSource, [realRoot])) return realSource
    } catch {
      // An unavailable allow-root cannot authorize a file.
    }
  }
  throw new OfficeFileError('symlink_escape', 'Office 文件的真实路径超出允许的本地目录')
}

async function persistBlankDraft(
  artifact: OfficeBlankArtifact,
  createWorkbook: BlankOfficeFileDependencies['createWorkbook']
): Promise<void> {
  const artifactDir = dirname(artifact.draftPath)
  await mkdir(dirname(artifactDir), { recursive: true })
  try {
    await mkdir(artifactDir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const failureCode = code === 'EEXIST' ? 'artifact_exists' : 'create_failed'
    throw new OfficeFileError(failureCode, '无法创建空白 Office 草稿目录', { cause: error })
  }
  try {
    await writeFile(join(artifactDir, 'artifact.json'), `${JSON.stringify(artifact, null, 2)}\n`, {
      flag: 'wx'
    })
    await createWorkbook(artifact.draftPath)
  } catch (error) {
    try {
      await rm(artifactDir, { recursive: true, force: true })
    } catch (cleanupError) {
      throw new OfficeFileError('cleanup_failed', '无法清理创建失败的空白 Office 草稿', {
        cause: cleanupError
      })
    }
    throw new OfficeFileError('create_failed', '无法创建空白 Office 草稿', { cause: error })
  }
}

async function inspectDraft(
  draftPath: string,
  kind: OfficeDocumentKind,
  dependencies: OfficeFileDependencies
): Promise<void> {
  let inspection: OfficeWorkbookDimensions | OfficeDocumentInspection | OfficePresentationInspection
  try {
    if (dependencies.inspectDocument) {
      inspection = await dependencies.inspectDocument(draftPath, kind)
    } else if (kind === 'xlsx' && dependencies.inspectWorkbook) {
      inspection = await dependencies.inspectWorkbook(draftPath)
    } else {
      throw new Error('missing document inspector')
    }
  } catch (error) {
    throw new OfficeFileError('inspection_failed', '无法检查 Office 文档内容', { cause: error })
  }
  if (kind === 'docx') return assertDocxInspection(inspection)
  if (kind === 'pptx') return assertPptxInspection(inspection)
  assertWorkbookInspection(inspection)
}

function assertWorkbookInspection(
  dimensions: OfficeWorkbookDimensions | OfficeDocumentInspection | OfficePresentationInspection
): void {
  if (!('rows' in dimensions) || !('columns' in dimensions)) {
    throw new OfficeFileError('inspection_failed', '工作簿数据范围检查结果无效')
  }
  if (![dimensions.rows, dimensions.columns].every(Number.isSafeInteger)) {
    throw new OfficeFileError('inspection_failed', '工作簿数据范围检查结果无效')
  }
  if (dimensions.rows < 0 || dimensions.columns < 0) {
    throw new OfficeFileError('inspection_failed', '工作簿数据范围检查结果无效')
  }
  const cells = dimensions.rows * dimensions.columns
  if (
    dimensions.rows > MAX_OFFICE_ROWS ||
    dimensions.columns > MAX_OFFICE_COLUMNS ||
    cells > MAX_OFFICE_CELLS
  ) {
    throw new OfficeFileError(
      'workbook_too_large',
      '工作簿数据范围超过 1,000 行 × 100 列且不超过 80,000 格的准入上限'
    )
  }
}

function assertDocxInspection(
  inspection: OfficeWorkbookDimensions | OfficeDocumentInspection | OfficePresentationInspection
): void {
  if (!('paragraphs' in inspection) || !Number.isSafeInteger(inspection.paragraphs)) {
    throw new OfficeFileError('inspection_failed', 'Word 文档段落检查结果无效')
  }
  if (inspection.paragraphs < 0) {
    throw new OfficeFileError('inspection_failed', 'Word 文档段落检查结果无效')
  }
  if (inspection.paragraphs > MAX_OFFICE_PARAGRAPHS) {
    throw new OfficeFileError('document_too_large', 'Word 文档超过 5,000 段上限')
  }
}

function assertPptxInspection(
  inspection: OfficeWorkbookDimensions | OfficeDocumentInspection | OfficePresentationInspection
): void {
  if (!('slides' in inspection) || !Number.isSafeInteger(inspection.slides)) {
    throw new OfficeFileError('inspection_failed', 'PowerPoint 幻灯片数量检查结果无效')
  }
  if (inspection.slides < 0) {
    throw new OfficeFileError('inspection_failed', 'PowerPoint 幻灯片数量检查结果无效')
  }
  if (inspection.slides > MAX_OFFICE_SLIDES) {
    throw new OfficeFileError('document_too_large', 'PowerPoint 演示文稿超过 200 张幻灯片上限')
  }
}

async function persistDraft(
  artifact: OfficeArtifact,
  bytes: Buffer,
  dependencies: OfficeFileDependencies
): Promise<void> {
  const artifactDir = dirname(artifact.draftPath)
  await mkdir(dirname(artifactDir), { recursive: true })
  try {
    await mkdir(artifactDir)
  } catch (error) {
    throw new OfficeFileError('copy_failed', '无法创建 Office 草稿目录', { cause: error })
  }
  try {
    await writeFile(artifact.draftPath, bytes, { flag: 'wx' })
    await inspectDraft(artifact.draftPath, artifact.kind, dependencies)
    await writeFile(join(artifactDir, 'artifact.json'), `${JSON.stringify(artifact, null, 2)}\n`, {
      flag: 'wx'
    })
  } catch (error) {
    await rm(artifactDir, { recursive: true, force: true })
    if (error instanceof OfficeFileError) throw error
    throw new OfficeFileError('copy_failed', '无法创建 Office 草稿', { cause: error })
  }
}

export async function createOfficeDraft(
  input: CreateOfficeDraftInput,
  dependencies: OfficeFileDependencies
): Promise<OfficeArtifact> {
  if (input.projectLocation?.kind === 'ssh') {
    throw remoteOfficeNotSupported()
  }
  let kind: OfficeDocumentKind
  try {
    kind = officeDocumentKindFromPath(input.sourcePath)
  } catch (error) {
    throw new OfficeFileError(
      'invalid_extension',
      '仅支持 .xlsx、.docx 或 .pptx 文件的 Office 实时预览',
      { cause: error }
    )
  }
  await assertOfficeSourcePathIsNotPrivate(input.sourcePath)
  if (!isLocalFilePathAllowedByRoots(input.sourcePath, input.allowRoots)) {
    throw new OfficeFileError('source_not_allowed', '没有权限读取此 Office 文件')
  }
  const stats = await sourceStats(input.sourcePath)
  if (!stats.isFile()) {
    throw new OfficeFileError('source_not_file', 'Office 文件必须是普通文件')
  }
  if (stats.size > MAX_OFFICE_FILE_BYTES) {
    throw new OfficeFileError('file_too_large', 'Office 文件超过 25 MB 上限')
  }
  const realSourcePath = await allowedRealSource(input.sourcePath, input.allowRoots)
  assertOfficeSessionIdentity(input)
  const bytes = await readFile(realSourcePath)
  if (bytes.length > MAX_OFFICE_FILE_BYTES) {
    throw new OfficeFileError('file_too_large', 'Office 文件超过 25 MB 上限')
  }
  try {
    dependencies.validatePackage?.(bytes)
  } catch (error) {
    if (error instanceof OfficePptxPackageError && error.code === 'too_many_slides') {
      throw new OfficeFileError('document_too_large', 'PowerPoint 演示文稿超过 200 张幻灯片上限', {
        cause: error
      })
    }
    throw new OfficeFileError(
      'inspection_failed',
      `Office 文件不是有效的${officeKindAdapter(kind).displayName}`,
      {
        cause: error
      }
    )
  }
  const sourceHash = createHash('sha256').update(bytes).digest('hex')
  const artifact = artifactFor(input, (dependencies.artifactId ?? randomUUID)(), sourceHash)
  await persistDraft(artifact, bytes, dependencies)
  return artifact
}

export async function createBlankOfficeDraft(
  input: CreateBlankOfficeDraftInput,
  dependencies: BlankOfficeFileDependencies
): Promise<OfficeBlankArtifact> {
  const kind = parseOfficeDocumentKind(input.kind)
  const filename = blankDraftFilename(kind, input.name)
  if (input.projectLocation?.kind === 'ssh') throw remoteOfficeNotSupported()
  assertOfficeSessionIdentity(input)
  const artifact = blankArtifactFor(input, (dependencies.artifactId ?? randomUUID)(), filename)
  await persistBlankDraft(artifact, dependencies.createWorkbook)
  return artifact
}

export async function removeCreatedOfficeDraft(artifact: OfficeCreatedArtifact): Promise<void> {
  assertArtifactId(artifact.artifactId, 'cleanup_path_mismatch')
  const expectedDir = join(
    getSessionDir(artifact.sessionId),
    'artifacts',
    'office',
    artifact.artifactId
  )
  if (dirname(artifact.draftPath) !== expectedDir) {
    throw new OfficeFileError('cleanup_path_mismatch', 'Office 草稿清理路径与产物身份不匹配')
  }
  try {
    await rm(expectedDir, { recursive: true, force: true })
  } catch (error) {
    throw new OfficeFileError('cleanup_failed', '无法清理空白 Office 草稿', { cause: error })
  }
}

export async function removeBlankOfficeDraft(artifact: OfficeBlankArtifact): Promise<void> {
  await removeCreatedOfficeDraft(artifact)
}
