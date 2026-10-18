import {
  REMOTE_OMP_VERSION,
  type RemoteOmpScope,
  type RemoteOmpRuntimeRef
} from '../../../session/runtime-reference'
import type { WorkspaceHost } from '../../../workspace-host/types'
import type { RemoteStdioProcess } from '../../../wrappers/remote-ssh-session'

export const REMOTE_SESSION_OMP_VERSION = REMOTE_OMP_VERSION

/** Supplied by the verified project/profile binding, never by model tool arguments. */
export interface RemoteSessionScope extends RemoteOmpScope {
  readonly phiSessionId: string
}

export interface RemoteSessionPaths {
  readonly scopeHash: string
  readonly durableSessionKey: string
  readonly directory: string
  readonly manifest: string
  readonly journals: string
  readonly data: string
  readonly blobs: string
  readonly lock: string
  /** Held by the OMP process itself (inherited fd); see run-guard.ts. */
  readonly runLock: string
  readonly runRecord: string
}

/** A durable locator contains no connection generation or gateway authority. */
export interface RemoteSessionReference
  extends Omit<RemoteOmpRuntimeRef, 'checkpoint'>, RemoteSessionScope {}

export interface RemoteSessionServerManifest extends RemoteSessionReference {
  readonly schemaVersion: 1
}

export type RemoteSessionStorageErrorCode =
  | 'INVALID_SCOPE'
  | 'PATH_INVALID'
  | 'PERMISSION_DENIED'
  | 'FILE_MISSING'
  | 'FILE_INVALID'
  | 'IDENTITY_MISMATCH'
  | 'SESSION_BUSY'
  | 'LEASE_LOST'
  | 'PERSISTENCE_FAILED'

export class RemoteSessionStorageError extends Error {
  constructor(
    readonly code: RemoteSessionStorageErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'RemoteSessionStorageError'
  }
}

export interface RemoteSessionWriterLease {
  readonly signal: AbortSignal
  readonly lost: Promise<never>
  assertActive(): void
  release(): Promise<void>
}

export interface RemoteSessionStoragePreparation {
  readonly scope: Readonly<RemoteSessionScope>
  readonly paths: Readonly<RemoteSessionPaths>
  readonly lease: RemoteSessionWriterLease
}

export interface PrepareRemoteSessionStorageOptions {
  readonly runtimeHost: WorkspaceHost
  readonly scope: RemoteSessionScope
  readonly openLockStdio: (command: string) => Promise<RemoteStdioProcess>
  readonly signal?: AbortSignal
  readonly lockWaitMs?: number
  /** Factory-owned startup transaction will create directories and attach the held lock. */
  readonly deferToStartup?: boolean
}

export interface RemoteJournalPreflight {
  readonly journalPath: string
  readonly ompSessionId: string
  readonly cwd: string
  readonly headerVersion: 3
  /** Device/inode plus exact logical session-header digest; independent of append-only revisions. */
  readonly fileIdentity: string
  /** Metadata and bounded physical title/header prefix snapshot; compare only when no legitimate append is expected. */
  readonly fingerprint: string
  /** A legacy header or one valid256-byte title prefix + header; switch_session must verify again; this is not FD adoption. */
  readonly verification: 'bounded-header'
}
