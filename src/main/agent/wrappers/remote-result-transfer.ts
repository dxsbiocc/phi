import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rename, rm, stat, statfs, unlink } from 'node:fs/promises'
import { basename, dirname, join, posix } from 'node:path'

import type { WrapperResultDownloadProgress } from '../../../shared/wrapperResultTypes'
import {
  getFileTransferCoordinator,
  HelperTransferDataPlane,
  TransferError,
  type FileTransferCoordinator,
  type TransferEvent,
  type TransferManifest,
  type TransferRegistryEntry,
  type TransferRequest,
  type TransferResult,
  type TransferSourceIdentity
} from '../transfer'
import type {
  PartialInspection,
  TransferCopyOptions,
  TransferDataPlane,
  TransferDataPlaneSession,
  TransferPreflight
} from '../transfer/data-plane'
import { getPhiAgentDir } from '../runtime-paths'
import { SshTransferDataPlane } from '../transfer/ssh-data-plane'
import { readCapabilityProfile } from '../workspace-host/capability-profile-store'
import type { WorkspaceHost } from '../workspace-host/types'
import type { AuthorizedWrapperResultPath } from './remote-results'
import { shellQuote, type RemoteSshSession, type RemoteStdioProcess } from './remote-ssh-session'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const CLEANUP_OWNER = 'wrapper-result'
export type WrapperDownloadTargetSnapshot = Readonly<{
  dev: number
  ino: number
  size: number
  mtimeMs: number
}>

export type WrapperResultTransferOptions = Readonly<{
  requestId: string
  authorized: AuthorizedWrapperResultPath
  session: RemoteSshSession
  destination: string
  agentDir?: string
  signal?: AbortSignal
  expectedSha256?: string
  targetBefore: WrapperDownloadTargetSnapshot | null
  helperConnect?: () => Promise<RemoteStdioProcess>
  coordinator?: FileTransferCoordinator
  onProgress?: (progress: WrapperResultDownloadProgress) => void
}>

function transferIdentity(options: WrapperResultTransferOptions): string {
  const digest = createHash('sha256')
    .update(options.authorized.hostProfileId)
    .update('\0')
    .update(options.authorized.projectId)
    .update('\0')
    .update(options.authorized.runId)
    .update('\0')
    .update(options.authorized.scope)
    .update('\0')
    .update(options.authorized.path)
    .update('\0')
    .update(options.destination)
    .digest('hex')
  return `wrapper-${digest.slice(0, 40)}`
}

function authorizationId(authorized: AuthorizedWrapperResultPath): string {
  return createHash('sha256')
    .update(authorized.hostProfileId)
    .update('\0')
    .update(authorized.runId)
    .update('\0')
    .update(authorized.scope)
    .update('\0')
    .update(authorized.root)
    .digest('hex')
}

function checkedExpectedSha256(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const digest = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value
  if (!SHA256_PATTERN.test(digest)) throw new Error('预期 SHA-256 摘要无效')
  return digest
}

async function targetSnapshot(path: string): Promise<WrapperDownloadTargetSnapshot | null> {
  try {
    const metadata = await lstat(path)
    if (!metadata.isFile()) throw new Error('本地保存位置不是普通文件')
    return {
      dev: metadata.dev,
      ino: metadata.ino,
      size: metadata.size,
      mtimeMs: metadata.mtimeMs
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function sameTarget(
  before: WrapperDownloadTargetSnapshot | null,
  after: WrapperDownloadTargetSnapshot | null
): boolean {
  if (!before || !after) return before === after
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs
  )
}

export async function captureWrapperDownloadTarget(
  path: string
): Promise<WrapperDownloadTargetSnapshot | null> {
  return targetSnapshot(path)
}

async function validateOwnedCleanupFile(
  path: string,
  entry: TransferRegistryEntry,
  manifest: boolean
): Promise<boolean> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  try {
    const metadata = await handle.stat()
    const owner = typeof process.getuid === 'function' ? process.getuid() : null
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (owner !== null && metadata.uid !== owner) ||
      (metadata.mode & 0o777) !== 0o600 ||
      (manifest && metadata.size > 64 * 1024)
    ) {
      throw new Error('拒绝清理类型、所有者或权限异常的结果传输文件')
    }
    if (manifest) {
      let value: unknown
      try {
        value = JSON.parse(await handle.readFile('utf8'))
      } catch {
        throw new Error('拒绝清理内容异常的结果传输 manifest')
      }
      if (
        typeof value !== 'object' ||
        value === null ||
        (value as { transferId?: unknown }).transferId !== entry.transferId
      ) {
        throw new Error('拒绝清理传输 ID 不匹配的结果传输 manifest')
      }
    }
    return true
  } finally {
    await handle.close()
  }
}

async function removeOwnedLocalTransfer(entry: TransferRegistryEntry): Promise<void> {
  const expectedSuffix = `.phi-transfer-${entry.transferId}.part`
  if (
    !basename(entry.partialLocator).endsWith(expectedSuffix) ||
    entry.manifestLocator !== `${entry.partialLocator}.json`
  ) {
    throw new Error('拒绝清理不匹配的结果传输文件')
  }
  const [partialExists, manifestExists] = await Promise.all([
    validateOwnedCleanupFile(entry.partialLocator, entry, false),
    validateOwnedCleanupFile(entry.manifestLocator, entry, true)
  ])
  if (partialExists) await unlink(entry.partialLocator)
  if (manifestExists) await unlink(entry.manifestLocator)
}

function commandHost(session: RemoteSshSession): WorkspaceHost {
  return {
    exec: {
      async run(command, options) {
        if (command.length !== 3 || command[0] !== 'sh' || command[1] !== '-c') {
          throw new Error('远程结果传输只允许固定 shell 控制命令')
        }
        if (!session.execBounded) {
          throw new Error('SSH 连接不支持有界结果传输控制命令')
        }
        options.signal?.throwIfAborted()
        const result = await session.execBounded(command[2], {
          timeoutMs: options.timeoutMs ?? 30 * 60 * 1000,
          maxOutputBytes: options.maxOutputBytes ?? 64 * 1024,
          signal: options.signal
        })
        options.signal?.throwIfAborted()
        const stdoutTruncated = 'stdoutTruncated' in result && result.stdoutTruncated
        const stderrTruncated = 'stderrTruncated' in result && result.stderrTruncated
        return {
          ...result,
          truncated: stdoutTruncated || stderrTruncated,
          stdoutTruncated,
          stderrTruncated
        }
      },
      async spawnBackground() {
        throw new Error('远程结果传输不允许后台命令')
      }
    }
  } as unknown as WorkspaceHost
}

function installedHelperConnect(
  options: WrapperResultTransferOptions
): (() => Promise<RemoteStdioProcess>) | undefined {
  if (options.helperConnect) return options.helperConnect
  if (!options.session.execBounded || !options.session.openStdio) return undefined
  const profile = readCapabilityProfile(
    {
      hostAlias: options.authorized.hostAlias,
      projectRoot: options.authorized.workspaceRoot
    },
    { agentDir: options.agentDir ?? getPhiAgentDir() }
  )
  const version = profile?.helperVersion
  if (
    profile?.helperStatus?.state !== 'available' ||
    typeof version !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version)
  ) {
    return undefined
  }
  const useHome =
    profile.storage?.homeWritable.state === 'available' &&
    profile.storage.homeExecutable.state === 'available'
  let remotePath: Promise<string> | undefined
  const locate = async (): Promise<string> => {
    const base = useHome ? 'base="$HOME/.phi/remote"' : 'base="${TMPDIR:-/tmp}/phi-remote-$(id -u)"'
    const script = [
      'set -eu',
      `version=${shellQuote(version)}`,
      base,
      'candidate="$base/$version/phi-helper"',
      '[ -f "$candidate" ] && [ ! -L "$candidate" ] && [ -x "$candidate" ] || exit 73',
      "printf 'PHI_HELPER_HEX='",
      "printf '%s' \"$candidate\" | od -An -tx1 -v | tr -d ' \\n'",
      "printf '\\n'"
    ].join('\n')
    const result = await options.session.execBounded!(`sh -c ${shellQuote(script)}`, {
      timeoutMs: 30_000,
      maxOutputBytes: 16 * 1024,
      signal: options.signal
    })
    if (result.code !== 0 || result.stdoutTruncated || result.stderrTruncated) {
      throw new Error('Remote helper unavailable')
    }
    const match = /^PHI_HELPER_HEX=([a-f0-9]+)$/m.exec(result.stdout)
    if (!match || match[1].length > 16 * 1024 || match[1].length % 2 !== 0) {
      throw new Error('Remote helper path response is invalid')
    }
    const path = Buffer.from(match[1], 'hex').toString('utf8')
    if (
      !posix.isAbsolute(path) ||
      posix.normalize(path) !== path ||
      /[\0\r\n]/.test(path) ||
      Buffer.from(path).toString('hex') !== match[1]
    ) {
      throw new Error('Remote helper path is invalid')
    }
    return path
  }
  return async () => {
    remotePath ??= locate()
    const path = await remotePath
    return options.session.openStdio!(
      `${shellQuote(path)} serve --root ${shellQuote(options.authorized.root)}`
    )
  }
}

class WrapperPublishingSession implements TransferDataPlaneSession {
  readonly destinationKey: string
  private readyPublished = false

  constructor(
    private readonly inner: TransferDataPlaneSession,
    private readonly readyPath: string,
    private readonly destination: string,
    private readonly targetBefore: WrapperDownloadTargetSnapshot | null,
    private readonly expectedTransferId: string
  ) {
    this.destinationKey = destination
  }

  get partialLocator(): string {
    return this.readyPublished ? this.readyPath : this.inner.partialLocator
  }

  get manifestLocator(): string {
    return this.inner.manifestLocator
  }

  async preflight(signal: AbortSignal): Promise<TransferPreflight> {
    await this.restoreInterruptedPublish()
    return this.inner.preflight(signal)
  }

  inspectSource(): Promise<TransferSourceIdentity> {
    return this.inner.inspectSource()
  }

  loadManifest(): Promise<TransferManifest | null> {
    return this.inner.loadManifest()
  }

  writeManifest(manifest: TransferManifest): Promise<void> {
    return this.inner.writeManifest(manifest)
  }

  removeManifest(): Promise<void> {
    return this.inner.removeManifest()
  }

  async inspectPartial(): Promise<PartialInspection> {
    if (!this.readyPublished) return this.inner.inspectPartial()
    try {
      const metadata = await lstat(this.readyPath)
      return {
        kind: metadata.isFile()
          ? ('file' as const)
          : metadata.isDirectory()
            ? ('directory' as const)
            : metadata.isSymbolicLink()
              ? ('symlink' as const)
              : ('other' as const),
        size: metadata.size,
        ownerId: typeof metadata.uid === 'number' ? metadata.uid : null
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { kind: 'missing' as const, size: 0, ownerId: null }
      }
      throw error
    }
  }

  createPartial(): Promise<void> {
    return this.inner.createPartial()
  }

  truncatePartial(size: number): Promise<void> {
    return this.inner.truncatePartial(size)
  }

  hashPartialRange(offset: number, size: number, chunkSize: number): Promise<string> {
    return this.inner.hashPartialRange(offset, size, chunkSize)
  }

  copy(options: TransferCopyOptions): Promise<void> {
    return this.inner.copy(options)
  }

  hashSource(chunkSize: number, signal?: AbortSignal): Promise<string> {
    return this.inner.hashSource(chunkSize, signal)
  }

  hashPartial(chunkSize: number, signal?: AbortSignal): Promise<string> {
    return this.inner.hashPartial(chunkSize, signal)
  }

  async publish(): Promise<void> {
    await this.inner.publish()
    this.readyPublished = true
    try {
      if (!sameTarget(this.targetBefore, await targetSnapshot(this.destination))) {
        throw new Error('本地目标文件在下载期间发生变化，拒绝覆盖')
      }
      await rename(this.readyPath, this.destination)
      this.readyPublished = false
    } catch (error) {
      try {
        await rename(this.readyPath, this.inner.partialLocator)
        this.readyPublished = false
      } catch {
        // A later retry restores the validated ready file before manager preflight.
      }
      throw error
    }
  }

  async discard(): Promise<void> {
    await this.inner.discard()
    await rm(this.readyPath, { force: true }).catch(() => undefined)
  }

  private async restoreInterruptedPublish(): Promise<void> {
    let ready
    try {
      ready = await lstat(this.readyPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const [partial, manifest] = await Promise.all([
      this.inner.inspectPartial(),
      this.inner.loadManifest()
    ])
    const owner = typeof process.getuid === 'function' ? process.getuid() : null
    const chunk = manifest?.lastChunk
    const validEmpty = ready.size === 0 && manifest?.durableOffset === 0 && chunk === null
    const validChunk =
      ready.size > 0 &&
      chunk !== null &&
      chunk !== undefined &&
      chunk.offset >= 0 &&
      chunk.size > 0 &&
      chunk.offset + chunk.size === manifest?.durableOffset
    if (
      !ready.isFile() ||
      ready.isSymbolicLink() ||
      ready.nlink !== 1 ||
      (owner !== null && ready.uid !== owner) ||
      (ready.mode & 0o777) !== 0o600 ||
      partial.kind !== 'missing' ||
      manifest === null ||
      manifest.transferId !== this.expectedTransferId ||
      manifest.durableOffset !== ready.size ||
      (!validEmpty && !validChunk)
    ) {
      throw new TransferError('INVALID_PARTIAL', 'Interrupted result publication is invalid')
    }
    await rename(this.readyPath, this.inner.partialLocator)
    if (!validChunk || chunk === null || chunk === undefined) return
    try {
      const actual = await this.inner.hashPartialRange(chunk.offset, chunk.size, manifest.chunkSize)
      if (actual !== chunk.sha256) {
        throw new TransferError('HASH_MISMATCH', 'Interrupted result publication chunk changed')
      }
    } catch (error) {
      await rename(this.inner.partialLocator, this.readyPath).catch(() => undefined)
      throw error
    }
  }
}

class AuthorizedWrapperResultDataPlane implements TransferDataPlane {
  readonly id = 'wrapper-result-ssh'

  constructor(
    private readonly options: WrapperResultTransferOptions,
    private readonly expectedAuthorizationId: string,
    private readonly finalDestination: string,
    private readonly expectedTransferId: string,
    private readonly expectedReadyPath: string
  ) {}

  destinationKey(): string {
    return this.finalDestination
  }

  async open(request: TransferRequest): Promise<TransferDataPlaneSession> {
    const source = request.source
    const relativePath = posix.relative(this.options.authorized.root, this.options.authorized.path)
    if (
      request.transferId !== this.expectedTransferId ||
      request.direction !== 'download' ||
      source.kind !== 'authorized-wrapper-result-path' ||
      source.hostId !== this.options.authorized.hostProfileId ||
      source.authorizationId !== this.expectedAuthorizationId ||
      source.relativePath !== relativePath ||
      request.destination.kind !== 'local-path' ||
      request.destination.path !== this.expectedReadyPath
    ) {
      throw new Error('远程结果传输授权已失效')
    }
    if (!relativePath || relativePath.startsWith('../') || posix.isAbsolute(relativePath)) {
      throw new Error('远程结果传输源必须是授权范围内的文件')
    }
    if (!this.options.session.openStdio) throw new Error('SSH 连接不支持流式结果下载')
    const translated: TransferRequest = {
      ...request,
      dataPlaneId: 'ssh',
      source: {
        kind: 'remote-workspace-path',
        hostId: source.hostId,
        workspaceId: source.authorizationId,
        relativePath
      }
    }
    const sshPlane = new SshTransferDataPlane({
      host: commandHost(this.options.session),
      hostId: source.hostId,
      workspaceId: source.authorizationId,
      remoteRoot: this.options.authorized.root,
      canonicalRoot: this.options.authorized.root,
      openStream: (command) => this.options.session.openStdio!(command)
    })
    const connectHelper = installedHelperConnect(this.options)
    const plane = connectHelper
      ? new HelperTransferDataPlane({
          hostId: source.hostId,
          workspaceId: source.authorizationId,
          remoteRoot: this.options.authorized.root,
          canonicalRoot: this.options.authorized.root,
          connect: connectHelper,
          fallback: sshPlane
        })
      : sshPlane
    return new WrapperPublishingSession(
      await plane.open({ ...translated, dataPlaneId: plane.id }),
      this.expectedReadyPath,
      this.finalDestination,
      this.options.targetBefore,
      this.expectedTransferId
    )
  }
}

function progressPhase(state: TransferEvent['state']): WrapperResultDownloadProgress['phase'] {
  if (state === 'verifying') return 'verifying'
  if (state === 'publishing' || state === 'saved') return 'saving'
  return 'downloading'
}

export async function transferAuthorizedWrapperResult(
  options: WrapperResultTransferOptions
): Promise<TransferResult> {
  const transferId = transferIdentity(options)
  const authId = authorizationId(options.authorized)
  const readyPath = join(
    dirname(options.destination),
    `.${basename(options.destination)}.phi-wrapper-${transferId}.ready`
  )
  const plane = new AuthorizedWrapperResultDataPlane(
    options,
    authId,
    options.destination,
    transferId,
    readyPath
  )
  const coordinator =
    options.coordinator ?? getFileTransferCoordinator(options.agentDir ?? getPhiAgentDir())
  const releaseReservation = coordinator.reserveRetention(transferId)
  let storageKey: string
  try {
    const filesystem = await statfs(dirname(options.destination))
    storageKey = `local-device:${(await stat(dirname(options.destination))).dev}`
    const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize)
    await coordinator.cleanupRetained({
      hostKey: options.authorized.hostProfileId,
      cleanupOwner: CLEANUP_OWNER,
      storageKey,
      freeBytes: Number.isSafeInteger(freeBytes) ? freeBytes : 0,
      removeOwned: removeOwnedLocalTransfer
    })
  } finally {
    releaseReservation()
  }
  const handle = coordinator.enqueue(
    {
      transferId,
      direction: 'download',
      hostKey: options.authorized.hostProfileId,
      retention: { cleanupOwner: CLEANUP_OWNER, storageKey },
      source: {
        kind: 'authorized-wrapper-result-path',
        hostId: options.authorized.hostProfileId,
        authorizationId: authId,
        relativePath: posix.relative(options.authorized.root, options.authorized.path)
      },
      destination: { kind: 'local-path', path: readyPath },
      expectedSha256: checkedExpectedSha256(options.expectedSha256)
    },
    plane,
    (event) => {
      if (!['transferring', 'verifying', 'publishing'].includes(event.state)) return
      if (event.state === 'transferring' && event.bytesTransferred === 0) return
      if (event.state === 'verifying') {
        options.onProgress?.({
          requestId: options.requestId,
          phase: 'downloading',
          bytesDownloaded: event.bytesTransferred,
          totalBytes: event.totalBytes ?? 0
        })
      }
      options.onProgress?.({
        requestId: options.requestId,
        phase: progressPhase(event.state),
        bytesDownloaded: event.bytesTransferred,
        totalBytes: event.totalBytes ?? 0
      })
    }
  )
  const cancel = (): void => handle.cancel()
  options.signal?.addEventListener('abort', cancel, { once: true })
  if (options.signal?.aborted) handle.cancel()
  try {
    return await handle.completion
  } catch (error) {
    if (error instanceof TransferError && error.code === 'SOURCE_CHANGED') {
      throw new Error('远端文件在下载期间发生变化', { cause: error })
    }
    if (error instanceof TransferError && error.code === 'HASH_MISMATCH') {
      throw new Error('下载文件与服务器摘要不一致', { cause: error })
    }
    throw error
  } finally {
    options.signal?.removeEventListener('abort', cancel)
  }
}
