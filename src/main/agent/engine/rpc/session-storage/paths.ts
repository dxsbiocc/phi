import { posix } from 'node:path'
import { remoteOmpDurableSessionKey } from '../../../session/runtime-reference'
import {
  REMOTE_SESSION_OMP_VERSION,
  RemoteSessionStorageError,
  type RemoteSessionPaths,
  type RemoteSessionReference,
  type RemoteSessionScope
} from './types'

const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
export function validateRemoteSessionScope(scope: RemoteSessionScope): void {
  if (
    !scope ||
    Object.keys(scope).sort().join(',') !==
      'bindingHash,hostProfileId,phiSessionId,projectId,projectRoot,runtimeRoot' ||
    Object.values(scope).some((value) => typeof value !== 'string') ||
    !identifier.test(scope.phiSessionId)
  ) {
    throw new RemoteSessionStorageError('INVALID_SCOPE', 'Invalid verified remote session scope')
  }
  const { phiSessionId, ...identity } = scope
  try {
    remoteOmpDurableSessionKey(identity, phiSessionId)
  } catch {
    throw new RemoteSessionStorageError('INVALID_SCOPE', 'Invalid verified remote session scope')
  }
}

export function deriveRemoteSessionPaths(scope: RemoteSessionScope): Readonly<RemoteSessionPaths> {
  validateRemoteSessionScope(scope)
  const { phiSessionId, ...identity } = scope
  const durableSessionKey = remoteOmpDurableSessionKey(identity, phiSessionId)
  const scopeHash = durableSessionKey.split('/')[0]
  const directory = posix.join(scope.runtimeRoot, 'omp-sessions', durableSessionKey)
  const data = posix.join(directory, 'data')
  return Object.freeze({
    scopeHash,
    durableSessionKey,
    directory,
    manifest: posix.join(directory, 'manifest.json'),
    journals: posix.join(directory, 'journals'),
    data,
    blobs: posix.join(data, 'omp', 'blobs'),
    lock: posix.join(directory, 'lease.lock'),
    runLock: posix.join(directory, 'run.lock'),
    runRecord: posix.join(directory, 'run.record')
  })
}

/** Only a basename minted/verified from SDK state may be adopted by the caller. */
export function remoteJournalPath(
  scope: RemoteSessionScope,
  reference: RemoteSessionReference
): string {
  const paths = deriveRemoteSessionPaths(scope)
  if (
    reference.kind !== 'remote-omp' ||
    reference.version !== 1 ||
    reference.ompVersion !== REMOTE_SESSION_OMP_VERSION ||
    !identifier.test(reference.ompSessionId) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}\.jsonl$/.test(reference.journalBasename) ||
    reference.journalBasename.includes('..') ||
    reference.durableSessionKey !== paths.durableSessionKey ||
    (Object.keys(scope) as Array<keyof RemoteSessionScope>).some(
      (key) => reference[key] !== scope[key]
    )
  ) {
    throw new RemoteSessionStorageError(
      'IDENTITY_MISMATCH',
      'Remote journal identity does not match'
    )
  }
  return posix.join(paths.journals, reference.journalBasename)
}
