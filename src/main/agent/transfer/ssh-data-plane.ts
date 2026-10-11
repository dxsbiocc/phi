import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, posix, resolve } from 'node:path'
import { once } from 'node:events'
import type { Readable, Writable } from 'node:stream'

import type { WorkspaceHost } from '../workspace-host/types'
import type { RemoteStdioProcess } from '../wrappers/remote-ssh-session'
import type {
  PartialInspection,
  TransferCopyOptions,
  TransferDataPlane,
  TransferDataPlaneSession,
  TransferPreflight
} from './data-plane'
import { TransferError } from './errors'
import { parseTransferManifest, type TransferManifest } from './manifest'
import { SshDownloadSession } from './ssh-data-plane-download'
import {
  hashLocalFile,
  localOwnerId,
  localSourceIdentity,
  transferAbortError
} from './ssh-data-plane-local'
import {
  buildRemoveUploadStateScript,
  buildUploadInitializeScript,
  buildUploadPreflightScript,
  buildUploadPublishScript,
  buildUploadRangeHashScript,
  buildUploadStreamScript,
  shellScriptCommand,
  type RemoteHashTool
} from './ssh-data-plane-scripts'
import type { TransferRequest, TransferSourceIdentity } from './types'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const MAX_CONTROL_OUTPUT_BYTES = 160 * 1024
const DEFAULT_CONTROL_TIMEOUT_MS = 30 * 60 * 1000

export interface SshTransferDataPlaneOptions {
  host: WorkspaceHost
  hostId: string
  workspaceId: string
  remoteRoot: string
  canonicalRoot: string
  openStream: (command: string) => Promise<RemoteStdioProcess>
  id?: string
  controlTimeoutMs?: number
}

type UploadPreflight = Readonly<{
  hashTool: RemoteHashTool
  availableBytes: number
  partial: PartialInspection
  manifest: TransferManifest | null
}>

type RemotePaths = Readonly<{
  destinationRelative: string
  destination: string
  parent: string
  partial: string
  manifest: string
}>

function checkedRoot(value: string, label: string): string {
  if (!posix.isAbsolute(value) || posix.normalize(value) !== value || /[\0\r\n]/.test(value)) {
    throw new TransferError('INVALID_REQUEST', `${label} must be a normalized absolute POSIX path`)
  }
  return value
}

function checkedRemoteRelativePath(value: string): string {
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
  return value
}

function remotePaths(root: string, relativePath: string, transferId: string): RemotePaths {
  const checked = checkedRemoteRelativePath(relativePath)
  const destination = posix.join(root, checked)
  const parent = posix.dirname(destination)
  const partial = posix.join(
    parent,
    `.${posix.basename(destination)}.phi-transfer-${transferId}.part`
  )
  return {
    destinationRelative: checked,
    destination,
    parent,
    partial,
    manifest: `${partial}.json`
  }
}

function lineValue(output: string, key: string): string | null {
  const prefix = `${key}=`
  const line = output.split('\n').find((candidate) => candidate.startsWith(prefix))
  return line?.slice(prefix.length) ?? null
}

function mappedRemoteError(output: string, fallback: string): TransferError {
  switch (lineValue(output, 'PHI_ERROR')) {
    case 'DESTINATION_EXISTS':
      return new TransferError('DESTINATION_EXISTS', 'Transfer destination already exists')
    case 'HASH_UNAVAILABLE':
      return new TransferError(
        'HASH_UNAVAILABLE',
        'Remote SHA-256 verification is unavailable; size-only verification is forbidden'
      )
    case 'HASH_MISMATCH':
      return new TransferError('HASH_MISMATCH', 'Transfer SHA-256 verification failed')
    case 'INVALID_MANIFEST':
      return new TransferError('INVALID_MANIFEST', 'Remote transfer manifest is invalid')
    case 'INVALID_PARTIAL':
    case 'OFFSET_MISMATCH':
      return new TransferError('INVALID_PARTIAL', 'Remote transfer partial is invalid')
    case 'WRITE_UNAVAILABLE':
    case 'SPACE_UNAVAILABLE':
      return new TransferError('INSUFFICIENT_SPACE', 'Remote transfer destination is not writable')
    case 'INVALID_PATH':
      return new TransferError('INVALID_REQUEST', 'Remote transfer path failed containment checks')
    default:
      return new TransferError('TRANSFER_FAILED', fallback)
  }
}

function decodeManifest(hex: string): TransferManifest | null {
  if (hex === '') return null
  if (!/^(?:[a-f0-9]{2})+$/i.test(hex) || hex.length > 128 * 1024) {
    throw new TransferError('INVALID_MANIFEST', 'Remote transfer manifest encoding is invalid')
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(hex, 'hex').toString('utf8'))
  } catch {
    throw new TransferError('INVALID_MANIFEST', 'Remote transfer manifest JSON is invalid')
  }
  const manifest = parseTransferManifest(value)
  if (manifest === null) {
    throw new TransferError('INVALID_MANIFEST', 'Remote transfer manifest is invalid')
  }
  return manifest
}

async function writeBuffer(stream: Writable, buffer: Buffer): Promise<void> {
  if (stream.destroyed) throw new Error('SSH transfer stream closed while writing')
  if (!stream.write(buffer)) await once(stream, 'drain')
}

function captureText(stream: Readable, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    stream.on('data', (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      const kept = chunk.subarray(0, Math.max(0, limit - bytes))
      if (kept.byteLength > 0) chunks.push(kept)
      bytes += kept.byteLength
    })
    stream.once('error', reject)
    stream.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

class SshUploadSession implements TransferDataPlaneSession {
  readonly destinationKey: string
  readonly partialLocator: string
  readonly manifestLocator: string
  private sourceIdentity?: TransferSourceIdentity
  private preflightState?: UploadPreflight
  private manifest: TransferManifest | null = null
  private partial: PartialInspection = { kind: 'missing', size: 0, ownerId: null }
  private remoteHash?: string
  private initialized = false
  private copied = false
  private published = false

  constructor(
    private readonly request: TransferRequest,
    private readonly sourcePath: string,
    private readonly paths: RemotePaths,
    private readonly options: SshTransferDataPlaneOptions
  ) {
    this.destinationKey = `ssh:${options.hostId}:${options.workspaceId}:${paths.destinationRelative}`
    this.partialLocator = `ssh://${options.hostId}/${options.workspaceId}/${paths.partial}`
    this.manifestLocator = `ssh://${options.hostId}/${options.workspaceId}/${paths.manifest}`
  }

  async preflight(signal: AbortSignal): Promise<TransferPreflight> {
    if (signal.aborted) throw transferAbortError()
    const identity = await localSourceIdentity(this.sourcePath)
    const script = buildUploadPreflightScript({
      ...this.paths,
      canonicalRoot: this.options.canonicalRoot,
      probe: posix.join(this.paths.parent, `.phi-transfer-probe-${this.request.transferId}`)
    })
    const result = await this.options.host.exec.run(['sh', '-c', script], {
      cwd: '.',
      timeoutMs: this.options.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS,
      maxOutputBytes: MAX_CONTROL_OUTPUT_BYTES,
      signal
    })
    if (result.code !== 0)
      throw mappedRemoteError(result.stdout, 'Remote transfer preflight failed')
    const hashTool = lineValue(result.stdout, 'PHI_HASH')
    if (!['sha256sum', 'shasum', 'openssl', 'perl'].includes(hashTool ?? '')) {
      throw new TransferError(
        'HASH_UNAVAILABLE',
        'Remote SHA-256 verification is unavailable; size-only verification is forbidden'
      )
    }
    const availableBytes = Number(lineValue(result.stdout, 'PHI_SPACE'))
    const part = lineValue(result.stdout, 'PHI_PART')?.split(':')
    if (
      !Number.isSafeInteger(availableBytes) ||
      availableBytes < 0 ||
      !part ||
      !['missing', 'file'].includes(part[0]) ||
      !Number.isSafeInteger(Number(part[1])) ||
      Number(part[1]) < 0
    ) {
      throw new TransferError('TRANSFER_FAILED', 'Remote transfer preflight response is invalid')
    }
    const partial: PartialInspection =
      part[0] === 'file'
        ? { kind: 'file', size: Number(part[1]), ownerId: localOwnerId() }
        : { kind: 'missing', size: 0, ownerId: null }
    const manifest = decodeManifest(lineValue(result.stdout, 'PHI_MANIFEST_HEX') ?? '')
    this.sourceIdentity = identity
    this.partial = partial
    this.manifest = manifest
    this.preflightState = {
      hashTool: hashTool as RemoteHashTool,
      availableBytes,
      partial,
      manifest
    }
    return {
      sourceIdentity: identity,
      expectedSize: identity.size,
      sourceHashAvailable: true,
      destinationHashAvailable: true,
      destinationAvailableBytes: availableBytes
    }
  }

  inspectSource(): Promise<TransferSourceIdentity> {
    return localSourceIdentity(this.sourcePath)
  }

  async loadManifest(): Promise<TransferManifest | null> {
    this.requirePreflight()
    return this.manifest
  }

  async writeManifest(manifest: TransferManifest): Promise<void> {
    this.requirePreflight()
    this.manifest = { ...manifest }
    if (this.initialized || this.preflightState!.manifest !== null) return
    const temporary = `${this.paths.manifest}.${this.request.transferId}.tmp`
    const result = await this.runControl(
      buildUploadInitializeScript({
        ...this.paths,
        manifestTemporary: temporary,
        manifestJson: JSON.stringify(manifest)
      })
    )
    if (result.code !== 0) {
      throw mappedRemoteError(result.stdout, 'Remote transfer staging initialization failed')
    }
    this.initialized = true
  }

  async removeManifest(): Promise<void> {
    this.manifest = null
  }

  async inspectPartial(): Promise<PartialInspection> {
    this.requirePreflight()
    return { ...this.partial }
  }

  async createPartial(): Promise<void> {
    this.requirePreflight()
    this.partial = { kind: 'file', size: 0, ownerId: localOwnerId() }
  }

  async truncatePartial(size: number): Promise<void> {
    this.requirePreflight()
    this.partial = { kind: 'file', size, ownerId: localOwnerId() }
  }

  async hashPartialRange(offset: number, size: number): Promise<string> {
    if (offset === 0 && size === this.partial.size && this.remoteHash) return this.remoteHash
    const preflight = this.requirePreflight()
    const result = await this.runControl(
      buildUploadRangeHashScript({
        partial: this.paths.partial,
        offset,
        size,
        hashTool: preflight.hashTool
      })
    )
    if (result.code !== 0) {
      throw mappedRemoteError(result.stdout, 'Remote partial range verification failed')
    }
    const digest = lineValue(result.stdout, 'PHI_HASH')
    if (!digest || !SHA256_PATTERN.test(digest)) {
      throw new TransferError('HASH_UNAVAILABLE', 'Remote partial range hash is invalid')
    }
    return digest
  }

  async copy(copyOptions: TransferCopyOptions): Promise<void> {
    const preflight = this.requirePreflight()
    if (copyOptions.signal.aborted) throw transferAbortError()
    const channel = await this.options.openStream(
      shellScriptCommand(
        buildUploadStreamScript({
          partial: this.paths.partial,
          manifestPath: this.paths.manifest,
          manifestTemporary: `${this.paths.manifest}.${this.request.transferId}.stream`,
          truncateTemporary: `${this.paths.partial}.${this.request.transferId}.truncate`,
          manifest: this.manifest!,
          offset: copyOptions.offset,
          hashTool: preflight.hashTool
        })
      )
    )
    const stdout = captureText(channel.stdout)
    const stderr = captureText(channel.stderr)
    const closeOnAbort = (): void => void channel.close()
    copyOptions.signal.addEventListener('abort', closeOnAbort, { once: true })
    const source = await open(
      this.sourcePath,
      constants.O_RDONLY | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0)
    )
    const buffer = Buffer.allocUnsafe(Math.max(1, copyOptions.chunkSize))
    let position = copyOptions.offset
    let lastCheckpoint = position
    try {
      while (true) {
        if (copyOptions.signal.aborted) throw transferAbortError()
        const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, position)
        if (bytesRead === 0) break
        const chunk = buffer.subarray(0, bytesRead)
        await writeBuffer(channel.stdin, chunk)
        const progress = {
          offset: position + bytesRead,
          chunkOffset: position,
          chunkSize: bytesRead,
          chunkSha256: createHash('sha256').update(chunk).digest('hex')
        }
        position = progress.offset
        this.partial = { kind: 'file', size: position, ownerId: localOwnerId() }
        if (await copyOptions.onChunk(progress)) {
          await copyOptions.onCheckpoint(progress)
          lastCheckpoint = progress.offset
        }
        if (copyOptions.signal.aborted) throw transferAbortError()
      }
      channel.stdin.end()
      const closed = await channel.closed
      const output = await stdout
      const errorOutput = await stderr
      if (closed.code !== 0) {
        throw mappedRemoteError(`${output}\n${errorOutput}`, 'Remote transfer stream failed')
      }
      const size = Number(lineValue(output, 'PHI_SIZE'))
      const digest = lineValue(output, 'PHI_HASH')
      if (size !== position || !digest || !SHA256_PATTERN.test(digest)) {
        throw new TransferError('TRANSFER_FAILED', 'Remote transfer stream response is invalid')
      }
      this.partial = { kind: 'file', size, ownerId: localOwnerId() }
      this.remoteHash = digest
      this.copied = true
      if (position > lastCheckpoint) {
        const lastSize = Math.min(copyOptions.chunkSize, position)
        const lastOffset = position - lastSize
        await copyOptions.onCheckpoint({
          offset: position,
          chunkOffset: lastOffset,
          chunkSize: lastSize,
          chunkSha256: await hashLocalFile(this.sourcePath, copyOptions.chunkSize, {
            offset: lastOffset,
            size: lastSize
          })
        })
      }
    } catch (error) {
      await channel.close().catch(() => undefined)
      if (copyOptions.signal.aborted) throw transferAbortError()
      throw error
    } finally {
      copyOptions.signal.removeEventListener('abort', closeOnAbort)
      await source.close()
    }
  }

  hashSource(chunkSize: number, signal?: AbortSignal): Promise<string> {
    return hashLocalFile(this.sourcePath, chunkSize, undefined, signal)
  }

  async hashPartial(): Promise<string> {
    if (!this.copied || !this.remoteHash) {
      throw new TransferError('INVALID_PARTIAL', 'Remote transfer partial has not been verified')
    }
    return this.remoteHash
  }

  async publish(): Promise<void> {
    const preflight = this.requirePreflight()
    if (!this.remoteHash || !this.sourceIdentity) {
      throw new TransferError('INVALID_PARTIAL', 'Remote transfer partial has not been verified')
    }
    const result = await this.runControl(
      buildUploadPublishScript({
        ...this.paths,
        canonicalRoot: this.options.canonicalRoot,
        expectedSize: this.sourceIdentity.size,
        expectedHash: this.remoteHash,
        hashTool: preflight.hashTool
      })
    )
    if (result.code !== 0) throw mappedRemoteError(result.stdout, 'Remote transfer publish failed')
    this.partial = { kind: 'missing', size: 0, ownerId: null }
    this.manifest = null
    this.published = true
  }

  async discard(): Promise<void> {
    if (this.published) return
    const result = await this.runControl(
      buildRemoveUploadStateScript(this.paths.partial, this.paths.manifest)
    )
    if (result.code !== 0) {
      throw new TransferError('INVALID_PARTIAL', 'Remote transfer staging cannot be removed safely')
    }
    this.partial = { kind: 'missing', size: 0, ownerId: null }
    this.manifest = null
  }

  private requirePreflight(): UploadPreflight {
    if (!this.preflightState) throw new Error('SSH transfer preflight has not completed')
    return this.preflightState
  }

  private runControl(script: string): ReturnType<WorkspaceHost['exec']['run']> {
    return this.options.host.exec.run(['sh', '-c', script], {
      cwd: '.',
      timeoutMs: this.options.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS,
      maxOutputBytes: MAX_CONTROL_OUTPUT_BYTES
    })
  }
}

export class SshTransferDataPlane implements TransferDataPlane {
  readonly id: string
  private readonly options: SshTransferDataPlaneOptions

  constructor(options: SshTransferDataPlaneOptions) {
    this.options = {
      ...options,
      remoteRoot: checkedRoot(options.remoteRoot, 'Remote root'),
      canonicalRoot: checkedRoot(options.canonicalRoot, 'Canonical remote root')
    }
    this.id = options.id ?? 'ssh'
    if (!ID_PATTERN.test(this.id)) {
      throw new TransferError('INVALID_REQUEST', 'SSH data plane id is invalid')
    }
  }

  destinationKey(request: TransferRequest): string {
    if (request.direction === 'upload' && request.destination.kind === 'remote-workspace-path') {
      return `ssh:${request.destination.hostId}:${request.destination.workspaceId}:${checkedRemoteRelativePath(request.destination.relativePath)}`
    }
    if (request.direction === 'download' && request.destination.kind === 'local-path') {
      return resolve(request.destination.path)
    }
    return `unsupported:${request.transferId}`
  }

  async open(request: TransferRequest): Promise<TransferDataPlaneSession> {
    if (!ID_PATTERN.test(request.transferId)) {
      throw new TransferError('INVALID_REQUEST', 'Transfer id is invalid')
    }
    if (request.expectedSha256 !== undefined && !SHA256_PATTERN.test(request.expectedSha256)) {
      throw new TransferError('INVALID_REQUEST', 'Expected SHA-256 is invalid')
    }
    if (request.direction === 'upload') {
      if (
        request.source.kind !== 'local-path' ||
        request.destination.kind !== 'remote-workspace-path'
      ) {
        throw new TransferError(
          'INVALID_REQUEST',
          'SSH upload requires local-to-workspace endpoints'
        )
      }
      if (!isAbsolute(request.source.path)) {
        throw new TransferError('INVALID_REQUEST', 'Local transfer source must be absolute')
      }
      this.assertRemoteEndpoint(request.destination)
      return new SshUploadSession(
        request,
        request.source.path,
        remotePaths(this.options.remoteRoot, request.destination.relativePath, request.transferId),
        this.options
      )
    }
    if (request.direction === 'download') {
      if (
        request.source.kind !== 'remote-workspace-path' ||
        request.destination.kind !== 'local-path' ||
        !isAbsolute(request.destination.path)
      ) {
        throw new TransferError(
          'INVALID_REQUEST',
          'SSH download requires workspace-to-local endpoints'
        )
      }
      this.assertRemoteEndpoint(request.source)
      return new SshDownloadSession(
        request,
        checkedRemoteRelativePath(request.source.relativePath),
        request.destination.path,
        this.options
      )
    }
    throw new TransferError(
      'INVALID_REQUEST',
      'SSH data plane requires upload or download direction'
    )
  }

  private assertRemoteEndpoint(endpoint: {
    hostId: string
    workspaceId: string
    relativePath: string
  }): void {
    if (
      endpoint.hostId !== this.options.hostId ||
      endpoint.workspaceId !== this.options.workspaceId
    ) {
      throw new TransferError('INVALID_REQUEST', 'Remote transfer endpoint is not authorized')
    }
  }
}
