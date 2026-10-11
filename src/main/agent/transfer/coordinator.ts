import { resolve, join } from 'node:path'

import { getPhiAgentDir } from '../runtime-paths'
import type { TransferDataPlane, TransferDataPlaneSession } from './data-plane'
import { TransferError } from './errors'
import { FileTransferManager } from './manager'
import { FileTransferRegistry } from './registry'
import type { RegistryCleanupResult, TransferRegistryEntry } from './registry'
import type { TransferEvent, TransferHandle, TransferPolicy, TransferRequest } from './types'

const ROUTER_DATA_PLANE_ID = 'coordinated'

export type CoordinatedTransferRequest = Omit<TransferRequest, 'dataPlaneId'>

export type FileTransferCoordinatorOptions = Readonly<{
  registry: FileTransferRegistry
  policy?: Partial<TransferPolicy>
  now?: () => number
}>

type Registration = Readonly<{
  plane: TransferDataPlane
  onEvent?: (event: TransferEvent) => void
}>

export class FileTransferCoordinator {
  readonly registry: FileTransferRegistry
  private readonly registrations = new Map<string, Registration>()
  private readonly retentionReservations = new Set<string>()
  private readonly retentionRemovals = new Set<string>()
  private readonly manager: FileTransferManager
  private readonly initialization: Promise<number>

  constructor(options: FileTransferCoordinatorOptions) {
    this.registry = options.registry
    this.initialization = options.registry.reconcileInterrupted((options.now ?? Date.now)())
    const router: TransferDataPlane = {
      id: ROUTER_DATA_PLANE_ID,
      destinationKey: (request) =>
        this.registration(request.transferId).plane.destinationKey(request),
      open: async (request): Promise<TransferDataPlaneSession> => {
        await this.initialization
        return this.registration(request.transferId).plane.open(request)
      }
    }
    this.manager = new FileTransferManager({
      registry: options.registry,
      dataPlanes: [router],
      policy: options.policy,
      now: options.now,
      onEvent: (event) => this.registrations.get(event.transferId)?.onEvent?.(event)
    })
  }

  enqueue(
    request: CoordinatedTransferRequest,
    plane: TransferDataPlane,
    onEvent?: (event: TransferEvent) => void
  ): TransferHandle {
    if (
      this.registrations.has(request.transferId) ||
      this.retentionReservations.has(request.transferId) ||
      this.retentionRemovals.has(request.transferId)
    ) {
      throw new TransferError('INVALID_REQUEST', 'Transfer id is already registered')
    }
    this.registrations.set(request.transferId, { plane, onEvent })
    let handle: TransferHandle
    try {
      handle = this.manager.enqueue({
        ...request,
        dataPlaneId: ROUTER_DATA_PLANE_ID,
        retention: request.retention ?? {
          cleanupOwner: plane.id,
          storageKey: request.hostKey
        }
      })
    } catch (error) {
      this.registrations.delete(request.transferId)
      throw error
    }
    void handle.completion.then(
      () => this.release(request.transferId),
      () => this.release(request.transferId)
    )
    return handle
  }

  reserveRetention(transferId: string): () => void {
    if (
      this.registrations.has(transferId) ||
      this.retentionReservations.has(transferId) ||
      this.retentionRemovals.has(transferId)
    ) {
      throw new TransferError('INVALID_REQUEST', 'Transfer id is already registered')
    }
    this.retentionReservations.add(transferId)
    return () => this.retentionReservations.delete(transferId)
  }

  async cleanupRetained(
    options: Readonly<{
      hostKey: string
      cleanupOwner: string
      storageKey: string
      freeBytes?: number
      now?: number
      removeOwned: (entry: TransferRegistryEntry) => Promise<void>
    }>
  ): Promise<RegistryCleanupResult> {
    await this.initialization
    const inUse = (transferId: string): boolean =>
      this.registrations.has(transferId) || this.retentionReservations.has(transferId)
    return this.registry.cleanupRetained({
      ...options,
      excludeTransferIds: new Set([
        ...this.registrations.keys(),
        ...this.retentionReservations,
        ...this.retentionRemovals
      ]),
      removeOwned: async (entry) => {
        if (inUse(entry.transferId)) return false
        this.retentionRemovals.add(entry.transferId)
        try {
          if (inUse(entry.transferId)) return false
          await options.removeOwned(entry)
          return true
        } finally {
          this.retentionRemovals.delete(entry.transferId)
        }
      }
    })
  }

  private registration(transferId: string): Registration {
    const registration = this.registrations.get(transferId)
    if (!registration) {
      throw new TransferError('INVALID_REQUEST', 'Transfer data plane registration is unavailable')
    }
    return registration
  }

  private release(transferId: string): void {
    this.manager.forget(transferId)
    this.registrations.delete(transferId)
  }
}

const defaultCoordinators = new Map<string, FileTransferCoordinator>()

export function getFileTransferCoordinator(agentDir = getPhiAgentDir()): FileTransferCoordinator {
  const key = resolve(agentDir)
  let coordinator = defaultCoordinators.get(key)
  if (!coordinator) {
    coordinator = new FileTransferCoordinator({
      registry: new FileTransferRegistry(join(key, 'transfers', 'registry.json'))
    })
    defaultCoordinators.set(key, coordinator)
  }
  return coordinator
}
