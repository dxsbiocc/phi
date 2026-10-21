export interface SessionRuntimeOrigin {
  sessionKey: string
  cwd: string
}

export interface SessionKeyRegistryOptions {
  getFreshSessionCounter: () => number
  phiOnlySessionPath: (sessionId: string) => string
}

export class SessionKeyRegistry {
  private readonly sessionKeyAliases = new Map<string, string>()
  private readonly phiSessionIdsByKey = new Map<string, string>()
  private readonly runtimeSessionOrigins = new Map<string, SessionRuntimeOrigin>()
  private readonly getFreshSessionCounter: () => number
  private readonly phiOnlySessionPath: (sessionId: string) => string

  constructor(options: SessionKeyRegistryOptions) {
    this.getFreshSessionCounter = options.getFreshSessionCounter
    this.phiOnlySessionPath = options.phiOnlySessionPath
  }

  createKey(
    path: string | undefined,
    cwd: string,
    freshId = this.getFreshSessionCounter()
  ): string {
    return path ? `path:${path}` : `fresh:${cwd}:${freshId}`
  }

  createPhiKey(sessionId: string, cwd: string): string {
    return this.createKey(this.phiOnlySessionPath(sessionId), cwd)
  }

  canonicalize(sessionKey: string): string {
    let current = sessionKey
    const seen = new Set<string>()
    while (true) {
      const next = this.sessionKeyAliases.get(current)
      if (!next || seen.has(current)) return current
      seen.add(current)
      current = next
    }
  }

  sameCanonical(left: string, right: string): boolean {
    return this.canonicalize(left) === this.canonicalize(right)
  }

  setAlias(aliasKey: string, canonicalKey: string): void {
    this.sessionKeyAliases.set(aliasKey, canonicalKey)
  }

  phiSessionIdFor(sessionKey: string): string | undefined {
    return this.phiSessionIdsByKey.get(this.canonicalize(sessionKey))
  }

  setPhiSessionId(sessionKey: string, sessionId: string): void {
    this.phiSessionIdsByKey.set(this.canonicalize(sessionKey), sessionId)
  }

  originFor(runtimeSessionId: string): SessionRuntimeOrigin | undefined {
    return this.runtimeSessionOrigins.get(runtimeSessionId)
  }

  recordOrigin(runtimeSessionId: string, origin: SessionRuntimeOrigin): void {
    this.runtimeSessionOrigins.set(runtimeSessionId, origin)
  }
}
