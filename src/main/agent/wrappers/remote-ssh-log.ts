import { shellQuote, type RemoteSshSession } from './remote-ssh-session'

/** 195,000 raw bytes encode to 260,000 ASCII bytes, leaving room below the 256 KiB SSH cap. */
export const MAX_REMOTE_LOG_RAW_BYTES = 195_000
export const MAX_REMOTE_LOG_RESPONSE_BYTES = 256 * 1024

export interface RemoteFileChunkOptions {
  offset: number
  maxBytes: number
  identity?: string
  tail?: boolean
  /** D02: only read regular files beneath this already-authorized physical root. */
  canonicalRoot?: string
  noFollow?: boolean
  signal?: AbortSignal
}

export interface RemoteFileChunk {
  missing: boolean
  bytes: Buffer
  size: number
  identity?: string
  startOffset: number
  nextOffset: number
  reset?: 'rotated' | 'truncated'
}

/** The source file is opened once, so metadata and bytes refer to the same inode. */
const READ_CHUNK_PERL = String.raw`
use strict;
use warnings;
use Cwd qw(realpath getcwd);
use Fcntl qw(O_RDONLY O_NONBLOCK O_NOFOLLOW S_IFMT S_IFREG);
use MIME::Base64 qw(encode_base64);
my ($path, $offset, $limit, $expected, $tail, $root, $no_follow) = @ARGV;
if ($root ne '-') {
  my $physical_root = realpath($root);
  my $parent = $path;
  my $leaf = $path;
  $parent =~ s{/[^/]*$}{};
  $leaf =~ s{.*/}{};
  $parent = '/' if $parent eq '';
  exit 46 unless defined($physical_root) && $physical_root eq $root && chdir($parent);
  my $physical_parent = getcwd();
  exit 46 unless defined($physical_parent);
  exit 46 unless $root eq '/' || $physical_parent eq $root || index($physical_parent, "$root/") == 0;
  $path = $leaf;
}
my $flags = O_RDONLY | O_NONBLOCK;
$flags |= O_NOFOLLOW if $no_follow eq '1';
sysopen(my $file, $path, $flags) or do {
  if ($!{ENOENT}) { print "MISSING\n"; exit 0; }
  print STDERR "cannot open file\n";
  exit 42;
};
binmode($file);
my @st = stat($file);
exit 43 unless @st && ($st[2] & S_IFMT) == S_IFREG;
my $identity = "$st[0]:$st[1]";
my $size = $st[7];
my $start = $offset;
my $reset = 'same';
if ($tail eq '1') { $start = $size > $limit ? $size - $limit : 0; }
elsif ($expected ne '-' && $expected ne $identity) { $start = 0; $reset = 'rotated'; }
elsif ($offset > $size) { $start = 0; $reset = 'truncated'; }
seek($file, $start, 0) or exit 44;
my $count = read($file, my $bytes, $limit);
exit 45 unless defined($count);
print "PHI_LOG_V1\t$identity\t$size\t$start\t$count\t$reset\n";
print encode_base64($bytes, '');
`

export function buildRemoteFileChunkCommand(path: string, options: RemoteFileChunkOptions): string {
  return `perl -e ${shellQuote(READ_CHUNK_PERL)} -- ${shellQuote(path)} ${options.offset} ${options.maxBytes} ${shellQuote(options.identity ?? '-')} ${options.tail ? '1' : '0'} ${shellQuote(options.canonicalRoot ?? '-')} ${options.noFollow ? '1' : '0'}`
}

function validate(path: string, options: RemoteFileChunkOptions): void {
  if (!path.startsWith('/') || path.includes('\0') || Buffer.byteLength(path) > 4096) {
    throw new Error('远程日志路径必须是有效的绝对路径')
  }
  if (!Number.isSafeInteger(options.offset) || options.offset < 0) {
    throw new Error('远程日志字节偏移无效')
  }
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1 ||
    options.maxBytes > MAX_REMOTE_LOG_RAW_BYTES
  ) {
    throw new Error('远程日志单页字节上限无效')
  }
  if (options.identity !== undefined && !/^[0-9]+:[0-9]+$/.test(options.identity)) {
    throw new Error('远程日志文件身份无效')
  }
  if (
    options.canonicalRoot !== undefined &&
    (!options.canonicalRoot.startsWith('/') ||
      options.canonicalRoot.includes('\0') ||
      options.canonicalRoot.split('/').includes('..') ||
      Buffer.byteLength(options.canonicalRoot, 'utf8') > 4096)
  ) {
    throw new Error('远程读取根目录无效')
  }
}

/** Byte coordinates follow DSH's OutputCollector.readFrom; Phi bounds each SSH response. */
export async function readRemoteFileChunk(
  session: RemoteSshSession,
  path: string,
  options: RemoteFileChunkOptions
): Promise<RemoteFileChunk> {
  validate(path, options)
  options.signal?.throwIfAborted()
  if (session.readFileChunk && !options.canonicalRoot && !options.noFollow) {
    const chunk = await session.readFileChunk(path, options)
    options.signal?.throwIfAborted()
    if (
      chunk.bytes.length > options.maxBytes ||
      !Number.isSafeInteger(chunk.nextOffset) ||
      chunk.nextOffset < 0
    )
      throw new Error('远程日志页超出字节范围')
    return chunk
  }
  const command = buildRemoteFileChunkCommand(path, options)
  const result = session.execBounded
    ? await session.execBounded(command, {
        timeoutMs: 30_000,
        maxOutputBytes: MAX_REMOTE_LOG_RESPONSE_BYTES,
        signal: options.signal
      })
    : await session.exec(command)
  options.signal?.throwIfAborted()
  if (result.code !== 0) {
    throw new Error(`远程日志读取失败: ${(result.stderr || result.stdout).trim() || result.code}`)
  }
  if (
    ('stdoutTruncated' in result && result.stdoutTruncated) ||
    ('stderrTruncated' in result && result.stderrTruncated) ||
    Buffer.byteLength(result.stdout, 'utf8') > MAX_REMOTE_LOG_RESPONSE_BYTES
  ) {
    throw new Error('远程日志响应超过字节上限，偏移未推进')
  }
  if (result.stdout === 'MISSING\n') {
    return {
      missing: true,
      bytes: Buffer.alloc(0),
      size: 0,
      startOffset: options.offset,
      nextOffset: options.offset
    }
  }
  const newline = result.stdout.indexOf('\n')
  if (newline < 0 || newline > 512) throw new Error('远程日志响应头无效')
  const parts = result.stdout.slice(0, newline).split('\t')
  if (parts.length !== 6 || parts[0] !== 'PHI_LOG_V1') throw new Error('远程日志响应版本无效')
  const [, identity, sizeRaw, startRaw, countRaw, resetRaw] = parts
  if (!/^[0-9]+:[0-9]+$/.test(identity)) throw new Error('远程日志文件身份无效')
  const size = Number(sizeRaw)
  const startOffset = Number(startRaw)
  const count = Number(countRaw)
  if (
    ![size, startOffset, count].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    count > options.maxBytes ||
    !Number.isSafeInteger(startOffset + count) ||
    !['same', 'rotated', 'truncated'].includes(resetRaw)
  )
    throw new Error('远程日志响应范围无效')
  const encoded = result.stdout.slice(newline + 1)
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('远程日志响应编码无效')
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length !== count) throw new Error('远程日志响应字节数不匹配')
  return {
    missing: false,
    bytes,
    size,
    identity,
    startOffset,
    nextOffset: startOffset + count,
    ...(resetRaw !== 'same' ? { reset: resetRaw as 'rotated' | 'truncated' } : {})
  }
}
