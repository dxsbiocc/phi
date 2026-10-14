import type { PhiSessionManifest } from './session-store'
import {
  assertRuntimeScope,
  assertRuntimeReferenceProject,
  parseRuntimeReference,
  remoteOmpDurableSessionKey,
  RuntimeReferenceError,
  type RemoteOmpScope,
  type RemoteOmpRuntimeRef
} from './runtime-reference'

export interface RuntimeReferenceAdoption {
  /** Call only after server publication and post-attachment identity proof have succeeded. */
  adopt(reference: unknown): PhiSessionManifest
  release(): void
}

export interface RuntimeReferenceAdoptionOptions {
  readonly signal?: AbortSignal
  readonly expectedOmpSessionId?: string
  readonly expectedJournalBasename?: string
}

interface ManifestIO {
  read(): PhiSessionManifest
  write(manifest: PhiSessionManifest): void
}

const current = new Map<string, { generation: string; invalidate(): void }>()

function assertManifestScope(manifest: PhiSessionManifest, scope: RemoteOmpScope): void {
  if (manifest.runtimeRecoveryError)
    throw new RuntimeReferenceError(
      manifest.runtimeRecoveryError.code,
      manifest.runtimeRecoveryError.message
    )
  assertRuntimeReferenceProject(manifest, scope)
  if (manifest.runtimeRef) assertRuntimeScope(manifest.runtimeRef, scope)
}

/** No await inside adoption: append/update/adopt each commits in one serialized JS turn. */
export function createRuntimeReferenceAdoption(
  key: string,
  sessionId: string,
  trustedScope: RemoteOmpScope,
  generation: string,
  io: ManifestIO,
  options: RuntimeReferenceAdoptionOptions = {}
): RuntimeReferenceAdoption {
  if (!generation || typeof generation !== 'string') {
    throw new RuntimeReferenceError('STALE_GENERATION', '远程连接代次无效')
  }
  // Copy the trusted identity and expectations before any asynchronous server work begins.
  const scope = Object.freeze({ ...trustedScope })
  remoteOmpDurableSessionKey(scope, sessionId)
  const initial = io.read()
  assertManifestScope(initial, scope)
  const initialReference = JSON.stringify(initial.runtimeRef)
  const { signal, expectedOmpSessionId, expectedJournalBasename } = options
  const lease = { generation, invalidate: (): void => release() }
  let released = false
  let cancelled = signal?.aborted ?? false
  const abort = (): void => {
    cancelled = true
    if (current.get(key) === lease) current.delete(key)
  }
  const assertActive = (): void => {
    if (cancelled || signal?.aborted)
      throw new RuntimeReferenceError('CANCELLED', '远程历史采用已取消')
    if (released || current.get(key) !== lease) {
      throw new RuntimeReferenceError('STALE_GENERATION', '旧连接不能更新远程会话定位信息')
    }
  }
  const release = (): void => {
    released = true
    signal?.removeEventListener('abort', abort)
    if (current.get(key) === lease) current.delete(key)
  }
  // Replacing the map entry invalidates old authority and removes its abort listener immediately.
  current.get(key)?.invalidate()
  current.set(key, lease)
  signal?.addEventListener('abort', abort, { once: true })
  if (cancelled) abort()
  return {
    release,
    adopt(reference): PhiSessionManifest {
      assertActive()
      const ref: RemoteOmpRuntimeRef = parseRuntimeReference(reference, sessionId)
      assertRuntimeScope(ref, scope)
      const latest = io.read()
      assertManifestScope(latest, scope)
      if (
        latest.sessionId !== sessionId ||
        latest.cwd !== initial.cwd ||
        latest.cwdRealPath !== initial.cwdRealPath ||
        JSON.stringify(latest.runtimeRef) !== initialReference ||
        (expectedOmpSessionId !== undefined && ref.ompSessionId !== expectedOmpSessionId) ||
        (expectedJournalBasename !== undefined &&
          ref.journalBasename !== expectedJournalBasename) ||
        (initial.runtimeRef &&
          (ref.ompSessionId !== initial.runtimeRef.ompSessionId ||
            ref.journalBasename !== initial.runtimeRef.journalBasename))
      ) {
        throw new RuntimeReferenceError(
          'STALE_GENERATION',
          '远程会话标识或检查点已改变，请重新验证'
        )
      }
      const next = { ...latest, runtimeRef: ref, updatedAt: new Date().toISOString() }
      assertActive()
      io.write(next)
      // One verified publication per lease. A checkpoint update starts a fresh proof/lease.
      release()
      return next
    }
  }
}
