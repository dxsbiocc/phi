import { createHash } from 'node:crypto'
import { posix } from 'node:path'

import {
  RemoteWorkspaceTargetMissingError,
  withAuthorizedRemoteWorkspacePath,
  type RemoteWorkspaceBoundaryDependencies
} from './remote-workspace-boundary'
import { readRemoteWorkspaceTextFile } from './remote-workspace-read'
import {
  REMOTE_WRITE_MAX_BYTES,
  RemoteWorkspaceWriteManager,
  checkedRemoteWriteRequest,
  type RemoteWriteRequest,
  type RemoteWriteResult
} from './remote-workspace-write'
import { shellQuote, type RemoteSshSession } from './wrappers/remote-ssh-session'

export interface RemoteEditRequest {
  sessionId: string
  projectId: string
  requestId: string
  toolCallId: string
  path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

export type RemoteMutationResult =
  | RemoteWriteResult
  | { status: 'updated'; path: string; bytes: number; oldText: string; newText: string }

function digest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** In-memory observations bind the Phi session, project and SSH host. */
export class RemoteWorkspaceReadBasis {
  private readonly values = new Map<string, string>()

  private key(sessionId: string, projectId: string, hostAlias: string, path: string): string {
    return JSON.stringify([sessionId, projectId, hostAlias, path])
  }

  record(
    sessionId: string,
    projectId: string,
    hostAlias: string,
    path: string,
    content: string
  ): void {
    const key = this.key(sessionId, projectId, hostAlias, path)
    this.values.delete(key)
    this.values.set(key, digest(content))
    if (this.values.size > 256) this.values.delete(this.values.keys().next().value as string)
  }

  get(sessionId: string, projectId: string, hostAlias: string, path: string): string | undefined {
    return this.values.get(this.key(sessionId, projectId, hostAlias, path))
  }

  forget(sessionId: string, projectId: string, hostAlias: string, path: string): void {
    this.values.delete(this.key(sessionId, projectId, hostAlias, path))
  }
}

function checkedEditRequest(value: unknown): RemoteEditRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('远程编辑请求无效')
  }
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).some(
      (key) =>
        ![
          'sessionId',
          'projectId',
          'requestId',
          'toolCallId',
          'path',
          'old_string',
          'new_string',
          'replace_all'
        ].includes(key)
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
    typeof record.old_string !== 'string' ||
    !record.old_string ||
    record.old_string.includes('\0') ||
    typeof record.new_string !== 'string' ||
    record.new_string.includes('\0') ||
    (record.replace_all !== undefined && typeof record.replace_all !== 'boolean') ||
    Buffer.byteLength(record.old_string, 'utf8') > REMOTE_WRITE_MAX_BYTES ||
    Buffer.byteLength(record.new_string, 'utf8') > REMOTE_WRITE_MAX_BYTES
  ) {
    throw new Error('远程编辑参数无效；请使用非空 old_string 和 UTF-8 文本')
  }
  return record as unknown as RemoteEditRequest
}

/** OMP's replace edit mode: an ambiguous single replacement is refused. */
export function applyRemoteReplace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false
): string {
  if (!oldString) throw new Error('old_string 不能为空')
  const occurrences = content.split(oldString).length - 1
  if (occurrences === 0) throw new Error('old_string 与已读取的远程文件不匹配')
  if (occurrences > 1 && !replaceAll) {
    throw new Error('old_string 在文件中出现多次；请提供更精确的内容或使用 replace_all')
  }
  const updated = replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, newString)
  if (updated === content) throw new Error('编辑内容未发生变化')
  return updated
}

/**
 * OMP's staged stdin and DSH's stale-version rule, adapted to a checked SHA-256
 * followed by same-filesystem rename. An uncooperative writer can still race
 * the final check and rename; there is no remote helper or file lock contract.
 */
export function buildRemoteReplaceFileCommand(
  path: string,
  canonicalRoot: string,
  expectedHash: string,
  expectedBytes: number
): string {
  const leaf = posix.basename(path)
  const parent = posix.dirname(path)
  const perl = [
    'use strict; use warnings;',
    'use File::Temp qw(tempdir);',
    'use Fcntl qw(O_WRONLY O_CREAT O_EXCL O_RDONLY O_NOFOLLOW S_IFMT S_IFREG);',
    'use Digest::SHA qw(sha256_hex);',
    'my ($leaf, $expectedHash, $expectedBytes) = @ARGV;',
    'my $dir = tempdir(".phi-edit-XXXXXXXX", DIR => ".", CLEANUP => 0);',
    'my $stage = "$dir/payload";',
    'END { unlink $stage if defined $stage && -e $stage; rmdir $dir if defined $dir && -d $dir; }',
    'sysopen(my $out, $stage, O_WRONLY | O_CREAT | O_EXCL, 0600) or exit 78;',
    'binmode(STDIN); binmode($out);',
    'my $received = 0;',
    'while (1) {',
    '  my $count = sysread(STDIN, my $chunk, 65536);',
    '  defined($count) or exit 77;',
    '  last if $count == 0;',
    '  $received += $count;',
    '  $received <= $expectedBytes or exit 77;',
    '  my $offset = 0;',
    '  while ($offset < $count) {',
    '    my $written = syswrite($out, $chunk, $count - $offset, $offset);',
    '    defined($written) && $written > 0 or exit 78;',
    '    $offset += $written;',
    '  }',
    '}',
    '$received == $expectedBytes or exit 77;',
    'close($out) or exit 78;',
    'sysopen(my $old, $leaf, O_RDONLY | O_NOFOLLOW) or exit 73;',
    'binmode($old);',
    'my @before = stat($old);',
    '@before && (($before[2] & S_IFMT) == S_IFREG) or exit 74;',
    `my $oldBytes = ""; while (length($oldBytes) <= ${REMOTE_WRITE_MAX_BYTES}) {`,
    '  my $count = sysread($old, my $chunk, 65536);',
    '  defined($count) or exit 73;',
    '  last if $count == 0;',
    '  $oldBytes .= $chunk;',
    '}',
    `length($oldBytes) <= ${REMOTE_WRITE_MAX_BYTES} or exit 75;`,
    'sha256_hex($oldBytes) eq $expectedHash or exit 76;',
    'my @name = lstat($leaf);',
    '@name && (($name[2] & S_IFMT) == S_IFREG) or exit 73;',
    '-w $leaf or exit 82;',
    '$name[0] == $before[0] && $name[1] == $before[1] && $name[7] == $before[7] &&',
    '$name[9] == $before[9] && $name[10] == $before[10] or exit 76;',
    'chmod($before[2] & 0777, $stage) or exit 78;',
    'close($old) or exit 73;',
    'rename($stage, $leaf) or exit 79;',
    'rmdir($dir) or exit 80;',
    'undef $stage; undef $dir;'
  ].join('\n')
  const script = [
    'set -eu',
    `cd -P -- ${shellQuote(parent)} || exit 72`,
    `root=${shellQuote(canonicalRoot)}`,
    'if [ "$root" != / ]; then',
    '  case "$PWD" in "$root"|"$root"/*) ;; *) exit 72 ;; esac',
    'fi',
    'command -v perl >/dev/null 2>&1 || exit 81',
    `perl -e ${shellQuote(perl)} -- ${shellQuote(leaf)} ${shellQuote(expectedHash)} ${expectedBytes}`
  ].join('\n')
  return `bash -c ${shellQuote(script)}`
}

function updateFailure(code: number | null): Error {
  const reason: Record<number, string> = {
    72: '父目录已移出项目根目录或不可访问',
    73: '目标已删除、替换或变成符号链接',
    74: '目标不是普通文件',
    75: '目标超过 1 MiB 文本上限',
    76: '文件自上次读取后已变化；请重新 read',
    77: '内容传输不完整',
    78: '临时文件写入失败',
    79: '替换文件失败',
    80: '文件已更新，但临时目录清理失败',
    81: '服务器缺少 Perl 运行时',
    82: '目标文件不可写'
  }
  return new Error(`远程文件修改失败：${reason[code ?? -1] ?? '远端执行未完成'}`)
}

type ActiveMutation = {
  sessionId: string
  projectId: string
  cancelled: boolean
  session?: RemoteSshSession
}

export interface RemoteMutationDependencies extends RemoteWorkspaceBoundaryDependencies {
  basis: RemoteWorkspaceReadBasis
  beforeWrite?: (request: RemoteWriteRequest) => void
  beforeEdit?: (request: RemoteEditRequest) => void
}

function unknownResult(reason: 'cancelled' | 'connection_lost'): RemoteMutationResult {
  return {
    status: 'unknown',
    reason,
    resultUnknown: true,
    message:
      reason === 'cancelled'
        ? '已停止本地 SSH 调用；远端文件可能已经修改。请重新 read 核对后再操作。'
        : 'SSH 连接中断；远端文件可能已经修改。请重新 read 核对后再操作。'
  }
}

export class RemoteWorkspaceMutationManager {
  private readonly active = new Map<string, ActiveMutation>()
  private readonly createManager: RemoteWorkspaceWriteManager

  constructor(private readonly dependencies: RemoteMutationDependencies) {
    this.createManager = new RemoteWorkspaceWriteManager({
      ...dependencies,
      beforeWrite: undefined
    })
  }

  async write(input: unknown): Promise<RemoteMutationResult> {
    const request = checkedRemoteWriteRequest(input)
    this.dependencies.beforeWrite?.(request)
    return this.run(request, 'write', () => request.content)
  }

  async edit(input: unknown): Promise<RemoteMutationResult> {
    const request = checkedEditRequest(input)
    this.dependencies.beforeEdit?.(request)
    return this.run(request, 'edit', (current) =>
      applyRemoteReplace(current, request.old_string, request.new_string, request.replace_all)
    )
  }

  private async run(
    request: RemoteWriteRequest | RemoteEditRequest,
    kind: 'write' | 'edit',
    transform: (current: string) => string
  ): Promise<RemoteMutationResult> {
    if (this.active.has(request.requestId)) throw new Error('远程文件请求 ID 已在运行')
    const entry: ActiveMutation = {
      sessionId: request.sessionId,
      projectId: request.projectId,
      cancelled: false
    }
    this.active.set(request.requestId, entry)
    try {
      try {
        return await withAuthorizedRemoteWorkspacePath(
          {
            sessionId: request.sessionId,
            projectId: request.projectId,
            path: request.path,
            mode: 'existing'
          },
          async (authorized, session) => {
            entry.session = session
            if (entry.cancelled) return unknownResult('cancelled')
            const basis = this.dependencies.basis.get(
              request.sessionId,
              request.projectId,
              authorized.hostAlias,
              authorized.path
            )
            if (!basis) throw new Error('修改已有远程文件前，请先用 read 读取该文件')
            const { content: current } = await readRemoteWorkspaceTextFile(
              session,
              authorized.path,
              authorized.canonicalRoot
            )
            if (entry.cancelled) return unknownResult('cancelled')
            if (digest(current) !== basis) {
              this.dependencies.basis.forget(
                request.sessionId,
                request.projectId,
                authorized.hostAlias,
                authorized.path
              )
              throw updateFailure(76)
            }
            const next = transform(current)
            if (Buffer.byteLength(next, 'utf8') > REMOTE_WRITE_MAX_BYTES) {
              throw new Error('修改后的远程文本超过 1 MiB 上限')
            }
            if (next === current) {
              return {
                status: 'updated',
                path: `ssh://${authorized.hostAlias}${authorized.path.split('/').map(encodeURIComponent).join('/')}`,
                bytes: Buffer.byteLength(next, 'utf8'),
                oldText: current,
                newText: next
              }
            }
            if (!session.execWithInput) throw new Error('当前 SSH 连接不支持安全文本输入')
            const command = buildRemoteReplaceFileCommand(
              authorized.path,
              authorized.canonicalRoot,
              basis,
              Buffer.byteLength(next, 'utf8')
            )
            let result: Awaited<ReturnType<NonNullable<RemoteSshSession['execWithInput']>>>
            try {
              result = await session.execWithInput(command, next)
            } catch {
              this.dependencies.basis.forget(
                request.sessionId,
                request.projectId,
                authorized.hostAlias,
                authorized.path
              )
              return unknownResult(entry.cancelled ? 'cancelled' : 'connection_lost')
            }
            if (entry.cancelled || result.code === null || result.code === 255) {
              this.dependencies.basis.forget(
                request.sessionId,
                request.projectId,
                authorized.hostAlias,
                authorized.path
              )
              return unknownResult(entry.cancelled ? 'cancelled' : 'connection_lost')
            }
            if (result.code !== 0) {
              this.dependencies.basis.forget(
                request.sessionId,
                request.projectId,
                authorized.hostAlias,
                authorized.path
              )
              throw updateFailure(result.code)
            }
            this.dependencies.basis.record(
              request.sessionId,
              request.projectId,
              authorized.hostAlias,
              authorized.path,
              next
            )
            return {
              status: 'updated',
              path: `ssh://${authorized.hostAlias}${authorized.path.split('/').map(encodeURIComponent).join('/')}`,
              bytes: Buffer.byteLength(next, 'utf8'),
              oldText: current,
              newText: next
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
        if (!(error instanceof RemoteWorkspaceTargetMissingError) || kind !== 'write') throw error
        if (entry.cancelled) return unknownResult('cancelled')
        return await this.createManager.create(request)
      }
    } catch (error) {
      if (entry.cancelled) return unknownResult('cancelled')
      throw error
    } finally {
      this.active.delete(request.requestId)
    }
  }

  cancel(input: unknown): boolean {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new Error('远程文件取消请求无效')
    }
    const record = input as Record<string, unknown>
    if (
      Object.keys(record).some((key) => !['sessionId', 'projectId', 'requestId'].includes(key)) ||
      typeof record.sessionId !== 'string' ||
      typeof record.projectId !== 'string' ||
      typeof record.requestId !== 'string'
    )
      throw new Error('远程文件取消请求无效')
    const entry = this.active.get(record.requestId)
    if (!entry) return false
    if (entry.sessionId !== record.sessionId || entry.projectId !== record.projectId) {
      throw new Error('远程文件取消请求归属不匹配')
    }
    entry.cancelled = true
    if (entry.session) void entry.session.close()
    this.createManager.cancel(input)
    return true
  }

  cancelSession(sessionId: string): void {
    for (const entry of this.active.values()) {
      if (entry.sessionId !== sessionId) continue
      entry.cancelled = true
      if (entry.session) void entry.session.close()
    }
    this.createManager.cancelSession(sessionId)
  }

  cancelAll(): void {
    for (const entry of this.active.values()) {
      entry.cancelled = true
      if (entry.session) void entry.session.close()
    }
    this.createManager.cancelAll()
  }
}
