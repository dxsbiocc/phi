import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, matchesGlob, posix } from 'node:path'

import { RemoteWorkspaceTargetMissingError } from '../remote-workspace-boundary'
import { buildRemoteReadKindCommand, listRemoteDirectoryEntries } from '../remote-workspace-read'
import { buildRemoteReplaceFileCommand } from '../remote-workspace-edit'
import { REMOTE_WRITE_MAX_BYTES, buildRemoteCreateFileCommand } from '../remote-workspace-write'
import { MAX_REMOTE_LOG_RAW_BYTES, readRemoteFileChunk } from '../wrappers/remote-ssh-log'
import { shellQuote, type RemoteSshSession } from '../wrappers/remote-ssh-session'
import { SshHostContext } from './ssh-host-context'
import {
  WORKSPACE_ATOMIC_WRITE_MAX_BYTES,
  WorkspaceHostError,
  type AtomicWriteOptions,
  type AtomicWriteResult,
  type GlobOptions,
  type ListOptions,
  type ListResult,
  type ReadRangeOptions,
  type ReadRangeResult,
  type RemoveOptions,
  type StatOptions,
  type WorkspaceContent,
  type WorkspaceEntry,
  type WorkspaceHost,
  type WorkspaceStat
} from './types'

type FileSystemHost = WorkspaceHost['fs']

function invalid(message: string): WorkspaceHostError {
  return new WorkspaceHostError(message, 'INVALID_ARGUMENT')
}

function hash(content: WorkspaceContent): string {
  return createHash('sha256').update(content).digest('hex')
}

function checkedBinaryWriteContent(content: Uint8Array): Buffer {
  if (content.byteLength > WORKSPACE_ATOMIC_WRITE_MAX_BYTES) {
    throw invalid('workspace atomic writes are limited to 25 MiB')
  }
  return Buffer.isBuffer(content) ? content : Buffer.from(content)
}

function lockedMutationCommand(path: string, command: string, relative = false): string {
  const lockName = `.phi-cas-${hash(path).slice(0, 32)}.lock`
  const lock = relative ? lockName : posix.join(posix.dirname(path), lockName)
  const perl = [
    'use strict; use warnings;',
    'use Errno qw(EEXIST EPERM);',
    'use Fcntl qw(O_WRONLY O_CREAT O_EXCL S_IFMT S_IFDIR);',
    'my ($lock, $command) = @ARGV;',
    'my $owner = "$lock/owner"; my $owned = 0; my $deadline = time() + 30;',
    'my $ownerValue = "$$:" . time() . ":" . rand() . "\n";',
    'my $releaseOwned = sub {',
    '  my $current = "";',
    '  if (open(my $fh, "<", $owner)) { local $/; $current = <$fh> // ""; close($fh); }',
    '  return unless $current eq $ownerValue;',
    '  unlink($owner) or return;',
    '  rmdir($lock);',
    '};',
    'END { $releaseOwned->() if $owned; }',
    'while (!mkdir($lock, 0700)) {',
    '  $!{EEXIST} or exit 83;',
    '  my @info = lstat($lock);',
    '  @info && (($info[2] & S_IFMT) == S_IFDIR) or exit 83;',
    '  my $ownerContents = "";',
    '  if (open(my $fh, "<", $owner)) { local $/; $ownerContents = <$fh> // ""; close($fh); }',
    '  my $validPid = $ownerContents =~ /^([1-9][0-9]*):/;',
    '  my $alive = $validPid && (kill(0, $1) || $!{EPERM});',
    '  if (($validPid && !$alive) || (!$validPid && time() - $info[9] > 120)) {',
    '    if (length($ownerContents)) {',
    '      my $current = "";',
    '      if (open(my $fh, "<", $owner)) { local $/; $current = <$fh> // ""; close($fh); }',
    '      $current eq $ownerContents or exit 83;',
    '      unlink($owner) or exit 83;',
    '    }',
    '    rmdir($lock) and next;',
    '    exit 83;',
    '  }',
    '  time() < $deadline or exit 83;',
    '  select undef, undef, undef, 0.01;',
    '}',
    'sysopen(my $fh, $owner, O_WRONLY | O_CREAT | O_EXCL, 0600) or do { rmdir $lock; exit 83; };',
    'print($fh $ownerValue) or do { close($fh); $releaseOwned->(); exit 83; };',
    'close($fh) or do { $releaseOwned->(); exit 83; };',
    '$owned = 1;',
    'my $status = system("bash", "-c", $command);',
    '$status != -1 or exit 83;',
    'exit(($status & 127) ? 84 : ($status >> 8));'
  ].join('\n')
  return `perl -e ${shellQuote(perl)} -- ${shellQuote(lock)} ${shellQuote(command)}`
}

function contentText(content: string): string {
  const bytes = Buffer.from(content)
  if (bytes.length > REMOTE_WRITE_MAX_BYTES) throw invalid('remote text is limited to 1 MiB')
  if (content.includes('\0')) throw invalid('remote text cannot contain NUL bytes')
  return content
}

async function readBytes(
  session: RemoteSshSession,
  path: string,
  root: string,
  offset: number,
  length: number
): Promise<{ bytes: Buffer; size: number }> {
  const probe = await readRemoteFileChunk(session, path, {
    offset: 0,
    maxBytes: 1,
    canonicalRoot: root,
    noFollow: true
  })
  if (probe.missing) throw new Error('remote workspace target does not exist')
  if (length === 0 || offset >= probe.size) return { bytes: Buffer.alloc(0), size: probe.size }
  const chunks: Buffer[] = []
  let cursor = offset
  let remaining = Math.min(length, probe.size - offset)
  while (remaining > 0) {
    const chunk = await readRemoteFileChunk(session, path, {
      offset: cursor,
      maxBytes: Math.min(remaining, MAX_REMOTE_LOG_RAW_BYTES),
      canonicalRoot: root,
      noFollow: true
    })
    if (chunk.missing || chunk.nextOffset <= cursor) break
    chunks.push(chunk.bytes)
    cursor = chunk.nextOffset
    remaining -= chunk.bytes.length
  }
  return { bytes: Buffer.concat(chunks), size: probe.size }
}

async function readWholeFile(
  session: RemoteSshSession,
  path: string,
  root: string
): Promise<Buffer> {
  const value = await readBytes(session, path, root, 0, REMOTE_WRITE_MAX_BYTES + 1)
  if (value.size > REMOTE_WRITE_MAX_BYTES) throw invalid('remote text is limited to 1 MiB')
  return value.bytes
}

const SSH_ATOMIC_UPLOAD_TIMEOUT_MS = 5 * 60_000
const SSH_ATOMIC_MAX_OUTPUT_BYTES = 64 * 1024

function stagedMutationCommand(
  path: string,
  canonicalRoot: string,
  stageName: string,
  expectedBytes: number,
  contentHash: string,
  options: AtomicWriteOptions
): string {
  const leaf = posix.basename(path)
  const parent = posix.dirname(path)
  const mode = options.ifAbsent ? 'absent' : options.expectedHash !== undefined ? 'hash' : 'replace'
  const perl = [
    'use strict; use warnings;',
    'use Digest::SHA;',
    'use Errno qw(EEXIST);',
    'use Fcntl qw(O_RDONLY O_NOFOLLOW S_IFMT S_IFREG);',
    'my ($leaf, $stage, $mode, $expectedHash, $expectedBytes, $contentHash) = @ARGV;',
    'sub hashRegular {',
    '  my ($name, $missingCode, $kindCode) = @_;',
    '  sysopen(my $fh, $name, O_RDONLY | O_NOFOLLOW) or exit $missingCode;',
    '  binmode($fh);',
    '  my @opened = stat($fh);',
    '  @opened && (($opened[2] & S_IFMT) == S_IFREG) or exit $kindCode;',
    '  my $sha = Digest::SHA->new(256); $sha->addfile($fh); my $digest = $sha->hexdigest;',
    '  my @named = lstat($name);',
    '  @named && (($named[2] & S_IFMT) == S_IFREG) or exit $kindCode;',
    '  for my $index (0, 1, 7, 9, 10) { $named[$index] == $opened[$index] or exit 76; }',
    '  close($fh) or exit $missingCode;',
    '  return ($digest, @opened);',
    '}',
    'my ($uploadedHash, @uploaded) = hashRegular($stage, 85, 86);',
    '$uploaded[7] == $expectedBytes && $uploadedHash eq $contentHash or exit 87;',
    'if ($mode eq "absent") {',
    '  (-e $leaf || -l $leaf) and exit 76;',
    '  link($stage, $leaf) or exit($!{EEXIST} ? 76 : 88);',
    '  unlink($stage) or exit 89;',
    '} elsif ($mode eq "hash") {',
    '  my ($beforeHash, @before) = hashRegular($leaf, 73, 74);',
    '  $beforeHash eq $expectedHash or exit 76;',
    '  my ($latestHash, @latest) = hashRegular($leaf, 73, 74);',
    '  $latestHash eq $expectedHash or exit 76;',
    '  for my $index (0, 1, 7, 9, 10) { $latest[$index] == $before[$index] or exit 76; }',
    '  rename($stage, $leaf) or exit 88;',
    '} elsif ($mode eq "replace") {',
    '  if (-e $leaf || -l $leaf) {',
    '    my @current = lstat($leaf);',
    '    @current && (($current[2] & S_IFMT) == S_IFREG) or exit 74;',
    '  }',
    '  rename($stage, $leaf) or exit 88;',
    '} else { exit 90; }',
    'undef $stage;'
  ].join('\n')
  const script = [
    'set -eu',
    `expected_parent=${shellQuote(parent)}`,
    'actual_parent=$(pwd -P) || exit 72',
    '[ "$actual_parent" = "$expected_parent" ] || exit 72',
    `root=${shellQuote(canonicalRoot)}`,
    'if [ "$root" != / ]; then',
    '  case "$actual_parent" in "$root"|"$root"/*) ;; *) exit 72 ;; esac',
    'fi',
    'command -v perl >/dev/null 2>&1 || exit 91',
    `perl -e ${shellQuote(perl)} -- ${shellQuote(leaf)} ${shellQuote(stageName)} ${shellQuote(mode)} ${shellQuote(options.expectedHash ?? '')} ${expectedBytes} ${shellQuote(contentHash)}`
  ].join('\n')
  return `bash -c ${shellQuote(script)}`
}

function streamedAtomicWriteCommand(
  path: string,
  canonicalRoot: string,
  stageName: string,
  expectedBytes: number,
  contentHash: string,
  options: AtomicWriteOptions
): string {
  const parent = posix.dirname(path)
  const receiver = [
    'use strict; use warnings;',
    'use Digest::SHA;',
    'use Fcntl qw(O_WRONLY O_CREAT O_EXCL O_NOFOLLOW);',
    'my ($stage, $expectedBytes, $contentHash) = @ARGV;',
    'sysopen(my $fh, $stage, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600) or exit 85;',
    'binmode(STDIN); binmode($fh);',
    'my $received = 0; my $sha = Digest::SHA->new(256);',
    'while (1) {',
    '  my $count = sysread(STDIN, my $chunk, 65536);',
    '  defined($count) or exit 86;',
    '  last if $count == 0;',
    '  $received += $count; $received <= $expectedBytes or exit 86;',
    '  $sha->add($chunk);',
    '  my $offset = 0;',
    '  while ($offset < $count) {',
    '    my $written = syswrite($fh, $chunk, $count - $offset, $offset);',
    '    defined($written) && $written > 0 or exit 86;',
    '    $offset += $written;',
    '  }',
    '}',
    '$received == $expectedBytes && $sha->hexdigest eq $contentHash or exit 87;',
    'close($fh) or exit 86;'
  ].join('\n')
  const commit = lockedMutationCommand(
    path,
    stagedMutationCommand(path, canonicalRoot, stageName, expectedBytes, contentHash, options),
    true
  )
  const script = [
    'set -eu',
    `expected_parent=${shellQuote(parent)}`,
    `cd -P -- ${shellQuote(parent)} || exit 72`,
    'verify_parent() {',
    '  actual_parent=$(pwd -P) || exit 72',
    '  [ "$actual_parent" = "$expected_parent" ] || exit 72',
    `root=${shellQuote(canonicalRoot)}`,
    'if [ "$root" != / ]; then',
    '  case "$actual_parent" in "$root"|"$root"/*) ;; *) exit 72 ;; esac',
    'fi',
    '}',
    'verify_parent',
    'umask 077',
    `[ ! -e ${shellQuote(stageName)} ] && [ ! -L ${shellQuote(stageName)} ] || exit 85`,
    `cleanup() { rm -f -- ${shellQuote(stageName)}; }`,
    'trap cleanup EXIT',
    'command -v perl >/dev/null 2>&1 || exit 91',
    `perl -e ${shellQuote(receiver)} -- ${shellQuote(stageName)} ${expectedBytes} ${shellQuote(contentHash)}`,
    'verify_parent',
    commit,
    'cleanup',
    'trap - EXIT'
  ].join('\n')
  return `bash -c ${shellQuote(script)}`
}

async function runBinaryInput(
  session: RemoteSshSession,
  command: string,
  content: Uint8Array
): Promise<{ stdout: string; stderr: string; code: number | null; signal: string | null }> {
  if (!session.openStdio) {
    throw new Error('当前 SSH 连接不支持安全二进制输入')
  }
  const process = await session.openStdio(command)
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let outputBytes = 0
  let outputOverflow = false
  let finished = false
  const collect = (target: Buffer[], chunk: Buffer): void => {
    outputBytes += chunk.byteLength
    if (outputBytes > SSH_ATOMIC_MAX_OUTPUT_BYTES) {
      outputOverflow = true
      return
    }
    target.push(chunk)
  }
  process.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk))
  process.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk))
  process.stdin.on('error', () => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('remote atomic write timed out; result may be unknown')),
      SSH_ATOMIC_UPLOAD_TIMEOUT_MS
    )
  })
  try {
    process.stdin.end(content)
    const result = await Promise.race([process.closed, timeout])
    finished = true
    if (outputOverflow) throw new Error('remote atomic write produced too much output')
    return {
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      code: result.code,
      signal: result.signal
    }
  } finally {
    if (timer) clearTimeout(timer)
    if (!finished) await process.close().catch(() => undefined)
  }
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

async function remoteModifiedAt(session: RemoteSshSession, path: string): Promise<string> {
  const source = 'my @info = stat($ARGV[0]); defined $info[9] or exit 1; print $info[9];'
  const result = await session.exec(`perl -e ${shellQuote(source)} -- ${shellQuote(path)}`)
  const seconds = Number(result.stdout)
  if (result.code !== 0 || !Number.isFinite(seconds)) {
    throw new Error('remote workspace mtime check failed')
  }
  return new Date(seconds * 1000).toISOString()
}

async function collectPaths(
  session: RemoteSshSession,
  directory: string,
  root: string,
  prefix: string,
  includeDirectories: boolean
): Promise<string[]> {
  const paths: string[] = []
  const entries = await listRemoteDirectoryEntries(session, directory, root)
  for (const entry of entries) {
    const relative = prefix ? posix.join(prefix, entry.name) : entry.name
    if (!entry.isDirectory) paths.push(relative)
    else {
      if (includeDirectories) paths.push(relative)
      paths.push(
        ...(await collectPaths(
          session,
          posix.join(directory, entry.name),
          root,
          relative,
          includeDirectories
        ))
      )
    }
  }
  return paths
}

function validateRange(options: ReadRangeOptions): void {
  if (!Number.isSafeInteger(options.offset) || options.offset < 0) {
    throw invalid('range offset must be a non-negative integer')
  }
  if (!Number.isSafeInteger(options.length) || options.length < 0) {
    throw invalid('range length must be a non-negative integer')
  }
}

class SshFileSystem {
  constructor(private readonly context: SshHostContext) {}

  asHost(): FileSystemHost {
    return {
      glob: (pattern, options = {}) => this.glob(pattern, options),
      list: (path, options = {}) => this.list(path, options),
      mkdirp: (path) => this.context.mkdirp(path),
      readRange: (path, options) => this.readRange(path, options),
      remove: (path, options = {}) => this.remove(path, options),
      stat: (path, options = {}) => this.stat(path, options),
      writeAtomic: (path, content, options = {}) => this.writeAtomic(path, content, options)
    }
  }

  private async readRange(path: string, options: ReadRangeOptions): Promise<ReadRangeResult> {
    validateRange(options)
    return this.context.withPath(path, 'existing', async (session, resolved) => {
      const value = await readBytes(
        session,
        resolved,
        this.context.canonicalRoot,
        options.offset,
        options.length
      )
      return {
        content: value.bytes,
        bytesRead: value.bytes.length,
        eof: options.offset + value.bytes.length >= value.size
      }
    })
  }

  private async list(path: string, options: ListOptions): Promise<ListResult> {
    const limit = options.limit ?? 100
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw invalid('list limit must be between 1 and 1000')
    }
    return this.context.withPath(path, 'existing', async (session, resolved) => {
      const entries = (
        await listRemoteDirectoryEntries(session, resolved, this.context.canonicalRoot)
      )
        .map((entry): WorkspaceEntry => ({
          name: entry.name,
          path: posix.relative(this.context.canonicalRoot, posix.join(resolved, entry.name)),
          kind: entry.isDirectory ? 'directory' : 'file'
        }))
        .sort((left, right) => compareNames(left.name, right.name))
      const start = options.cursor
        ? entries.findIndex((entry) => compareNames(entry.name, options.cursor as string) > 0)
        : 0
      const page = start < 0 ? [] : entries.slice(start, start + limit)
      const more = start >= 0 && start + page.length < entries.length
      return { entries: page, ...(more ? { nextCursor: page.at(-1)?.name } : {}) }
    })
  }

  private async glob(pattern: string, options: GlobOptions): Promise<readonly string[]> {
    if (
      !pattern ||
      pattern.includes('\0') ||
      isAbsolute(pattern) ||
      posix.isAbsolute(pattern) ||
      pattern.split('/').includes('..')
    ) {
      throw invalid('glob pattern must stay inside the workspace')
    }
    return this.context.withPath(options.cwd ?? '.', 'existing', async (session, resolved) => {
      const paths = await collectPaths(
        session,
        resolved,
        this.context.canonicalRoot,
        '',
        options.includeDirectories ?? false
      )
      return paths.filter((path) => matchesGlob(path, pattern)).sort()
    })
  }

  private async stat(path: string, options: StatOptions): Promise<WorkspaceStat> {
    return this.context.withPath(path, 'existing', async (session, resolved) => {
      const kind = await session.exec(buildRemoteReadKindCommand(resolved))
      if (kind.code !== 0) throw new Error('remote workspace target type check failed')
      const modifiedAt = options.includeModifiedAt
        ? await remoteModifiedAt(session, resolved)
        : undefined
      if (kind.stdout === 'directory')
        return { kind: 'directory', size: 0, ...(modifiedAt ? { modifiedAt } : {}) }
      if (kind.stdout !== 'file')
        return { kind: 'other', size: 0, ...(modifiedAt ? { modifiedAt } : {}) }
      const value = await readBytes(session, resolved, this.context.canonicalRoot, 0, 0)
      return { kind: 'file', size: value.size, ...(modifiedAt ? { modifiedAt } : {}) }
    })
  }

  private async remove(path: string, options: RemoveOptions): Promise<void> {
    return this.context.withPath(path, 'existing', async (session, resolved) => {
      if (resolved === this.context.canonicalRoot) throw invalid('cannot remove the workspace root')
      const flags = `${options.recursive ? 'r' : ''}${options.force ? 'f' : ''}`
      const result = await session.exec(`rm ${flags ? `-${flags} ` : ''}-- ${shellQuote(resolved)}`)
      if (result.code !== 0) throw new Error(result.stderr || 'remote workspace remove failed')
    })
  }

  private async writeAtomic(
    path: string,
    content: WorkspaceContent,
    options: AtomicWriteOptions
  ): Promise<AtomicWriteResult> {
    if (options.ifAbsent && options.expectedHash !== undefined) {
      throw invalid('expectedHash and ifAbsent cannot be combined')
    }
    if (typeof content === 'string') {
      const text = contentText(content)
      if (!options.ifAbsent) return this.writeLegacyText(path, text, options)
      return this.writeBinary(path, Buffer.from(text), options)
    }
    return this.writeBinary(path, checkedBinaryWriteContent(content), options)
  }

  private async writeBinary(
    path: string,
    content: Uint8Array,
    options: AtomicWriteOptions
  ): Promise<AtomicWriteResult> {
    return this.context.withSession(async (session) => {
      let target: string
      try {
        target = await this.context.resolve(session, path, 'existing')
      } catch (error) {
        if (!(error instanceof RemoteWorkspaceTargetMissingError)) throw error
        target = await this.context.resolve(session, path, 'create')
      }
      return this.stageAndCommit(session, target, content, options)
    })
  }

  private async writeLegacyText(
    path: string,
    text: string,
    options: AtomicWriteOptions
  ): Promise<AtomicWriteResult> {
    return this.context.withSession(async (session) => {
      let target: string
      try {
        target = await this.context.resolve(session, path, 'existing')
      } catch (error) {
        if (!(error instanceof RemoteWorkspaceTargetMissingError)) throw error
        target = await this.context.resolve(session, path, 'create')
        return this.createTextFile(session, target, text, options)
      }
      return this.replaceTextFile(session, target, text, options)
    })
  }

  private async createTextFile(
    session: RemoteSshSession,
    path: string,
    text: string,
    options: AtomicWriteOptions
  ): Promise<AtomicWriteResult> {
    if (options.expectedHash !== undefined) {
      throw new WorkspaceHostError('file does not match the expected hash', 'HASH_MISMATCH')
    }
    const result = await this.runTextInput(
      session,
      lockedMutationCommand(
        path,
        buildRemoteCreateFileCommand(path, this.context.canonicalRoot, Buffer.byteLength(text))
      ),
      text
    )
    if (result.code !== 0) throw new Error(`remote atomic create failed with code ${result.code}`)
    return { hash: hash(text) }
  }

  private async replaceTextFile(
    session: RemoteSshSession,
    path: string,
    text: string,
    options: AtomicWriteOptions
  ): Promise<AtomicWriteResult> {
    const current = await readWholeFile(session, path, this.context.canonicalRoot)
    const currentHash = hash(current)
    if (options.expectedHash !== undefined && options.expectedHash !== currentHash) {
      throw new WorkspaceHostError('file does not match the expected hash', 'HASH_MISMATCH')
    }
    const result = await this.runTextInput(
      session,
      lockedMutationCommand(
        path,
        buildRemoteReplaceFileCommand(
          path,
          this.context.canonicalRoot,
          currentHash,
          Buffer.byteLength(text)
        )
      ),
      text
    )
    if (result.code === 76) {
      throw new WorkspaceHostError('file does not match the expected hash', 'HASH_MISMATCH')
    }
    if (result.code !== 0) throw new Error(`remote atomic replace failed with code ${result.code}`)
    return { hash: hash(text) }
  }

  private runTextInput(
    session: RemoteSshSession,
    command: string,
    input: string
  ): ReturnType<NonNullable<RemoteSshSession['execWithInput']>> {
    if (!session.execWithInput) throw new Error('当前 SSH 连接不支持安全文本输入')
    return session.execWithInput(command, input)
  }

  private async stageAndCommit(
    session: RemoteSshSession,
    path: string,
    content: Uint8Array,
    options: AtomicWriteOptions
  ): Promise<AtomicWriteResult> {
    const stageName = `.phi-write-${randomUUID()}`
    const contentHash = hash(content)
    const result = await runBinaryInput(
      session,
      streamedAtomicWriteCommand(
        path,
        this.context.canonicalRoot,
        stageName,
        content.byteLength,
        contentHash,
        options
      ),
      content
    )
    if (result.code === 73 || result.code === 76) {
      throw new WorkspaceHostError(
        options.ifAbsent
          ? 'file exists but an absent target was required'
          : 'file does not match the expected hash',
        'HASH_MISMATCH'
      )
    }
    if (result.code !== 0) throw new Error(`remote atomic write failed with code ${result.code}`)
    return { hash: contentHash }
  }
}

export function createSshFileSystem(context: SshHostContext): FileSystemHost {
  return new SshFileSystem(context).asHost()
}
