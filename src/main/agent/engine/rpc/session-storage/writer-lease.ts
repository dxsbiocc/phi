import {
  acquireOwnedRemoteLock,
  RemoteLockBusyError,
  type ExtensionLock
} from '../extension-deployment/remote-lock'
import { deriveRemoteSessionPaths } from './paths'
import { registerStorageHost, runStorageCommand, storagePrefix } from './remote-preflight'
import {
  RemoteSessionStorageError,
  type PrepareRemoteSessionStorageOptions,
  type RemoteSessionStoragePreparation,
  type RemoteSessionWriterLease
} from './types'

export async function prepareRemoteSessionStorage(
  options: PrepareRemoteSessionStorageOptions
): Promise<RemoteSessionStoragePreparation> {
  const scope = Object.freeze({ ...options.scope })
  const paths = deriveRemoteSessionPaths(scope)
  const controller = new AbortController()
  const cancel = (): void => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', cancel, { once: true })
  if (options.signal?.aborted) cancel()
  let lock: ExtensionLock | undefined
  let released = false
  let releasePromise: Promise<void> | undefined
  const assertActive = (): void => {
    if (controller.signal.aborted) throw controller.signal.reason
    if (released)
      throw new RemoteSessionStorageError('LEASE_LOST', 'Session writer lease was released')
  }
  const release = (): Promise<void> => {
    released = true
    controller.abort(
      new RemoteSessionStorageError('LEASE_LOST', 'Session writer lease was released')
    )
    options.signal?.removeEventListener('abort', cancel)
    releasePromise ??= lock?.release() ?? Promise.resolve()
    return releasePromise
  }
  try {
    await runStorageCommand(
      options.runtimeHost,
      scope,
      storagePrefix(scope, paths, true),
      controller.signal
    )
    assertActive()
    lock = await acquireOwnedRemoteLock({
      root: scope.runtimeRoot,
      directory: paths.directory,
      basename: 'lease.lock',
      openStdio: options.openLockStdio,
      signal: controller.signal,
      waitMs: options.lockWaitMs
    })
    const lost = lock.lost.catch((cause: unknown): never => {
      const error = new RemoteSessionStorageError(
        'LEASE_LOST',
        'Session writer transport disconnected',
        { cause }
      )
      controller.abort(error)
      throw error
    })
    void lost.catch(() => undefined)
    const lease: RemoteSessionWriterLease = Object.freeze({
      signal: controller.signal,
      lost,
      assertActive,
      release
    })
    const preparation = Object.freeze({ scope, paths, lease })
    registerStorageHost(preparation, options.runtimeHost)
    // Abort retires authority immediately and closes only this owned lock channel.
    controller.signal.addEventListener(
      'abort',
      () => {
        void release().catch(() => undefined)
      },
      { once: true }
    )
    assertActive()
    return preparation
  } catch (error) {
    await release().catch(() => undefined)
    if (options.signal?.aborted) throw options.signal.reason
    if (error instanceof RemoteLockBusyError)
      throw new RemoteSessionStorageError(
        'SESSION_BUSY',
        'Another active writer owns this remote session',
        { cause: error }
      )
    throw error
  }
}
