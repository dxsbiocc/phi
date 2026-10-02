import type { Session } from 'electron'

export type BrowserSessionLike = Pick<
  Session,
  'setPermissionCheckHandler' | 'setPermissionRequestHandler' | 'on' | 'off' | 'listenerCount'
>

interface SharedSessionPolicy {
  refs: number
  installed: boolean
  poisoned: boolean
  downloadListener: (...args: unknown[]) => void
}

const SHARED_SESSION_POLICIES = new WeakMap<object, SharedSessionPolicy>()

export function acquireBrowserSessionPolicy(session: BrowserSessionLike): () => boolean {
  const key = session as object
  let policy = SHARED_SESSION_POLICIES.get(key)
  if (!policy) {
    policy = {
      refs: 0,
      installed: false,
      poisoned: false,
      downloadListener: (...args: unknown[]): void => {
        const event = args[0] as { preventDefault?: () => void } | undefined
        event?.preventDefault?.()
      }
    }
    SHARED_SESSION_POLICIES.set(key, policy)
  }
  if (policy.refs === 0 || !policy.installed || policy.poisoned) installPolicy(session, policy)
  policy.refs += 1
  let released = false
  return () => {
    if (released) return false
    released = true
    return releaseBrowserSessionPolicy(session, policy)
  }
}

function installPolicy(session: BrowserSessionLike, policy: SharedSessionPolicy): void {
  policy.installed = false
  policy.poisoned = true
  for (let attempt = 0; attempt < 32; attempt += 1) {
    if (session.listenerCount('will-download', policy.downloadListener) === 0) break
    session.off('will-download', policy.downloadListener)
  }
  if (session.listenerCount('will-download', policy.downloadListener) !== 0) {
    throw new Error('Unable to deduplicate browser download policy')
  }
  session.setPermissionCheckHandler(() => false)
  session.setPermissionRequestHandler((...args: unknown[]) => {
    const callback = args[2]
    if (typeof callback === 'function') (callback as (allowed: boolean) => void)(false)
  })
  session.on('will-download', policy.downloadListener)
  if (session.listenerCount('will-download', policy.downloadListener) !== 1) {
    throw new Error('Unable to install browser download policy')
  }
  policy.installed = true
  policy.poisoned = false
}

function releaseBrowserSessionPolicy(
  session: BrowserSessionLike,
  policy: SharedSessionPolicy
): boolean {
  if (policy.refs > 0) policy.refs -= 1
  if (policy.refs > 0) return false
  try {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      if (session.listenerCount('will-download', policy.downloadListener) === 0) break
      session.off('will-download', policy.downloadListener)
    }
    if (session.listenerCount('will-download', policy.downloadListener) !== 0) {
      throw new Error('Unable to remove browser download policy')
    }
    session.setPermissionCheckHandler(null)
    session.setPermissionRequestHandler(null)
    policy.installed = false
    policy.poisoned = false
    SHARED_SESSION_POLICIES.delete(session as object)
    return false
  } catch {
    policy.refs = 0
    policy.installed = false
    policy.poisoned = true
    try {
      installPolicy(session, policy)
    } catch {
      policy.installed = false
      policy.poisoned = true
    }
    return true
  }
}
