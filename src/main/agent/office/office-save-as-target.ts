import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path'

import type { OfficeDocumentKind } from '../../../shared/officeProtocol'
import { isPathInsideRoot } from '../local-file-access'
import { officeKindAdapter } from './office-kind-adapters'

export type OfficeSaveAsErrorCode =
  | 'no_target'
  | 'target_missing'
  | 'session_mismatch'
  | 'outside_project'
  | 'invalid_extension'
  | 'invalid_name'
  | 'unsafe_path'
  | 'target_exists'
  | 'permission_denied'
  | 'copy_failed'
  | 'copy_verification_failed'
  | 'save_failed'
  | 'output_log_corrupt'
  | 'document_frozen'
  | 'document_read_only'
  | 'remote_not_supported'
  | 'approval_changed'
  | 'operation_conflict'
  | 'output_integrity_failed'
  | 'delivery_check_failed'
  | 'presentation_validation_failed'
  | 'save_as_cancelled'

export class OfficeSaveAsError extends Error {
  constructor(
    readonly code: OfficeSaveAsErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'OfficeSaveAsError'
  }
}

export interface ValidatedOfficeSaveAsTarget {
  readonly projectRoot: string
  readonly targetPath: string
  readonly outputPath: string
  readonly fileName: string
}

export async function validateOfficeSaveAsTarget(
  projectRoot: string,
  targetPath: string,
  kind: OfficeDocumentKind = 'xlsx'
): Promise<ValidatedOfficeSaveAsTarget> {
  if (!isAbsolute(projectRoot) || !isAbsolute(targetPath)) {
    throw new OfficeSaveAsError('outside_project', '另存目标必须位于当前项目内')
  }
  const target = resolve(targetPath)
  const requestedRoot = resolve(projectRoot)
  const fileName = basename(target)
  assertFileName(fileName)
  const extension = officeKindAdapter(kind).extension
  if (extname(fileName).toLowerCase() !== extension) {
    throw new OfficeSaveAsError('invalid_extension', `另存文件必须使用 ${extension} 扩展名`)
  }
  const [realRoot, realParent] = await Promise.all([
    resolveRealDirectory(projectRoot),
    resolveRealDirectory(dirname(target))
  ])
  const realTarget = resolve(realParent, fileName)
  // Containment is judged on real paths only. A lexical comparison against the registered root
  // would reject the same project spelled through a symlink (macOS /var -> /private/var), while
  // real-path checks already catch every symlink that points out of the project.
  if (!isPathInsideRoot(realRoot, realParent) || !isPathInsideRoot(realRoot, realTarget)) {
    throw new OfficeSaveAsError('outside_project', '另存目标必须位于当前项目内')
  }
  await assertTargetMissing(target)
  const outputPath = relative(realRoot, realTarget)
  if (!outputPath || outputPath.startsWith('..')) {
    throw new OfficeSaveAsError('outside_project', '另存目标必须位于当前项目内')
  }
  return { projectRoot: requestedRoot, targetPath: target, outputPath, fileName }
}

function assertFileName(fileName: string): void {
  if (
    fileName.length === 0 ||
    [...fileName].length > 128 ||
    fileName === '.' ||
    fileName === '..' ||
    /[\\/]/u.test(fileName) ||
    /\p{Cc}/u.test(fileName)
  ) {
    throw new OfficeSaveAsError('invalid_name', '另存文件名无效')
  }
}

async function resolveRealDirectory(path: string): Promise<string> {
  try {
    const [real, stats] = await Promise.all([realpath(path), stat(path)])
    if (!stats.isDirectory()) throw new Error('not directory')
    return real
  } catch {
    throw new OfficeSaveAsError('permission_denied', '另存目标目录不可用')
  }
}

async function assertTargetMissing(path: string): Promise<void> {
  try {
    await lstat(path)
    throw new OfficeSaveAsError('target_exists', '目标文件已存在，不会覆盖')
  } catch (error) {
    if (error instanceof OfficeSaveAsError) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new OfficeSaveAsError('permission_denied', '无法检查另存目标')
    }
  }
}
