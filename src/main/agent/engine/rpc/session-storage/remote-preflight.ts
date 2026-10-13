import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { TextDecoder } from 'node:util'
import type { CommandResult, WorkspaceHost } from '../../../workspace-host/types'
import { shellQuote as q } from '../../../wrappers/remote-ssh-session'
import { privateRemotePrefix } from '../extension-deployment/remote-commands'
import { remoteJournalPath } from './paths'
import {
  RemoteSessionStorageError,
  type RemoteJournalPreflight,
  type RemoteSessionReference,
  type RemoteSessionScope,
  type RemoteSessionPaths,
  type RemoteSessionStorageErrorCode,
  type RemoteSessionStoragePreparation
} from './types'

const hosts = new WeakMap<RemoteSessionStoragePreparation, WorkspaceHost>()
const codes = new Set<RemoteSessionStorageErrorCode>([
  'PATH_INVALID',
  'PERMISSION_DENIED',
  'FILE_MISSING',
  'FILE_INVALID',
  'IDENTITY_MISMATCH',
  'PERSISTENCE_FAILED'
])

export const STORAGE_REMOTE_FUNCTIONS = `
storage_fail() { printf 'PHI_STORAGE:%s\\n' "$1" >&2; exit 1; }
storage_owned() {
  [ ! -L "$1" ] || storage_fail PATH_INVALID
  storage_owner=$(stat -c %u -- "$1" 2>/dev/null || stat -f %u "$1") || storage_fail PERMISSION_DENIED
  [ "$storage_owner" = "$(id -u)" ] || storage_fail PERMISSION_DENIED
}
storage_dir() {
  [ ! -L "$1" ] || storage_fail PATH_INVALID
  if [ ! -e "$1" ]; then
    [ "$2" = create ] || storage_fail FILE_MISSING
    mkdir -m 700 -- "$1" 2>/dev/null || { [ -d "$1" ] && [ ! -L "$1" ]; } || storage_fail PERSISTENCE_FAILED
  fi
  [ -d "$1" ] || storage_fail PATH_INVALID
  storage_owned "$1"
  [ "$(cd -- "$1" && pwd -P)" = "$1" ] || storage_fail PATH_INVALID
  storage_mode=$(stat -c %a -- "$1" 2>/dev/null || stat -f %Lp "$1") || storage_fail PERMISSION_DENIED
  [ "$storage_mode" = 700 ] || storage_fail PERMISSION_DENIED
}
storage_stat() {
  stat -c '%d:%i:%s:%y:%z' -- "$1" 2>/dev/null || stat -f '%d:%i:%z:%m:%c' "$1"
}
storage_file() {
  [ ! -L "$1" ] || storage_fail PATH_INVALID
  [ -e "$1" ] || storage_fail FILE_MISSING
  [ -f "$1" ] || storage_fail FILE_INVALID
  storage_owned "$1"
  storage_links=$(stat -c %h -- "$1" 2>/dev/null || stat -f %l "$1") || storage_fail PERMISSION_DENIED
  [ "$storage_links" = 1 ] || storage_fail FILE_INVALID
  storage_mode=$(stat -c %a -- "$1" 2>/dev/null || stat -f %Lp "$1") || storage_fail PERMISSION_DENIED
  [ "$storage_mode" = 600 ] || storage_fail PERMISSION_DENIED
}`

export function storageDirectories(scope: RemoteSessionScope, paths: RemoteSessionPaths): string[] {
  return [
    posix.join(scope.runtimeRoot, 'omp-sessions'),
    posix.dirname(paths.directory),
    paths.directory,
    paths.journals,
    paths.data,
    posix.join(paths.data, 'omp'),
    paths.blobs
  ]
}

export function storagePrefix(
  scope: RemoteSessionScope,
  paths: RemoteSessionPaths,
  create = false
): string {
  return `${privateRemotePrefix(scope.runtimeRoot)}\n${STORAGE_REMOTE_FUNCTIONS}
[ -d ${q(scope.projectRoot)} ] && [ "$(cd -- ${q(scope.projectRoot)} && pwd -P)" = ${q(scope.projectRoot)} ] || storage_fail IDENTITY_MISMATCH
${storageDirectories(scope, paths)
  .map((path) => `storage_dir ${q(path)} ${create ? 'create' : 'existing'}`)
  .join('\n')}`
}

/** Retire authority promptly even when a host transport resolves a cancelled operation late. */
export async function waitForStorageOperation<T>(
  pending: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return pending
  let cancel!: () => void
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        cancel = () => reject(signal.reason)
        signal.addEventListener('abort', cancel, { once: true })
        if (signal.aborted) cancel()
      })
    ])
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

export async function runStorageCommand(
  host: WorkspaceHost,
  scope: RemoteSessionScope,
  command: string,
  signal?: AbortSignal,
  maxOutputBytes = 16 * 1024 + 1
): Promise<string> {
  signal?.throwIfAborted()
  let result: CommandResult
  try {
    result = await waitForStorageOperation(
      host.exec.run(['sh', '-c', command], {
        cwd: scope.runtimeRoot,
        signal,
        timeoutMs: 30_000,
        maxOutputBytes
      }),
      signal
    )
  } catch (cause) {
    signal?.throwIfAborted()
    throw new RemoteSessionStorageError('PERSISTENCE_FAILED', 'Remote storage transport failed', {
      cause
    })
  }
  signal?.throwIfAborted()
  if (result.code !== 0 || result.truncated || result.terminationReason) {
    const code = result.stderr.match(/PHI_STORAGE:([A-Z_]+)/)?.[1] as RemoteSessionStorageErrorCode
    const rootCode = /PHI_EXT:.*(?:another owner|writable by)/.test(result.stderr)
      ? 'PERMISSION_DENIED'
      : /PHI_EXT:.*(?:Symbolic|canonical)/.test(result.stderr)
        ? 'PATH_INVALID'
        : 'PERSISTENCE_FAILED'
    throw new RemoteSessionStorageError(
      codes.has(code) ? code : rootCode,
      'Remote storage operation did not pass server validation'
    )
  }
  return result.stdout
}

export function registerStorageHost(
  preparation: RemoteSessionStoragePreparation,
  host: WorkspaceHost
): void {
  hosts.set(preparation, host)
}

export function storageHost(preparation: RemoteSessionStoragePreparation): WorkspaceHost {
  preparation.lease.assertActive()
  const host = hosts.get(preparation)
  if (!host) throw new RemoteSessionStorageError('INVALID_SCOPE', 'Unknown storage preparation')
  return host
}

/** Locked18.10.3 has either a legacy header or one fixed256-byte physical title slot. */
function journalHeader(bytes: Buffer): {
  header: Record<string, unknown>
  headerBytes: Buffer
  prefixBytes: Buffer
} {
  const line = (offset: number): { value: Record<string, unknown>; end: number } => {
    const end = bytes.indexOf(10, offset)
    if (end < 0 || end >= 16384) throw new Error('Incomplete bounded header prefix')
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, end))
    const value: unknown = JSON.parse(decoded)
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid record')
    return { value: value as Record<string, unknown>, end }
  }
  const first = line(0)
  let start = 0
  if (first.value.type === 'title') {
    const slot = first.value
    const allowed = ['type', 'v', 'title', 'source', 'updatedAt', 'pad']
    if (
      first.end !== 255 ||
      slot.v !== 1 ||
      typeof slot.title !== 'string' ||
      typeof slot.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(slot.updatedAt)) ||
      typeof slot.pad !== 'string' ||
      !/^ *$/.test(slot.pad) ||
      (slot.source !== undefined && slot.source !== 'auto' && slot.source !== 'user') ||
      Object.keys(slot).some((key) => !allowed.includes(key))
    )
      throw new Error('Invalid fixed title slot')
    start = first.end + 1
  }
  const record = start ? line(start) : first
  return {
    header: record.value,
    headerBytes: bytes.subarray(start, record.end),
    prefixBytes: bytes.subarray(0, record.end + 1)
  }
}

export async function preflightRemoteJournal(
  preparation: RemoteSessionStoragePreparation,
  reference: RemoteSessionReference
): Promise<RemoteJournalPreflight> {
  const host = storageHost(preparation)
  const { scope, paths, lease } = preparation
  const journalPath = remoteJournalPath(scope, reference)
  const output = await runStorageCommand(
    host,
    scope,
    `${storagePrefix(scope, paths)}
storage_file ${q(journalPath)}
metadata_before=$(storage_stat ${q(journalPath)}) || storage_fail FILE_INVALID
printf '%s\\n' "$metadata_before"
head -c 16385 -- ${q(journalPath)} | base64
metadata_after=$(storage_stat ${q(journalPath)}) || storage_fail FILE_INVALID
[ "$metadata_before" = "$metadata_after" ] || storage_fail FILE_INVALID
storage_file ${q(journalPath)}`,
    lease.signal,
    24 * 1024
  )
  lease.assertActive()
  const separator = output.indexOf('\n')
  const metadata = output.slice(0, separator)
  const encoded = output.slice(separator + 1)
  if (
    separator < 0 ||
    !/^[0-9]+:[0-9]+:[0-9]+:/.test(metadata) ||
    !/^[A-Za-z0-9+/=\s]*$/.test(encoded)
  )
    throw new RemoteSessionStorageError('FILE_INVALID', 'Invalid bounded journal encoding')
  const bytes = Buffer.from(encoded.replace(/\s/g, ''), 'base64')
  let parsed: ReturnType<typeof journalHeader>
  try {
    if (bytes.includes(0)) throw new Error('NUL in journal prefix')
    parsed = journalHeader(bytes)
  } catch {
    throw new RemoteSessionStorageError(
      'FILE_INVALID',
      'Invalid bounded journal title/header prefix'
    )
  }
  const { header, headerBytes, prefixBytes } = parsed
  if (
    header.type !== 'session' ||
    header.version !== 3 ||
    typeof header.id !== 'string' ||
    typeof header.cwd !== 'string' ||
    typeof header.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(header.timestamp))
  )
    throw new RemoteSessionStorageError('FILE_INVALID', 'Invalid journal header schema')
  if (header.id !== reference.ompSessionId || header.cwd !== scope.projectRoot)
    throw new RemoteSessionStorageError('IDENTITY_MISMATCH', 'Journal session or project differs')
  return Object.freeze({
    journalPath,
    ompSessionId: header.id,
    cwd: header.cwd,
    headerVersion: 3,
    fileIdentity: createHash('sha256')
      .update(metadata.split(':').slice(0, 2).join(':'))
      .update('\0')
      .update(headerBytes)
      .digest('hex'),
    fingerprint: createHash('sha256')
      .update(metadata)
      .update('\0')
      .update(prefixBytes)
      .digest('hex'),
    verification: 'bounded-header'
  })
}
