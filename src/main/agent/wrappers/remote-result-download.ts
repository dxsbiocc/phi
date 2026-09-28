import { randomUUID } from 'node:crypto'
import { lstat, open, rename, rm, stat, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { hashFile } from '../download/file-transfer'
import type {
  WrapperResultDownloadProgress,
  WrapperResultDownloadResult,
  WrapperResultReadRequest
} from '../../../shared/wrapperResultTypes'
import { readAuthorizedResultChunk, WRAPPER_RESULT_RANGE_MAX_BYTES } from './remote-result-read'
import {
  withAuthorizedWrapperResultPath,
  type AuthorizedWrapperResultPath,
  type WrapperResultDependencies
} from './remote-results'
import { shellQuote, type RemoteSshSession } from './remote-ssh-session'

const activeDestinations = new Set<string>()

const DIGEST_PERL = String.raw`
use strict; use warnings;
use Cwd qw(realpath getcwd);
use Fcntl qw(O_RDONLY O_NONBLOCK O_NOFOLLOW S_IFMT S_IFREG);
use Digest::SHA ();
my ($path, $root) = @ARGV;
my $physical_root = realpath($root);
exit 72 unless defined($physical_root) && $physical_root eq $root;
my $parent = $path;
my $leaf = $path;
$parent =~ s{/[^/]*$}{};
$leaf =~ s{.*/}{};
$parent = '/' if $parent eq '';
chdir($parent) or exit 73;
my $cwd = getcwd();
exit 74 unless defined($cwd) && ($root eq '/' || $cwd eq $root || index($cwd, "$root/") == 0);
sysopen(my $fh, $leaf, O_RDONLY | O_NONBLOCK | O_NOFOLLOW) or exit 75;
binmode($fh);
my @before = stat($fh);
exit 76 unless @before && ($before[2] & S_IFMT) == S_IFREG;
my $digest = Digest::SHA->new(256);
$digest->addfile($fh);
my @after = stat($fh);
exit 77 unless @after && $before[0] == $after[0] && $before[1] == $after[1] && $before[7] == $after[7];
print "PHI_SHA256_V1\t$before[0]:$before[1]\t$before[7]\t", $digest->hexdigest, "\n";
`

export function validateWrapperResultDownloadRequest(input: unknown): WrapperResultReadRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Wrapper 下载请求无效')
  }
  const record = input as Record<string, unknown>
  if (
    Object.keys(record).some(
      (key) => !['projectId', 'hostProfileId', 'runId', 'scope', 'path', 'requestId'].includes(key)
    ) ||
    typeof record.projectId !== 'string' ||
    typeof record.hostProfileId !== 'string' ||
    typeof record.runId !== 'string' ||
    (record.scope !== 'run' && record.scope !== 'output') ||
    typeof record.path !== 'string' ||
    !record.path ||
    record.path.startsWith('/') ||
    /^ssh:\/\//i.test(record.path) ||
    record.path.split('/').includes('..') ||
    record.path.includes('\0') ||
    typeof record.requestId !== 'string' ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(record.requestId)
  ) {
    throw new Error('Wrapper 下载请求只能指定已保存的运行与相对文件路径')
  }
  return record as unknown as WrapperResultReadRequest
}

function pathRequest(request: WrapperResultReadRequest): Record<string, unknown> {
  return {
    projectId: request.projectId,
    hostProfileId: request.hostProfileId,
    runId: request.runId,
    scope: request.scope,
    ...(request.path !== undefined ? { path: request.path } : {})
  }
}

async function existingTarget(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function unchangedTarget(
  before: Awaited<ReturnType<typeof lstat>> | null,
  after: Awaited<ReturnType<typeof lstat>> | null
): boolean {
  if (!before || !after) return before === after
  return (
    after.isFile() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs
  )
}

async function remoteSha256(
  session: RemoteSshSession,
  authorized: AuthorizedWrapperResultPath,
  identity: string,
  size: number,
  signal?: AbortSignal
): Promise<string | undefined> {
  signal?.throwIfAborted()
  const command = [
    'if perl -MDigest::SHA -e 1 >/dev/null 2>&1; then',
    `perl -e ${shellQuote(DIGEST_PERL)} -- ${shellQuote(authorized.path)} ${shellQuote(authorized.root)}`,
    "else printf 'UNAVAILABLE\\n'; fi"
  ].join('\n')
  const result = session.execBounded
    ? await session.execBounded(command, { timeoutMs: 600_000, maxOutputBytes: 1024, signal })
    : await session.exec(command)
  signal?.throwIfAborted()
  if (
    ('stdoutTruncated' in result && result.stdoutTruncated) ||
    ('stderrTruncated' in result && result.stderrTruncated) ||
    Buffer.byteLength(result.stdout, 'utf8') > 1024
  ) {
    throw new Error('远端文件摘要响应超过上限')
  }
  if (result.code !== 0) throw new Error('远端文件摘要校验失败')
  if (result.stdout === 'UNAVAILABLE\n') return undefined
  const match = /^PHI_SHA256_V1\t([0-9]+:[0-9]+)\t([0-9]+)\t([a-f0-9]{64})\n$/.exec(result.stdout)
  if (!match || match[1] !== identity || Number(match[2]) !== size) {
    throw new Error('远端文件在摘要校验时发生变化')
  }
  return `sha256:${match[3]}`
}

async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0
  while (offset < bytes.length) {
    const written = await handle.write(bytes, offset, bytes.length - offset)
    if (written.bytesWritten <= 0) throw new Error('本地临时文件写入中断')
    offset += written.bytesWritten
  }
}

/** Main-process only: destination comes from the native save dialog, never the renderer. */
export async function downloadWrapperResultToPath(
  input: unknown,
  destinationInput: string,
  dependencies: WrapperResultDependencies & {
    onProgress?: (progress: WrapperResultDownloadProgress) => void
  } = {}
): Promise<Extract<WrapperResultDownloadResult, { status: 'saved' }>> {
  const request = validateWrapperResultDownloadRequest(input)
  if (
    !isAbsolute(destinationInput) ||
    destinationInput.includes('\0') ||
    basename(destinationInput) === '.' ||
    basename(destinationInput) === '..'
  ) {
    throw new Error('本地保存路径必须来自有效的绝对文件位置')
  }
  const destination = resolve(destinationInput)
  if (activeDestinations.has(destination)) throw new Error('该本地文件正在下载中')
  activeDestinations.add(destination)
  const temp = join(
    dirname(destination),
    `.${basename(destination)}.phi-download-${randomUUID()}.part`
  )
  let handle: FileHandle | undefined
  try {
    return await withAuthorizedWrapperResultPath(
      pathRequest(request),
      async (authorized, session) => {
        const initial = await readAuthorizedResultChunk(
          session,
          authorized,
          0,
          1,
          dependencies.signal
        )
        const targetBefore = await existingTarget(destination)
        if (targetBefore && !targetBefore.isFile()) {
          throw new Error('本地保存位置不是普通文件')
        }
        handle = await open(temp, 'wx', 0o600)
        let offset = 0
        const notify = (phase: WrapperResultDownloadProgress['phase']): void => {
          dependencies.onProgress?.({
            requestId: request.requestId,
            phase,
            bytesDownloaded: offset,
            totalBytes: initial.size
          })
        }
        notify('downloading')
        while (offset < initial.size) {
          dependencies.signal?.throwIfAborted()
          const page = await readAuthorizedResultChunk(
            session,
            authorized,
            offset,
            Math.min(WRAPPER_RESULT_RANGE_MAX_BYTES, initial.size - offset),
            dependencies.signal,
            initial.identity
          )
          if (
            page.identity !== initial.identity ||
            page.size !== initial.size ||
            page.bytes.length === 0
          ) {
            throw new Error('远端文件在下载期间发生变化')
          }
          await writeAll(handle, page.bytes)
          offset = page.nextOffset
          notify('downloading')
        }
        const finalProbe = await readAuthorizedResultChunk(
          session,
          authorized,
          0,
          1,
          dependencies.signal,
          initial.identity
        )
        if (finalProbe.identity !== initial.identity || finalProbe.size !== initial.size) {
          throw new Error('远端文件在下载后发生变化')
        }
        await handle.sync()
        await handle.close()
        handle = undefined
        if ((await stat(temp)).size !== initial.size) throw new Error('本地下载文件大小不匹配')
        notify('verifying')
        const sha256 = await hashFile(temp, dependencies.signal)
        const remoteDigest = await remoteSha256(
          session,
          authorized,
          initial.identity!,
          initial.size,
          dependencies.signal
        )
        if (remoteDigest && remoteDigest !== sha256) {
          throw new Error('下载文件与服务器摘要不一致')
        }
        dependencies.signal?.throwIfAborted()
        if (!unchangedTarget(targetBefore, await existingTarget(destination))) {
          throw new Error('本地目标文件在下载期间发生变化，拒绝覆盖')
        }
        notify('saving')
        dependencies.signal?.throwIfAborted()
        await rename(temp, destination)
        return {
          status: 'saved' as const,
          path: destination,
          bytes: initial.size,
          sha256,
          remoteDigestVerified: remoteDigest !== undefined
        }
      },
      dependencies
    )
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temp, { force: true }).catch(() => undefined)
    activeDestinations.delete(destination)
  }
}
