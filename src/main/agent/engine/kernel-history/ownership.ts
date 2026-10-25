import { chmod, readFile, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { isMissingFile, writeJsonAtomic } from './atomic-file'
import type { KernelHistoryPlan } from './planner'

export const KERNEL_OWNER_SCHEMA_VERSION = 1

export type RollbackProgressState =
  'started' | 'exported' | 'manifest-backed-up' | 'manifest-repointed'

export interface KernelRollbackProgress {
  readonly state: RollbackProgressState
  readonly originalRuntimeSessionPath: string
  readonly exportPath: string
  readonly originalManifestSha256: string
  readonly startedAt: string
}

export interface KernelOwnerRecord {
  readonly schemaVersion: typeof KERNEL_OWNER_SCHEMA_VERSION
  readonly kernelSessionId: string
  readonly host: string
  readonly runtimeRoot: string
  readonly migratedAt: string
  readonly sourceSha256: string
  readonly readOnly?: boolean
  readonly reason?: string
  readonly rollback?: KernelRollbackProgress
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function sha256String(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

type KernelOwnerIdentity = Pick<
  KernelOwnerRecord,
  'schemaVersion' | 'kernelSessionId' | 'host' | 'runtimeRoot' | 'migratedAt' | 'sourceSha256'
>

function validOwnerIdentity(
  item: Partial<KernelOwnerRecord>
): item is Partial<KernelOwnerRecord> & KernelOwnerIdentity {
  return (
    item.schemaVersion === KERNEL_OWNER_SCHEMA_VERSION &&
    typeof item.kernelSessionId === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(item.kernelSessionId) &&
    nonEmptyString(item.host) &&
    typeof item.runtimeRoot === 'string' &&
    isAbsolute(item.runtimeRoot) &&
    validIso(item.migratedAt) &&
    sha256String(item.sourceSha256)
  )
}

function validOwnerOptions(item: Partial<KernelOwnerRecord>): boolean {
  const readOnlyValid = item.readOnly === undefined || typeof item.readOnly === 'boolean'
  const reasonValid = item.reason === undefined || typeof item.reason === 'string'
  return readOnlyValid && reasonValid
}

function validateRollback(value: unknown): KernelRollbackProgress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid kernel owner rollback state')
  }
  const item = value as Partial<KernelRollbackProgress>
  if (
    !['started', 'exported', 'manifest-backed-up', 'manifest-repointed'].includes(
      String(item.state)
    ) ||
    typeof item.originalRuntimeSessionPath !== 'string' ||
    !item.originalRuntimeSessionPath ||
    typeof item.exportPath !== 'string' ||
    !item.exportPath ||
    typeof item.originalManifestSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(item.originalManifestSha256) ||
    !validIso(item.startedAt)
  ) {
    throw new Error('Invalid kernel owner rollback state')
  }
  return item as KernelRollbackProgress
}

export function validateKernelOwner(value: unknown): KernelOwnerRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid kernel owner record')
  }
  const item = value as Partial<KernelOwnerRecord>
  const allowed = new Set([
    'schemaVersion',
    'kernelSessionId',
    'host',
    'runtimeRoot',
    'migratedAt',
    'sourceSha256',
    'readOnly',
    'reason',
    'rollback'
  ])
  const hasUnknownField = Object.keys(item).some((key) => !allowed.has(key))
  if (hasUnknownField || !validOwnerIdentity(item) || !validOwnerOptions(item)) {
    throw new Error('Invalid kernel owner record')
  }
  const rollback = item.rollback === undefined ? undefined : validateRollback(item.rollback)
  return {
    schemaVersion: KERNEL_OWNER_SCHEMA_VERSION,
    kernelSessionId: item.kernelSessionId,
    host: item.host,
    runtimeRoot: item.runtimeRoot,
    migratedAt: item.migratedAt,
    sourceSha256: item.sourceSha256,
    ...(item.readOnly === undefined ? {} : { readOnly: item.readOnly }),
    ...(item.reason === undefined ? {} : { reason: item.reason }),
    ...(rollback ? { rollback } : {})
  }
}

export async function writeKernelOwner(
  phiSessionDirectory: string,
  owner: KernelOwnerRecord
): Promise<void> {
  await writeJsonAtomic(join(phiSessionDirectory, 'kernel-owner.json'), validateKernelOwner(owner))
}

export async function readKernelOwner(
  phiSessionDirectory: string
): Promise<KernelOwnerRecord | undefined> {
  try {
    return validateKernelOwner(
      JSON.parse(await readFile(join(phiSessionDirectory, 'kernel-owner.json'), 'utf8'))
    )
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }
}

export async function removeKernelOwner(phiSessionDirectory: string): Promise<void> {
  await rm(join(phiSessionDirectory, 'kernel-owner.json'), { force: true })
}

export interface RpcDiagnosticsRecord {
  readonly schemaVersion: 1
  readonly recordedAt: string
  readonly diagnostics: unknown
}

/** RPC leases/proofs/hashes are evidence only; mode 0400 prevents accidental reuse as authority. */
export async function writeRpcDiagnostics(
  adoptedSessionDirectory: string,
  diagnostics: unknown,
  recordedAt = new Date().toISOString()
): Promise<string> {
  if (!validIso(recordedAt)) throw new Error('Invalid RPC diagnostics timestamp')
  const path = join(adoptedSessionDirectory, 'rpc-diagnostics.json')
  await writeJsonAtomic(path, { schemaVersion: 1, recordedAt, diagnostics }, 0o400)
  // Keep the intent explicit even on platforms whose rename inherits broader permissions.
  await chmod(path, 0o400)
  return path
}

export interface RecordKernelHistoryAdoptionInput {
  readonly plan: Extract<KernelHistoryPlan, { action: 'adopt-local' | 'adopt-remote' }>
  readonly phiSessionDirectory: string
  readonly adoptedSessionDirectory: string
  readonly kernelSessionId: string
  readonly host: string
  readonly runtimeRoot: string
  readonly sourceSha256: string
  readonly migratedAt?: string
}

/** Publish the desktop companion records only after the kernel adoption completed. */
export async function recordKernelHistoryAdoption(
  input: RecordKernelHistoryAdoptionInput
): Promise<{ owner: KernelOwnerRecord; rpcDiagnosticsPath?: string }> {
  const owner: KernelOwnerRecord = {
    schemaVersion: KERNEL_OWNER_SCHEMA_VERSION,
    kernelSessionId: input.kernelSessionId,
    host: input.host,
    runtimeRoot: input.runtimeRoot,
    migratedAt: input.migratedAt ?? new Date().toISOString(),
    sourceSha256: input.sourceSha256
  }
  const rpcDiagnosticsPath =
    input.plan.action === 'adopt-remote' && input.plan.rpcDiagnostics !== undefined
      ? await writeRpcDiagnostics(
          input.adoptedSessionDirectory,
          input.plan.rpcDiagnostics,
          owner.migratedAt
        )
      : undefined
  // Diagnostics are non-authoritative. Publish them first so a serialization or
  // disk failure cannot leave an owner claim without its required evidence.
  await writeKernelOwner(input.phiSessionDirectory, owner)
  return { owner, ...(rpcDiagnosticsPath ? { rpcDiagnosticsPath } : {}) }
}
