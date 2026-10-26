import type {
  RunCompletedPayload,
  SessionLastRun,
  SessionListEntry
} from '../../shared/kernel-protocol'
import type {
  HistoryMigrationState,
  SessionAdoptParams
} from '../../shared/kernel-protocol/history'

export const SESSION_MANIFEST_SCHEMA_VERSION = 1 as const

export type SessionModel = {
  provider: string
  id: string
}

export type SessionManifest = {
  schemaVersion: typeof SESSION_MANIFEST_SCHEMA_VERSION
  sessionId: string
  cwd: string
  createdAt: string
  updatedAt: string
  model?: SessionModel
  thinkingLevel?: string
  title?: string
  policy?: {
    projectBound: boolean
    requiresTrustedResources: boolean
  }
  journal: 'journal.jsonl'
  lastRun?: SessionLastRun
}

export type SessionMigrationRecord = {
  schemaVersion: 1
  migrationVersion: 1
  source: {
    kind: 'omp-journal'
    path: string
    cwd: string
    size: number
    mtime: string
    sha256: string
    origin: SessionAdoptParams['source']['origin']
    phiSessionId: string
    ompSessionId: string
    headerVersion: number
    headerTimestamp: string
  }
  target: {
    title?: string
    model?: SessionModel
    thinkingLevel?: string
  }
  backup: 'source-backup.jsonl'
  state: HistoryMigrationState
  startedAt: string
  copiedAt?: string
  verifiedAt?: string
  completedAt?: string
}

export type AcceptedRunReceipt = {
  runId: string
  clientRunKey?: string
  state: 'accepted'
  at: string
}

export type TerminalRunReceipt = {
  runId: string
  state: 'terminal'
  status: RunCompletedPayload['status']
  at: string
  reason?: string
}

export type RunReceipt = AcceptedRunReceipt | TerminalRunReceipt

export type RunReceiptState = {
  accepted: AcceptedRunReceipt
  terminal?: TerminalRunReceipt
}

export type SessionWriterLockBody = {
  pid: number
  kernelInstanceId: string
  startedAt: string
  hostname: string
}

export type SessionWriterLock = {
  body: Readonly<SessionWriterLockBody>
  path: string
  release(): Promise<void>
  releaseSync(): void
}

export type ProcessLockGuard = {
  readonly acquired: boolean
  release(): void
}

export type AcquireProcessLockGuard = (path: string) => ProcessLockGuard | Promise<ProcessLockGuard>

export type PersistentSession = {
  readonly directory: string
  readonly journalPath: string
  readonly receiptsPath: string
  readonly manifestPath: string
  readonly lock: SessionWriterLock
  manifest: SessionManifest
  readonly runs: Map<string, RunReceiptState>
  readonly clientRuns: Map<string, RunReceiptState>
  receiptTail: Promise<void>
}

export type DuplicateRun = {
  runId: string
  status: 'running' | RunCompletedPayload['status']
}

export type SessionListResult = { sessions: SessionListEntry[] }
