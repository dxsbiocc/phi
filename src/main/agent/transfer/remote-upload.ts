import { createHash } from 'node:crypto'
import { posix } from 'node:path'

import type { RemoteSshSession } from '../wrappers/remote-ssh-session'
import type { WorkspaceHost } from '../workspace-host/types'
import {
  REMOTE_HELPER_READY_MARKER_FILENAME,
  REMOTE_HELPER_READY_MARKER_MODE,
  remoteHelperReadyMarkerSha256,
  type RemoteHelperReadyMarkerIdentity
} from '../remote-helper-marker'
import { FileTransferCoordinator, getFileTransferCoordinator } from './coordinator'
import { HelperTransferDataPlane } from './helper-data-plane'
import { sameSourceIdentity } from './manifest'
import { TransferError } from './errors'
import { SshTransferDataPlane } from './ssh-data-plane'
import { hashLocalFile, localSourceIdentity } from './ssh-data-plane-local'
import { buildReuseUploadDestinationScript, shellScriptCommand } from './ssh-data-plane-scripts'
import type { TransferEvent, TransferResult } from './types'
import type { TransferStdioProcess } from './remote-upload-types'

export interface RemoteFileUploadOptions {
  session: RemoteSshSession
  localPath: string
  remotePath: string
  remoteRoot: string
  canonicalRoot: string
  hostKey: string
  workspaceId: string
  transferId: string
  expectedSha256?: string
  signal?: AbortSignal
  onEvent?: (event: TransferEvent) => void
  coordinator?: FileTransferCoordinator
  agentDir?: string
  helperConnect?: () => Promise<TransferStdioProcess>
  forceSsh?: boolean
  reuseVerifiedDestination?: boolean
  controlTimeoutMs?: number
}

export function remoteTransferHostKey(hostAlias: string): string {
  if (!hostAlias || /[\0\r\n]/.test(hostAlias) || Buffer.byteLength(hostAlias) > 512) {
    throw new Error('Remote transfer host identity is invalid')
  }
  return createHash('sha256').update(hostAlias).digest('hex')
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export async function resolveRemoteUploadCanonicalRoot(
  session: RemoteSshSession,
  remoteRoot: string,
  signal?: AbortSignal
): Promise<string> {
  if (
    !posix.isAbsolute(remoteRoot) ||
    posix.normalize(remoteRoot) !== remoteRoot ||
    /[\0\r\n]/.test(remoteRoot)
  ) {
    throw new Error('Remote upload root must be a normalized absolute path')
  }
  if (!session.execBounded) throw new Error('SSH connection lacks bounded upload control')
  const script = [
    'set -eu',
    `root=${shellQuote(remoteRoot)}`,
    '[ -d "$root" ] || exit 72',
    'cd -P -- "$root"',
    "printf 'PHI_ROOT_HEX='",
    "printf '%s' \"$PWD\" | od -An -tx1 -v | tr -d ' \\n'",
    "printf '\\n'"
  ].join('\n')
  const result = await session.execBounded(`sh -c ${shellQuote(script)}`, {
    timeoutMs: 30_000,
    maxOutputBytes: 16 * 1024,
    signal
  })
  if (result.code !== 0 || result.stdoutTruncated || result.stderrTruncated) {
    throw new Error('Remote upload root could not be resolved')
  }
  const match = /^PHI_ROOT_HEX=([a-f0-9]+)$/m.exec(result.stdout)
  if (!match || match[1].length > 16 * 1024 || match[1].length % 2 !== 0) {
    throw new Error('Remote upload root response is invalid')
  }
  const canonicalRoot = Buffer.from(match[1], 'hex').toString('utf8')
  if (
    !posix.isAbsolute(canonicalRoot) ||
    posix.normalize(canonicalRoot) !== canonicalRoot ||
    /[\0\r\n]/.test(canonicalRoot) ||
    Buffer.from(canonicalRoot).toString('hex') !== match[1]
  ) {
    throw new Error('Remote upload root response is invalid')
  }
  return canonicalRoot
}

export async function reuseVerifiedRemoteUploadDestination(
  session: RemoteSshSession,
  remotePath: string,
  canonicalRoot: string,
  expectedSha256: string,
  signal?: AbortSignal
): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new TransferError('INVALID_REQUEST', 'Expected SHA-256 is invalid')
  }
  if (!session.execBounded) throw new Error('SSH connection lacks bounded upload control')
  const result = await session.execBounded(
    shellScriptCommand(
      buildReuseUploadDestinationScript({
        destination: remotePath,
        parent: posix.dirname(remotePath),
        canonicalRoot,
        expectedHash: expectedSha256
      })
    ),
    { timeoutMs: 30 * 60 * 1000, maxOutputBytes: 16 * 1024, signal }
  )
  if (result.code !== 0 || result.stdoutTruncated || result.stderrTruncated) {
    const code = /^PHI_ERROR=([^\r\n]+)$/m.exec(result.stdout)?.[1]
    if (code === 'HASH_UNAVAILABLE') {
      throw new TransferError('HASH_UNAVAILABLE', 'Remote SHA-256 verification is unavailable')
    }
    if (code === 'INVALID_DESTINATION' || code === 'INVALID_PATH') {
      throw new TransferError('INVALID_REQUEST', 'Remote upload staging is unsafe')
    }
    throw new TransferError('TRANSFER_FAILED', 'Remote upload staging inspection failed')
  }
  const state = /^PHI_REUSE=(valid|missing|removed)$/m.exec(result.stdout)?.[1]
  if (!state)
    throw new TransferError('TRANSFER_FAILED', 'Remote upload staging response is invalid')
  return state === 'valid'
}

export function createInstalledHelperTransferConnect(
  session: RemoteSshSession,
  remoteRoot: string,
  identity: RemoteHelperReadyMarkerIdentity
): () => Promise<TransferStdioProcess> {
  if (
    identity.schema !== 1 ||
    identity.kind !== 'remote-helper' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identity.version) ||
    !/^[a-f0-9]{64}$/.test(identity.sha256)
  ) {
    throw new Error('Remote helper identity is invalid')
  }
  const expectedMarkerSha256 = remoteHelperReadyMarkerSha256(identity)
  let resolved: Promise<string> | undefined
  const locate = async (): Promise<string> => {
    if (!session.execBounded || !session.openStdio) throw new Error('Remote helper unavailable')
    const script = [
      'set -eu',
      `version=${shellQuote(identity.version)}`,
      `expected_helper_sha256=${shellQuote(identity.sha256)}`,
      `expected_marker_sha256=${shellQuote(expectedMarkerSha256)}`,
      'uid=$(id -u)',
      'for candidate in "$HOME/.phi/remote/$version/phi-helper" "${TMPDIR:-/tmp}/phi-remote-$uid/$version/phi-helper"; do',
      '  [ -f "$candidate" ] && [ ! -L "$candidate" ] && [ -x "$candidate" ] || continue',
      '  owner=$(stat -Lc %u "$candidate" 2>/dev/null || stat -f %u "$candidate" 2>/dev/null) || continue',
      '  [ "$owner" = "$uid" ] || continue',
      '  directory=${candidate%/*}',
      `  marker="$directory/${REMOTE_HELPER_READY_MARKER_FILENAME}"`,
      '  [ -d "$directory" ] && [ ! -L "$directory" ] && [ -O "$directory" ] || continue',
      '  [ -f "$marker" ] && [ ! -L "$marker" ] && [ -O "$marker" ] || continue',
      `  [ "$(stat -Lc %a -- "$marker" 2>/dev/null)" = ${shellQuote(REMOTE_HELPER_READY_MARKER_MODE.toString(8))} ] || continue`,
      '  marker_sha256=$(sha256sum -- "$marker") || continue',
      '  marker_sha256=${marker_sha256%% *}',
      '  [ "$marker_sha256" = "$expected_marker_sha256" ] || continue',
      '  helper_sha256=$(sha256sum -- "$candidate") || continue',
      '  helper_sha256=${helper_sha256%% *}',
      '  [ "$helper_sha256" = "$expected_helper_sha256" ] || continue',
      "  printf 'PHI_HELPER_HEX='",
      "  printf '%s' \"$candidate\" | od -An -tx1 -v | tr -d ' \\n'",
      "  printf '\\n'",
      '  exit 0',
      'done',
      'exit 73'
    ].join('\n')
    const result = await session.execBounded(`sh -c ${shellQuote(script)}`, {
      timeoutMs: 30_000,
      maxOutputBytes: 16 * 1024
    })
    if (result.code !== 0 || result.stdoutTruncated || result.stderrTruncated) {
      throw new Error('Remote helper unavailable')
    }
    const match = /^PHI_HELPER_HEX=([a-f0-9]+)$/m.exec(result.stdout)
    if (!match || match[1].length > 16 * 1024 || match[1].length % 2 !== 0) {
      throw new Error('Remote helper path response is invalid')
    }
    const path = Buffer.from(match[1], 'hex').toString('utf8')
    if (!posix.isAbsolute(path) || posix.normalize(path) !== path || /[\0\r\n]/.test(path)) {
      throw new Error('Remote helper path is invalid')
    }
    return path
  }
  return async () => {
    resolved ??= locate()
    const path = await resolved
    return session.openStdio!(`${shellQuote(path)} serve --root ${shellQuote(remoteRoot)}`)
  }
}

function remoteRelativePath(root: string, path: string): string {
  const relative = posix.relative(root, path)
  if (
    !posix.isAbsolute(root) ||
    !posix.isAbsolute(path) ||
    relative === '' ||
    relative === '..' ||
    relative.startsWith('../') ||
    posix.isAbsolute(relative)
  ) {
    throw new Error('Remote upload destination must stay inside its authorized root')
  }
  return relative
}

function commandHost(session: RemoteSshSession): WorkspaceHost {
  return {
    exec: {
      async run(command, options) {
        if (command.length !== 3 || command[0] !== 'sh' || command[1] !== '-c') {
          throw new Error('Remote upload only allows fixed transfer control commands')
        }
        if (!session.execBounded) throw new Error('SSH connection lacks bounded upload control')
        options.signal?.throwIfAborted()
        const result = await session.execBounded(command[2], {
          timeoutMs: options.timeoutMs ?? 30 * 60 * 1000,
          maxOutputBytes: options.maxOutputBytes ?? 160 * 1024,
          signal: options.signal
        })
        options.signal?.throwIfAborted()
        return {
          ...result,
          truncated: result.stdoutTruncated || result.stderrTruncated
        }
      },
      async spawnBackground() {
        throw new Error('Remote upload does not allow background commands')
      }
    }
  } as unknown as WorkspaceHost
}

export async function uploadRemoteFile(options: RemoteFileUploadOptions): Promise<TransferResult> {
  if (!options.session.execBounded || !options.session.openStdio) {
    throw new Error('SSH connection lacks the streaming upload transport')
  }
  const relativePath = remoteRelativePath(options.remoteRoot, options.remotePath)
  if (options.reuseVerifiedDestination && options.expectedSha256) {
    const source = await localSourceIdentity(options.localPath)
    const localSha256 = await hashLocalFile(
      options.localPath,
      8 * 1024 * 1024,
      undefined,
      options.signal
    )
    if (localSha256 !== options.expectedSha256) {
      throw new TransferError(
        'HASH_MISMATCH',
        'Local transfer source does not match expected SHA-256'
      )
    }
    if (!sameSourceIdentity(source, await localSourceIdentity(options.localPath))) {
      throw new TransferError('SOURCE_CHANGED', 'Local transfer source changed during hashing')
    }
    const reusable = await reuseVerifiedRemoteUploadDestination(
      options.session,
      options.remotePath,
      options.canonicalRoot,
      options.expectedSha256,
      options.signal
    )
    if (reusable) {
      if (!sameSourceIdentity(source, await localSourceIdentity(options.localPath))) {
        throw new TransferError(
          'SOURCE_CHANGED',
          'Local transfer source changed during verification'
        )
      }
      const event: TransferEvent = {
        transferId: options.transferId,
        direction: 'upload',
        state: 'saved',
        bytesTransferred: source.size,
        totalBytes: source.size,
        resumedFrom: source.size,
        instantaneousBytesPerSecond: 0,
        smoothedBytesPerSecond: 0
      }
      options.onEvent?.(event)
      return {
        transferId: options.transferId,
        state: 'saved',
        bytes: source.size,
        resumedFrom: source.size,
        sha256: options.expectedSha256
      }
    }
  }
  const sshPlane = new SshTransferDataPlane({
    host: commandHost(options.session),
    hostId: options.hostKey,
    workspaceId: options.workspaceId,
    remoteRoot: options.remoteRoot,
    canonicalRoot: options.canonicalRoot,
    openStream: (command) => options.session.openStdio!(command),
    controlTimeoutMs: options.controlTimeoutMs
  })
  const plane =
    !options.forceSsh && options.helperConnect
      ? new HelperTransferDataPlane({
          hostId: options.hostKey,
          workspaceId: options.workspaceId,
          remoteRoot: options.remoteRoot,
          canonicalRoot: options.canonicalRoot,
          connect: options.helperConnect,
          fallback: sshPlane
        })
      : sshPlane
  const coordinator = options.coordinator ?? getFileTransferCoordinator(options.agentDir)
  const handle = coordinator.enqueue(
    {
      transferId: options.transferId,
      direction: 'upload',
      hostKey: options.hostKey,
      source: { kind: 'local-path', path: options.localPath },
      destination: {
        kind: 'remote-workspace-path',
        hostId: options.hostKey,
        workspaceId: options.workspaceId,
        relativePath
      },
      expectedSha256: options.expectedSha256
    },
    plane,
    options.onEvent
  )
  const cancel = (): void => handle.cancel()
  options.signal?.addEventListener('abort', cancel, { once: true })
  if (options.signal?.aborted) handle.cancel()
  try {
    return await handle.completion
  } finally {
    options.signal?.removeEventListener('abort', cancel)
  }
}
