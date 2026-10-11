import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { posix } from 'node:path'

import { remoteWorkspaceUri } from '../../../shared/remoteWorkspacePath'
import {
  resolveRemoteWorkspaceHostBinding,
  withAuthorizedRemoteWorkspacePath,
  type RemoteWorkspaceBoundaryDependencies
} from '../remote-workspace-boundary'
import { getProject, listProjects, type Project } from '../projects'
import { getPhiAgentDir } from '../runtime-paths'
import { getFileTransferCoordinator } from '../transfer'
import type { TransferEvent, TransferHandle } from '../transfer/types'
import { shellQuote, type RemoteSshSession } from '../wrappers/remote-ssh-session'
import { validateDownloadUrl } from './project-download-tool'
import {
  deterministicRemoteDownloadId,
  RemoteProjectDownloadDataPlane,
  remoteDownloadFreeBytes,
  removeOwnedRemoteDownloadState,
  type RemoteProjectDownloadContext
} from './remote-project-download-data-plane'
import type { RemoteDownloadResult } from './remote-project-download-tool'

const MAX_BYTES = 2 * 1024 * 1024 * 1024

type Request = {
  sessionId: string
  projectId: string
  requestId: string
  toolCallId: string
  url: string
  outputPath: string
  maxFileBytes: number
  expectedSha256?: string
}

type ActiveDownload = {
  controller: AbortController
  session?: RemoteSshSession
  handle?: TransferHandle
}
type DownloadIdentity = Pick<Request, 'sessionId' | 'projectId' | 'requestId'>

export type RemoteProjectDownloadDependencies = RemoteWorkspaceBoundaryDependencies &
  Readonly<{
    onTransferEvent?: (event: TransferEvent) => void
    listProjects?: () => readonly Project[]
  }>

export class RemoteProjectDownloadManager {
  private readonly active = new Map<string, ActiveDownload>()
  private readonly cancelledBeforeStart = new Set<string>()
  constructor(private readonly dependencies: RemoteProjectDownloadDependencies = {}) {}

  async run(input: unknown): Promise<RemoteDownloadResult> {
    const request = checkedRequest(input)
    const key = requestKey(request)
    if (this.active.has(key)) throw new Error('远程下载请求 ID 已在使用')
    const entry: ActiveDownload = { controller: new AbortController() }
    if (this.cancelledBeforeStart.delete(key)) entry.controller.abort()
    this.active.set(key, entry)
    try {
      return await this.execute(request, entry)
    } finally {
      this.active.delete(key)
    }
  }

  cancel(input: unknown): void {
    const key = requestKey(checkedCancelIdentity(input))
    const entry = this.active.get(key)
    if (!entry) {
      this.cancelledBeforeStart.add(key)
      while (this.cancelledBeforeStart.size > 256) {
        const oldest = this.cancelledBeforeStart.values().next().value
        if (typeof oldest !== 'string') break
        this.cancelledBeforeStart.delete(oldest)
      }
      return
    }
    entry.controller.abort()
    entry.handle?.cancel()
    if (entry.session && !entry.handle) void entry.session.close()
  }

  private async execute(request: Request, active: ActiveDownload): Promise<RemoteDownloadResult> {
    active.controller.signal.throwIfAborted()
    resolveRemoteWorkspaceHostBinding(
      { sessionId: request.sessionId, projectId: request.projectId },
      this.dependencies
    )
    const project = (this.dependencies.getProject ?? getProject)(request.projectId)
    if (!project || project.location.kind !== 'ssh') throw new Error('远程项目位置无效')
    const hostKey = project.location.hostProfileId
    return withAuthorizedRemoteWorkspacePath(
      {
        sessionId: request.sessionId,
        projectId: request.projectId,
        path: request.outputPath,
        mode: 'create'
      },
      async (authorized, session) => {
        active.session = session
        active.controller.signal.throwIfAborted()
        if (!session.execBounded) throw new Error('服务器下载后端不可用')
        const resolution = await resolveRemoteAddress(
          session,
          request.url,
          active.controller.signal
        )
        const sourceUrl = new URL(request.url)
        const sourceFingerprint = createHash('sha256')
          .update(`${sourceUrl.origin}${sourceUrl.pathname}`)
          .digest('hex')
        const transferId = deterministicRemoteDownloadId({
          hostKey,
          workspaceId: request.projectId,
          destination: authorized.path,
          sourceFingerprint
        })
        const context: RemoteProjectDownloadContext = {
          transferId,
          hostKey,
          workspaceId: request.projectId,
          session,
          url: request.url,
          sourceFingerprint,
          ...(resolution.curlResolve ? { curlResolve: resolution.curlResolve } : {}),
          destination: authorized.path,
          relativePath: authorized.relativePath,
          canonicalRoot: authorized.canonicalRoot,
          maxFileBytes: request.maxFileBytes
        }
        const coordinator = getFileTransferCoordinator(
          this.dependencies.agentDir ?? getPhiAgentDir()
        )
        const releaseReservation = coordinator.reserveRetention(transferId)
        let storageKey: string
        try {
          const freeBytes = await remoteDownloadFreeBytes(context)
          const allowedRoots = new Set(
            (this.dependencies.listProjects ?? listProjects)().flatMap((candidate) =>
              candidate.location.kind === 'ssh' && candidate.location.hostProfileId === hostKey
                ? [candidate.location.canonicalRoot]
                : []
            )
          )
          allowedRoots.add(authorized.canonicalRoot)
          storageKey = `remote-root:${createHash('sha256').update(authorized.canonicalRoot).digest('hex')}`
          await coordinator.cleanupRetained({
            hostKey,
            cleanupOwner: 'remote-http-direct',
            storageKey,
            freeBytes,
            removeOwned: (entry) =>
              removeOwnedRemoteDownloadState(entry, session, hostKey, allowedRoots)
          })
        } finally {
          releaseReservation()
        }
        const plane = new RemoteProjectDownloadDataPlane()
        plane.bind(context)
        try {
          const handle = coordinator.enqueue(
            {
              transferId,
              direction: 'download',
              hostKey,
              retention: { cleanupOwner: 'remote-http-direct', storageKey },
              source: {
                kind: 'remote-workspace-path',
                hostId: hostKey,
                workspaceId: request.projectId,
                relativePath: '.phi-http-source/' + sourceFingerprint
              },
              destination: {
                kind: 'remote-workspace-path',
                hostId: hostKey,
                workspaceId: request.projectId,
                relativePath: authorized.relativePath
              },
              ...(request.expectedSha256 ? { expectedSha256: request.expectedSha256 } : {})
            },
            plane,
            this.dependencies.onTransferEvent
          )
          active.handle = handle
          if (active.controller.signal.aborted) handle.cancel()
          const result = await handle.completion
          return {
            path: remoteWorkspaceUri(authorized.hostAlias, authorized.path),
            displayPath: authorized.relativePath,
            bytes: result.bytes
          }
        } finally {
          plane.unbind(transferId)
        }
      },
      this.dependencies
    )
  }
}

type RemoteAddress = { curlResolve?: string }

async function resolveRemoteAddress(
  session: RemoteSshSession,
  input: string,
  signal: AbortSignal
): Promise<RemoteAddress> {
  const url = new URL(input)
  const hostname = url.hostname.replace(/^\[|\]$/gu, '')
  if (isIP(hostname)) {
    if (!isPublicIp(hostname)) throw new Error('Download blocked: private server address')
    return {}
  }
  if (!session.execBounded) throw new Error('服务器 DNS 安全检查不可用')
  const command = `command -v getent >/dev/null 2>&1 || exit 91\ngetent ahosts ${shellQuote(hostname)} | awk '{print $1}' | sort -u`
  const result = await session.execBounded(command, {
    timeoutMs: 30_000,
    maxOutputBytes: 8192,
    signal
  })
  if (result.code !== 0 || result.stdoutTruncated || result.stderrTruncated) {
    throw new Error('服务器无法安全解析下载地址；请检查 DNS 或安装 getent。')
  }
  const addresses = result.stdout.split(/\s+/u).filter(Boolean)
  if (
    addresses.length < 1 ||
    addresses.length > 32 ||
    addresses.some((item) => !isPublicIp(item))
  ) {
    throw new Error('Download blocked: hostname resolves to a private or invalid server address')
  }
  const address = addresses[0]
  const pinned = address.includes(':') ? `[${address}]` : address
  return { curlResolve: `${hostname}:${url.port || '443'}:${pinned}` }
}

function isPublicIp(address: string): boolean {
  if (isIP(address) === 4) return isPublicIpv4(address)
  if (isIP(address) !== 6) return false
  const bytes = ipv6Bytes(address)
  if (!bytes) return false
  if (bytes.every((value) => value === 0)) return false
  if (bytes.slice(0, 15).every((value) => value === 0) && bytes[15] === 1) return false
  if (bytes[0] === 0xff || (bytes[0] & 0xfe) === 0xfc) return false
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) !== 0) return false
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
    return false
  }
  if (bytes[0] === 0x20 && (bytes[1] === 0x02 || (bytes[1] === 0x01 && bytes[2] === 0))) {
    return false
  }
  const mapped =
    bytes.slice(0, 10).every((value) => value === 0) && bytes[10] === 0xff && bytes[11] === 0xff
  return mapped ? isPublicIpv4(bytes.slice(12).join('.')) : true
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split('.').map(Number)
  if (
    octets.length !== 4 ||
    octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  )
    return false
  const [first, second, third] = octets
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false
  if (first === 100 && second >= 64 && second <= 127) return false
  if (first === 169 && second === 254) return false
  if (first === 172 && second >= 16 && second <= 31) return false
  if (first === 192 && (second === 0 || second === 168)) return false
  if (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100)))
    return false
  return !(first === 203 && second === 0 && third === 113)
}

function ipv6Bytes(address: string): number[] | undefined {
  let normalized = address.toLowerCase()
  if (normalized.includes('.')) {
    const split = normalized.lastIndexOf(':')
    const tail = normalized
      .slice(split + 1)
      .split('.')
      .map(Number)
    if (
      tail.length !== 4 ||
      tail.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
    )
      return undefined
    normalized = `${normalized.slice(0, split)}:${((tail[0] << 8) | tail[1]).toString(16)}:${((tail[2] << 8) | tail[3]).toString(16)}`
  }
  const halves = normalized.split('::')
  if (halves.length > 2) return undefined
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined
  const parts = [...left, ...Array.from({ length: missing }, () => '0'), ...right]
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) return undefined
  return parts.flatMap((part) => {
    const value = Number.parseInt(part, 16)
    return [value >> 8, value & 0xff]
  })
}

function checkedRequest(value: unknown): Request {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('远程下载请求无效')
  const record = value as Record<string, unknown>
  const allowed = [
    'sessionId',
    'projectId',
    'requestId',
    'toolCallId',
    'url',
    'outputPath',
    'maxFileBytes',
    'expectedSha256'
  ]
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error('远程下载请求无效')
  if (
    ![
      record.sessionId,
      record.projectId,
      record.requestId,
      record.toolCallId,
      record.url,
      record.outputPath
    ].every((item) => typeof item === 'string' && item.length > 0)
  ) {
    throw new Error('远程下载请求无效')
  }
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(record.requestId as string))
    throw new Error('远程下载请求 ID 无效')
  validateDownloadUrl(new URL(record.url as string))
  if (unsafeOutputPath(record.outputPath as string)) throw new Error('远程下载目标必须位于项目内')
  if (
    !Number.isInteger(record.maxFileBytes) ||
    (record.maxFileBytes as number) < 1 ||
    (record.maxFileBytes as number) > MAX_BYTES
  )
    throw new Error('远程下载大小上限无效')
  if (
    record.expectedSha256 !== undefined &&
    (typeof record.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.expectedSha256))
  ) {
    throw new Error('远程下载 SHA-256 无效')
  }
  return record as unknown as Request
}

function unsafeOutputPath(path: string): boolean {
  return (
    path.includes('\0') ||
    /^ssh:\/\//i.test(path) ||
    posix.isAbsolute(path) ||
    path.split('/').includes('..')
  )
}

function checkedCancelIdentity(value: unknown): DownloadIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('远程下载取消请求无效')
  }
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).some((key) => !['sessionId', 'projectId', 'requestId'].includes(key)) ||
    typeof record.sessionId !== 'string' ||
    !record.sessionId ||
    typeof record.projectId !== 'string' ||
    !record.projectId ||
    typeof record.requestId !== 'string' ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(record.requestId)
  ) {
    throw new Error('远程下载取消请求无效')
  }
  return record as unknown as DownloadIdentity
}

function requestKey(identity: DownloadIdentity): string {
  return JSON.stringify([identity.sessionId, identity.projectId, identity.requestId])
}
