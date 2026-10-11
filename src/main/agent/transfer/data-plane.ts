import type { TransferManifest } from './manifest'
import type { TransferProgress, TransferRequest, TransferSourceIdentity } from './types'

export type TransferPreflight = Readonly<{
  sourceIdentity: TransferSourceIdentity
  expectedSize: number
  sourceHashAvailable: boolean
  destinationHashAvailable: boolean
  destinationAvailableBytes: number
}>

export type PartialInspection = Readonly<{
  kind: 'missing' | 'file' | 'directory' | 'symlink' | 'other'
  size: number
  ownerId: number | null
}>

export type TransferCopyOptions = Readonly<{
  offset: number
  chunkSize: number
  signal: AbortSignal
  onChunk: (progress: TransferProgress) => Promise<boolean>
  onCheckpoint: (progress: TransferProgress) => Promise<void>
}>

export interface TransferDataPlaneSession {
  readonly destinationKey: string
  readonly partialLocator: string
  readonly manifestLocator: string
  preflight(signal: AbortSignal): Promise<TransferPreflight>
  inspectSource(): Promise<TransferSourceIdentity>
  loadManifest(): Promise<TransferManifest | null>
  writeManifest(manifest: TransferManifest): Promise<void>
  removeManifest(): Promise<void>
  inspectPartial(): Promise<PartialInspection>
  createPartial(): Promise<void>
  truncatePartial(size: number): Promise<void>
  hashPartialRange(offset: number, size: number, chunkSize: number): Promise<string>
  copy(options: TransferCopyOptions): Promise<void>
  hashSource(chunkSize: number, signal?: AbortSignal): Promise<string>
  hashPartial(chunkSize: number, signal?: AbortSignal): Promise<string>
  publish(): Promise<void>
  discard(): Promise<void>
}

export interface TransferDataPlane {
  readonly id: string
  destinationKey(request: TransferRequest): string
  open(request: TransferRequest): Promise<TransferDataPlaneSession>
}
