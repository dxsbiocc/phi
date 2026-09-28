import { posix } from 'node:path'

import {
  withAuthorizedRemoteWorkspacePath,
  type RemoteWorkspaceBoundaryDependencies
} from './remote-workspace-boundary'
import { shellQuote, type RemoteSshSession } from './wrappers/remote-ssh-session'

export const REMOTE_WRITE_MAX_BYTES = 1024 * 1024

export interface RemoteWriteRequest {
  sessionId: string
  projectId: string
  requestId: string
  toolCallId: string
  path: string
  content: string
}

export type RemoteWriteResult =
  | { status: 'created'; path: string; bytes: number }
  | {
      status: 'unknown'
      reason: 'cancelled' | 'connection_lost'
      resultUnknown: true
      message: string
    }

export interface RemoteWriteDependencies extends RemoteWorkspaceBoundaryDependencies {
  beforeWrite?: (request: RemoteWriteRequest) => void
}

export function checkedRemoteWriteRequest(value: unknown): RemoteWriteRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('远程新建文件请求无效')
  }
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).some(
      (key) =>
        !['sessionId', 'projectId', 'requestId', 'toolCallId', 'path', 'content'].includes(key)
    ) ||
    typeof record.sessionId !== 'string' ||
    !record.sessionId ||
    typeof record.projectId !== 'string' ||
    !record.projectId ||
    typeof record.requestId !== 'string' ||
    !record.requestId ||
    typeof record.toolCallId !== 'string' ||
    !record.toolCallId ||
    typeof record.path !== 'string' ||
    !record.path ||
    record.path.endsWith('/') ||
    typeof record.content !== 'string' ||
    record.content.includes('\0') ||
    Buffer.byteLength(record.content, 'utf8') > REMOTE_WRITE_MAX_BYTES
  ) {
    throw new Error('远程新建文件参数无效；文本最多 1 MiB')
  }
  return record as unknown as RemoteWriteRequest
}

/**
 * OMP 18.1.10 ssh/file-transfer.ts stages stdin beside the target and cleans it on exit.
 * Adapt DSH fs-local fsio.ts createIfAbsent at 00102833: a private staging directory
 * and link(2) publish without replacing a concurrent creator's path.
 */
export function buildRemoteCreateFileCommand(
  path: string,
  canonicalRoot: string,
  expectedBytes: number
): string {
  const leaf = posix.basename(path)
  const parent = posix.dirname(path)
  const perl = [
    'use strict; use warnings;',
    'use File::Temp qw(tempdir);',
    'use Fcntl qw(O_WRONLY O_CREAT O_EXCL);',
    'use Errno qw(EEXIST);',
    'my $leaf = $ARGV[0];',
    'my $expected = $ARGV[1]; my $received = 0;',
    '(-e $leaf || -l $leaf) and exit 73;',
    'my $dir = tempdir(".phi-write-XXXXXXXX", DIR => ".", CLEANUP => 0);',
    'my $stage = "$dir/payload";',
    'END { unlink $stage if defined $stage && -e $stage; rmdir $dir if defined $dir && -d $dir; }',
    'sysopen(my $fh, $stage, O_WRONLY | O_CREAT | O_EXCL, 0600) or exit 74;',
    'binmode(STDIN); binmode($fh);',
    'while (1) {',
    '  my $read = sysread(STDIN, my $bytes, 65536);',
    '  defined($read) or exit 75;',
    '  last if $read == 0;',
    '  $received += $read;',
    '  $received <= $expected or exit 75;',
    '  my $offset = 0;',
    '  while ($offset < $read) {',
    '    my $written = syswrite($fh, $bytes, $read - $offset, $offset);',
    '    defined($written) && $written > 0 or exit 76;',
    '    $offset += $written;',
    '  }',
    '}',
    '$received == $expected or exit 75;',
    'close($fh) or exit 76;',
    'link($stage, $leaf) or exit($!{EEXIST} ? 73 : 77);',
    'unlink($stage) or exit 78;',
    'rmdir($dir) or exit 78;',
    'undef $stage; undef $dir;'
  ].join('\n')
  const script = [
    'set -eu',
    `cd -P -- ${shellQuote(parent)} || exit 72`,
    `root=${shellQuote(canonicalRoot)}`,
    'if [ "$root" != / ]; then',
    '  case "$PWD" in "$root"|"$root"/*) ;; *) exit 72 ;; esac',
    'fi',
    'command -v perl >/dev/null 2>&1 || exit 79',
    `perl -e ${shellQuote(perl)} -- ${shellQuote(leaf)} ${expectedBytes}`
  ].join('\n')
  return `bash -c ${shellQuote(script)}`
}

function writeFailure(code: number | null): Error {
  const reason: Record<number, string> = {
    72: '父目录已移出项目根目录或不可访问',
    73: '目标已存在；不会覆盖现有文件',
    74: '临时文件创建失败',
    75: '内容传输失败',
    76: '临时文件写入失败',
    77: '无法安全发布新文件',
    78: '新文件已发布，但临时文件清理失败',
    79: '服务器缺少 Perl 运行时'
  }
  return new Error(`远程新建文件失败：${reason[code ?? -1] ?? '远端执行未完成'}`)
}

type ActiveWrite = {
  sessionId: string
  projectId: string
  cancelled: boolean
  session?: RemoteSshSession
}

function unknownResult(reason: 'cancelled' | 'connection_lost'): RemoteWriteResult {
  return {
    status: 'unknown',
    reason,
    resultUnknown: true,
    message:
      reason === 'cancelled'
        ? '已停止本地 SSH 调用；远端文件可能已经创建。请先检查目标，勿自动重试。'
        : 'SSH 连接中断；远端文件可能已经创建。请先检查目标，勿自动重试。'
  }
}

export class RemoteWorkspaceWriteManager {
  private readonly active = new Map<string, ActiveWrite>()

  constructor(private readonly dependencies: RemoteWriteDependencies = {}) {}

  async create(input: unknown): Promise<RemoteWriteResult> {
    const request = checkedRemoteWriteRequest(input)
    if (this.active.has(request.requestId)) throw new Error('远程新建文件请求 ID 已在运行')
    this.dependencies.beforeWrite?.(request)
    const entry: ActiveWrite = {
      sessionId: request.sessionId,
      projectId: request.projectId,
      cancelled: false
    }
    this.active.set(request.requestId, entry)
    try {
      return await withAuthorizedRemoteWorkspacePath(
        {
          sessionId: request.sessionId,
          projectId: request.projectId,
          path: request.path,
          mode: 'create'
        },
        async (authorized, session) => {
          entry.session = session
          if (entry.cancelled) return unknownResult('cancelled')
          if (!session.execWithInput) throw new Error('当前 SSH 连接不支持安全文本输入')
          const command = buildRemoteCreateFileCommand(
            authorized.path,
            authorized.canonicalRoot,
            Buffer.byteLength(request.content, 'utf8')
          )
          let result: Awaited<ReturnType<NonNullable<RemoteSshSession['execWithInput']>>>
          try {
            result = await session.execWithInput(command, request.content)
          } catch {
            return unknownResult(entry.cancelled ? 'cancelled' : 'connection_lost')
          }
          if (entry.cancelled || result.code === null || result.code === 255) {
            return unknownResult(entry.cancelled ? 'cancelled' : 'connection_lost')
          }
          if (result.code !== 0) throw writeFailure(result.code)
          return {
            status: 'created',
            path: `ssh://${authorized.hostAlias}${authorized.path.split('/').map(encodeURIComponent).join('/')}`,
            bytes: Buffer.byteLength(request.content, 'utf8')
          }
        },
        {
          ...this.dependencies,
          execTimeoutMs: this.dependencies.execTimeoutMs ?? 30_000,
          onConnected: (session) => {
            entry.session = session
            this.dependencies.onConnected?.(session)
            if (entry.cancelled) void session.close()
          }
        }
      )
    } catch (error) {
      if (entry.cancelled) return unknownResult('cancelled')
      throw error
    } finally {
      this.active.delete(request.requestId)
    }
  }

  cancel(input: unknown): boolean {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new Error('远程新建文件取消请求无效')
    }
    const record = input as Record<string, unknown>
    if (
      Object.keys(record).some((key) => !['sessionId', 'projectId', 'requestId'].includes(key)) ||
      typeof record.sessionId !== 'string' ||
      typeof record.projectId !== 'string' ||
      typeof record.requestId !== 'string'
    ) {
      throw new Error('远程新建文件取消请求无效')
    }
    const entry = this.active.get(record.requestId)
    if (!entry) return false
    if (entry.sessionId !== record.sessionId || entry.projectId !== record.projectId) {
      throw new Error('远程新建文件取消请求归属不匹配')
    }
    this.stop(entry)
    return true
  }

  private stop(entry: ActiveWrite): void {
    entry.cancelled = true
    if (entry.session) void entry.session.close()
  }

  cancelSession(sessionId: string): void {
    for (const entry of this.active.values()) if (entry.sessionId === sessionId) this.stop(entry)
  }

  cancelAll(): void {
    for (const entry of this.active.values()) this.stop(entry)
  }
}
