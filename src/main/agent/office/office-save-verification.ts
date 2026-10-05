import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'

import { officeCliEnv, runOfficeCli, type OfficeCliRunResult } from './office-driver'
import { releaseTransientOfficeResident } from './office-process'
import type { OfficeSavedFileVerification } from './office-save'
import type { OfficeWriteContext } from './office-write-contract'

const VALIDATION_TIMEOUT_MS = 30_000
const SAVE_ENV = { OFFICECLI_RESIDENT_FLUSH: 'each' } as const

export class OfficeSaveVerificationError extends Error {
  readonly code = 'save_failed' as const

  constructor() {
    super('Office 草稿保存后校验失败')
    this.name = 'OfficeSaveVerificationError'
  }
}

interface OfficeSaveVerificationDependencies {
  readonly run?: typeof runOfficeCli
  /** Set for transient copies: `validate` starts a resident that must not outlive the copy. */
  readonly releaseResident?: boolean
  readonly release?: (binaryPath: string, path: string) => Promise<void>
}

export async function verifySavedOfficeFile(
  context: Pick<OfficeWriteContext, 'binaryPath' | 'draftPath' | 'signal'>,
  dependencies: OfficeSaveVerificationDependencies = {}
): Promise<OfficeSavedFileVerification> {
  const before = await readRegularFile(context.draftPath)
  let result: OfficeCliRunResult
  try {
    result = await (dependencies.run ?? runOfficeCli)(
      context.binaryPath,
      ['validate', context.draftPath, '--json'],
      {
        timeoutMs: VALIDATION_TIMEOUT_MS,
        signal: context.signal,
        env: officeCliEnv(process.env, SAVE_ENV)
      }
    )
  } finally {
    if (dependencies.releaseResident) {
      await (dependencies.release ?? releaseTransientOfficeResident)(
        context.binaryPath,
        context.draftPath
      )
    }
  }
  assertSuccessfulValidation(result)
  const after = await readRegularFile(context.draftPath)
  const beforeHash = digest(before)
  if (beforeHash !== digest(after)) throw new OfficeSaveVerificationError()
  return { sha256: beforeHash, size: before.length }
}

async function readRegularFile(path: string): Promise<Buffer> {
  try {
    const stats = await lstat(path)
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0) {
      throw new OfficeSaveVerificationError()
    }
    const bytes = await readFile(path)
    if (bytes.length <= 0) throw new OfficeSaveVerificationError()
    return bytes
  } catch (error) {
    if (error instanceof OfficeSaveVerificationError) throw error
    throw new OfficeSaveVerificationError()
  }
}

function assertSuccessfulValidation(result: OfficeCliRunResult): void {
  if (result.timedOut || result.spawnError || result.truncated || result.exitCode !== 0) {
    throw new OfficeSaveVerificationError()
  }
  try {
    const value = JSON.parse(result.stdout) as {
      success?: unknown
      warnings?: unknown
      data?: { valid?: unknown; warnings?: unknown }
    }
    if (
      value.success !== true ||
      hasWarnings(value.warnings) ||
      hasWarnings(value.data?.warnings) ||
      value.data?.valid === false
    ) {
      throw new Error('invalid')
    }
  } catch {
    throw new OfficeSaveVerificationError()
  }
}

function hasWarnings(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
