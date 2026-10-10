import { createHash } from 'node:crypto'
import { isAbsolute, matchesGlob, posix } from 'node:path'

import { RemoteWorkspaceTargetMissingError } from '../remote-workspace-boundary'
import { buildRemoteReadKindCommand, listRemoteDirectoryEntries } from '../remote-workspace-read'
import { buildRemoteReplaceFileCommand } from '../remote-workspace-edit'
import { REMOTE_WRITE_MAX_BYTES, buildRemoteCreateFileCommand } from '../remote-workspace-write'
import { MAX_REMOTE_LOG_RAW_BYTES, readRemoteFileChunk } from '../wrappers/remote-ssh-log'
import { shellQuote, type RemoteSshSession } from '../wrappers/remote-ssh-session'
import { SshHostContext } from './ssh-host-context'
import {
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

function lockedMutationCommand(path: string, command: string): string {
  const lock = posix.join(posix.dirname(path), `.phi-cas-${hash(path).slice(0, 32)}.lock`)
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

function contentText(content: WorkspaceContent): string {
  const bytes = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content)
  if (bytes.length > REMOTE_WRITE_MAX_BYTES) throw invalid('remote text is limited to 1 MiB')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw invalid('pure SSH atomic writes require UTF-8 text')
  }
  if (text.includes('\0')) throw invalid('remote text cannot contain NUL bytes')
  return text
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
    const text = contentText(content)
    return this.context.withSession(async (session) => {
      let target: string
      try {
        target = await this.context.resolve(session, path, 'existing')
      } catch (error) {
        if (!(error instanceof RemoteWorkspaceTargetMissingError)) throw error
        target = await this.context.resolve(session, path, 'create')
        return this.createFile(session, target, text, content, options)
      }
      return this.replaceFile(session, target, text, content, options)
    })
  }

  private async createFile(
    session: RemoteSshSession,
    path: string,
    text: string,
    content: WorkspaceContent,
    options: AtomicWriteOptions
  ): Promise<AtomicWriteResult> {
    if (options.expectedHash !== undefined) {
      throw new WorkspaceHostError('file does not match the expected hash', 'HASH_MISMATCH')
    }
    const result = await this.runInput(
      session,
      lockedMutationCommand(
        path,
        buildRemoteCreateFileCommand(path, this.context.canonicalRoot, Buffer.byteLength(text))
      ),
      text
    )
    if (result.code !== 0) throw new Error(`remote atomic create failed with code ${result.code}`)
    return { hash: hash(content) }
  }

  private async replaceFile(
    session: RemoteSshSession,
    path: string,
    text: string,
    content: WorkspaceContent,
    options: AtomicWriteOptions
  ): Promise<AtomicWriteResult> {
    const current = await readWholeFile(session, path, this.context.canonicalRoot)
    const currentHash = hash(current)
    if (options.expectedHash !== undefined && options.expectedHash !== currentHash) {
      throw new WorkspaceHostError('file does not match the expected hash', 'HASH_MISMATCH')
    }
    const result = await this.runInput(
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
    return { hash: hash(content) }
  }

  private runInput(
    session: RemoteSshSession,
    command: string,
    input: string
  ): ReturnType<NonNullable<RemoteSshSession['execWithInput']>> {
    if (!session.execWithInput) throw new Error('当前 SSH 连接不支持安全文本输入')
    return session.execWithInput(command, input)
  }
}

export function createSshFileSystem(context: SshHostContext): FileSystemHost {
  return new SshFileSystem(context).asHost()
}
