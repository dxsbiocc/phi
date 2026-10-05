import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

import { OfficeExportError } from './office-export-contract'
import { OfficeSaveAsError } from './office-save-as-target'

export interface OfficeDelimitedOutputVerification {
  readonly sha256: string
  readonly size: number
}

interface OfficeDelimitedOutputInput {
  readonly targetPath: string
  readonly bytes: Buffer
  readonly signal: AbortSignal
  readonly assertTargetStable?: () => Promise<void>
  readonly beginCommit?: () => void
}

interface OfficeDelimitedOutputDependencies {
  readonly randomId?: () => string
  readonly readFile?: typeof readFile
  readonly writeFile?: typeof writeFile
  readonly link?: typeof link
  readonly lstat?: typeof lstat
  readonly rm?: typeof rm
}

export async function createOfficeDelimitedOutput<T>(
  input: OfficeDelimitedOutputInput,
  record: (verification: OfficeDelimitedOutputVerification) => Promise<T> | T,
  dependencies: OfficeDelimitedOutputDependencies = {}
): Promise<T> {
  assertNotAborted(input.signal)
  const tempPath = temporaryPath(input.targetPath, dependencies.randomId ?? randomUUID)
  let tempCreated = false
  let finalLinked = false
  let finalIdentity: { dev: number; ino: number } | undefined
  try {
    await input.assertTargetStable?.()
    await (dependencies.writeFile ?? writeFile)(tempPath, input.bytes, {
      flag: 'wx',
      mode: 0o600,
      signal: input.signal
    })
    tempCreated = true
    const tempStats = await (dependencies.lstat ?? lstat)(tempPath)
    finalIdentity = { dev: tempStats.dev, ino: tempStats.ino }
    await verifyBytes(tempPath, input, dependencies)
    assertNotAborted(input.signal)
    await input.assertTargetStable?.()
    await publish(tempPath, input.targetPath, dependencies)
    finalLinked = true
    await input.assertTargetStable?.()
    await assertPublishedIdentity(input.targetPath, finalIdentity, dependencies)
    await verifyBytes(input.targetPath, input, dependencies)
    assertNotAborted(input.signal)
    await (dependencies.rm ?? rm)(tempPath, { force: true })
    tempCreated = false
    assertNotAborted(input.signal)
    input.beginCommit?.()
    return await record({ sha256: digest(input.bytes), size: input.bytes.length })
  } catch (error) {
    if (finalLinked && (await sameFile(input.targetPath, finalIdentity, dependencies))) {
      await (dependencies.rm ?? rm)(input.targetPath, { force: true }).catch(() => undefined)
    }
    if (tempCreated) await (dependencies.rm ?? rm)(tempPath, { force: true }).catch(() => undefined)
    throw mapOutputError(error, input.signal)
  }
}

async function assertPublishedIdentity(
  path: string,
  expected: { dev: number; ino: number },
  dependencies: OfficeDelimitedOutputDependencies
): Promise<void> {
  const stats = await (dependencies.lstat ?? lstat)(path)
  if (stats.isSymbolicLink() || stats.dev !== expected.dev || stats.ino !== expected.ino) {
    throw new OfficeExportError('export_verification_failed', '导出文件身份校验失败')
  }
}

function temporaryPath(targetPath: string, randomId: () => string): string {
  const extension = extname(targetPath)
  return join(dirname(targetPath), `.${basename(targetPath)}.phi-${randomId()}.tmp${extension}`)
}

async function verifyBytes(
  path: string,
  input: OfficeDelimitedOutputInput,
  dependencies: OfficeDelimitedOutputDependencies
): Promise<void> {
  const bytes = await (dependencies.readFile ?? readFile)(path, { signal: input.signal })
  if (!bytes.equals(input.bytes)) {
    throw new OfficeExportError('export_verification_failed', '导出文件回读校验失败')
  }
}

async function publish(
  tempPath: string,
  targetPath: string,
  dependencies: OfficeDelimitedOutputDependencies
): Promise<void> {
  try {
    await (dependencies.link ?? link)(tempPath, targetPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new OfficeSaveAsError('target_exists', '目标文件已存在，不会覆盖')
    }
    throw error
  }
}

async function sameFile(
  path: string,
  expected: { dev: number; ino: number } | undefined,
  dependencies: OfficeDelimitedOutputDependencies
): Promise<boolean> {
  if (!expected) return false
  try {
    const stats = await (dependencies.lstat ?? lstat)(path)
    return !stats.isSymbolicLink() && stats.dev === expected.dev && stats.ino === expected.ino
  } catch {
    return false
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new OfficeExportError('export_cancelled', '导出操作已取消')
}

function mapOutputError(error: unknown, signal: AbortSignal): unknown {
  if (signal.aborted || (error as NodeJS.ErrnoException).code === 'ABORT_ERR') {
    return new OfficeExportError('export_cancelled', '导出操作已取消')
  }
  if (error instanceof OfficeExportError || error instanceof OfficeSaveAsError) return error
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new OfficeSaveAsError('permission_denied', '没有权限写入导出目标')
  }
  return new OfficeExportError('export_failed', '无法创建导出文件')
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
