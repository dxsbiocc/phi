import { SessionKeyRegistry, type SessionKeyRegistryOptions } from './session-key-registry'

export interface SessionRuntimeOptions extends SessionKeyRegistryOptions {
  shareLifecycle: (aliasKey: string, canonicalKey: string) => void
}

export class SessionRuntime {
  readonly keys: SessionKeyRegistry
  private readonly shareLifecycle: SessionRuntimeOptions['shareLifecycle']

  constructor(options: SessionRuntimeOptions) {
    this.keys = new SessionKeyRegistry(options)
    this.shareLifecycle = options.shareLifecycle
  }

  alias(aliasKey: string, canonicalKey: string): void {
    const resolvedCanonicalKey = this.keys.canonicalize(canonicalKey)
    if (aliasKey === resolvedCanonicalKey) return

    this.keys.setAlias(aliasKey, resolvedCanonicalKey)
    this.shareLifecycle(aliasKey, resolvedCanonicalKey)
  }
}
