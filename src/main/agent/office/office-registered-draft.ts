import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { isLocalFilePathAllowedByRoots } from '../local-file-access'
import { findPhiSessionById, getSessionDir, listPhiSessions } from '../session/session-store'
import {
  type CreateOfficeDraftInput,
  type OfficeArtifact,
  type OfficeBlankArtifact,
  OfficeFileError,
  type OfficeFileErrorCode
} from './office-file-contract'
import { officeArtifactKind, officeDocumentKindFromPath } from './office-document-kind'

export function remoteOfficeNotSupported(): OfficeFileError {
  return new OfficeFileError('remote_not_supported', '远程文件暂不支持 Office 实时预览')
}

export function assertOfficeSessionIdentity(
  input: Pick<CreateOfficeDraftInput, 'sessionId' | 'projectId' | 'projectLocation'>
): void {
  const session = findPhiSessionById(input.sessionId)
  if (!session) throw new OfficeFileError('session_not_found', 'Office 预览会话不存在')
  if (session.projectLocation?.kind === 'ssh') throw remoteOfficeNotSupported()
  if (session.projectId !== input.projectId) {
    throw new OfficeFileError('session_identity_mismatch', 'Office 文件与会话项目身份不匹配')
  }
}

function assertArtifactId(artifactId: string, code: OfficeFileErrorCode): void {
  if (!/^[A-Za-z0-9_-]+$/u.test(artifactId)) {
    throw new OfficeFileError(code, 'Office 草稿编号无效')
  }
}

async function registeredDraftStats(path: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  try {
    return await lstat(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new OfficeFileError('draft_not_found', '已登记的 Office 草稿不存在', { cause: error })
    }
    throw error
  }
}

export async function validateRegisteredOfficeDraft(
  artifact: OfficeArtifact,
  sessionId: string
): Promise<string> {
  if (artifact.sessionId !== sessionId) {
    throw new OfficeFileError('session_identity_mismatch', 'Office 草稿与当前会话身份不匹配')
  }
  assertArtifactId(artifact.artifactId, 'draft_path_mismatch')
  assertOfficeSessionIdentity(artifact)
  const officeRoot = join(getSessionDir(sessionId), 'artifacts', 'office')
  const artifactDir = join(officeRoot, artifact.artifactId)
  if (dirname(artifact.draftPath) !== artifactDir) {
    throw new OfficeFileError('draft_path_mismatch', 'Office 草稿路径与产物身份不匹配')
  }
  const [directoryStats, draftStats] = await Promise.all([
    registeredDraftStats(artifactDir),
    registeredDraftStats(artifact.draftPath)
  ])
  if (directoryStats.isSymbolicLink() || draftStats.isSymbolicLink()) {
    throw new OfficeFileError('draft_symlink', 'Office 草稿不能使用符号链接')
  }
  if (!directoryStats.isDirectory() || !draftStats.isFile()) {
    throw new OfficeFileError('draft_not_file', '已登记的 Office 草稿必须是普通文件')
  }
  const [realRoot, realArtifactDir, realDraft] = await Promise.all([
    realpath(officeRoot),
    realpath(artifactDir),
    realpath(artifact.draftPath)
  ])
  if (
    !isLocalFilePathAllowedByRoots(realArtifactDir, [realRoot]) ||
    dirname(realDraft) !== realArtifactDir
  ) {
    throw new OfficeFileError('draft_path_mismatch', 'Office 草稿路径与产物身份不匹配')
  }
  return realDraft
}

export async function loadRegisteredBlankOfficeDraft(
  input: CreateOfficeDraftInput
): Promise<OfficeBlankArtifact | undefined> {
  const officeRoot = join(getSessionDir(input.sessionId), 'artifacts', 'office')
  const candidatePath = resolve(input.sourcePath)
  const artifactDir = dirname(candidatePath)
  if (dirname(artifactDir) !== officeRoot) return undefined
  assertOfficeSessionIdentity(input)
  let value: unknown
  try {
    value = JSON.parse(await readFile(join(artifactDir, 'artifact.json'), 'utf8'))
  } catch (error) {
    throw invalidRegistration(error)
  }
  const artifact = registeredBlankArtifact(value, input, candidatePath)
  await validateRegisteredOfficeDraft(artifact, input.sessionId)
  return artifact
}

function registeredBlankArtifact(
  value: unknown,
  input: CreateOfficeDraftInput,
  candidatePath: string
): OfficeBlankArtifact {
  if (!isRecord(value) || value.origin !== 'blank') throw invalidRegistration()
  if (
    typeof value.artifactId !== 'string' ||
    value.sessionId !== input.sessionId ||
    value.projectId !== input.projectId ||
    value.sourcePath !== null ||
    value.sourceHash !== null ||
    typeof value.draftPath !== 'string' ||
    resolve(value.draftPath) !== candidatePath ||
    value.artifactId !== basename(dirname(candidatePath))
  ) {
    throw invalidRegistration()
  }
  assertArtifactId(value.artifactId, 'draft_registration_invalid')
  const kind = officeArtifactKind(value)
  if (officeDocumentKindFromPath(value.draftPath) !== kind) throw invalidRegistration()
  return {
    artifactId: value.artifactId,
    sessionId: input.sessionId,
    projectId: input.projectId,
    kind,
    origin: 'blank',
    sourcePath: null,
    sourceHash: null,
    draftPath: value.draftPath
  }
}

function invalidRegistration(cause?: unknown): OfficeFileError {
  return new OfficeFileError(
    'draft_registration_invalid',
    'Office 草稿登记记录无效，无法重新绑定',
    {
      cause
    }
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function knownOfficeArtifactRoots(): string[] {
  return listPhiSessions().map((session) =>
    join(getSessionDir(session.sessionId), 'artifacts', 'office')
  )
}

async function availableRealPaths(paths: readonly string[]): Promise<string[]> {
  const values = await Promise.all(paths.map((path) => realpath(path).catch(() => undefined)))
  return values.filter((path): path is string => path !== undefined)
}

export async function assertOfficeSourcePathIsNotPrivate(sourcePath: string): Promise<void> {
  const roots = knownOfficeArtifactRoots()
  if (isLocalFilePathAllowedByRoots(sourcePath, roots)) throw privatePathError()
  const realSource = await realpath(sourcePath).catch(() => undefined)
  if (!realSource) return
  const realRoots = await availableRealPaths(roots)
  if (isLocalFilePathAllowedByRoots(realSource, realRoots)) throw privatePathError()
}

function privatePathError(): OfficeFileError {
  return new OfficeFileError(
    'private_draft_path',
    '不能把 Phi 会话私有 Office 草稿作为来源文件重新打开'
  )
}
