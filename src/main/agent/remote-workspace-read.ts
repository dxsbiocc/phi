import { posix } from 'node:path'

import {
  withAuthorizedRemoteWorkspacePath,
  type AuthorizedRemoteWorkspacePath,
  type RemoteWorkspaceBoundaryDependencies
} from './remote-workspace-boundary'
import { shellQuote, type RemoteSshSession } from './wrappers/remote-ssh-session'
import { remoteWorkspaceUri } from '../../shared/remoteWorkspacePath'

export const REMOTE_READ_MAX_BYTES = 1024 * 1024
const REMOTE_TEXT_RESPONSE_MAX_BYTES = 1536 * 1024
const BINARY_SNIFF_BYTES = 8192
const REMOTE_LIST_MAX_ENTRIES = 1000
const REMOTE_LIST_MAX_BYTES = 256 * 1024

/** Adapted from @oh-my-pi/pi-utils 18.1.10 binary.ts (MIT): NUL or invalid UTF-8 means binary. */
function isProbablyBinaryHeader(header: Uint8Array): boolean {
  if (header.includes(0)) return true
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(header, { stream: true })
    return false
  } catch {
    return true
  }
}

export type RemoteWorkspaceReadResult =
  | { kind: 'file'; path: string; content: string; fileSize: number; contentType: string }
  | {
      kind: 'directory'
      path: string
      content: string
      entries: Array<{ name: string; isDirectory: boolean }>
    }

function displayEntryName(name: string): string {
  const hasControl = [...name].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
  return hasControl ? JSON.stringify(name) : name
}

function contentTypeFor(path: string): string {
  const extension = posix.extname(path).toLowerCase()
  if (extension === '.md' || extension === '.mdx' || extension === '.markdown') {
    return 'text/markdown'
  }
  return extension === '.json' ? 'application/json' : 'text/plain'
}

function boundedRootCheck(canonicalRoot: string): string {
  return [
    `root=${shellQuote(canonicalRoot)}`,
    'if [ "$root" != / ]; then',
    '  case "$PWD" in "$root"|"$root"/*) ;; *) exit 72 ;; esac',
    'fi'
  ].join('\n')
}

export function buildRemoteReadKindCommand(path: string): string {
  const script = [
    'set -eu',
    `target=${shellQuote(path)}`,
    'if [ -d "$target" ]; then printf directory;',
    'elif [ -f "$target" ]; then printf file;',
    'elif [ -e "$target" ] || [ -L "$target" ]; then printf other;',
    'else printf missing; fi'
  ].join('\n')
  return `bash -c ${shellQuote(script)}`
}

/** OMP's maxBytes+1 detection, adapted to a descriptor opened with O_NOFOLLOW. */
export function buildRemoteTextReadCommand(path: string, canonicalRoot: string): string {
  const perl = [
    'use strict; use warnings;',
    'use Fcntl qw(O_RDONLY O_NOFOLLOW O_NONBLOCK);',
    'use MIME::Base64 qw(encode_base64);',
    'my $name = $ARGV[0];',
    'sysopen(my $fh, $name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK) or exit 75;',
    'binmode($fh);',
    '-f $fh or exit 76;',
    'my $bytes = "";',
    `while (length($bytes) < ${REMOTE_READ_MAX_BYTES + 1}) {`,
    `  my $want = ${REMOTE_READ_MAX_BYTES + 1} - length($bytes);`,
    '  $want = 65536 if $want > 65536;',
    '  my $count = read($fh, my $chunk, $want);',
    '  defined($count) or exit 77;',
    '  last if $count == 0;',
    '  $bytes .= $chunk;',
    '}',
    'print encode_base64($bytes, "");'
  ].join('\n')
  const script = [
    'set -eu',
    `target=${shellQuote(path)}`,
    'parent=${target%/*}',
    'leaf=${target##*/}',
    'cd -P -- "$parent" || exit 72',
    boundedRootCheck(canonicalRoot),
    'command -v perl >/dev/null 2>&1 || exit 79',
    `perl -e ${shellQuote(perl)} -- "$leaf"`
  ].join('\n')
  return `bash -c ${shellQuote(script)}`
}

/** NUL records preserve names containing newlines, unlike OMP's ls -1Ap parser. */
export function buildRemoteDirectoryReadCommand(path: string, canonicalRoot: string): string {
  const perl = [
    'use strict; use warnings;',
    'opendir(my $dir, ".") or exit 74;',
    'binmode(STDOUT, ":raw");',
    'my ($count, $bytes) = (0, 0);',
    'while (defined(my $name = readdir($dir))) {',
    '  next if $name eq "." || $name eq "..";',
    '  my $kind = -d $name ? "d" : "f";',
    '  my $record = $kind . "\\0" . $name . "\\0";',
    `  $count++; $bytes += length($record);`,
    `  exit 78 if $count > ${REMOTE_LIST_MAX_ENTRIES} || $bytes > ${REMOTE_LIST_MAX_BYTES};`,
    '  print $record;',
    '}'
  ].join('\n')
  const script = [
    'set -eu',
    `target=${shellQuote(path)}`,
    'cd -P -- "$target" || exit 73',
    boundedRootCheck(canonicalRoot),
    'command -v perl >/dev/null 2>&1 || exit 79',
    `perl -e ${shellQuote(perl)}`
  ].join('\n')
  return `bash -c ${shellQuote(script)}`
}

function readError(code: number | null, kind: 'file' | 'directory'): Error {
  const reasons: Record<number, string> = {
    72: '目标已移出项目根目录',
    73: '远程目录不可访问',
    74: '远程目录无读取权限',
    75: '远程文件不可访问或已变成符号链接',
    76: '远程目标不是普通文件',
    77: '远程文件读取失败',
    78: '远程目录条目过多',
    79: '服务器缺少读取所需的 Perl 运行时'
  }
  return new Error(
    `远程${kind === 'file' ? '文件' : '目录'}读取失败：${reasons[code ?? -1] ?? '连接或检查未完成'}`
  )
}

async function readKind(session: RemoteSshSession, path: string): Promise<'file' | 'directory'> {
  const result = await session.exec(buildRemoteReadKindCommand(path))
  if (result.code !== 0) throw new Error('远程目标类型检查失败')
  if (result.stdout === 'file' || result.stdout === 'directory') return result.stdout
  if (result.stdout === 'other') throw new Error('远程目标不是普通文件或目录')
  if (result.stdout === 'missing') throw new Error('远程目标不存在')
  throw new Error('远程目标类型返回格式无效')
}

function parseDirectoryEntries(value: string): Array<{ name: string; isDirectory: boolean }> {
  if (value.includes('\uFFFD')) throw new Error('远程目录包含非 UTF-8 文件名')
  if (!value) return []
  const fields = value.split('\0')
  if (fields.at(-1) !== '' || fields.length % 2 !== 1) {
    throw new Error('远程目录返回格式无效')
  }
  const entries: Array<{ name: string; isDirectory: boolean }> = []
  for (let index = 0; index < fields.length - 1; index += 2) {
    const kind = fields[index]
    const name = fields[index + 1]
    if ((kind !== 'd' && kind !== 'f') || !name || name.includes('/')) {
      throw new Error('远程目录返回格式无效')
    }
    entries.push({ name, isDirectory: kind === 'd' })
  }
  return entries.sort(
    (left, right) =>
      Number(right.isDirectory) - Number(left.isDirectory) || left.name.localeCompare(right.name)
  )
}

/** T02's bounded directory reader, also used after D01 authorizes a run root. */
export async function listRemoteDirectoryEntries(
  session: RemoteSshSession,
  path: string,
  canonicalRoot: string
): Promise<Array<{ name: string; isDirectory: boolean }>> {
  const listed = await session.exec(buildRemoteDirectoryReadCommand(path, canonicalRoot))
  if (listed.code !== 0) throw readError(listed.code, 'directory')
  return parseDirectoryEntries(listed.stdout)
}

export async function readRemoteWorkspaceTextFile(
  session: RemoteSshSession,
  path: string,
  canonicalRoot: string,
  signal?: AbortSignal
): Promise<{ content: string; fileSize: number }> {
  signal?.throwIfAborted()
  const command = buildRemoteTextReadCommand(path, canonicalRoot)
  const result = session.execBounded
    ? await session.execBounded(command, {
        timeoutMs: 30_000,
        maxOutputBytes: REMOTE_TEXT_RESPONSE_MAX_BYTES,
        signal
      })
    : await session.exec(command)
  signal?.throwIfAborted()
  if (
    ('stdoutTruncated' in result && result.stdoutTruncated) ||
    ('stderrTruncated' in result && result.stderrTruncated) ||
    Buffer.byteLength(result.stdout, 'utf8') > REMOTE_TEXT_RESPONSE_MAX_BYTES
  ) {
    throw new Error('远程文本响应超过字节上限')
  }
  if (result.code !== 0) throw readError(result.code, 'file')
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.stdout)) {
    throw new Error('远程文件编码返回格式无效')
  }
  const bytes = Buffer.from(result.stdout, 'base64')
  if (bytes.toString('base64') !== result.stdout) throw new Error('远程文件编码返回格式无效')
  if (bytes.length > REMOTE_READ_MAX_BYTES) throw new Error('远程文本文件超过 1 MiB 上限')
  if (isProbablyBinaryHeader(bytes.subarray(0, BINARY_SNIFF_BYTES)) || bytes.includes(0)) {
    throw new Error('远程文件是二进制内容，暂不支持文本读取')
  }
  try {
    return {
      content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      fileSize: bytes.length
    }
  } catch {
    throw new Error('远程文件不是有效的 UTF-8 文本')
  }
}

export async function readRemoteWorkspacePath(
  input: unknown,
  dependencies: RemoteWorkspaceBoundaryDependencies & {
    onFileRead?: (authorized: AuthorizedRemoteWorkspacePath, content: string) => void
    onResolved?: (authorized: AuthorizedRemoteWorkspacePath) => void
    expectedKind?: 'file' | 'directory'
  } = {}
): Promise<RemoteWorkspaceReadResult> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('远程读取请求无效')
  }
  const request = input as Record<string, unknown>
  if (
    Object.keys(request).some((key) => !['sessionId', 'projectId', 'path'].includes(key)) ||
    typeof request.sessionId !== 'string' ||
    typeof request.projectId !== 'string' ||
    typeof request.path !== 'string'
  ) {
    throw new Error('远程读取请求只能包含会话、项目 ID 和路径')
  }
  return withAuthorizedRemoteWorkspacePath(
    { ...request, mode: 'existing' },
    async (authorized, session) => {
      dependencies.onResolved?.(authorized)
      const kind = await readKind(session, authorized.path)
      if (dependencies.expectedKind && kind !== dependencies.expectedKind) {
        throw new Error(
          dependencies.expectedKind === 'file' ? '远程目标不是普通文本文件' : '远程目标不是目录'
        )
      }
      const path = remoteWorkspaceUri(authorized.hostAlias, authorized.path)
      if (kind === 'file') {
        const { content, fileSize } = await readRemoteWorkspaceTextFile(
          session,
          authorized.path,
          authorized.canonicalRoot
        )
        dependencies.onFileRead?.(authorized, content)
        return {
          kind: 'file',
          path,
          content,
          fileSize,
          contentType: contentTypeFor(authorized.path)
        }
      }
      const entries = await listRemoteDirectoryEntries(
        session,
        authorized.path,
        authorized.canonicalRoot
      )
      return {
        kind: 'directory',
        path,
        entries,
        content: entries.length
          ? entries
              .map((entry) => `${displayEntryName(entry.name)}${entry.isDirectory ? '/' : ''}`)
              .join('\n')
          : '(empty directory)'
      }
    },
    { ...dependencies, execTimeoutMs: dependencies.execTimeoutMs ?? 30_000 }
  )
}
