import type { Readable, Writable } from 'node:stream'

import type { FileTransferCoordinator } from './coordinator'
import type { TransferEvent } from './types'

export interface TransferStdioProcess {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  closed: Promise<{ code: number | null; signal: string | null }>
  close(): Promise<void>
}

export interface RemoteUploadFileOptions {
  timeoutMs?: number
  transferId?: string
  expectedSha256?: string
  remoteRoot?: string
  canonicalRoot?: string
  hostKey?: string
  workspaceId?: string
  signal?: AbortSignal
  onEvent?: (event: TransferEvent) => void
  coordinator?: FileTransferCoordinator
  agentDir?: string
  helperConnect?: () => Promise<TransferStdioProcess>
  helperVersion?: string
  reuseVerifiedDestination?: boolean
  forceSsh?: boolean
}
