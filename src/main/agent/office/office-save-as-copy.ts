import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { OfficeDocumentKind } from '../../../shared/officeProtocol'
import { officeDocumentKindFromPath } from './office-document-kind'
import { officeKindAdapter } from './office-kind-adapters'
import type { OfficeSavedFileVerification } from './office-save'
import { OfficeSaveAsError } from './office-save-as-target'
import { verifySavedOfficeFile } from './office-save-verification'

interface ImmutableOfficeOutputInput {
  readonly binaryPath: string
  readonly kind?: OfficeDocumentKind
  readonly sourcePath: string
  readonly targetPath: string
  readonly expectedSha256: string
  readonly signal: AbortSignal
}

interface ImmutableOfficeOutputDependencies {
  readonly randomId?: () => string
  readonly readFile?: typeof readFile
  readonly writeFile?: typeof writeFile
  readonly link?: typeof link
  readonly lstat?: typeof lstat
  readonly rm?: typeof rm
  readonly verifyFile?: (path: string) => Promise<OfficeSavedFileVerification>
}

export async function createImmutableOfficeOutput<T>(
  input: ImmutableOfficeOutputInput,
  record: (verification: OfficeSavedFileVerification) => Promise<T>,
  dependencies: ImmutableOfficeOutputDependencies = {}
): Promise<T> {
  assertNotAborted(input.signal)
  const kind = input.kind ?? officeDocumentKindFromPath(input.targetPath)
  const tempPath = join(
    dirname(input.targetPath),
    `.${basename(input.targetPath)}.phi-${(dependencies.randomId ?? randomUUID)()}.tmp${officeKindAdapter(kind).extension}`
  )
  let tempCreated = false
  let finalLinked = false
  let finalIdentity: { dev: number; ino: number } | undefined
  try {
    await writeTemp(input, tempPath, dependencies)
    tempCreated = true
    const verified = await verifyTemp(input, tempPath, dependencies)
    assertNotAborted(input.signal)
    try {
      await (dependencies.link ?? link)(tempPath, input.targetPath)
      finalLinked = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new OfficeSaveAsError('target_exists', '目标文件已存在，不会覆盖')
      }
      throw error
    }
    const finalBytes = await (dependencies.readFile ?? readFile)(input.targetPath, {
      signal: input.signal
    })
    if (digest(finalBytes) !== input.expectedSha256) throw verificationError()
    const finalStats = await (dependencies.lstat ?? lstat)(input.targetPath)
    finalIdentity = { dev: finalStats.dev, ino: finalStats.ino }
    assertNotAborted(input.signal)
    await (dependencies.rm ?? rm)(tempPath, { force: true })
    tempCreated = false
    return await record(verified)
  } catch (error) {
    if (finalLinked && (await sameOutput(input.targetPath, finalIdentity, dependencies))) {
      await (dependencies.rm ?? rm)(input.targetPath, { force: true }).catch(() => undefined)
    }
    if (tempCreated) await (dependencies.rm ?? rm)(tempPath, { force: true }).catch(() => undefined)
    throw input.signal.aborted
      ? new OfficeSaveAsError('save_as_cancelled', '另存操作已取消')
      : mappedCopyError(error)
  }
}

async function writeTemp(
  input: ImmutableOfficeOutputInput,
  tempPath: string,
  dependencies: ImmutableOfficeOutputDependencies
): Promise<void> {
  const source = await (dependencies.readFile ?? readFile)(input.sourcePath, {
    signal: input.signal
  })
  if (digest(source) !== input.expectedSha256) throw verificationError()
  await (dependencies.writeFile ?? writeFile)(tempPath, source, {
    flag: 'wx',
    mode: 0o600,
    signal: input.signal
  })
}

async function verifyTemp(
  input: ImmutableOfficeOutputInput,
  tempPath: string,
  dependencies: ImmutableOfficeOutputDependencies
): Promise<OfficeSavedFileVerification> {
  const verified = dependencies.verifyFile
    ? await dependencies.verifyFile(tempPath)
    : await verifySavedOfficeFile(
        { binaryPath: input.binaryPath, draftPath: tempPath, signal: input.signal },
        { releaseResident: true }
      )
  if (verified.sha256 !== input.expectedSha256 || verified.size <= 0) throw verificationError()
  return verified
}

async function sameOutput(
  path: string,
  expected: { dev: number; ino: number } | undefined,
  dependencies: ImmutableOfficeOutputDependencies
): Promise<boolean> {
  if (!expected) return false
  try {
    const inspect = dependencies.lstat ?? lstat
    const stats = await inspect(path)
    return stats.dev === expected.dev && stats.ino === expected.ino
  } catch {
    return false
  }
}

function mappedCopyError(error: unknown): unknown {
  if (error instanceof OfficeSaveAsError) return error
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'save_failed') return verificationError()
  if (code === 'ABORT_ERR') return new OfficeSaveAsError('save_as_cancelled', '另存操作已取消')
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new OfficeSaveAsError('permission_denied', '没有权限写入另存目标')
  }
  return new OfficeSaveAsError('copy_failed', '无法创建 Office 输出副本')
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new OfficeSaveAsError('save_as_cancelled', '另存操作已取消')
}

function verificationError(): OfficeSaveAsError {
  return new OfficeSaveAsError('copy_verification_failed', 'Office 输出副本校验失败')
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
