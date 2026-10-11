import { posix } from 'node:path'

import type { RemoteExecBoundedResult, RemoteSshSession } from '../wrappers/remote-ssh-session'
import type {
  PartialInspection,
  TransferCopyOptions,
  TransferDataPlane,
  TransferDataPlaneSession,
  TransferPreflight
} from '../transfer/data-plane'
import { TransferError } from '../transfer/errors'
import { sameSourceIdentity, type TransferManifest } from '../transfer/manifest'
import {
  buildUploadPreflightScript,
  buildUploadRangeHashScript
} from '../transfer/ssh-data-plane-scripts'
import type { TransferRequest, TransferSourceIdentity } from '../transfer/types'
import { shellQuote } from '../wrappers/remote-ssh-session'
import {
  copyCommand,
  drainBounded,
  hashFileScript,
  headCommand,
  initializeCommand,
  inspectPartialCommand,
  pathsFor,
  pathsForValues,
  publishCommand,
  removeStateCommand,
  securityPreamble,
  sourceHashCommand,
  truncateCommand,
  type Paths
} from './remote-project-download-data-plane-scripts'
import {
  checkedNumber,
  decodeManifest,
  lineValue,
  locator,
  mappedControlError,
  parseLocator,
  preflightState,
  sha256,
  sourceIdentity,
  type HttpIdentity,
  type PreflightState,
  type RemoteProjectDownloadContext
} from './remote-project-download-data-plane-state'

export type { RemoteProjectDownloadContext } from './remote-project-download-data-plane-state'

const CONTROL_BYTES = 160 * 1024
const CONTROL_TIMEOUT_MS = 30 * 60 * 1000
const SHA256 = /^[a-f0-9]{64}$/u

export class RemoteProjectDownloadDataPlane implements TransferDataPlane {
  readonly id = 'remote-http-direct'
  private readonly contexts = new Map<string, RemoteProjectDownloadContext>()

  bind(context: RemoteProjectDownloadContext): void {
    if (this.contexts.has(context.transferId)) {
      throw new TransferError('INVALID_REQUEST', 'Remote download is already active')
    }
    this.contexts.set(context.transferId, context)
  }

  unbind(transferId: string): void {
    this.contexts.delete(transferId)
  }

  destinationKey(request: TransferRequest): string {
    return this.context(request).destination
  }

  open(request: TransferRequest): Promise<TransferDataPlaneSession> {
    const context = this.context(request)
    if (
      request.direction !== 'download' ||
      request.destination.kind !== 'remote-workspace-path' ||
      request.destination.hostId !== context.hostKey ||
      request.destination.workspaceId !== context.workspaceId ||
      request.destination.relativePath !== context.relativePath
    ) {
      throw new TransferError('INVALID_REQUEST', 'Remote download endpoint is not authorized')
    }
    return Promise.resolve(new RemoteProjectDownloadSession(request, context))
  }

  private context(request: TransferRequest): RemoteProjectDownloadContext {
    const context = this.contexts.get(request.transferId)
    if (!context)
      throw new TransferError('INVALID_REQUEST', 'Remote download context is unavailable')
    return context
  }
}

class RemoteProjectDownloadSession implements TransferDataPlaneSession {
  readonly destinationKey: string
  readonly partialLocator: string
  readonly manifestLocator: string
  private readonly paths: Paths
  private state?: PreflightState
  private identity?: TransferSourceIdentity
  private httpIdentity?: HttpIdentity
  private partial: PartialInspection = { kind: 'missing', size: 0, ownerId: null }
  private manifest: TransferManifest | null = null
  private initialized = false
  private digest?: string

  constructor(
    private readonly request: TransferRequest,
    private readonly context: RemoteProjectDownloadContext
  ) {
    this.paths = pathsFor(context)
    this.destinationKey = context.destination
    this.partialLocator = locator(context, this.paths.partial)
    this.manifestLocator = locator(context, this.paths.manifest)
  }

  async preflight(signal: AbortSignal): Promise<TransferPreflight> {
    signal.throwIfAborted()
    const inspected = await this.runControl(
      [
        securityPreamble(this.context, this.paths),
        buildUploadPreflightScript({
          ...this.paths,
          canonicalRoot: this.context.canonicalRoot,
          probe: posix.join(this.paths.parent, `.phi-transfer-probe-${this.request.transferId}`)
        })
      ].join('\n'),
      signal
    )
    if (inspected.code !== 0)
      throw mappedControlError(inspected.stdout, 'Remote download preflight failed')
    this.state = preflightState(inspected.stdout)
    this.partial = this.state.partial
    this.manifest = this.state.manifest
    this.httpIdentity = await this.readHttpIdentity(signal)
    this.identity = this.httpIdentity.identity
    const staleSource =
      this.manifest !== null &&
      !sameSourceIdentity(this.manifest.sourceIdentity, this.httpIdentity.identity)
    const orphanPartial = this.manifest === null && this.partial.kind !== 'missing'
    if (
      staleSource ||
      orphanPartial ||
      (!this.httpIdentity.ifRange && (this.manifest !== null || this.partial.kind !== 'missing'))
    ) {
      await this.discard()
      this.state = { ...this.state, partial: this.partial, manifest: null }
    }
    return {
      sourceIdentity: this.identity,
      expectedSize: this.identity.size,
      sourceHashAvailable:
        this.httpIdentity.remoteSha256 !== undefined || this.request.expectedSha256 === undefined,
      destinationHashAvailable: true,
      destinationAvailableBytes: this.state.availableBytes
    }
  }

  async inspectSource(): Promise<TransferSourceIdentity> {
    return (await this.readHttpIdentity()).identity
  }

  loadManifest(): Promise<TransferManifest | null> {
    this.requireState()
    return Promise.resolve(this.manifest)
  }

  async writeManifest(manifest: TransferManifest): Promise<void> {
    this.requireState()
    this.manifest = { ...manifest }
    if (!this.initialized && this.state!.manifest === null) {
      const result = await this.runControl(
        initializeCommand(
          this.context,
          this.paths,
          `${this.paths.manifest}.${this.request.transferId}.tmp`,
          JSON.stringify(manifest)
        )
      )
      if (result.code !== 0) {
        throw mappedControlError(result.stdout, 'Remote download staging initialization failed')
      }
      this.initialized = true
      return
    }
    const temporary = `${this.paths.manifest}.${this.request.transferId}.checkpoint`
    const script = [
      'set -eu',
      securityPreamble(this.context, this.paths),
      `path=${shellQuote(this.paths.manifest)}`,
      `partial=${shellQuote(this.paths.partial)}`,
      `destination=${shellQuote(this.paths.destination)}`,
      `temporary=${shellQuote(temporary)}`,
      '[ ! -e "$destination" ] && [ ! -L "$destination" ] || fail DESTINATION_EXISTS',
      'safe_file "$path" || fail INVALID_MANIFEST',
      'safe_file "$partial" || fail INVALID_PARTIAL',
      '[ ! -L "$temporary" ] || fail INVALID_MANIFEST',
      'if [ -e "$temporary" ]; then safe_file "$temporary" || fail INVALID_MANIFEST; rm -f -- "$temporary"; fi',
      'umask 077',
      `( set -C; printf '%s\\n' ${shellQuote(JSON.stringify(manifest))} > "$temporary" )`,
      'chmod 600 "$temporary"',
      'mv -f "$temporary" "$path"',
      'safe_file "$path" || fail INVALID_MANIFEST',
      'sync "$path" 2>/dev/null || sync'
    ].join('\n')
    const result = await this.runControl(script)
    if (result.code !== 0) throw new TransferError('INVALID_MANIFEST', 'Remote checkpoint failed')
  }

  async removeManifest(): Promise<void> {
    const result = await this.runControl(
      [
        'set -eu',
        securityPreamble(this.context, this.paths),
        `path=${shellQuote(this.paths.manifest)}`,
        'if [ -L "$path" ]; then fail INVALID_MANIFEST; fi',
        'if [ -e "$path" ]; then safe_file "$path" || fail INVALID_MANIFEST; rm -f -- "$path"; fi'
      ].join('\n')
    )
    if (result.code !== 0) throw mappedControlError(result.stdout, 'Remote metadata cleanup failed')
    this.manifest = null
  }

  async inspectPartial(): Promise<PartialInspection> {
    this.requireState()
    const result = await this.runControl(inspectPartialCommand(this.context, this.paths))
    if (result.code !== 0)
      throw mappedControlError(result.stdout, 'Remote partial inspection failed')
    const encoded = lineValue(result.stdout, 'PHI_PART')?.split(':')
    if (!encoded || !['missing', 'file'].includes(encoded[0] ?? '')) {
      throw new TransferError('INVALID_PARTIAL', 'Remote partial inspection is invalid')
    }
    const size = checkedNumber(encoded[1] ?? null, 'Remote partial')
    this.partial =
      encoded[0] === 'file'
        ? {
            kind: 'file',
            size,
            ownerId: typeof process.getuid === 'function' ? process.getuid() : null
          }
        : { kind: 'missing', size: 0, ownerId: null }
    return { ...this.partial }
  }

  createPartial(): Promise<void> {
    this.requireState()
    this.partial = {
      kind: 'file',
      size: 0,
      ownerId: typeof process.getuid === 'function' ? process.getuid() : null
    }
    return Promise.resolve()
  }

  async truncatePartial(size: number): Promise<void> {
    const temporary = `${this.paths.partial}.${this.request.transferId}.truncate`
    const result = await this.runControl(truncateCommand(this.context, this.paths, temporary, size))
    if (result.code !== 0)
      throw mappedControlError(result.stdout, 'Remote partial truncation failed')
    this.partial = { ...this.partial, size }
  }

  async hashPartialRange(offset: number, size: number): Promise<string> {
    const state = this.requireState()
    const result = await this.runControl(
      buildUploadRangeHashScript({
        partial: this.paths.partial,
        offset,
        size,
        hashTool: state.hashTool
      })
    )
    if (result.code !== 0) throw mappedControlError(result.stdout, 'Remote partial hash failed')
    const digest = lineValue(result.stdout, 'PHI_HASH')
    if (!digest || !SHA256.test(digest))
      throw new TransferError('HASH_UNAVAILABLE', 'Remote hash is invalid')
    return digest
  }

  async copy(options: TransferCopyOptions): Promise<void> {
    const state = this.requireState()
    const identity = this.identity
    const httpIdentity = this.httpIdentity
    if (!identity || !httpIdentity) {
      throw new TransferError('TRANSFER_FAILED', 'Remote HTTP identity is unavailable')
    }
    if (options.offset === identity.size) {
      this.digest = await this.hashPartial()
      return
    }
    if (options.offset > 0 && !httpIdentity.ifRange) {
      throw new TransferError('SOURCE_CHANGED', 'Remote HTTP source has no safe resume validator')
    }
    if (!this.context.session.openStdio) {
      throw new TransferError('TRANSFER_FAILED', '服务器下载流后端不可用')
    }
    const channel = await this.context.session.openStdio(
      copyCommand(
        this.context,
        this.paths,
        options.offset,
        identity.size,
        httpIdentity.ifRange ?? '',
        state.hashTool
      )
    )
    channel.stdin.end()
    let pending = ''
    let finalSize: number | undefined
    let finalDigest: string | undefined
    let remoteError: string | undefined
    const stderr = drainBounded(channel.stderr)
    const closeOnAbort = (): void => void channel.close()
    options.signal.addEventListener('abort', closeOnAbort, { once: true })
    try {
      for await (const value of channel.stdout) {
        pending += Buffer.from(value).toString('utf8')
        if (Buffer.byteLength(pending) > CONTROL_BYTES) {
          throw new TransferError('TRANSFER_FAILED', 'Remote download progress exceeded its bound')
        }
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) {
          const progress = /^PHI_PROGRESS_V1\t([0-9]+)\t([0-9]+)\t([0-9]+)\t([a-f0-9]{64})$/u.exec(
            line
          )
          if (progress) {
            const offset = Number(progress[1])
            const chunkOffset = Number(progress[2])
            const chunkSize = Number(progress[3])
            if (
              !Number.isSafeInteger(offset) ||
              !Number.isSafeInteger(chunkOffset) ||
              !Number.isSafeInteger(chunkSize) ||
              chunkSize < 1 ||
              chunkOffset + chunkSize !== offset ||
              offset > identity.size
            ) {
              throw new TransferError('TRANSFER_FAILED', 'Remote download progress is invalid')
            }
            this.partial = { ...this.partial, size: offset }
            const update = {
              offset,
              chunkOffset,
              chunkSize,
              chunkSha256: progress[4]
            }
            if (await options.onChunk(update)) await options.onCheckpoint(update)
            continue
          }
          const completed = /^PHI_REMOTE_DOWNLOAD_V2\t([0-9]+)\t([a-f0-9]{64})$/u.exec(line)
          if (completed) {
            finalSize = Number(completed[1])
            finalDigest = completed[2]
            continue
          }
          const failure = /^PHI_ERROR=([A-Z_]+)$/u.exec(line)
          if (failure) remoteError = failure[1]
        }
      }
      if (pending) {
        const completed = /^PHI_REMOTE_DOWNLOAD_V2\t([0-9]+)\t([a-f0-9]{64})$/u.exec(pending)
        if (completed) {
          finalSize = Number(completed[1])
          finalDigest = completed[2]
        }
      }
      const closed = await channel.closed
      await stderr
      if (options.signal.aborted) throw new TransferError('ABORTED', 'Transfer cancelled')
      if (closed.code !== 0) throw this.copyError(remoteError)
      if (finalSize !== identity.size || !finalDigest || !SHA256.test(finalDigest)) {
        throw new TransferError('TRANSFER_FAILED', '服务器下载结果格式无效')
      }
      this.digest = finalDigest
      this.partial = { ...this.partial, size: finalSize }
    } catch (error) {
      await channel.close().catch(() => undefined)
      if (options.signal.aborted) throw new TransferError('ABORTED', 'Transfer cancelled')
      throw error
    } finally {
      options.signal.removeEventListener('abort', closeOnAbort)
    }
  }

  private copyError(code: string | undefined): TransferError {
    switch (code) {
      case 'NETWORK':
        return new TransferError(
          'TRANSFER_FAILED',
          '服务器无法联网或无法访问该地址；请检查服务器网络/防火墙后重试。'
        )
      case 'TOO_LARGE':
        return new TransferError('TRANSFER_FAILED', '服务器下载文件超过 maxFileBytes。')
      case 'SOURCE_CHANGED':
        return new TransferError('SOURCE_CHANGED', '远程 HTTP 来源不再支持安全续传。')
      case 'DESTINATION_EXISTS':
        return mappedControlError('PHI_ERROR=DESTINATION_EXISTS\n', 'Remote publish race')
      default:
        return new TransferError(
          'TRANSFER_FAILED',
          '服务器下载失败；没有改用本机网络或本机项目目录。'
        )
    }
  }

  async hashSource(_chunkSize: number, signal?: AbortSignal): Promise<string> {
    const advertised = this.httpIdentity?.remoteSha256
    if (advertised) return advertised
    const identity = this.identity
    const state = this.requireState()
    if (!identity)
      throw new TransferError('TRANSFER_FAILED', 'Remote source identity is unavailable')
    const result = await this.runControl(
      sourceHashCommand(this.context, this.paths, identity.size, state.hashTool),
      signal
    )
    const digest = lineValue(result.stdout, 'PHI_HASH')
    if (result.code !== 0 || !digest || !SHA256.test(digest)) {
      throw mappedControlError(result.stdout, 'Remote HTTP source hash failed')
    }
    return digest
  }

  async hashPartial(_chunkSize?: number, signal?: AbortSignal): Promise<string> {
    const state = this.requireState()
    if (this.digest) return this.digest
    const result = await this.runControl(
      `set -eu\ndigest=$(${hashFileScript(state.hashTool, this.paths.partial)})\nprintf 'PHI_HASH=%s\\n' "$digest"`,
      signal
    )
    const digest = lineValue(result.stdout, 'PHI_HASH')
    if (result.code !== 0 || !digest || !SHA256.test(digest)) {
      throw new TransferError('HASH_UNAVAILABLE', 'Remote SHA-256 verification failed')
    }
    this.digest = digest
    return digest
  }

  async publish(): Promise<void> {
    const state = this.requireState()
    const identity = this.identity
    const digest = await this.hashPartial()
    if (!identity)
      throw new TransferError('TRANSFER_FAILED', 'Remote source identity is unavailable')
    const result = await this.runControl(
      publishCommand(this.context, this.paths, identity.size, digest, state.hashTool)
    )
    if (result.code !== 0) throw mappedControlError(result.stdout, 'Remote publish failed')
    this.partial = { kind: 'missing', size: 0, ownerId: null }
    this.manifest = null
  }

  async discard(): Promise<void> {
    const result = await this.runControl(removeStateCommand(this.context, this.paths))
    if (result.code !== 0)
      throw mappedControlError(result.stdout, 'Remote transfer staging cannot be removed safely')
    this.partial = { kind: 'missing', size: 0, ownerId: null }
    this.manifest = null
  }

  private requireState(): PreflightState {
    if (!this.state) throw new Error('Remote download preflight has not completed')
    return this.state
  }

  private async readHttpIdentity(signal?: AbortSignal): Promise<HttpIdentity> {
    const result = await this.runControl(headCommand(this.context, this.paths), signal)
    if (result.code === 81)
      throw new TransferError(
        'TRANSFER_FAILED',
        '服务器缺少 curl，无法直接下载；请先安装 curl 或手动准备文件。'
      )
    if (result.code !== 0) {
      throw new TransferError(
        'TRANSFER_FAILED',
        '服务器无法联网或无法访问该地址；请检查服务器网络/防火墙后重试。'
      )
    }
    return sourceIdentity(result.stdout, this.context)
  }

  private runControl(script: string, signal?: AbortSignal): Promise<RemoteExecBoundedResult> {
    if (!this.context.session.execBounded)
      throw new TransferError('TRANSFER_FAILED', '服务器下载后端不可用')
    return this.context.session.execBounded(script, {
      timeoutMs: CONTROL_TIMEOUT_MS,
      maxOutputBytes: CONTROL_BYTES,
      ...(signal ? { signal } : {})
    })
  }
}

export async function remoteDownloadFreeBytes(
  context: RemoteProjectDownloadContext
): Promise<number> {
  if (!context.session.execBounded) {
    throw new TransferError('TRANSFER_FAILED', 'Remote download cleanup backend is unavailable')
  }
  const result = await context.session.execBounded(
    `set -eu\nphi_space=$(df -Pk ${shellQuote(context.canonicalRoot)} 2>/dev/null | awk 'NR == 2 { printf "%.0f", $4 * 1024 }')\ncase "$phi_space" in ''|*[!0-9]*) exit 1 ;; esac\nprintf 'PHI_SPACE=%s\\n' "$phi_space"`,
    { timeoutMs: CONTROL_TIMEOUT_MS, maxOutputBytes: CONTROL_BYTES }
  )
  const freeBytes = checkedNumber(lineValue(result.stdout, 'PHI_SPACE'), 'Remote free space')
  if (result.code !== 0 || result.stdoutTruncated || result.stderrTruncated) {
    throw new TransferError('TRANSFER_FAILED', 'Remote free-space check failed')
  }
  return freeBytes
}

export async function removeOwnedRemoteDownloadState(
  entry: Readonly<{ partialLocator: string; manifestLocator: string }>,
  session: RemoteSshSession,
  hostKey: string,
  allowedCanonicalRoots: ReadonlySet<string>
): Promise<void> {
  const partial = parseLocator(entry.partialLocator, hostKey)
  const manifest = parseLocator(entry.manifestLocator, hostKey)
  if (
    !allowedCanonicalRoots.has(partial.canonicalRoot) ||
    manifest.canonicalRoot !== partial.canonicalRoot ||
    manifest.path !== `${partial.path}.json`
  ) {
    throw new TransferError('INVALID_PARTIAL', 'Remote download registry locators do not match')
  }
  const name = posix.basename(partial.path)
  const match = /^\.(.+)\.phi-transfer-(remote_http_[a-f0-9]{48})\.part$/u.exec(name)
  if (!match || match[1].includes('/')) {
    throw new TransferError('INVALID_PARTIAL', 'Remote download registry partial is invalid')
  }
  const parent = posix.dirname(partial.path)
  const paths = pathsForValues(posix.join(parent, match[1]), match[2])
  if (paths.partial !== partial.path || paths.manifest !== manifest.path) {
    throw new TransferError('INVALID_PARTIAL', 'Remote download registry paths are invalid')
  }
  if (!session.execBounded) {
    throw new TransferError('TRANSFER_FAILED', 'Remote download cleanup backend is unavailable')
  }
  const inspected = await session.execBounded(
    [
      'set -eu',
      securityPreamble({ canonicalRoot: partial.canonicalRoot }, paths),
      `partial=${shellQuote(paths.partial)}`,
      `manifest=${shellQuote(paths.manifest)}`,
      'safe_file "$partial" || fail INVALID_PARTIAL',
      'safe_file "$manifest" || fail INVALID_MANIFEST',
      'test "$(wc -c < "$manifest" | tr -d \' \')" -le 65536 || fail INVALID_MANIFEST',
      `printf 'PHI_MANIFEST_HEX='; od -An -tx1 -v ${shellQuote(paths.manifest)} | tr -d ' \\n'; printf '\\n'`
    ].join('\n'),
    { timeoutMs: CONTROL_TIMEOUT_MS, maxOutputBytes: CONTROL_BYTES }
  )
  if (inspected.code !== 0 || inspected.stdoutTruncated || inspected.stderrTruncated) {
    throw mappedControlError(inspected.stdout, 'Remote retained download validation failed')
  }
  const encodedManifest = lineValue(inspected.stdout, 'PHI_MANIFEST_HEX') ?? ''
  const transferManifest = decodeManifest(encodedManifest)
  if (!transferManifest || transferManifest.transferId !== match[2]) {
    throw new TransferError('INVALID_MANIFEST', 'Remote retained download identity is invalid')
  }
  const manifestJson = Buffer.from(encodedManifest, 'hex').toString('utf8').trim()
  const removed = await session.execBounded(
    removeStateCommand({ canonicalRoot: partial.canonicalRoot }, paths, manifestJson),
    { timeoutMs: CONTROL_TIMEOUT_MS, maxOutputBytes: CONTROL_BYTES }
  )
  if (removed.code !== 0 || removed.stdoutTruncated || removed.stderrTruncated) {
    throw mappedControlError(removed.stdout, 'Remote retained download cleanup failed')
  }
}

export function deterministicRemoteDownloadId(
  input: Readonly<{
    hostKey: string
    workspaceId: string
    destination: string
    sourceFingerprint: string
  }>
): string {
  return `remote_http_${sha256(JSON.stringify(input)).slice(0, 48)}`
}
