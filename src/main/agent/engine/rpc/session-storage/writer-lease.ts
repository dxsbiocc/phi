import type { RpcStartupHeldLock } from '../startup-transaction'
import { acquireOwnedRemoteLock, RemoteLockBusyError } from '../extension-deployment/remote-lock'
import { deriveRemoteSessionPaths } from './paths'
import { registerStorageHost, runStorageCommand, storagePrefix } from './remote-preflight'
import {
  RemoteSessionStorageError,
  type PrepareRemoteSessionStorageOptions,
  type RemoteSessionStoragePreparation,
  type RemoteSessionWriterLease
} from './types'

interface DeferredWriterLease {
  readonly controller: AbortController
  readonly rejectLost: (error: Error) => void
  released: boolean
  lock?: RpcStartupHeldLock
  releasePromise?: Promise<void>
}

const deferred = new WeakMap<RemoteSessionStoragePreparation, DeferredWriterLease>()

/**
 * Build the verified storage scope locally. The consolidated startup channel
 * creates/checks the directories and acquires the server lock later, after all
 * generation files have been queued.
 */
export async function prepareRemoteSessionStorage(
  options: PrepareRemoteSessionStorageOptions
): Promise<RemoteSessionStoragePreparation> {
  const scope = Object.freeze({ ...options.scope })
  const paths = deriveRemoteSessionPaths(scope)
  const controller = new AbortController()
  let rejectLost!: (error: Error) => void
  const lost = new Promise<never>((_, reject) => {
    rejectLost = reject
  })
  void lost.catch(() => undefined)
  const state: DeferredWriterLease = { controller, rejectLost, released: false }
  const assertActive = (): void => {
    if (controller.signal.aborted) throw controller.signal.reason
    if (state.released)
      throw new RemoteSessionStorageError('LEASE_LOST', 'Session writer lease was released')
  }
  const retire = (reason: unknown): Promise<void> => {
    if (state.releasePromise) return state.releasePromise
    state.released = true
    controller.abort(reason)
    options.signal?.removeEventListener('abort', cancel)
    state.releasePromise = state.lock?.release() ?? Promise.resolve()
    return state.releasePromise
  }
  const release = (): Promise<void> =>
    retire(new RemoteSessionStorageError('LEASE_LOST', 'Session writer lease was released'))
  const cancel = (): void => {
    void retire(options.signal?.reason).catch(() => undefined)
  }
  options.signal?.addEventListener('abort', cancel, { once: true })
  if (options.signal?.aborted) cancel()
  const lease: RemoteSessionWriterLease = Object.freeze({
    signal: controller.signal,
    lost,
    assertActive,
    release
  })
  const preparation = Object.freeze({ scope, paths, lease })
  deferred.set(preparation, state)
  registerStorageHost(preparation, options.runtimeHost)
  try {
    assertActive()
    if (!options.deferToStartup) {
      await runStorageCommand(
        options.runtimeHost,
        scope,
        storagePrefix(scope, paths, true),
        controller.signal
      )
      const lock = await acquireOwnedRemoteLock({
        root: scope.runtimeRoot,
        directory: paths.directory,
        basename: 'lease.lock',
        openStdio: options.openLockStdio,
        signal: controller.signal,
        waitMs: options.lockWaitMs
      })
      await activateRemoteSessionStorageLease(preparation, lock)
    }
    return preparation
  } catch (error) {
    await release().catch(() => undefined)
    if (error instanceof RemoteLockBusyError)
      throw new RemoteSessionStorageError(
        'SESSION_BUSY',
        'Another active writer owns this remote session',
        { cause: error }
      )
    throw error
  }
}

/** Attach the one startup channel's held flock to the already-issued writer authority. */
export async function activateRemoteSessionStorageLease(
  preparation: RemoteSessionStoragePreparation,
  lock: RpcStartupHeldLock
): Promise<void> {
  const state = deferred.get(preparation)
  if (!state || state.lock) {
    await lock.release().catch(() => undefined)
    throw new RemoteSessionStorageError('INVALID_SCOPE', 'Unknown or active storage lease')
  }
  if (state.released || state.controller.signal.aborted) {
    await lock.release().catch(() => undefined)
    preparation.lease.assertActive()
  }
  state.lock = lock
  void lock.lost.catch((cause: unknown) => {
    const error = new RemoteSessionStorageError(
      'LEASE_LOST',
      'Session writer transport disconnected',
      { cause }
    )
    state.controller.abort(error)
    state.rejectLost(error)
  })
  preparation.lease.assertActive()
}
