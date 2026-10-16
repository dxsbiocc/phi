import type { TransferDataPlane, TransferDataPlaneSession } from './data-plane'
import { asTransferError, safeTransferText, TransferError } from './errors'
import { sameSourceIdentity, TRANSFER_MANIFEST_VERSION, type TransferManifest } from './manifest'
import { FileTransferRegistry, type TransferRegistryStatus } from './registry'
import { transitionTransferState } from './state-machine'
import {
  DEFAULT_TRANSFER_POLICY,
  type TransferEvent,
  type TransferHandle,
  type TransferPolicy,
  type TransferRequest,
  type TransferResult,
  type TransferState
} from './types'

type Deferred = Readonly<{
  promise: Promise<TransferResult>
  resolve: (value: TransferResult) => void
  reject: (reason: unknown) => void
}>

type Job = {
  readonly request: TransferRequest
  readonly plane: TransferDataPlane
  readonly destinationKey: string
  readonly deferred: Deferred
  controller: AbortController
  session: TransferDataPlaneSession | null
  state: TransferState
  bytes: number
  totalBytes: number | null
  resumedFrom: number
  instantaneousSpeed: number
  smoothedSpeed: number
  lastChunkAt: number
  lastChunkBytes: number
  lastProgressAt: number
  lastProgressBytes: number
  pauseRequested: boolean
  cancelRequested: boolean
  discardPartial: boolean
  retentionEstablished: boolean
  retentionCreatedAt: number
  cancelFinishing?: Promise<void>
  quarantined?: boolean
}

type RunOutcome =
  | Readonly<{ state: 'saved'; result: TransferResult }>
  | Readonly<{ state: 'paused' }>
  | Readonly<{ state: 'cancelled' | 'failed'; error: TransferError }>

export type FileTransferManagerOptions = Readonly<{
  registry: FileTransferRegistry
  dataPlanes: readonly TransferDataPlane[]
  policy?: Partial<TransferPolicy>
  onEvent?: (event: TransferEvent) => void
  now?: () => number
}>

function deferred(): Deferred {
  let resolve!: (value: TransferResult) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<TransferResult>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

function validateRequest(request: TransferRequest): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(request.transferId)) {
    throw new TransferError('INVALID_REQUEST', 'Transfer id is invalid')
  }
  if (Buffer.byteLength(request.hostKey) > 512 || request.hostKey.length === 0) {
    throw new TransferError('INVALID_REQUEST', 'Transfer host key is invalid')
  }
  if (request.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(request.expectedSha256)) {
    throw new TransferError('INVALID_REQUEST', 'Expected SHA-256 is invalid')
  }
}

function withCleanupFailure(primary: TransferError, secondary: unknown): TransferError {
  const first = new TransferError(primary.code, primary.message)
  const cleanup = asTransferError(secondary)
  const safeCleanup = new TransferError(cleanup.code, cleanup.message)
  primary.message = `${safeTransferText(primary.message, 640)}; cleanup unconfirmed: ${safeTransferText(safeCleanup, 320)}`
  Object.defineProperty(primary, 'cause', {
    value: new AggregateError([first, safeCleanup], 'Transfer cleanup unconfirmed'),
    configurable: true,
    writable: true
  })
  return primary
}

function manifestMatchesRequest(
  manifest: TransferManifest,
  request: TransferRequest,
  sourceIdentity: TransferManifest['sourceIdentity'],
  expectedSize: number,
  chunkSize: number
): boolean {
  return (
    manifest.protocolVersion === TRANSFER_MANIFEST_VERSION &&
    manifest.transferId === request.transferId &&
    manifest.direction === request.direction &&
    sameSourceIdentity(manifest.sourceIdentity, sourceIdentity) &&
    manifest.expectedSize === expectedSize &&
    manifest.expectedSha256 === request.expectedSha256 &&
    manifest.chunkSize === chunkSize &&
    Number.isSafeInteger(manifest.durableOffset) &&
    manifest.durableOffset >= 0 &&
    manifest.durableOffset <= expectedSize
  )
}

export class FileTransferManager {
  private readonly registry: FileTransferRegistry
  private readonly planes: ReadonlyMap<string, TransferDataPlane>
  private readonly policy: TransferPolicy
  private readonly onEvent: (event: TransferEvent) => void
  private readonly now: () => number
  private readonly jobs = new Map<string, Job>()
  private readonly queue: string[] = []
  private readonly active = new Set<string>()
  private readonly activeHosts = new Map<string, number>()
  private readonly activeDestinations = new Map<string, number>()
  private readonly quarantinedHosts = new Set<string>()
  private scheduling = false

  constructor(options: FileTransferManagerOptions) {
    this.registry = options.registry
    this.planes = new Map(options.dataPlanes.map((plane) => [plane.id, plane]))
    this.policy = Object.freeze({ ...DEFAULT_TRANSFER_POLICY, ...options.policy })
    this.onEvent = options.onEvent ?? (() => undefined)
    this.now = options.now ?? Date.now
  }

  enqueue(request: TransferRequest): TransferHandle {
    const snapshot: TransferRequest = Object.freeze({
      ...request,
      source: Object.freeze({ ...request.source }),
      destination: Object.freeze({ ...request.destination }),
      ...(request.retention === undefined
        ? {}
        : { retention: Object.freeze({ ...request.retention }) })
    })
    validateRequest(snapshot)
    if (this.jobs.has(snapshot.transferId)) {
      throw new TransferError('INVALID_REQUEST', 'Transfer id is already registered')
    }
    const plane = this.planes.get(snapshot.dataPlaneId)
    if (plane === undefined) {
      throw new TransferError('INVALID_REQUEST', 'Requested transfer data plane is unavailable')
    }
    const pending = deferred()
    const now = this.now()
    const job: Job = {
      request: snapshot,
      plane,
      destinationKey: plane.destinationKey(snapshot),
      deferred: pending,
      controller: new AbortController(),
      session: null,
      state: 'queued',
      bytes: 0,
      totalBytes: null,
      resumedFrom: 0,
      instantaneousSpeed: 0,
      smoothedSpeed: 0,
      lastChunkAt: now,
      lastChunkBytes: 0,
      lastProgressAt: now,
      lastProgressBytes: 0,
      pauseRequested: false,
      cancelRequested: false,
      discardPartial: false,
      retentionEstablished: false,
      retentionCreatedAt: now
    }
    this.jobs.set(snapshot.transferId, job)
    this.queue.push(snapshot.transferId)
    this.emit(job)
    this.schedule()
    return Object.freeze({
      transferId: snapshot.transferId,
      completion: pending.promise,
      cancel: (options) => this.cancel(snapshot.transferId, options),
      pause: () => this.pause(snapshot.transferId)
    })
  }

  resume(transferId: string): void {
    const job = this.jobs.get(transferId)
    if (job === undefined || job.state !== 'paused' || job.cancelRequested || job.cancelFinishing) {
      throw new TransferError('INVALID_REQUEST', 'Only a paused transfer can be resumed')
    }
    job.controller = new AbortController()
    job.session = null
    job.pauseRequested = false
    this.transition(job, 'queued')
    this.queue.push(transferId)
    this.schedule()
  }

  getState(transferId: string): TransferState | null {
    return this.jobs.get(transferId)?.state ?? null
  }

  forget(transferId: string): boolean {
    const job = this.jobs.get(transferId)
    if (
      job === undefined ||
      job.quarantined ||
      !['saved', 'cancelled', 'failed'].includes(job.state)
    ) {
      return false
    }
    return this.jobs.delete(transferId)
  }

  private cancel(transferId: string, options?: Readonly<{ discardPartial?: boolean }>): void {
    const job = this.jobs.get(transferId)
    if (job === undefined || ['saved', 'cancelled', 'failed'].includes(job.state)) return
    job.cancelRequested = true
    job.discardPartial = options?.discardPartial === true
    if (job.state === 'queued' || job.state === 'paused') {
      const wasPaused = job.state === 'paused'
      const index = this.queue.indexOf(transferId)
      if (index >= 0) this.queue.splice(index, 1)
      void this.finishCancelled(job, wasPaused)
      return
    }
    job.controller.abort()
  }

  private finishCancelled(job: Job, wasPaused: boolean): Promise<void> {
    job.cancelFinishing ??= Promise.resolve().then(async () => {
      let error: TransferError = new TransferError('ABORTED', 'Transfer cancelled')
      try {
        if (wasPaused && job.session !== null) {
          if (job.discardPartial) {
            await job.session.discard()
            await this.registry.remove(job.request.transferId)
            job.retentionEstablished = false
          } else if (job.retentionEstablished) {
            await this.record(job, job.session, 'cancelled', job.retentionCreatedAt)
          }
        }
      } catch (cleanupError) {
        error = withCleanupFailure(error, cleanupError)
      }
      try {
        await this.closeSession(job, job.session)
      } catch (closeError) {
        error = withCleanupFailure(error, closeError)
      }
      if (!job.quarantined) job.session = null
      this.transition(job, 'cancelled', error)
      job.deferred.reject(error)
    })
    return job.cancelFinishing
  }

  private pause(transferId: string): void {
    const job = this.jobs.get(transferId)
    if (job === undefined || job.state !== 'transferring') return
    job.pauseRequested = true
    job.controller.abort()
  }

  private schedule(): void {
    if (this.scheduling) return
    this.scheduling = true
    queueMicrotask(() => {
      this.scheduling = false
      let started = true
      while (started && this.active.size < this.policy.globalConcurrency) {
        started = false
        const index = this.queue.findIndex((transferId) => {
          const job = this.jobs.get(transferId)
          return job !== undefined && this.hasCapacity(job)
        })
        if (index >= 0) {
          const [transferId] = this.queue.splice(index, 1)
          const job = this.jobs.get(transferId)
          if (job !== undefined) {
            started = true
            this.reserve(job)
            void this.run(job)
          }
        }
      }
    })
  }

  private hasCapacity(job: Job): boolean {
    return (
      !this.quarantinedHosts.has(job.request.hostKey) &&
      (this.activeHosts.get(job.request.hostKey) ?? 0) < this.policy.perHostConcurrency &&
      (this.activeDestinations.get(job.destinationKey) ?? 0) < this.policy.perDestinationConcurrency
    )
  }

  private reserve(job: Job): void {
    this.active.add(job.request.transferId)
    this.activeHosts.set(job.request.hostKey, (this.activeHosts.get(job.request.hostKey) ?? 0) + 1)
    this.activeDestinations.set(
      job.destinationKey,
      (this.activeDestinations.get(job.destinationKey) ?? 0) + 1
    )
  }

  private release(job: Job): void {
    if (job.quarantined) return
    this.active.delete(job.request.transferId)
    this.decrement(this.activeHosts, job.request.hostKey)
    this.decrement(this.activeDestinations, job.destinationKey)
    this.schedule()
  }

  private async closeSession(job: Job, session: TransferDataPlaneSession | null): Promise<void> {
    if (session === null) return
    let failed = false
    try {
      await session.close?.()
    } catch (error) {
      failed = true
      throw error
    } finally {
      const confirmed = session.isCloseConfirmed?.()
      if (confirmed === false || (failed && confirmed !== true)) {
        // Keep the original owner/queue reservation when a local close cannot prove remote exit.
        job.quarantined = true
        this.quarantinedHosts.add(job.request.hostKey)
        if (!this.active.has(job.request.transferId)) this.reserve(job)
      }
    }
  }

  private decrement(counts: Map<string, number>, key: string): void {
    const count = counts.get(key) ?? 0
    if (count <= 1) counts.delete(key)
    else counts.set(key, count - 1)
  }

  private async run(job: Job): Promise<void> {
    let session: TransferDataPlaneSession | null = null
    let outcome: RunOutcome | undefined
    let createdAt = this.now()
    let partialCreatedByRun = false
    try {
      this.transition(job, 'preparing')
      session = await job.plane.open(job.request)
      job.session = session
      const preflight = await session.preflight(job.controller.signal)
      job.totalBytes = preflight.expectedSize
      if (
        (!job.request.expectedSha256 &&
          (!preflight.sourceHashAvailable || !preflight.destinationHashAvailable)) ||
        (job.request.expectedSha256 !== undefined && !preflight.destinationHashAvailable)
      ) {
        throw new TransferError(
          'HASH_UNAVAILABLE',
          'SHA-256 verification is unavailable; size-only verification is forbidden'
        )
      }

      const existingManifest = await session.loadManifest()
      const partial = await session.inspectPartial()
      let manifest: TransferManifest
      if (existingManifest === null) {
        if (partial.kind !== 'missing') {
          throw new TransferError('INVALID_PARTIAL', 'Unregistered transfer partial already exists')
        }
        this.ensureCapacity(preflight.destinationAvailableBytes, preflight.expectedSize)
        await session.createPartial()
        partialCreatedByRun = true
        createdAt = this.now()
        manifest = {
          protocolVersion: TRANSFER_MANIFEST_VERSION,
          transferId: job.request.transferId,
          direction: job.request.direction,
          sourceIdentity: preflight.sourceIdentity,
          expectedSize: preflight.expectedSize,
          ...(job.request.expectedSha256 === undefined
            ? {}
            : { expectedSha256: job.request.expectedSha256 }),
          durableOffset: 0,
          chunkSize: this.policy.chunkSizeBytes,
          lastChunk: null,
          createdAt,
          updatedAt: createdAt
        }
        await session.writeManifest(manifest)
        job.retentionEstablished = true
      } else {
        manifest = existingManifest
        createdAt = manifest.createdAt
        await this.validateResume(job, session, manifest, partial, preflight.sourceIdentity)
        job.retentionEstablished = true
        this.ensureCapacity(
          preflight.destinationAvailableBytes,
          preflight.expectedSize - manifest.durableOffset
        )
        if (partial.size > manifest.durableOffset) {
          await session.truncatePartial(manifest.durableOffset)
        }
        job.resumedFrom = manifest.durableOffset
        job.bytes = manifest.durableOffset
        job.lastChunkBytes = manifest.durableOffset
        job.lastProgressBytes = manifest.durableOffset
      }
      job.retentionCreatedAt = createdAt
      await this.record(job, session, 'active', createdAt)
      this.transition(job, 'transferring')

      let lastCheckpointAt = this.now()
      let durableOffset = manifest.durableOffset
      await session.copy({
        offset: manifest.durableOffset,
        chunkSize: this.policy.chunkSizeBytes,
        signal: job.controller.signal,
        onChunk: async (progress) => {
          const now = this.now()
          const elapsed = Math.max(1, now - job.lastChunkAt)
          job.instantaneousSpeed = ((progress.offset - job.lastChunkBytes) * 1000) / elapsed
          job.smoothedSpeed =
            job.smoothedSpeed === 0
              ? job.instantaneousSpeed
              : job.smoothedSpeed * 0.75 + job.instantaneousSpeed * 0.25
          job.lastChunkAt = now
          job.lastChunkBytes = progress.offset
          job.bytes = progress.offset
          if (
            now - job.lastProgressAt >= this.policy.progressIntervalMs &&
            progress.offset - job.lastProgressBytes >= this.policy.progressBytes
          ) {
            job.lastProgressAt = now
            job.lastProgressBytes = progress.offset
            this.emit(job)
          }
          return (
            progress.offset - durableOffset >= this.policy.checkpointBytes ||
            now - lastCheckpointAt >= this.policy.checkpointIntervalMs
          )
        },
        onCheckpoint: async (progress) => {
          const now = this.now()
          manifest = {
            ...manifest,
            durableOffset: progress.offset,
            lastChunk: {
              offset: progress.chunkOffset,
              size: progress.chunkSize,
              sha256: progress.chunkSha256
            },
            updatedAt: now
          }
          await session!.writeManifest(manifest)
          durableOffset = progress.offset
          lastCheckpointAt = now
          await this.record(job, session!, 'active', createdAt)
        }
      })
      if (preflight.expectedSize === 0 && manifest.durableOffset !== 0) {
        throw new TransferError('INVALID_PARTIAL', 'Empty transfer has a non-empty checkpoint')
      }
      job.bytes = preflight.expectedSize
      this.transition(job, 'verifying')
      const currentSource = await session.inspectSource()
      if (!sameSourceIdentity(currentSource, preflight.sourceIdentity)) {
        throw new TransferError('SOURCE_CHANGED', 'Transfer source changed during transfer')
      }
      const finalPartial = await session.inspectPartial()
      if (finalPartial.kind !== 'file' || finalPartial.size !== preflight.expectedSize) {
        throw new TransferError(
          'INVALID_PARTIAL',
          'Transfer partial size does not match the source'
        )
      }
      const targetSha256 = await session.hashPartial(
        this.policy.chunkSizeBytes,
        job.controller.signal
      )
      const sourceSha256 = preflight.sourceHashAvailable
        ? await session.hashSource(this.policy.chunkSizeBytes, job.controller.signal)
        : null
      const expected = job.request.expectedSha256 ?? sourceSha256
      if (
        expected === null ||
        targetSha256 !== expected ||
        (sourceSha256 && sourceSha256 !== expected)
      ) {
        throw new TransferError('HASH_MISMATCH', 'Transfer SHA-256 verification failed')
      }
      const verifiedSource = await session.inspectSource()
      if (!sameSourceIdentity(verifiedSource, preflight.sourceIdentity)) {
        throw new TransferError('SOURCE_CHANGED', 'Transfer source changed during verification')
      }
      this.transition(job, 'publishing')
      if (job.controller.signal.aborted) {
        throw new TransferError('ABORTED', 'Transfer cancelled before publish')
      }
      await session.publish()
      await session.removeManifest()
      await this.registry.remove(job.request.transferId)
      job.retentionEstablished = false
      outcome = {
        state: 'saved',
        result: {
          transferId: job.request.transferId,
          state: 'saved',
          bytes: preflight.expectedSize,
          resumedFrom: job.resumedFrom,
          sha256: targetSha256
        }
      }
    } catch (unknownError) {
      let error = asTransferError(unknownError)
      if (job.pauseRequested && !job.cancelRequested) {
        try {
          if (session !== null && job.retentionEstablished) {
            await this.record(job, session, 'paused', createdAt)
          }
          outcome = { state: 'paused' }
        } catch (retentionError) {
          error = withCleanupFailure(error, retentionError)
          outcome = { state: 'failed', error }
        }
      } else if (job.cancelRequested || error.code === 'ABORTED') {
        try {
          if (session !== null) {
            if (job.discardPartial) {
              await session.discard()
              await this.registry.remove(job.request.transferId)
              job.retentionEstablished = false
            } else if (job.retentionEstablished) {
              await this.record(job, session, 'cancelled', createdAt)
            }
          }
        } catch (retentionError) {
          error = withCleanupFailure(error, retentionError)
        }
        outcome = { state: 'cancelled', error }
      } else {
        try {
          if (session !== null && job.retentionEstablished) {
            await this.record(job, session, 'failed', createdAt)
          } else if (session !== null && partialCreatedByRun) {
            await session.discard()
          }
        } catch (retentionError) {
          error = withCleanupFailure(error, retentionError)
        }
        outcome = { state: 'failed', error }
      }
    } finally {
      try {
        try {
          await this.closeSession(job, session)
        } catch (error) {
          if (outcome?.state === 'saved' || outcome?.state === 'paused') {
            outcome = { state: 'failed', error: asTransferError(error) }
          } else if (outcome) {
            withCleanupFailure(outcome.error, error)
          }
        }
        if (outcome?.state === 'paused' && job.cancelRequested) {
          await this.finishCancelled(job, true)
        } else if (outcome?.state === 'saved') {
          if (!job.quarantined) job.session = null
          this.transition(job, 'saved')
          job.deferred.resolve(outcome.result)
        } else if (outcome?.state === 'paused') {
          // Retain only the drained session for explicit paused cleanup; resume opens a new one.
          this.transition(job, 'paused')
        } else if (outcome) {
          if (!job.quarantined) job.session = null
          this.transition(job, outcome.state, outcome.error)
          job.deferred.reject(outcome.error)
        }
      } finally {
        this.release(job)
      }
    }
  }

  private async validateResume(
    job: Job,
    session: TransferDataPlaneSession,
    manifest: TransferManifest,
    partial: Awaited<ReturnType<TransferDataPlaneSession['inspectPartial']>>,
    sourceIdentity: TransferManifest['sourceIdentity']
  ): Promise<void> {
    if (!sameSourceIdentity(manifest.sourceIdentity, sourceIdentity)) {
      throw new TransferError('SOURCE_CHANGED', 'Transfer source changed since the checkpoint')
    }
    if (
      !manifestMatchesRequest(
        manifest,
        job.request,
        sourceIdentity,
        sourceIdentity.size,
        this.policy.chunkSizeBytes
      )
    ) {
      throw new TransferError('INVALID_MANIFEST', 'Transfer manifest does not match the request')
    }
    const owner = typeof process.getuid === 'function' ? process.getuid() : null
    if (
      partial.kind !== 'file' ||
      partial.size < manifest.durableOffset ||
      (owner !== null && partial.ownerId !== owner)
    ) {
      throw new TransferError('INVALID_PARTIAL', 'Transfer partial type, owner, or size is invalid')
    }
    if (manifest.durableOffset === 0) {
      if (manifest.lastChunk !== null) {
        throw new TransferError('INVALID_MANIFEST', 'Empty checkpoint cannot have a chunk hash')
      }
      return
    }
    const chunk = manifest.lastChunk
    if (
      chunk === null ||
      chunk.offset < 0 ||
      chunk.size <= 0 ||
      chunk.offset + chunk.size !== manifest.durableOffset
    ) {
      throw new TransferError('INVALID_MANIFEST', 'Last confirmed chunk metadata is invalid')
    }
    const actual = await session.hashPartialRange(
      chunk.offset,
      chunk.size,
      this.policy.chunkSizeBytes
    )
    if (actual !== chunk.sha256) {
      throw new TransferError('HASH_MISMATCH', 'Last confirmed transfer chunk does not match')
    }
  }

  private ensureCapacity(availableBytes: number, remainingBytes: number): void {
    const requiredBytes = remainingBytes + this.policy.chunkSizeBytes + 64 * 1024
    if (!Number.isSafeInteger(availableBytes) || availableBytes < requiredBytes) {
      throw new TransferError(
        'INSUFFICIENT_SPACE',
        'Transfer destination does not have enough available space'
      )
    }
  }

  private async record(
    job: Job,
    session: TransferDataPlaneSession,
    status: TransferRegistryStatus,
    createdAt: number
  ): Promise<void> {
    const partial = await session.inspectPartial()
    await this.registry.upsert({
      transferId: job.request.transferId,
      hostKey: job.request.hostKey,
      cleanupOwner: job.request.retention?.cleanupOwner ?? job.request.dataPlaneId,
      storageKey: job.request.retention?.storageKey ?? job.request.hostKey,
      partialLocator: session.partialLocator,
      manifestLocator: session.manifestLocator,
      status,
      retainedBytes: partial.kind === 'file' ? partial.size : 0,
      createdAt,
      updatedAt: this.now()
    })
  }

  private transition(job: Job, state: TransferState, error?: TransferError): void {
    job.state = transitionTransferState(job.state, state)
    this.emit(job, error)
  }

  private emit(job: Job, error?: TransferError): void {
    const event = Object.freeze({
      transferId: job.request.transferId,
      direction: job.request.direction,
      state: job.state,
      bytesTransferred: job.bytes,
      totalBytes: job.totalBytes,
      resumedFrom: job.resumedFrom,
      instantaneousBytesPerSecond: Math.max(0, Math.round(job.instantaneousSpeed)),
      smoothedBytesPerSecond: Math.max(0, Math.round(job.smoothedSpeed)),
      ...(error === undefined
        ? {}
        : { error: Object.freeze({ code: error.code, message: error.message }) })
    })
    try {
      this.onEvent(event)
    } catch {
      // Progress consumers are observational and cannot change transfer correctness.
    }
  }
}
