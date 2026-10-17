import { posix } from 'node:path'

export const RPC_SAVED_STATE_COMMAND = 'phi-rpc-saved-state'
export const RPC_CHECKPOINT_COMMAND = 'phi-rpc-checkpoint'
export const RPC_MANIFEST_COMMAND = 'phi-rpc-publish-manifest'
export const RPC_SESSION_VERIFICATION_DESCRIPTION = 'Phi RPC session verification v1'
export const RPC_SESSION_VERIFICATION_TYPE = 'phi_rpc_session_verification'
export const RPC_SESSION_MANIFEST_DESCRIPTION = 'Phi RPC session manifest publication v1'
export const RPC_SESSION_MANIFEST_TYPE = 'phi_rpc_session_manifest'

export type SessionVerificationCode =
  | 'FILE_INVALID'
  | 'ASSET_MISSING'
  | 'IDENTITY_MISMATCH'
  | 'SESSION_BUSY'
  | 'VERIFICATION_LIMIT'
  | 'GENERATION_REVOKED'
  | 'PERSISTENCE_FAILED'

export class SessionVerificationError extends Error {
  constructor(readonly code: SessionVerificationCode) {
    super(`Phi RPC session verification failed: ${code}`)
    this.name = 'SessionVerificationError'
  }
}

/** Launcher-owned authority; never reconstructed from a command or a journal header. */
export interface SessionVerificationIdentity {
  readonly nonce: string
  readonly phiSessionId: string
  readonly projectId: string
  readonly generation: number
  readonly projectRoot: string
  readonly directory: string
  readonly journals: string
  readonly blobs: string
}
export interface SessionVerificationBudgets {
  readonly journalBytes: number
  readonly hydratedBytes: number
  readonly entries: number
  readonly nodes: number
  readonly references: number
}
export interface SessionVerificationCapability extends SessionVerificationIdentity {
  readonly signal: AbortSignal
  readonly assertActive: () => void
  readonly budgets?: SessionVerificationBudgets
}
export interface SessionVerificationRequest {
  readonly schemaVersion: 1
  readonly requestId: string
  readonly nonce: string
  readonly phiSessionId: string
  readonly generation: number
  readonly action: 'saved' | 'checkpoint'
  readonly ompSessionId: string
  readonly journalBasename: string
}
export interface SessionVerificationProof {
  readonly ompSessionId: string
  readonly phiSessionId: string
  readonly generation: number
  readonly projectRoot: string
  readonly journalPath: string
  readonly leafId: string | null
  readonly model: { readonly provider: string; readonly id: string } | null
  readonly modelRole: string | null
  /** Device/inode plus exact logical session-header digest. */
  readonly journalFileIdentity: string
  readonly journalDigest: string
  readonly assetDigest: string
  readonly entryCount: number
  readonly blobCount: number
  readonly artifactCount: number
}
export interface SessionVerificationNotification {
  readonly type: typeof RPC_SESSION_VERIFICATION_TYPE
  readonly request: SessionVerificationRequest
  readonly proof?: SessionVerificationProof
  readonly error?: SessionVerificationCode
}
export interface SessionManifestValue {
  readonly schemaVersion: 1
  readonly kind: 'remote-omp'
  readonly version: 1
  readonly hostProfileId: string
  readonly bindingHash: string
  readonly projectId: string
  readonly projectRoot: string
  readonly runtimeRoot: string
  readonly phiSessionId: string
  readonly durableSessionKey: string
  readonly ompVersion: string
  readonly ompSessionId: string
  readonly journalBasename: string
}
export interface SessionManifestRequest {
  readonly schemaVersion: 1
  readonly requestId: string
  readonly nonce: string
  readonly phiSessionId: string
  readonly generation: number
  readonly manifest: SessionManifestValue
}
export interface SessionManifestNotification {
  readonly type: typeof RPC_SESSION_MANIFEST_TYPE
  readonly request: SessionManifestRequest
  readonly sha256?: string
  readonly error?: SessionVerificationCode
}
export const SESSION_VERIFICATION_DEFAULT_BUDGETS: SessionVerificationBudgets = Object.freeze({
  journalBytes: 128 * 1024 * 1024,
  hydratedBytes: 256 * 1024 * 1024,
  entries: 100_000,
  nodes: 1_000_000,
  references: 100_000
})
export function verificationFailure(code: SessionVerificationCode): never {
  throw new SessionVerificationError(code)
}
export function verificationRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
export function verificationText(value: unknown, max = 256): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    [...value].every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    )
  )
}
export function validateVerificationIdentity(value: SessionVerificationIdentity): void {
  if (
    !/^[A-Za-z0-9_-]{16,128}$/u.test(value.nonce) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value.phiSessionId) ||
    !verificationText(value.projectId) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    [value.projectRoot, value.directory, value.journals, value.blobs].some(
      (path) =>
        !verificationText(path, 4096) || !posix.isAbsolute(path) || posix.resolve(path) !== path
    ) ||
    value.journals !== posix.join(value.directory, 'journals') ||
    value.blobs !== posix.join(value.directory, 'data/omp/blobs')
  )
    verificationFailure('IDENTITY_MISMATCH')
}

export function parseSessionManifestRequest(
  input: string,
  identity: SessionVerificationIdentity
): SessionManifestRequest {
  if (Buffer.byteLength(input) > 16 * 1024) verificationFailure('VERIFICATION_LIMIT')
  let raw: unknown
  try {
    raw = JSON.parse(input)
  } catch {
    verificationFailure('IDENTITY_MISMATCH')
  }
  if (
    !verificationRecord(raw) ||
    Object.keys(raw).sort().join(',') !==
      'generation,manifest,nonce,phiSessionId,requestId,schemaVersion' ||
    raw.schemaVersion !== 1 ||
    raw.nonce !== identity.nonce ||
    raw.phiSessionId !== identity.phiSessionId ||
    raw.generation !== identity.generation ||
    typeof raw.requestId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(raw.requestId) ||
    !verificationRecord(raw.manifest) ||
    Object.keys(raw.manifest).sort().join(',') !==
      'bindingHash,durableSessionKey,hostProfileId,journalBasename,kind,ompSessionId,ompVersion,phiSessionId,projectId,projectRoot,runtimeRoot,schemaVersion,version' ||
    raw.manifest.schemaVersion !== 1 ||
    raw.manifest.kind !== 'remote-omp' ||
    raw.manifest.version !== 1 ||
    raw.manifest.projectId !== identity.projectId ||
    raw.manifest.projectRoot !== identity.projectRoot ||
    raw.manifest.phiSessionId !== identity.phiSessionId ||
    !verificationText(raw.manifest.hostProfileId) ||
    typeof raw.manifest.bindingHash !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(raw.manifest.bindingHash) ||
    !verificationText(raw.manifest.runtimeRoot, 4096) ||
    !posix.isAbsolute(raw.manifest.runtimeRoot) ||
    !verificationText(raw.manifest.durableSessionKey, 1024) ||
    !verificationText(raw.manifest.ompVersion) ||
    !verificationText(raw.manifest.ompSessionId) ||
    typeof raw.manifest.journalBasename !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}\.jsonl$/u.test(raw.manifest.journalBasename) ||
    raw.manifest.journalBasename.includes('..')
  )
    verificationFailure('IDENTITY_MISMATCH')
  return Object.freeze({
    ...(raw as unknown as SessionManifestRequest),
    manifest: Object.freeze({ ...(raw.manifest as unknown as SessionManifestValue) })
  })
}
export function parseSessionVerificationRequest(
  input: string,
  identity: SessionVerificationIdentity,
  action: 'saved' | 'checkpoint'
): SessionVerificationRequest {
  if (Buffer.byteLength(input) > 4096) verificationFailure('VERIFICATION_LIMIT')
  let raw: unknown
  try {
    raw = JSON.parse(input)
  } catch {
    verificationFailure('IDENTITY_MISMATCH')
  }
  const keys = [
    'schemaVersion',
    'requestId',
    'nonce',
    'phiSessionId',
    'generation',
    'action',
    'ompSessionId',
    'journalBasename'
  ]
  if (
    !verificationRecord(raw) ||
    Object.keys(raw).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(raw, key)) ||
    raw.schemaVersion !== 1 ||
    raw.nonce !== identity.nonce ||
    raw.phiSessionId !== identity.phiSessionId ||
    raw.generation !== identity.generation ||
    raw.action !== action ||
    typeof raw.requestId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(raw.requestId) ||
    typeof raw.ompSessionId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(raw.ompSessionId) ||
    typeof raw.journalBasename !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}\.jsonl$/u.test(raw.journalBasename) ||
    raw.journalBasename.includes('..')
  )
    verificationFailure('IDENTITY_MISMATCH')
  return Object.freeze(raw) as unknown as SessionVerificationRequest
}
export function assertVerificationActive(capability: SessionVerificationCapability): void {
  if (capability.signal.aborted) verificationFailure('GENERATION_REVOKED')
  try {
    capability.assertActive()
  } catch {
    verificationFailure('GENERATION_REVOKED')
  }
  if (capability.signal.aborted) verificationFailure('GENERATION_REVOKED')
}
