import { SessionLifecycle, type SessionSnapshot } from '../agent/session/session-lifecycle'

export class SessionLifecycleRegistry<TResult> {
  private readonly lifecycles = new Map<string, SessionLifecycle<TResult>>()
  private readonly abortControllers = new Map<string, AbortController>()
  private readonly cleanupBarriersByPath = new Map<string, Promise<void>>()
  private readonly unknownPathCleanupBarriers = new Set<Promise<void>>()

  constructor(private readonly canonicalize: (key: string) => string) {}

  forKey(key: string): SessionLifecycle<TResult> {
    const canonicalKey = this.canonicalize(key)
    let lifecycle = this.lifecycles.get(canonicalKey)
    if (!lifecycle) {
      lifecycle = new SessionLifecycle<TResult>()
      this.lifecycles.set(canonicalKey, lifecycle)
    }
    if (canonicalKey !== key) {
      this.lifecycles.set(key, lifecycle)
    }
    return lifecycle
  }

  shareWithAlias(aliasKey: string, resolvedCanonicalKey: string): void {
    const lifecycle = this.lifecycles.get(resolvedCanonicalKey)
    if (lifecycle) {
      this.lifecycles.set(aliasKey, lifecycle)
    }
  }

  abortControllerFor(key: string): AbortController | undefined {
    return this.abortControllers.get(key)
  }

  installAbortController(key: string, controller: AbortController): void {
    this.abortControllers.set(key, controller)
  }

  deleteAbortController(key: string): void {
    this.abortControllers.delete(key)
  }

  registerCleanupForPath(path: string, barrier: Promise<void>): void {
    this.cleanupBarriersByPath.set(path, barrier)
  }

  replaceCleanupForPathIfDifferent(path: string, barrier: Promise<void>): void {
    if (this.cleanupBarriersByPath.get(path) !== barrier) {
      this.cleanupBarriersByPath.set(path, barrier)
    }
  }

  releaseCleanupForPath(path: string, barrier: Promise<void> | null): void {
    if (this.cleanupBarriersByPath.get(path) === barrier) {
      this.cleanupBarriersByPath.delete(path)
    }
  }

  registerUnknownPathCleanup(barrier: Promise<void>): void {
    this.unknownPathCleanupBarriers.add(barrier)
  }

  releaseUnknownPathCleanup(barrier: Promise<void>): void {
    this.unknownPathCleanupBarriers.delete(barrier)
  }

  async waitForCleanup(snapshot: SessionSnapshot): Promise<void> {
    if (snapshot.path) {
      await Promise.all([...this.unknownPathCleanupBarriers])
      await this.cleanupBarriersByPath.get(snapshot.path)
      return
    }

    await Promise.all([...this.unknownPathCleanupBarriers])
  }
}
