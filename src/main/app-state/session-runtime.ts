import { SessionKeyRegistry, type SessionKeyRegistryOptions } from './session-key-registry'
import { SessionLifecycleRegistry } from './session-lifecycle-registry'
import { SessionPreferences } from './session-preferences'
import { PromptRunRegistry } from './prompt-run-registry'

export type SessionRuntimeOptions = SessionKeyRegistryOptions

export class SessionRuntime<TResult = unknown, TPromptRun = unknown> {
  readonly keys: SessionKeyRegistry
  readonly lifecycles: SessionLifecycleRegistry<TResult>
  readonly preferences: SessionPreferences
  readonly runs: PromptRunRegistry<TPromptRun>

  constructor(options: SessionRuntimeOptions) {
    this.keys = new SessionKeyRegistry(options)
    this.lifecycles = new SessionLifecycleRegistry(this.keys.canonicalize.bind(this.keys))
    this.preferences = new SessionPreferences()
    this.runs = new PromptRunRegistry(this.keys.canonicalize.bind(this.keys))
  }

  alias(aliasKey: string, canonicalKey: string): void {
    const resolvedCanonicalKey = this.keys.canonicalize(canonicalKey)
    if (aliasKey === resolvedCanonicalKey) return

    this.keys.setAlias(aliasKey, resolvedCanonicalKey)
    this.lifecycles.shareWithAlias(aliasKey, resolvedCanonicalKey)
  }
}
