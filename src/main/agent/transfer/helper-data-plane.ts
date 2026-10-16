import { isAbsolute, posix } from 'node:path'

import type { RemoteStdioProcess } from '../wrappers/remote-ssh-session'
import type { TransferDataPlane, TransferDataPlaneSession } from './data-plane'
import {
  HelperDataPlaneProtocolClient,
  HELPER_DATA_PLANE_CHUNK_BYTES,
  HelperProtocolError
} from './helper-data-plane-protocol'
import { HelperUploadSession } from './helper-data-plane-upload'
import { HelperDownloadSession } from './helper-data-plane-download'
import { TransferError } from './errors'
import type { TransferRequest } from './types'

const DATA_PLANE_PROTOCOL_VERSION = 1
const DATA_PLANE_MAX_WINDOW = 2

export type HelperTransferDataPlaneStatus =
  Readonly<{ state: 'unknown' | 'available' }> | Readonly<{ state: 'degraded'; reason: string }>

export type HelperTransferDataPlaneOptions = Readonly<{
  hostId: string
  workspaceId: string
  remoteRoot: string
  canonicalRoot: string
  connect: () => Promise<RemoteStdioProcess>
  fallback: TransferDataPlane
  id?: string
  maxReconnects?: number
  controlTimeoutMs?: number
  onStatus?: (status: HelperTransferDataPlaneStatus) => void
}>

export type NegotiatedHelperConnection = Readonly<{
  client: HelperDataPlaneProtocolClient
  maxWindow: number
}>

type NegotiationResult = Readonly<{
  protocolVersion: number
  capabilities: Readonly<{
    transferDataPlane?: Readonly<{
      version: number
      chunkSize: number
      maxWindow: number
    }>
  }>
}>

class HelperConnectionUnavailableError extends Error {}

function supportsDataPlane(result: NegotiationResult): boolean {
  const capability = result.capabilities?.transferDataPlane
  return (
    result.protocolVersion === DATA_PLANE_PROTOCOL_VERSION &&
    capability?.version === DATA_PLANE_PROTOCOL_VERSION &&
    capability.chunkSize === HELPER_DATA_PLANE_CHUNK_BYTES &&
    capability.maxWindow >= 1 &&
    capability.maxWindow <= DATA_PLANE_MAX_WINDOW
  )
}

function checkedRemotePath(value: string): void {
  if (
    !value ||
    posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value === '.' ||
    value.split('/').includes('..') ||
    /[\0\r\n]/.test(value)
  ) {
    throw new TransferError(
      'INVALID_REQUEST',
      'Remote transfer path must stay inside the workspace'
    )
  }
}

function checkedRoot(value: string, label: string): void {
  if (!posix.isAbsolute(value) || posix.normalize(value) !== value || /[\0\r\n]/.test(value)) {
    throw new TransferError('INVALID_REQUEST', `${label} must be a normalized absolute POSIX path`)
  }
}

export class HelperTransferDataPlane implements TransferDataPlane {
  readonly id: string
  private statusValue: HelperTransferDataPlaneStatus = { state: 'unknown' }

  constructor(private readonly options: HelperTransferDataPlaneOptions) {
    this.id = options.id ?? 'helper'
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(this.id)) {
      throw new TransferError('INVALID_REQUEST', 'Helper data plane id is invalid')
    }
    checkedRoot(options.remoteRoot, 'Remote root')
    checkedRoot(options.canonicalRoot, 'Canonical remote root')
  }

  status(): HelperTransferDataPlaneStatus {
    return this.statusValue
  }

  destinationKey(request: TransferRequest): string {
    this.validateRequest(request)
    return this.options.fallback.destinationKey(request)
  }

  async open(request: TransferRequest): Promise<TransferDataPlaneSession> {
    this.validateRequest(request)
    let connection: NegotiatedHelperConnection
    try {
      connection = await this.openNegotiatedConnection()
    } catch (error) {
      if (error instanceof HelperConnectionUnavailableError) {
        return this.degrade(request, 'Remote helper unavailable; using pure SSH fallback')
      }
      if (
        error instanceof HelperProtocolError &&
        (error.rpcCode === -32601 || error.domainCode === 'UNSUPPORTED_PROTOCOL')
      ) {
        return this.degrade(
          request,
          'Remote helper lacks transfer data-plane protocol v1; using pure SSH fallback'
        )
      }
      throw error
    }
    await connection.client.close()
    this.updateStatus({ state: 'available' })
    if (request.direction === 'upload') {
      return new HelperUploadSession(request, this.options, (onOpened) =>
        this.openNegotiatedConnection(onOpened)
      )
    }
    if (request.direction === 'download') {
      return new HelperDownloadSession(request, this.options, () => this.openNegotiatedConnection())
    }
    throw new TransferError(
      'INVALID_REQUEST',
      'Helper data plane requires upload or download direction'
    )
  }

  private async degrade(
    request: TransferRequest,
    reason: string
  ): Promise<TransferDataPlaneSession> {
    this.updateStatus({ state: 'degraded', reason })
    return this.options.fallback.open(request)
  }

  private async openNegotiatedConnection(
    onOpened?: (client: HelperDataPlaneProtocolClient) => void
  ): Promise<NegotiatedHelperConnection> {
    let process: RemoteStdioProcess
    try {
      process = await this.options.connect()
    } catch {
      throw new HelperConnectionUnavailableError()
    }
    const client = new HelperDataPlaneProtocolClient(process, {
      requestTimeoutMs: this.options.controlTimeoutMs
    })
    try {
      onOpened?.(client)
      const negotiated = await client.request<NegotiationResult>('protocol.negotiate', {
        minVersion: DATA_PLANE_PROTOCOL_VERSION,
        maxVersion: DATA_PLANE_PROTOCOL_VERSION
      })
      if (!supportsDataPlane(negotiated)) {
        throw new HelperProtocolError('Remote helper lacks transfer data-plane protocol v1', -32601)
      }
      return {
        client,
        maxWindow: negotiated.capabilities.transferDataPlane!.maxWindow
      }
    } catch (error) {
      if (onOpened) await client.drain().catch(() => undefined)
      else await client.close().catch(() => undefined)
      throw error
    }
  }

  private updateStatus(status: HelperTransferDataPlaneStatus): void {
    this.statusValue = status
    this.options.onStatus?.(status)
  }

  private validateRequest(request: TransferRequest): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(request.transferId)) {
      throw new TransferError('INVALID_REQUEST', 'Transfer id is invalid')
    }
    if (request.expectedSha256 && !/^[a-f0-9]{64}$/.test(request.expectedSha256)) {
      throw new TransferError('INVALID_REQUEST', 'Expected SHA-256 is invalid')
    }
    if (request.direction === 'upload') {
      if (
        request.source.kind !== 'local-path' ||
        !isAbsolute(request.source.path) ||
        request.destination.kind !== 'remote-workspace-path' ||
        request.destination.hostId !== this.options.hostId ||
        request.destination.workspaceId !== this.options.workspaceId
      ) {
        throw new TransferError(
          'INVALID_REQUEST',
          'Helper upload requires authorized local-to-workspace endpoints'
        )
      }
      checkedRemotePath(request.destination.relativePath)
      return
    }
    if (request.direction === 'download') {
      if (
        request.source.kind !== 'remote-workspace-path' ||
        request.source.hostId !== this.options.hostId ||
        request.source.workspaceId !== this.options.workspaceId ||
        request.destination.kind !== 'local-path' ||
        !isAbsolute(request.destination.path)
      ) {
        throw new TransferError(
          'INVALID_REQUEST',
          'Helper download requires authorized workspace-to-local endpoints'
        )
      }
      checkedRemotePath(request.source.relativePath)
      return
    }
    throw new TransferError(
      'INVALID_REQUEST',
      'Helper data plane requires upload or download direction'
    )
  }
}
