import { posix } from 'node:path'

import type {
  RemoteDirectoryListRequest,
  RemoteDirectoryListing
} from '../../shared/remoteDirectoryBrowser'
import { getRemoteHostProfile, remoteConnectionConfigForProfile } from './remote-hosts'
import {
  connectRemoteSshSession,
  shellQuote,
  type RemoteConnectionConfig,
  type RemoteSshSession
} from './wrappers/remote-ssh-session'

const PROTOCOL = 'phi-directory-list-v1'
const MAX_ENTRIES = 1_000
const MAX_PATH_BYTES = 4_096
const MAX_OUTPUT_BYTES = 1024 * 1024
const LIST_TIMEOUT_MS = 5_000

export interface RemoteDirectoryBrowserDependencies {
  agentDir?: string
  sshConfigPath?: string
  connectImpl?: (config: RemoteConnectionConfig) => Promise<RemoteSshSession>
}

function isAbsolutePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    posix.isAbsolute(value) &&
    !value.includes('\0') &&
    Buffer.byteLength(value, 'utf-8') <= MAX_PATH_BYTES
  )
}

function validateRequest(input: unknown): RemoteDirectoryListRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('远程目录请求无效')
  }
  const request = input as Record<string, unknown>
  if (Object.keys(request).some((key) => key !== 'hostProfileId' && key !== 'path')) {
    throw new Error('远程目录请求包含未知字段')
  }
  if (
    typeof request.hostProfileId !== 'string' ||
    !request.hostProfileId.trim() ||
    request.hostProfileId !== request.hostProfileId.trim() ||
    request.hostProfileId.length > 512 ||
    /[\r\n\0]/.test(request.hostProfileId)
  ) {
    throw new Error('SSH 服务器档案 ID 无效')
  }
  if (!isAbsolutePath(request.path)) throw new Error('远程目录必须是有效的绝对路径')
  return { hostProfileId: request.hostProfileId, path: request.path }
}

/** Shell quoting and NUL records preserve spaces, quotes, and newlines in directory names. */
export function buildRemoteDirectoryListCommand(path: string): string {
  if (!isAbsolutePath(path)) throw new Error('远程目录必须是有效的绝对路径')
  const script = [
    'set -eu',
    'export LC_ALL=C',
    `cd -P -- ${shellQuote(path)}`,
    '[ -r . ] && [ -x . ] || exit 20',
    `printf '%s\\0%s\\0' ${shellQuote(PROTOCOL)} "$PWD"`,
    'count=0',
    'truncated=0',
    'for entry in ./* ./.[!.]* ./..?*; do',
    '  [ -d "$entry" ] || continue',
    `  if [ "$count" -ge ${MAX_ENTRIES} ]; then truncated=1; break; fi`,
    '  printf \'%s\\0\' "${entry#./}"',
    '  count=$((count + 1))',
    'done',
    'printf \'\\0%s\\0\' "$truncated"'
  ].join('\n')
  return `bash -c ${shellQuote(script)}`
}

function parseListing(stdout: string, hostProfileId: string): RemoteDirectoryListing {
  if (stdout.includes('\uFFFD')) throw new Error('远程目录列表格式无效')
  if (Buffer.byteLength(stdout, 'utf-8') > MAX_OUTPUT_BYTES) {
    throw new Error('远程目录列表超出大小限制')
  }
  const records = stdout.split('\0')
  const path = records[1]
  const end = records.length - 1
  const truncated = records[end - 1]
  if (
    records.length < 5 ||
    records[0] !== PROTOCOL ||
    records[end] !== '' ||
    records[end - 2] !== '' ||
    (truncated !== '0' && truncated !== '1') ||
    !isAbsolutePath(path) ||
    posix.normalize(path) !== path
  ) {
    throw new Error('远程目录列表格式无效')
  }
  const names = records.slice(2, end - 2)
  if (
    names.length > MAX_ENTRIES ||
    new Set(names).size !== names.length ||
    names.some(
      (name) =>
        !name ||
        name === '.' ||
        name === '..' ||
        name.includes('/') ||
        Buffer.byteLength(name, 'utf-8') > 255
    )
  ) {
    throw new Error('远程目录列表格式无效')
  }
  return {
    hostProfileId,
    path,
    directories: names
      .sort((left, right) => left.localeCompare(right))
      .map((name) => ({ name, path: posix.join(path, name) })),
    truncated: truncated === '1'
  }
}

/** Resolves only saved/discovered SSH profiles; never falls back to local filesystem access. */
export async function listRemoteProjectDirectories(
  input: unknown,
  dependencies: RemoteDirectoryBrowserDependencies = {}
): Promise<RemoteDirectoryListing> {
  const request = validateRequest(input)
  const profile = getRemoteHostProfile(
    request.hostProfileId,
    dependencies.agentDir,
    dependencies.sshConfigPath
  )
  if (!profile) throw new Error('SSH 服务器档案不存在或不可用')
  const connect = dependencies.connectImpl ?? connectRemoteSshSession
  const session = await connect({
    ...remoteConnectionConfigForProfile(profile),
    readyTimeoutMs: 10_000,
    execTimeoutMs: LIST_TIMEOUT_MS
  })
  try {
    const command = buildRemoteDirectoryListCommand(request.path)
    const result = session.execBounded
      ? await session.execBounded(command, {
          timeoutMs: LIST_TIMEOUT_MS,
          maxOutputBytes: MAX_OUTPUT_BYTES
        })
      : await session.exec(command)
    if (
      ('stdoutTruncated' in result && result.stdoutTruncated) ||
      ('stderrTruncated' in result && result.stderrTruncated)
    ) {
      throw new Error('远程目录列表超出大小限制')
    }
    if (result.code !== 0) throw new Error('无法读取远程目录，请检查目录路径和访问权限')
    return parseListing(result.stdout, request.hostProfileId)
  } finally {
    await session.close()
  }
}
