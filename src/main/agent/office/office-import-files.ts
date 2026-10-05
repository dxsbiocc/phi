import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative } from 'node:path'

import type { ProjectLocation } from '../../../shared/projectLocation'
import { isLocalFilePathAllowedByRoots } from '../local-file-access'
import { getSessionDir } from '../session/session-store'
import {
  type OfficeImportedArtifact,
  OfficeFileError,
  type OfficeImportSource
} from './office-file-contract'
import {
  OfficeImportError,
  type OfficeDelimitedFormat,
  type OfficeImportCellValue,
  type OfficeImportExecutionControl
} from './office-import-contract'
import { parseOfficeDelimitedBytes } from './office-import-csv'
import { OFFICE_IMPORT_LIMITS } from './office-import-limits'
import { convertOfficeImportRows } from './office-import-values'
import {
  assertOfficeSessionIdentity,
  assertOfficeSourcePathIsNotPrivate,
  remoteOfficeNotSupported
} from './office-registered-draft'

export interface CreateImportedOfficeDraftInput {
  readonly sessionId: string
  readonly projectId: string | null
  readonly projectLocation?: ProjectLocation
  readonly sourcePath: string
  readonly allowRoots: readonly string[]
  readonly format: OfficeDelimitedFormat
}

export interface OfficeImportWorkbookInput {
  readonly draftPath: string
  readonly sheet: 'Sheet1'
  readonly values: readonly (readonly OfficeImportCellValue[])[]
  readonly rows: number
  readonly columns: number
}

export interface OfficeImportFileDependencies {
  readonly importWorkbook: (
    input: OfficeImportWorkbookInput,
    control: OfficeImportExecutionControl
  ) => Promise<void>
  readonly releaseWorkbook: (draftPath: string) => Promise<void>
  readonly artifactId?: () => string
}

interface PreparedOfficeImport {
  readonly artifact: OfficeImportedArtifact
  readonly realSource: string
  readonly sourceHash: string
  readonly workbook: OfficeImportWorkbookInput
}

function assertImportNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new OfficeImportError('import-cancelled', '已取消 CSV/TSV 导入')
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function changedSourceError(cause?: unknown): OfficeImportError {
  return new OfficeImportError(
    'source_changed_during_import',
    '导入期间源文件发生变化，请确认文件稳定后重试',
    undefined,
    cause === undefined ? undefined : { cause }
  )
}

async function readBoundedSource(path: string, recheck = false): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, 'r')
  } catch (error) {
    if (recheck) throw changedSourceError(error)
    throw new OfficeImportError('source_not_found', 'CSV/TSV 文件不存在', undefined, {
      cause: error
    })
  }
  try {
    const before = await handle.stat()
    if (!before.isFile()) {
      if (recheck) throw changedSourceError()
      throw new OfficeImportError('source_not_file', '导入来源必须是普通文件')
    }
    if (before.size > OFFICE_IMPORT_LIMITS.maxFileBytes) {
      if (recheck) throw changedSourceError()
      throw new OfficeImportError('import_too_large', '导入文件超过 5 MiB 上限')
    }
    const buffer = Buffer.allocUnsafe(
      Math.min(OFFICE_IMPORT_LIMITS.maxFileBytes + 1, before.size + 1)
    )
    let bytes = 0
    while (bytes < buffer.length) {
      const result = await handle.read(buffer, bytes, buffer.length - bytes, null)
      if (result.bytesRead === 0) break
      bytes += result.bytesRead
    }
    const after = await handle.stat()
    if (
      bytes > OFFICE_IMPORT_LIMITS.maxFileBytes ||
      after.size !== bytes ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      if (recheck || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw changedSourceError()
      }
      throw new OfficeImportError('import_too_large', '导入文件超过 5 MiB 上限')
    }
    return buffer.subarray(0, bytes)
  } finally {
    await handle.close()
  }
}

function assertFormatMatchesPath(path: string, format: OfficeDelimitedFormat): void {
  const extension = extname(path).toLowerCase()
  const accepted = format === 'csv' ? extension === '.csv' : ['.tsv', '.tab'].includes(extension)
  if (accepted) return
  throw new OfficeImportError(
    'invalid_extension',
    format === 'csv' ? 'CSV 导入只接受 .csv 文件' : 'TSV 导入只接受 .tsv 或 .tab 文件'
  )
}

async function allowedRealSource(
  sourcePath: string,
  roots: readonly string[]
): Promise<{ realSource: string; realRoots: readonly string[] }> {
  const realSource = await realpath(sourcePath)
  const realRoots = (
    await Promise.all(roots.map((root) => realpath(root).catch(() => undefined)))
  ).filter((root): root is string => root !== undefined)
  if (!isLocalFilePathAllowedByRoots(realSource, realRoots)) {
    throw new OfficeImportError('symlink_escape', '导入文件的真实路径超出允许的本地目录')
  }
  return { realSource, realRoots }
}

async function assertSourceFile(path: string): Promise<number> {
  let details: Awaited<ReturnType<typeof stat>>
  try {
    details = await stat(path)
  } catch (error) {
    throw new OfficeImportError('source_not_found', 'CSV/TSV 文件不存在', undefined, {
      cause: error
    })
  }
  if (!details.isFile()) throw new OfficeImportError('source_not_file', '导入来源必须是普通文件')
  if (details.size > OFFICE_IMPORT_LIMITS.maxFileBytes) {
    throw new OfficeImportError(
      'import_too_large',
      `导入文件为 ${details.size} 字节，超过 ${OFFICE_IMPORT_LIMITS.maxFileBytes} 字节上限`
    )
  }
  return details.size
}

function importedFilename(sourcePath: string): string {
  const sourceName = basename(sourcePath, extname(sourcePath)).normalize('NFC')
  const forbidden = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])
  const safeCharacters = Array.from(sourceName, (character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127 || forbidden.has(character) ? '_' : character
  }).join('')
  const cleaned = safeCharacters.replace(/\.{2,}/gu, '_').replace(/^[.\s]+|[.\s]+$/gu, '')
  const stem = [...(cleaned || '导入')].slice(0, 59).join('')
  return `${stem}.xlsx`
}

function displaySourcePath(realSource: string, realRoots: readonly string[]): string {
  const candidates = realRoots
    .filter((root) => isLocalFilePathAllowedByRoots(realSource, [root]))
    .map((root) => relative(root, realSource))
    .filter((path) => path.length > 0 && !path.startsWith('..'))
    .sort((left, right) => left.length - right.length)
  return candidates[0] ?? basename(realSource)
}

function importedArtifact(
  input: CreateImportedOfficeDraftInput,
  artifactId: string,
  sourceHash: string,
  importSource: OfficeImportSource
): OfficeImportedArtifact {
  if (!/^[A-Za-z0-9_-]+$/u.test(artifactId)) {
    throw new OfficeFileError('create_failed', 'Office 草稿编号无效')
  }
  const artifactDir = join(getSessionDir(input.sessionId), 'artifacts', 'office', artifactId)
  return {
    artifactId,
    sessionId: input.sessionId,
    projectId: input.projectId,
    kind: 'xlsx',
    origin: 'import',
    sourcePath: input.sourcePath,
    sourceHash,
    importSource,
    draftPath: join(artifactDir, importedFilename(input.sourcePath))
  }
}

async function createArtifactDirectory(artifact: OfficeImportedArtifact): Promise<string> {
  const artifactDir = dirname(artifact.draftPath)
  await mkdir(dirname(artifactDir), { recursive: true })
  try {
    await mkdir(artifactDir)
    return artifactDir
  } catch (error) {
    throw new OfficeFileError(
      (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'artifact_exists' : 'create_failed',
      '无法创建导入草稿目录',
      { cause: error }
    )
  }
}

async function cleanupFailedImport(
  artifactDir: string,
  draftPath: string,
  dependencies: OfficeImportFileDependencies
): Promise<void> {
  let failure: unknown
  try {
    await dependencies.releaseWorkbook(draftPath)
  } catch (error) {
    failure = error
  }
  try {
    await rm(artifactDir, { recursive: true, force: true })
  } catch (error) {
    failure ??= error
  }
  if (failure) {
    throw new OfficeImportError('import_failed', '导入失败且未能完整清理本次草稿', undefined, {
      cause: failure
    })
  }
}

async function prepareOfficeImport(
  input: CreateImportedOfficeDraftInput,
  dependencies: OfficeImportFileDependencies,
  control: OfficeImportExecutionControl
): Promise<PreparedOfficeImport> {
  assertImportNotCancelled(control.signal)
  if (input.projectLocation?.kind === 'ssh') throw remoteOfficeNotSupported()
  assertFormatMatchesPath(input.sourcePath, input.format)
  await assertOfficeSourcePathIsNotPrivate(input.sourcePath)
  if (!isLocalFilePathAllowedByRoots(input.sourcePath, input.allowRoots)) {
    throw new OfficeImportError('source_not_allowed', '没有权限读取此 CSV/TSV 文件')
  }
  await assertSourceFile(input.sourcePath)
  const { realSource, realRoots } = await allowedRealSource(input.sourcePath, input.allowRoots)
  assertOfficeSessionIdentity(input)
  const sourceBytes = await readBoundedSource(realSource)
  const parsed = parseOfficeDelimitedBytes(sourceBytes, input.format)
  assertImportNotCancelled(control.signal)
  const sourceHash = sha256(sourceBytes)
  const importSource: OfficeImportSource = {
    path: displaySourcePath(realSource, realRoots),
    format: input.format,
    delimiter: parsed.delimiter,
    rows: parsed.rows,
    columns: parsed.columns,
    sha256: sourceHash
  }
  const artifact = importedArtifact(
    input,
    (dependencies.artifactId ?? randomUUID)(),
    sourceHash,
    importSource
  )
  return {
    artifact,
    realSource,
    sourceHash,
    workbook: {
      draftPath: artifact.draftPath,
      sheet: 'Sheet1',
      values: convertOfficeImportRows(parsed.values),
      rows: parsed.rows,
      columns: parsed.columns
    }
  }
}

async function persistImportedOfficeDraft(
  prepared: PreparedOfficeImport,
  dependencies: OfficeImportFileDependencies,
  control: OfficeImportExecutionControl
): Promise<OfficeImportedArtifact> {
  const { artifact, realSource, sourceHash, workbook } = prepared
  const artifactDir = await createArtifactDirectory(artifact)
  control.onArtifactDir?.(artifactDir)
  control.onDraftPath?.(artifact.draftPath)
  try {
    await dependencies.importWorkbook(workbook, control)
    assertImportNotCancelled(control.signal)
    const draft = await stat(artifact.draftPath)
    if (!draft.isFile()) throw new OfficeImportError('import_failed', '导入未生成有效的 XLSX 草稿')
    if (sha256(await readBoundedSource(realSource, true)) !== sourceHash) {
      throw changedSourceError()
    }
    await writeFile(join(artifactDir, 'artifact.json'), `${JSON.stringify(artifact, null, 2)}\n`, {
      flag: 'wx'
    })
    return artifact
  } catch (error) {
    await cleanupFailedImport(artifactDir, artifact.draftPath, dependencies)
    throw error
  }
}

export async function createImportedOfficeDraft(
  input: CreateImportedOfficeDraftInput,
  dependencies: OfficeImportFileDependencies,
  control: OfficeImportExecutionControl = {}
): Promise<OfficeImportedArtifact> {
  const prepared = await prepareOfficeImport(input, dependencies, control)
  return persistImportedOfficeDraft(prepared, dependencies, control)
}
