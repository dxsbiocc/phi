import { isIP } from 'node:net'
import { posix } from 'node:path'

import { remoteWorkspaceUri } from '../../../shared/remoteWorkspacePath'
import {
  withAuthorizedRemoteWorkspacePath,
  type RemoteWorkspaceBoundaryDependencies
} from '../remote-workspace-boundary'
import { shellQuote, type RemoteSshSession } from '../wrappers/remote-ssh-session'
import { validateDownloadUrl } from './project-download-tool'
import type { RemoteDownloadResult } from './remote-project-download-tool'

const MAX_BYTES = 2 * 1024 * 1024 * 1024
const OUTPUT_BYTES = 16 * 1024

type Request = {
  sessionId: string
  projectId: string
  requestId: string
  toolCallId: string
  url: string
  outputPath: string
  maxFileBytes: number
}

type ActiveDownload = { controller: AbortController; session?: RemoteSshSession }
type DownloadIdentity = Pick<Request, 'sessionId' | 'projectId' | 'requestId'>

export class RemoteProjectDownloadManager {
  private readonly active = new Map<string, ActiveDownload>()
  private readonly cancelledBeforeStart = new Set<string>()

  constructor(private readonly dependencies: RemoteWorkspaceBoundaryDependencies = {}) {}

  async run(input: unknown): Promise<RemoteDownloadResult> {
    const request = checkedRequest(input)
    const key = requestKey(request)
    if (this.active.has(key)) throw new Error('远程下载请求 ID 已在使用')
    const entry: ActiveDownload = { controller: new AbortController() }
    if (this.cancelledBeforeStart.delete(key)) entry.controller.abort()
    this.active.set(key, entry)
    try {
      return await executeRemoteDownload(request, entry, this.dependencies)
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
    if (entry?.session) void entry.session.close()
  }
}

async function executeRemoteDownload(
  request: Request,
  active: ActiveDownload,
  dependencies: RemoteWorkspaceBoundaryDependencies
): Promise<RemoteDownloadResult> {
  active.controller.signal.throwIfAborted()
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
      const resolution = await resolveRemoteAddress(session, request.url, active.controller.signal)
      const result = await session.execBounded(
        downloadCommand(request, authorized.path, authorized.canonicalRoot, resolution),
        {
          timeoutMs: 600_000,
          maxOutputBytes: OUTPUT_BYTES,
          signal: active.controller.signal
        }
      )
      const bytes = downloadedBytes(result)
      return {
        path: remoteWorkspaceUri(authorized.hostAlias, authorized.path),
        displayPath: authorized.relativePath,
        bytes
      }
    },
    dependencies
  )
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

function downloadCommand(
  request: Request,
  destination: string,
  canonicalRoot: string,
  remoteAddress: RemoteAddress
): string {
  const resolveArgument = remoteAddress.curlResolve
    ? ` --resolve ${shellQuote(remoteAddress.curlResolve)}`
    : ''
  return [
    'set +e',
    'umask 077',
    `phi_url=${shellQuote(request.url)}`,
    `phi_root=${shellQuote(canonicalRoot)}`,
    `phi_parent=${shellQuote(posix.dirname(destination))}`,
    `phi_dest=${shellQuote(posix.basename(destination))}`,
    'cd -P -- "$phi_parent" || exit 88',
    '[ "$PWD" = "$phi_parent" ] || exit 88',
    'if [ "$phi_root" != / ]; then case "$PWD" in "$phi_root"|"$phi_root"/*) ;; *) exit 88 ;; esac; fi',
    '[ ! -e "$phi_dest" ] && [ ! -L "$phi_dest" ] || exit 87',
    'command -v mktemp >/dev/null 2>&1 || exit 86',
    'phi_stage=$(mktemp -d ".${phi_dest}.phi-download.XXXXXXXX") || exit 86',
    'phi_tmp="$phi_stage/payload"',
    'trap \'rm -f -- "$phi_tmp"; rmdir -- "$phi_stage" 2>/dev/null || true\' EXIT HUP INT TERM',
    'command -v curl >/dev/null 2>&1 || exit 81',
    `phi_http=$(curl --fail --silent --show-error --noproxy '*' --proto '=https' --max-redirs 0 --connect-timeout 20 --max-time 600 --max-filesize ${request.maxFileBytes}${resolveArgument} --write-out '%{http_code}' --output "$phi_tmp" "$phi_url")`,
    'phi_status=$?',
    'case "$phi_status" in 0) ;; 6|7|28) exit 83 ;; 63) exit 82 ;; *) exit 84 ;; esac',
    'case "$phi_http" in 2??) ;; 3??) exit 85 ;; *) exit 84 ;; esac',
    'phi_bytes=$(wc -c < "$phi_tmp") || exit 84',
    `test "$phi_bytes" -le ${request.maxFileBytes} || exit 82`,
    'ln -- "$phi_tmp" "$phi_dest" || exit 87',
    'rm -f -- "$phi_tmp" || exit 84',
    'rmdir -- "$phi_stage" || exit 84',
    'trap - EXIT HUP INT TERM',
    'printf \'PHI_REMOTE_DOWNLOAD_V1\\t%s\\n\' "$phi_bytes"'
  ].join('\n')
}

function downloadedBytes(
  result: Awaited<ReturnType<NonNullable<RemoteSshSession['execBounded']>>>
): number {
  if (result.code === 81)
    throw new Error('服务器缺少 curl，无法直接下载；请先安装 curl 或手动准备文件。')
  if (result.code === 82) throw new Error('服务器下载文件超过 maxFileBytes，已删除临时文件。')
  if (result.code === 83) {
    throw new Error('服务器无法联网或无法访问该地址；请检查服务器网络/防火墙后重试。')
  }
  if (result.code === 85) {
    throw new Error('服务器下载地址发生重定向；请提供最终的公开 HTTPS 地址后重试。')
  }
  if (result.code === 86) throw new Error('服务器缺少安全临时目录工具，无法开始下载。')
  if (result.code === 87) throw new Error('远程下载目标已存在或在发布时被占用；未覆盖现有文件。')
  if (result.code === 88) throw new Error('远程下载目标父目录已变化或移出项目根目录。')
  if (result.code !== 0 || result.stdoutTruncated || result.stderrTruncated) {
    throw new Error('服务器下载失败；没有改用本机网络或本机项目目录。')
  }
  const match = /^PHI_REMOTE_DOWNLOAD_V1\t([0-9]+)\n$/.exec(result.stdout)
  const bytes = match ? Number(match[1]) : Number.NaN
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('服务器下载结果格式无效')
  return bytes
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
    'maxFileBytes'
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
