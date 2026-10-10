import { posix } from 'node:path'

import { MAX_PRESENTED_FILES, type PresentedFile } from '../../../shared/presentedFileTypes'
import { remoteWorkspaceUri } from '../../../shared/remoteWorkspacePath'
import {
  withAuthorizedRemoteWorkspacePath,
  type RemoteWorkspaceBoundaryDependencies
} from '../remote-workspace-boundary'
import { shellQuote, type RemoteSshSession } from '../wrappers/remote-ssh-session'

const MAX_PATH_LENGTH = 4096
const MAX_DESCRIPTION_LENGTH = 160

type Identity = { sessionId: string; projectId: string }
type Inspection = PresentedFile & { identity: string }

export interface RemotePresentFilesDependencies extends RemoteWorkspaceBoundaryDependencies {
  inspect?: (path: string, identity: Identity) => Promise<Inspection>
}

export async function validateRemotePresentedFiles(
  identity: Identity,
  value: unknown,
  dependencies: RemotePresentFilesDependencies = {}
): Promise<PresentedFile[]> {
  const requested = requestedFiles(value)
  const inspect =
    dependencies.inspect ?? ((path) => inspectRemoteFile(identity, path, dependencies))
  const seen = new Set<string>()
  const files: PresentedFile[] = []
  for (const item of requested) {
    const inspected = await inspect(item.path, identity)
    if (seen.has(inspected.identity)) throw new Error(`Cannot present ${item.path} twice`)
    seen.add(inspected.identity)
    files.push({
      path: inspected.path,
      displayPath: inspected.displayPath,
      bytes: inspected.bytes,
      ...(item.description ? { description: item.description } : {})
    })
  }
  return files
}

function requestedFiles(value: unknown): Array<{ path: string; description?: string }> {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PRESENTED_FILES) {
    throw new Error(`Choose 1 to ${MAX_PRESENTED_FILES} existing files to present`)
  }
  return value.map((item) => requestedFile(item))
}

function requestedFile(value: unknown): { path: string; description?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Each presented file needs a path')
  }
  const record = value as Record<string, unknown>
  const path = typeof record.path === 'string' ? record.path.trim() : ''
  if (!path || path.length > MAX_PATH_LENGTH || unsafePath(path)) {
    throw new Error('Presented file path must stay inside the remote workspace')
  }
  const raw = record.description
  if (raw !== undefined && typeof raw !== 'string') {
    throw new Error('Presented file description must be text')
  }
  const description = raw?.replace(/\s+/g, ' ').trim()
  if (description && description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`Presented file description exceeds ${MAX_DESCRIPTION_LENGTH} characters`)
  }
  return { path, ...(description ? { description } : {}) }
}

function unsafePath(path: string): boolean {
  return path.includes('\0') || /^ssh:\/\//i.test(path) || path.split('/').includes('..')
}

async function inspectRemoteFile(
  identity: Identity,
  path: string,
  dependencies: RemoteWorkspaceBoundaryDependencies
): Promise<Inspection> {
  return withAuthorizedRemoteWorkspacePath(
    { ...identity, path, mode: 'existing' },
    async (authorized, session) => {
      const bytes = await regularFileSize(session, authorized.path, authorized.canonicalRoot)
      const requested = normalizedRelative(path, authorized.remoteRoot, authorized.canonicalRoot)
      if (requested !== authorized.relativePath) throw new Error(`Cannot present ${path}: symlink`)
      return {
        path: remoteWorkspaceUri(authorized.hostAlias, authorized.path),
        displayPath: authorized.relativePath,
        bytes,
        identity: authorized.path
      }
    },
    dependencies
  )
}

function normalizedRelative(path: string, remoteRoot: string, canonicalRoot: string): string {
  if (!posix.isAbsolute(path)) return posix.normalize(path).replace(/^\.\//, '')
  if (path === remoteRoot || path.startsWith(`${remoteRoot}/`))
    return posix.relative(remoteRoot, path)
  return posix.relative(canonicalRoot, path)
}

async function regularFileSize(
  session: RemoteSshSession,
  path: string,
  canonicalRoot: string
): Promise<number> {
  if (!session.execBounded) throw new Error('Remote file metadata backend is unavailable')
  const perl = [
    'use strict; use warnings;',
    'use Fcntl qw(O_RDONLY O_NOFOLLOW O_NONBLOCK S_IFMT S_IFREG);',
    'sysopen(my $fh, $ARGV[0], O_RDONLY | O_NOFOLLOW | O_NONBLOCK) or exit 75;',
    'my @info = stat($fh);',
    'exit 76 unless @info && ($info[2] & S_IFMT) == S_IFREG;',
    'print $info[7], "\\n";'
  ].join(' ')
  const parent = posix.dirname(path)
  const rootCheck =
    canonicalRoot === '/'
      ? ':'
      : `case "$PWD" in ${shellQuote(canonicalRoot)}|${shellQuote(`${canonicalRoot}/`)}*) ;; *) exit 72 ;; esac`
  const command = [
    'set -eu',
    `cd -P -- ${shellQuote(parent)} || exit 72`,
    `[ "$PWD" = ${shellQuote(parent)} ] || exit 72`,
    rootCheck,
    'command -v perl >/dev/null 2>&1 || exit 79',
    `perl -e ${shellQuote(perl)} -- ${shellQuote(posix.basename(path))}`
  ].join('\n')
  const result = await session.execBounded(command, { timeoutMs: 30_000, maxOutputBytes: 1024 })
  if (result.code !== 0 || result.stdoutTruncated || result.stderrTruncated) {
    throw new Error(`Cannot present ${path}: not a regular file`)
  }
  const bytes = Number(result.stdout.trim())
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Remote file size is invalid')
  return bytes
}
