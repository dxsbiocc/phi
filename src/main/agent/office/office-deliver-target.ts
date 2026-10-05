import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, realpath } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, parse, resolve } from 'node:path'

import type { OfficeDocumentKind } from '../../../shared/officeProtocol'
import { officeKindAdapter } from './office-kind-adapters'
import { OfficeSaveAsError } from './office-save-as-target'

export interface OfficeDeliveryDescriptor {
  readonly fileName: string
  readonly kind: OfficeDocumentKind
  readonly outputPath: string
}

export interface ResolvedOfficeDeliveryTarget extends OfficeDeliveryDescriptor {
  readonly absolutePath: string
  readonly exists: boolean
}

interface OfficeDeliveryTargetInput {
  readonly cwd: string
  readonly cwdRealPath: string
  readonly draftPath: string
  readonly kind: OfficeDocumentKind
  readonly operationId: string
  readonly outputName?: string
  readonly assertNotPrivate: (path: string) => Promise<void>
}

export async function resolveOfficeDeliveryTarget(
  input: OfficeDeliveryTargetInput
): Promise<ResolvedOfficeDeliveryTarget> {
  assertOperationId(input.operationId)
  const root = await resolveSafeCwd(input.cwd, input.cwdRealPath)
  const fileName = deliveryFileName(input)
  const absolutePath = join(root, fileName)
  await assertPublicPath(absolutePath, input.assertNotPrivate)
  return {
    absolutePath,
    fileName,
    kind: input.kind,
    outputPath: fileName,
    exists: await targetExists(absolutePath)
  }
}

export function assertOfficeDeliveryTargetMissing(target: ResolvedOfficeDeliveryTarget): void {
  if (target.exists) {
    throw new OfficeSaveAsError('target_exists', '目标文件已存在，不会覆盖')
  }
}

async function resolveSafeCwd(cwd: string, cwdRealPath: string): Promise<string> {
  if (!isAbsolute(cwd) || !isAbsolute(cwdRealPath)) throw outsideCwdError()
  try {
    const [stats, actual] = await Promise.all([lstat(cwd), realpath(cwd)])
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw outsideCwdError()
    if (resolve(actual) !== resolve(cwdRealPath)) throw outsideCwdError()
    await access(actual, constants.W_OK)
    return actual
  } catch (error) {
    if (error instanceof OfficeSaveAsError) throw error
    throw new OfficeSaveAsError('permission_denied', 'Office 交付目录不可写')
  }
}

function deliveryFileName(input: OfficeDeliveryTargetInput): string {
  const extension = officeKindAdapter(input.kind).extension
  if (input.outputName === undefined) {
    return defaultDeliveryFileName(input.draftPath, input.operationId, extension)
  }
  assertFileName(input.outputName)
  const requestedExtension = extname(input.outputName)
  if (requestedExtension && requestedExtension.toLowerCase() !== extension) {
    throw new OfficeSaveAsError('invalid_extension', `交付文件必须使用 ${extension} 扩展名`)
  }
  return requestedExtension ? input.outputName : `${input.outputName}${extension}`
}

function defaultDeliveryFileName(
  draftPath: string,
  operationId: string,
  extension: string
): string {
  const title = parse(basename(draftPath)).name
  const safeTitle = /[\\/]||\p{Cc}/u.test(title) || !title.trim() ? 'Office-output' : title.trim()
  const suffix = `-${stableSuffix(operationId)}${extension}`
  const maximum = 128 - [...suffix].length
  const fileName = `${[...safeTitle].slice(0, maximum).join('')}${suffix}`
  assertFileName(fileName)
  return fileName
}

function assertFileName(value: string): void {
  if (
    value.length === 0 ||
    value !== value.trim() ||
    [...value].length > 128 ||
    value === '.' ||
    value === '..' ||
    basename(value) !== value ||
    /[\\/]/u.test(value) ||
    /\p{Cc}/u.test(value)
  ) {
    throw new OfficeSaveAsError('invalid_name', '交付文件名无效')
  }
}

async function assertPublicPath(
  path: string,
  assertNotPrivate: (path: string) => Promise<void>
): Promise<void> {
  try {
    await assertNotPrivate(path)
  } catch {
    throw new OfficeSaveAsError('unsafe_path', '不能把 Office 交付文件写入会话私有草稿目录')
  }
}

async function targetExists(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) {
      throw new OfficeSaveAsError('unsafe_path', 'Office 交付目标不能是符号链接')
    }
    return true
  } catch (error) {
    if (error instanceof OfficeSaveAsError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new OfficeSaveAsError('permission_denied', '无法安全检查 Office 交付目标')
  }
}

function stableSuffix(operationId: string): string {
  return createHash('sha256').update(operationId).digest('hex').slice(0, 10)
}

function assertOperationId(value: string): void {
  if (!value || value.length > 200 || /\p{Cc}/u.test(value)) {
    throw new OfficeSaveAsError('operation_conflict', 'Office 交付请求缺少可信操作编号')
  }
}

function outsideCwdError(): OfficeSaveAsError {
  return new OfficeSaveAsError('outside_project', 'Office 交付目标必须位于当前工作目录')
}
