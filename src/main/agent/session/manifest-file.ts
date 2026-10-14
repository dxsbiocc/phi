import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PhiSessionManifest } from './session-store'
import {
  assertRuntimeReferenceProject,
  excludesLocalJournalPath,
  parseRuntimeReference,
  RuntimeReferenceError
} from './runtime-reference'

// Keep malformed input on disk while exposing only a diagnostic, never an unchecked locator.
const invalidReference = Symbol('invalidRuntimeReference')
type ReadManifest = Omit<PhiSessionManifest, 'runtimeRecoveryError'> & {
  runtimeRecoveryError?: PhiSessionManifest['runtimeRecoveryError']
  [invalidReference]?: unknown
}

export function readManifestFile(path: string, sessionId: string): PhiSessionManifest {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as ReadManifest
  if (manifest.schemaVersion !== 1 || manifest.sessionId !== sessionId) {
    throw new Error('Invalid session manifest identity')
  }
  delete manifest.runtimeRecoveryError
  if (!Object.hasOwn(manifest, 'runtimeRef')) return manifest
  const raw = manifest.runtimeRef
  try {
    manifest.runtimeRef = parseRuntimeReference(raw, sessionId)
    assertRuntimeReferenceProject(manifest, manifest.runtimeRef)
  } catch (error) {
    manifest[invalidReference] = raw
    delete manifest.runtimeRef
    manifest.runtimeRecoveryError = {
      code: error instanceof RuntimeReferenceError ? error.code : 'INVALID_RUNTIME_REFERENCE',
      message: '远程会话定位信息无法验证；本地时间线仍可查看，需要显式恢复'
    }
  }
  return manifest
}

export function writeManifestFile(directory: string, manifest: PhiSessionManifest): void {
  if (manifest.runtimeRef) {
    const ref = parseRuntimeReference(manifest.runtimeRef, manifest.sessionId)
    assertRuntimeReferenceProject(manifest, ref)
  }
  const document: Record<string | symbol, unknown> = { ...manifest }
  delete document.runtimeRecoveryError
  if (Object.hasOwn(document, invalidReference)) document.runtimeRef = document[invalidReference]
  const temporary = join(directory, `.manifest.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
      encoding: 'utf8'
    })
    renameSync(temporary, join(directory, 'manifest.json'))
  } finally {
    rmSync(temporary, { force: true })
  }
}

/** A private disk exclusion survives failed validation; it is never an executable runtime reference. */
export function excludesManifestLocalJournalPath(
  manifest: PhiSessionManifest,
  path: string
): boolean {
  const raw = (manifest as ReadManifest)[invalidReference]
  return excludesLocalJournalPath(manifest.runtimeRef ?? raw, path)
}
