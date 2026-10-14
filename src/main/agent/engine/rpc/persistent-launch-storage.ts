import type { WorkspaceHost } from '../../workspace-host/types'
import type { RpcSessionCreateParams } from './rpc-session-backend'
import { deriveRemoteSessionPaths } from './session-storage/paths'
import { storageHost } from './session-storage/remote-preflight'
import {
  RemoteSessionStorageError,
  type RemoteSessionStoragePreparation
} from './session-storage/types'

export interface PersistentLaunchStorageContext {
  readonly params: Readonly<RpcSessionCreateParams>
  readonly signal: AbortSignal
}

/** A trusted main-process capability, never a caller-supplied durable locator. */
export type PreparePersistentLaunchStorage = (
  context: PersistentLaunchStorageContext
) => Promise<RemoteSessionStoragePreparation>

/** The caller transfers lease ownership even if acquisition completes after cancellation. */
export async function acquirePersistentLaunchStorage(
  prepare: PreparePersistentLaunchStorage,
  context: PersistentLaunchStorageContext,
  expected: { host: WorkspaceHost; projectId: string; runtimeRoot: string }
): Promise<RemoteSessionStoragePreparation> {
  const { signal, params } = context
  signal.throwIfAborted()
  let acquired: RemoteSessionStoragePreparation | undefined
  let handedOff = false
  const retired = new WeakSet<RemoteSessionStoragePreparation>()
  const retire = async (storage: RemoteSessionStoragePreparation): Promise<void> => {
    if (retired.has(storage)) return
    retired.add(storage)
    await storage.lease.release().catch(() => undefined)
  }
  const pending = Promise.resolve().then(() => {
    signal.throwIfAborted()
    return prepare(context)
  })
  const checked = pending.then(async (storage) => {
    acquired = storage
    try {
      signal.throwIfAborted()
      const host = storageHost(storage)
      const paths = deriveRemoteSessionPaths(storage.scope)
      if (
        host !== expected.host ||
        storage.scope.projectId !== expected.projectId ||
        storage.scope.runtimeRoot !== expected.runtimeRoot ||
        storage.scope.projectRoot !== params.cwd ||
        storage.scope.phiSessionId !== params.sessionId ||
        Object.keys(storage.paths).length !== Object.keys(paths).length ||
        (Object.keys(paths) as Array<keyof typeof paths>).some(
          (key) => storage.paths[key] !== paths[key]
        )
      )
        throw new RemoteSessionStorageError(
          'IDENTITY_MISMATCH',
          'Persistent launch storage does not match the verified session'
        )
      return storage
    } catch (error) {
      await retire(storage)
      throw error
    }
  })
  // A losing acquisition remains observed, and a late successful lease is retired.
  void checked.catch(() => undefined)
  let abort!: () => void
  try {
    const storage = await Promise.race([
      checked,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
    ])
    signal.throwIfAborted()
    storage.lease.assertActive()
    handedOff = true
    return storage
  } finally {
    signal.removeEventListener('abort', abort)
    if (!handedOff && acquired) await retire(acquired)
    if (!handedOff)
      void pending.then(
        (late) => retire(late),
        () => undefined
      )
  }
}
