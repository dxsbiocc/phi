export const MIB = 1024 * 1024
export const GIB = 1024 * MIB

export interface TransferPolicyShape {
  globalConcurrency: number
  perHostConcurrency: number
  perDestinationConcurrency: number
  chunkSizeBytes: number
  checkpointBytes: number
  checkpointIntervalMs: number
  progressIntervalMs: number
  progressBytes: number
  retainedPartialTtlMs: number
  retainedPartialHostMaxBytes: number
  retainedPartialFreeSpaceFraction: number
}

export const DEFAULT_TRANSFER_POLICY: Readonly<TransferPolicyShape> = Object.freeze({
  globalConcurrency: 2,
  perHostConcurrency: 1,
  perDestinationConcurrency: 1,
  chunkSizeBytes: 8 * MIB,
  checkpointBytes: 64 * MIB,
  checkpointIntervalMs: 5_000,
  progressIntervalMs: 250,
  progressBytes: MIB,
  retainedPartialTtlMs: 7 * 24 * 60 * 60 * 1000,
  retainedPartialHostMaxBytes: 20 * GIB,
  retainedPartialFreeSpaceFraction: 0.1
})

export type TransferPolicy = Readonly<TransferPolicyShape>

export type TransferState =
  | 'queued'
  | 'preparing'
  | 'transferring'
  | 'verifying'
  | 'publishing'
  | 'saved'
  | 'paused'
  | 'cancelled'
  | 'failed'

export type TransferDirection = 'upload' | 'download' | 'local'

export type TransferEndpoint =
  | Readonly<{ kind: 'local-path'; path: string }>
  | Readonly<{
      kind: 'remote-workspace-path'
      hostId: string
      workspaceId: string
      relativePath: string
    }>
  | Readonly<{
      kind: 'authorized-wrapper-result-path'
      hostId: string
      authorizationId: string
      relativePath: string
    }>

export type TransferRequest = Readonly<{
  transferId: string
  direction: TransferDirection
  hostKey: string
  dataPlaneId: string
  source: TransferEndpoint
  destination: TransferEndpoint
  expectedSha256?: string
}>

export type TransferSourceIdentity = Readonly<{
  kind: string
  device: string
  inode: string
  size: number
  mtime: string
}>

export type TransferProgress = Readonly<{
  offset: number
  chunkOffset: number
  chunkSize: number
  chunkSha256: string
}>

export type TransferEvent = Readonly<{
  transferId: string
  direction: TransferDirection
  state: TransferState
  bytesTransferred: number
  totalBytes: number | null
  resumedFrom: number
  instantaneousBytesPerSecond: number
  smoothedBytesPerSecond: number
  error?: Readonly<{ code: string; message: string }>
}>

export type TransferResult = Readonly<{
  transferId: string
  state: 'saved'
  bytes: number
  resumedFrom: number
  sha256: string
}>

export type TransferHandle = Readonly<{
  transferId: string
  completion: Promise<TransferResult>
  cancel: (options?: Readonly<{ discardPartial?: boolean }>) => void
  pause: () => void
}>
