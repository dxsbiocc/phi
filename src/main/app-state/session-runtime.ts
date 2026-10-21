import { SessionKeyRegistry, type SessionKeyRegistryOptions } from './session-key-registry'
import { SessionLifecycleRegistry } from './session-lifecycle-registry'

export type SessionRuntimeOptions = SessionKeyRegistryOptions

export class SessionRuntime<TResult = unknown> {
  readonly keys: SessionKeyRegistry
  readonly lifecycles: SessionLifecycleRegistry<TResult>

  constructor(options: SessionRuntimeOptions) {
    this.keys = new SessionKeyRegistry(options)
    this.lifecycles = new SessionLifecycleRegistry(this.keys.canonicalize.bind(this.keys))
  }

  alias(aliasKey: string, canonicalKey: string): void {
    const resolvedCanonicalKey = this.keys.canonicalize(canonicalKey)
    if (aliasKey === resolvedCanonicalKey) return

    this.keys.setAlias(aliasKey, resolvedCanonicalKey)
    this.lifecycles.shareWithAlias(aliasKey, resolvedCanonicalKey)
  }
}
