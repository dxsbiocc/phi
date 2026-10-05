import { constants } from 'node:fs'
import { access, lstat, realpath } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'

import { isPathInsideRoot } from '../local-file-access'
import type { OfficeExportFormat } from './office-export-contract'
import { OfficeSaveAsError } from './office-save-as-target'

export interface ValidatedOfficeExportTarget {
  readonly projectRoot: string
  readonly targetPath: string
  readonly outputPath: string
  readonly fileName: string
  readonly realProjectRoot: string
  readonly parentPath: string
  readonly realParentPath: string
  readonly parentIdentity: { readonly dev: number; readonly ino: number }
}

export async function validateOfficeExportTarget(
  projectRoot: string,
  targetPath: string,
  format: OfficeExportFormat,
  assertNotPrivate: (path: string) => Promise<void> = async () => undefined
): Promise<ValidatedOfficeExportTarget> {
  if (!isAbsolute(projectRoot) || !isAbsolute(targetPath)) throw outsideProject()
  const root = resolve(projectRoot)
  const target = resolve(targetPath)
  const fileName = basename(target)
  assertFileName(fileName, format)
  const [realRoot, realParent] = await Promise.all([
    resolveRealRoot(root),
    resolveRealParent(dirname(target))
  ])
  const realTarget = resolve(realParent, fileName)
  if (!isPathInsideRoot(realRoot, realParent) || !isPathInsideRoot(realRoot, realTarget)) {
    throw outsideProject()
  }
  // The same project may arrive spelled through a symlink (macOS /var -> /private/var); real-path
  // containment above already rejects every link that leaves it, so the strict component walk only
  // applies to targets written in the root's own spelling.
  if (isPathInsideRoot(root, target)) await assertNoSymlinkComponents(root, dirname(target))
  await assertPublicPath(target, assertNotPrivate)
  await assertTargetMissing(target)
  const parentStats = await lstat(dirname(target))
  const outputPath = relative(realRoot, realTarget)
  if (!outputPath || outputPath.startsWith('..')) throw outsideProject()
  return {
    projectRoot: root,
    targetPath: target,
    outputPath,
    fileName,
    realProjectRoot: realRoot,
    parentPath: dirname(target),
    realParentPath: realParent,
    parentIdentity: { dev: parentStats.dev, ino: parentStats.ino }
  }
}

export async function assertOfficeExportTargetStable(
  target: ValidatedOfficeExportTarget
): Promise<void> {
  try {
    const [stats, realParent] = await Promise.all([
      lstat(target.parentPath),
      realpath(target.parentPath)
    ])
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      stats.dev !== target.parentIdentity.dev ||
      stats.ino !== target.parentIdentity.ino ||
      resolve(realParent) !== resolve(target.realParentPath) ||
      !isPathInsideRoot(target.realProjectRoot, realParent)
    ) {
      throw new Error('changed parent')
    }
  } catch {
    throw new OfficeSaveAsError('unsafe_path', '导出目标目录在操作期间发生变化')
  }
}

function assertFileName(fileName: string, format: OfficeExportFormat): void {
  if (
    !fileName ||
    fileName === '.' ||
    fileName === '..' ||
    [...fileName].length > 128 ||
    /[\\/]/u.test(fileName) ||
    /\p{Cc}/u.test(fileName)
  ) {
    throw new OfficeSaveAsError('invalid_name', '导出文件名无效')
  }
  if (extname(fileName).toLowerCase() !== `.${format}`) {
    throw new OfficeSaveAsError('invalid_extension', `导出文件必须使用 .${format} 扩展名`)
  }
}

async function resolveRealRoot(path: string): Promise<string> {
  try {
    // The session's own root may itself be reached through a symlink; it is trusted, and everything
    // below it is judged on real paths.
    const real = await realpath(path)
    const stats = await lstat(real)
    if (!stats.isDirectory()) throw new Error('unsafe root')
    await access(real, constants.W_OK)
    return real
  } catch {
    throw new OfficeSaveAsError('permission_denied', '导出目录不可写')
  }
}

async function resolveRealParent(path: string): Promise<string> {
  try {
    const real = await realpath(path)
    const stats = await lstat(real)
    if (!stats.isDirectory()) throw new Error('not directory')
    await access(real, constants.W_OK)
    return real
  } catch {
    throw new OfficeSaveAsError('permission_denied', '导出目标目录不可用')
  }
}

async function assertNoSymlinkComponents(root: string, parent: string): Promise<void> {
  const suffix = relative(root, parent)
  if (!suffix || suffix.startsWith('..')) return
  let current = root
  for (const component of suffix.split(sep)) {
    current = resolve(current, component)
    const stats = await lstat(current).catch(() => undefined)
    if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new OfficeSaveAsError('unsafe_path', '导出目标的父目录不能包含符号链接')
    }
  }
}

async function assertPublicPath(
  path: string,
  assertNotPrivate: (path: string) => Promise<void>
): Promise<void> {
  try {
    await assertNotPrivate(path)
  } catch {
    throw new OfficeSaveAsError('unsafe_path', '不能把导出文件写入会话私有草稿目录')
  }
}

async function assertTargetMissing(path: string): Promise<void> {
  try {
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) {
      throw new OfficeSaveAsError('unsafe_path', '导出目标不能是符号链接')
    }
    throw new OfficeSaveAsError('target_exists', '目标文件已存在，不会覆盖')
  } catch (error) {
    if (error instanceof OfficeSaveAsError) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new OfficeSaveAsError('permission_denied', '无法安全检查导出目标')
    }
  }
}

function outsideProject(): OfficeSaveAsError {
  return new OfficeSaveAsError('outside_project', '导出目标必须位于当前项目内')
}
