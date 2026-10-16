import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { parseDocument } from 'yaml'

import { shellQuote, type RemoteSshSession } from '../../../wrappers/remote-ssh-session'

const MAX_CONFLICT_OUTPUT_BYTES = 1024 * 1024
const agentNamePattern = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/u
const hashPattern = /^[a-f0-9]{64}$/u
const issuedDetections = new WeakSet<DetectedRpcAgentDefinition>()

export interface RpcAgentPathIdentity {
  readonly path: string
  readonly device: string
  readonly inode: string
  readonly mode: number
  readonly uid: number
  readonly gid: number
  readonly symlink: boolean
}

export interface DetectedRpcAgentDefinition {
  readonly filePath: string
  readonly realPath: string
  readonly name: string
  readonly contentHash: string
  readonly nameByteStart: number
  readonly nameByteEnd: number
  readonly pathIdentity: readonly RpcAgentPathIdentity[]
}

const detectorScript = String.raw`
use strict; use warnings;
use Digest::SHA qw(sha256_hex);
use JSON::PP qw(encode_json);
use MIME::Base64 qw(encode_base64);
use Cwd qw(abs_path);
my ($root) = @ARGV;
defined($root) or exit 64;
$root =~ m{^/} && $root !~ /[\0\r\n]/ or exit 64;
sub identity {
  my ($path) = @_;
  my @value = lstat($path);
  @value or exit 72;
  return {
    path => $path,
    device => "$value[0]",
    inode => "$value[1]",
    mode => 0 + $value[2],
    uid => 0 + $value[4],
    gid => 0 + $value[5],
    symlink => (-l _ ? JSON::PP::true : JSON::PP::false),
  };
}
sub identities {
  my ($path) = @_;
  my @parts = grep { length($_) } split(m{/+}, $path);
  my $current = '';
  my @result = (identity('/'));
  for my $part (@parts) {
    $current .= "/$part";
    push @result, identity($current);
  }
  return \@result;
}
my $directory;
my $current = $root;
while (1) {
  my $candidate = "$current/.omp/agents";
  if (-d $candidate) { $directory = $candidate; last; }
  last if $current eq '/';
  $current =~ s{/+[^/]+$}{};
  $current = '/' if $current eq '';
}
if (!defined($directory)) { print encode_json({ entries => [] }); exit 0; }
opendir(my $dh, $directory) or exit 73;
my @files = sort grep { /\.md\z/ && $_ ne '.' && $_ ne '..' } readdir($dh);
closedir($dh) or exit 73;
@files <= 256 or exit 74;
my @entries;
my $total = 0;
for my $leaf (@files) {
  my $path = "$directory/$leaf";
  open(my $fh, '<', $path) or next;
  binmode($fh);
  my @opened = stat($fh);
  next unless @opened && -f _;
  $opened[7] <= 1024 * 1024 or exit 74;
  $total += $opened[7]; $total <= 512 * 1024 or exit 74;
  local $/; my $content = <$fh>;
  close($fh) or exit 75;
  defined($content) or next;
  my $real = abs_path($path);
  defined($real) && $real =~ m{^/} or exit 76;
  push @entries, {
    filePath => $path,
    realPath => $real,
    contentBase64 => encode_base64($content, ''),
    contentHash => sha256_hex($content),
    pathIdentity => identities($path),
  };
}
print encode_json({ entries => \@entries });
`

const renamer = String.raw`
use strict; use warnings;
use Digest::SHA qw(sha256_hex);
use JSON::PP qw(decode_json encode_json);
use Fcntl qw(O_RDONLY O_WRONLY O_CREAT O_EXCL O_NOFOLLOW S_IFMT S_IFREG);
use IO::Handle;
use Cwd qw(abs_path);
my ($raw, $newName) = @ARGV;
defined($raw) && defined($newName) or exit 64;
$newName =~ /^[A-Za-z][A-Za-z0-9_-]{0,127}$/ or exit 64;
my $record = decode_json($raw);
my $cleanup;
END { unlink($cleanup) if defined($cleanup) && (-e $cleanup || -l $cleanup); }
ref($record) eq 'HASH' && ref($record->{pathIdentity}) eq 'ARRAY' or exit 64;
my $path = $record->{filePath};
defined($path) && $path =~ m{^/} && $path !~ /[\0\r\n]/ or exit 64;
sub verify_identity {
  my ($identity) = @_;
  ref($identity) eq 'HASH' or exit 65;
  my @value = lstat($identity->{path});
  @value or exit 66;
  (-l _) and exit 67;
  "$value[0]" eq $identity->{device} or exit 68;
  "$value[1]" eq $identity->{inode} or exit 68;
  (0 + $value[2]) == $identity->{mode} or exit 68;
  (0 + $value[4]) == $identity->{uid} or exit 68;
  (0 + $value[5]) == $identity->{gid} or exit 68;
  $identity->{symlink} and exit 67;
}
sub verify_path {
  verify_identity($_) for @{$record->{pathIdentity}};
  my $real = abs_path($path);
  defined($real) && $real eq $record->{realPath} or exit 68;
}
sub read_current {
  sysopen(my $fh, $path, O_RDONLY | O_NOFOLLOW) or exit 69;
  binmode($fh);
  my @opened = stat($fh);
  @opened && (($opened[2] & S_IFMT) == S_IFREG) or exit 70;
  local $/; my $content = <$fh>;
  close($fh) or exit 69;
  defined($content) && sha256_hex($content) eq $record->{contentHash} or exit 71;
  return ($content, @opened);
}
verify_path();
my ($content, @opened) = read_current();
my $start = $record->{nameByteStart}; my $end = $record->{nameByteEnd};
defined($start) && defined($end) && $start >= 0 && $end > $start && $end <= length($content) or exit 72;
my $next = substr($content, 0, $start) . $newName . substr($content, $end);
my $parent = $path; $parent =~ s{/[^/]+\z}{}; $parent = '/' if $parent eq '';
my $leaf = $path; $leaf =~ s{.*/}{};
chdir($parent) or exit 73;
my $temporary = ".phi-agent-rename-$$-" . int(rand(1_000_000_000));
$cleanup = $temporary;
sysopen(my $out, $temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600) or exit 74;
binmode($out);
my $offset = 0;
while ($offset < length($next)) {
  my $written = syswrite($out, $next, length($next) - $offset, $offset);
  defined($written) && $written > 0 or do { close($out); unlink($temporary); exit 75; };
  $offset += $written;
}
chmod($opened[2] & 07777, $temporary) == 1 or do { close($out); unlink($temporary); exit 76; };
chown($opened[4], $opened[5], $temporary) == 1 or do { close($out); unlink($temporary); exit 76; };
$out->sync or do { close($out); unlink($temporary); exit 75; };
close($out) or do { unlink($temporary); exit 75; };
verify_path();
read_current();
rename($temporary, $leaf) or do { unlink($temporary); exit 77; };
undef $cleanup;
my @published = lstat($leaf);
@published && !-l _ && (($published[2] & S_IFMT) == S_IFREG) or exit 78;
(0 + $published[2]) == (0 + $opened[2]) && $published[4] == $opened[4] && $published[5] == $opened[5] or exit 78;
sysopen(my $check, $leaf, O_RDONLY | O_NOFOLLOW) or exit 78;
binmode($check); my @checked = stat($check); local $/; my $actual = <$check>; close($check) or exit 78;
my @named = lstat($leaf);
@checked && @named && !-l _ or exit 78;
for my $index (0, 1, 2, 4, 5) { $checked[$index] == $named[$index] or exit 78; }
defined($actual) && sha256_hex($actual) eq sha256_hex($next) or exit 78;
print encode_json({ filePath => $path, name => $newName, contentHash => sha256_hex($next) });
`

function checkedNames(names: readonly string[]): readonly string[] {
  if (
    names.length > 128 ||
    names.some((name) => !agentNamePattern.test(name)) ||
    new Set(names).size !== names.length
  ) {
    throw new Error('Invalid RPC agent conflict name catalogue')
  }
  return names
}

function checkedIdentity(value: unknown): RpcAgentPathIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid RPC agent conflict path identity')
  }
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).sort().join(',') !==
      ['device', 'gid', 'inode', 'mode', 'path', 'symlink', 'uid'].sort().join(',') ||
    typeof record.path !== 'string' ||
    !posix.isAbsolute(record.path) ||
    typeof record.device !== 'string' ||
    !/^\d+$/u.test(record.device) ||
    typeof record.inode !== 'string' ||
    !/^\d+$/u.test(record.inode) ||
    !Number.isSafeInteger(record.mode) ||
    !Number.isSafeInteger(record.uid) ||
    !Number.isSafeInteger(record.gid) ||
    typeof record.symlink !== 'boolean'
  ) {
    throw new Error('Invalid RPC agent conflict path identity')
  }
  return Object.freeze(record as unknown as RpcAgentPathIdentity)
}

function ompAgentName(
  content: Buffer,
  filePath: string
): { name: string; nameByteStart: number; nameByteEnd: number } | undefined {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content)
  } catch {
    return undefined
  }
  const opening = /^---[ \t]*\r?\n/u.exec(text)
  if (!opening) return undefined
  const frontmatterStart = opening[0].length
  const remainder = text.slice(frontmatterStart)
  const closing = /^---[ \t]*\r?\n/mu.exec(remainder)
  if (!closing || closing.index === undefined) return undefined
  const frontmatter = remainder.slice(0, closing.index)
  const document = parseDocument(frontmatter, { prettyErrors: false, keepSourceTokens: true })
  if (document.errors.length) return undefined
  const value: unknown = document.toJS()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (
    typeof record.name !== 'string' ||
    !record.name ||
    typeof record.description !== 'string' ||
    !record.description ||
    ['main', 'sub'].includes(record.name.trim().toLowerCase())
  ) {
    return undefined
  }
  if (Buffer.byteLength(record.name, 'utf8') > 128 || /[\0\r\n]/u.test(record.name)) {
    throw new Error(`Project agent name is unsupported: ${filePath}`)
  }
  const node = document.get('name', true) as { range?: readonly number[] } | undefined
  if (!node?.range || node.range.length < 2) return undefined
  const nameByteStart = Buffer.byteLength(text.slice(0, frontmatterStart + node.range[0]))
  const nameByteEnd = Buffer.byteLength(text.slice(0, frontmatterStart + node.range[1]))
  if (nameByteEnd <= nameByteStart || nameByteEnd > content.length) return undefined
  return { name: record.name, nameByteStart, nameByteEnd }
}

function checkedDetection(
  value: unknown,
  wanted: ReadonlySet<string>
): DetectedRpcAgentDefinition | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid RPC agent conflict detection')
  }
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).sort().join(',') !==
      ['contentBase64', 'contentHash', 'filePath', 'pathIdentity', 'realPath'].sort().join(',') ||
    typeof record.filePath !== 'string' ||
    !posix.isAbsolute(record.filePath) ||
    typeof record.realPath !== 'string' ||
    !posix.isAbsolute(record.realPath) ||
    typeof record.contentBase64 !== 'string' ||
    record.contentBase64.length > 1_400_000 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      record.contentBase64
    ) ||
    typeof record.contentHash !== 'string' ||
    !hashPattern.test(record.contentHash) ||
    !Array.isArray(record.pathIdentity) ||
    record.pathIdentity.length < 2 ||
    record.pathIdentity.length > 512
  ) {
    throw new Error('Invalid RPC agent conflict detection')
  }
  const pathIdentity = record.pathIdentity.map(checkedIdentity)
  if (pathIdentity.at(-1)?.path !== record.filePath) {
    throw new Error('RPC agent conflict path identity differs')
  }
  const content = Buffer.from(record.contentBase64, 'base64')
  if (createHash('sha256').update(content).digest('hex') !== record.contentHash) {
    throw new Error('RPC agent conflict content hash differs')
  }
  const parsed = ompAgentName(content, record.filePath)
  if (!parsed || (wanted.size && !wanted.has(parsed.name))) return undefined
  if (!agentNamePattern.test(parsed.name)) return undefined
  return Object.freeze({
    filePath: record.filePath,
    realPath: record.realPath,
    name: parsed.name,
    contentHash: record.contentHash,
    nameByteStart: parsed.nameByteStart,
    nameByteEnd: parsed.nameByteEnd,
    pathIdentity: Object.freeze(pathIdentity)
  })
}

function checkedConfirmedDetection(value: unknown): DetectedRpcAgentDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid confirmed RPC agent conflict')
  }
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).sort().join(',') !==
      [
        'contentHash',
        'filePath',
        'name',
        'nameByteEnd',
        'nameByteStart',
        'pathIdentity',
        'realPath'
      ]
        .sort()
        .join(',') ||
    typeof record.filePath !== 'string' ||
    !posix.isAbsolute(record.filePath) ||
    typeof record.realPath !== 'string' ||
    !posix.isAbsolute(record.realPath) ||
    typeof record.name !== 'string' ||
    !agentNamePattern.test(record.name) ||
    !Number.isSafeInteger(record.nameByteStart) ||
    !Number.isSafeInteger(record.nameByteEnd) ||
    Number(record.nameByteStart) < 0 ||
    Number(record.nameByteEnd) <= Number(record.nameByteStart) ||
    typeof record.contentHash !== 'string' ||
    !hashPattern.test(record.contentHash) ||
    !Array.isArray(record.pathIdentity) ||
    record.pathIdentity.length < 2 ||
    record.pathIdentity.length > 512
  ) {
    throw new Error('Invalid confirmed RPC agent conflict')
  }
  const pathIdentity = record.pathIdentity.map(checkedIdentity)
  if (pathIdentity.at(-1)?.path !== record.filePath) {
    throw new Error('Confirmed RPC agent conflict path identity differs')
  }
  return Object.freeze({
    filePath: record.filePath,
    realPath: record.realPath,
    name: record.name,
    contentHash: record.contentHash,
    nameByteStart: record.nameByteStart as number,
    nameByteEnd: record.nameByteEnd as number,
    pathIdentity: Object.freeze(pathIdentity)
  })
}

async function boundedExec(
  session: RemoteSshSession,
  command: string
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return session.execBounded
    ? session.execBounded(command, { timeoutMs: 30_000, maxOutputBytes: MAX_CONFLICT_OUTPUT_BYTES })
    : session.exec(command)
}

export async function detectNearestOmpAgentDefinitions(
  session: RemoteSshSession,
  projectRoot: string,
  names: readonly string[]
): Promise<readonly DetectedRpcAgentDefinition[]> {
  if (!posix.isAbsolute(projectRoot) || posix.normalize(projectRoot) !== projectRoot) {
    throw new Error('Invalid RPC agent conflict project root')
  }
  const checked = checkedNames(names)
  const command = `perl -e ${shellQuote(detectorScript)} -- ${shellQuote(projectRoot)}`
  const result = await boundedExec(session, command)
  if (result.code !== 0) {
    throw new Error(`Cannot verify project agent conflicts (${result.code ?? 'unknown'})`)
  }
  if (Buffer.byteLength(result.stdout) > MAX_CONFLICT_OUTPUT_BYTES) {
    throw new Error('Project agent conflict result exceeds its bound')
  }
  const value: unknown = JSON.parse(result.stdout)
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray((value as { entries?: unknown }).entries)
  ) {
    throw new Error('Invalid project agent conflict result')
  }
  const detections = (value as { entries: unknown[] }).entries
    .flatMap((entry) => {
      const detection = checkedDetection(entry, new Set(checked))
      return detection ? [detection] : []
    })
    .sort((left, right) =>
      posix.basename(left.filePath).localeCompare(posix.basename(right.filePath))
    )
  for (const detection of detections) issuedDetections.add(detection)
  return Object.freeze(detections)
}

export async function renameDetectedOmpAgent(
  session: RemoteSshSession,
  detection: DetectedRpcAgentDefinition,
  newName: string
): Promise<{ readonly filePath: string; readonly name: string; readonly contentHash: string }> {
  if (!issuedDetections.delete(detection)) {
    throw new Error('Project agent rename was not issued by conflict detection')
  }
  const checked = checkedConfirmedDetection(detection)
  if (!agentNamePattern.test(newName) || newName === checked.name) {
    throw new Error('Invalid project agent rename')
  }
  const record = JSON.stringify(checked)
  const command = `perl -e ${shellQuote(renamer)} -- ${shellQuote(record)} ${shellQuote(newName)}`
  const result = await boundedExec(session, command)
  if (result.code !== 0) {
    const reasons: Record<number, string> = {
      67: 'Project agent rename refused a symbolic link',
      68: 'Project agent path changed since detection',
      69: 'Project agent file is no longer readable',
      70: 'Project agent target is not a regular file',
      71: 'Project agent content changed since detection',
      72: 'Project agent frontmatter changed since detection',
      73: 'Project agent parent directory changed since detection',
      74: 'Project agent atomic staging failed',
      75: 'Project agent atomic write failed',
      76: 'Project agent mode or ownership could not be preserved',
      77: 'Project agent atomic rename failed',
      78: 'Project agent atomic rename could not be verified'
    }
    throw new Error(reasons[result.code ?? -1] ?? 'Project agent rename failed')
  }
  const value = JSON.parse(result.stdout) as Record<string, unknown>
  if (
    value.filePath !== checked.filePath ||
    value.name !== newName ||
    typeof value.contentHash !== 'string' ||
    !hashPattern.test(value.contentHash)
  ) {
    throw new Error('Invalid project agent rename result')
  }
  return Object.freeze({
    filePath: checked.filePath,
    name: newName,
    contentHash: value.contentHash
  })
}

export function rpcAgentConflictIdentity(
  projectId: string,
  sessionId: string,
  detection: DetectedRpcAgentDefinition
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        projectId,
        sessionId,
        detection.filePath,
        detection.name,
        detection.contentHash
      ])
    )
    .digest('hex')
}
