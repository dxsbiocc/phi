import {
  type AuthCredential,
  type AuthCredentialSnapshotEntry,
  type AuthCredentialStore,
  type ClientUsageIdentity,
  type ClientUsageReport,
  type ClientUsageSummary,
  type OAuthCredential,
  type OAuthCredentials,
  type OAuthRefreshReason,
  type ObservedUsageEntry,
  type Provider,
  type StoredAuthCredential,
  type StoredCredentialBlock,
  type UsageHistoryEntry,
  type UsageHistoryQuery
} from '../omp/model-access'

import { ModelAccessReadOnlyError } from './errors'

type RefreshCredential = (
  provider: Provider,
  credentialId: number,
  credential: OAuthCredential,
  signal?: AbortSignal,
  reason?: OAuthRefreshReason
) => Promise<AuthCredentialSnapshotEntry>

type CacheEntry = { value: string; expiresAtSec: number }
type RefreshLease = { owner: string; expiresAtMs: number }
const REMOTE_REFRESH_SENTINEL = '__remote__' as const
type ProviderUsageAggregate = ObservedUsageEntry & { app?: string }
type ClientUsageAggregate = {
  installId: string
  hostname?: string
  firstSeen: number
  lastSeen: number
  providers: Map<string, ProviderUsageAggregate>
}

function credentialData(credential: AuthCredential): string {
  return JSON.stringify(credential)
}

function blockKey(credentialId: number, providerKey: string, blockScope: string): string {
  return JSON.stringify([credentialId, providerKey, blockScope])
}

function cloneCredential<T extends AuthCredential>(credential: T): T {
  return { ...credential }
}

function cloneStored(row: StoredAuthCredential): StoredAuthCredential {
  return { ...row, credential: cloneCredential(row.credential) }
}

function add(current: number | undefined, increment: number): number {
  return (current ?? 0) + increment
}

function newClientUsageAggregate(
  report: ClientUsageReport,
  entries: readonly ObservedUsageEntry[]
): ClientUsageAggregate {
  return {
    installId: report.installId,
    ...(report.hostname ? { hostname: report.hostname } : {}),
    firstSeen: Math.min(...entries.map((entry) => entry.at)),
    lastSeen: Math.max(...entries.map((entry) => entry.at)),
    providers: new Map()
  }
}

function mergeClientUsage(
  client: ClientUsageAggregate,
  report: ClientUsageReport,
  entry: ObservedUsageEntry
): void {
  client.firstSeen = Math.min(client.firstSeen, entry.at)
  client.lastSeen = Math.max(client.lastSeen, entry.at)
  const current = client.providers.get(entry.provider)
  client.providers.set(entry.provider, {
    at: Math.max(current?.at ?? 0, entry.at),
    provider: entry.provider,
    model: entry.model,
    requests: add(current?.requests, entry.requests),
    inputTokens: add(current?.inputTokens, entry.inputTokens),
    outputTokens: add(current?.outputTokens, entry.outputTokens),
    cacheReadTokens: add(current?.cacheReadTokens, entry.cacheReadTokens),
    cacheWriteTokens: add(current?.cacheWriteTokens, entry.cacheWriteTokens),
    costUsd: add(current?.costUsd, entry.costUsd),
    ...(report.app ? { app: report.app } : {})
  })
}

function summarizeClientUsage(client: ClientUsageAggregate): ClientUsageSummary['clients'][number] {
  return {
    installId: client.installId,
    ...(client.hostname ? { hostname: client.hostname } : {}),
    firstSeen: client.firstSeen,
    lastSeen: client.lastSeen,
    providers: [...client.providers.values()].map((entry) => ({
      ...(entry.app ? { app: entry.app } : {}),
      provider: entry.provider,
      requests: entry.requests,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheReadTokens: entry.cacheReadTokens,
      cacheWriteTokens: entry.cacheWriteTokens,
      costUsd: entry.costUsd
    }))
  }
}

/**
 * Process-local AuthCredentialStore used by both model-access adapters.
 * Public credential mutations are rejected; privileged snapshot/refresh updates
 * only replace this cache and never touch a credential file.
 */
export class MemoryAuthCredentialStore implements AuthCredentialStore {
  private rows = new Map<number, StoredAuthCredential>()
  private readonly cache = new Map<string, CacheEntry>()
  private readonly blocks = new Map<string, StoredCredentialBlock>()
  private readonly refreshLeases = new Map<number, RefreshLease>()
  private readonly usageHistory: UsageHistoryEntry[] = []
  private readonly observedUsage: ClientUsageReport[] = []
  private readonly refreshes = new Map<number, Promise<AuthCredentialSnapshotEntry>>()
  private closed = false

  constructor(
    private readonly options: {
      refreshCredential?: RefreshCredential
      refreshSnapshot?: (signal?: AbortSignal) => Promise<readonly AuthCredentialSnapshotEntry[]>
      onSnapshotChanged?: () => void
    } = {}
  ) {}

  replaceSnapshot(entries: readonly AuthCredentialSnapshotEntry[]): void {
    this.assertOpen()
    const next = new Map<number, StoredAuthCredential>()
    for (const entry of entries) {
      if (next.has(entry.id)) throw new Error(`Duplicate model credential id: ${entry.id}`)
      next.set(entry.id, {
        id: entry.id,
        provider: entry.provider,
        credential: cloneCredential(entry.credential),
        disabledCause: null
      })
    }
    const changed = this.snapshotFingerprint(this.rows) !== this.snapshotFingerprint(next)
    this.rows = next
    if (changed) this.options.onSnapshotChanged?.()
  }

  replaceProviderSnapshot(provider: string, entries: readonly AuthCredentialSnapshotEntry[]): void {
    const retained = [...this.rows.values()]
      .filter((row) => row.provider !== provider)
      .map((row) => ({
        id: row.id,
        provider: row.provider,
        credential:
          row.credential.type === 'oauth'
            ? { ...row.credential, refresh: REMOTE_REFRESH_SENTINEL }
            : cloneCredential(row.credential),
        identityKey: null
      }))
    this.replaceSnapshot([...retained, ...entries])
  }

  close(): void {
    this.closed = true
    this.rows.clear()
    this.cache.clear()
    this.blocks.clear()
    this.refreshLeases.clear()
    this.refreshes.clear()
  }

  pollExternalChanges(): boolean {
    return false
  }

  listAuthCredentials(provider?: string): StoredAuthCredential[] {
    this.assertOpen()
    return [...this.rows.values()]
      .filter((row) => provider === undefined || row.provider === provider)
      .map(cloneStored)
  }

  credentialSnapshot(): AuthCredentialSnapshotEntry[] {
    return this.listAuthCredentials().map((row) => ({
      id: row.id,
      provider: row.provider,
      credential:
        row.credential.type === 'oauth'
          ? { ...row.credential, refresh: REMOTE_REFRESH_SENTINEL }
          : cloneCredential(row.credential),
      identityKey: null
    }))
  }

  async refreshSnapshot(): Promise<void> {
    if (!this.options.refreshSnapshot) return
    this.replaceSnapshot(await this.options.refreshSnapshot())
  }

  updateAuthCredential(id: number, credential: AuthCredential): void {
    this.assertOpen()
    const current = this.rows.get(id)
    if (!current) return
    this.rows.set(id, { ...current, credential: cloneCredential(credential) })
    this.options.onSnapshotChanged?.()
  }

  deleteAuthCredential(): Promise<boolean> {
    return Promise.reject(new ModelAccessReadOnlyError('removeById'))
  }

  tryDisableAuthCredentialIfMatches(
    id: number,
    expectedData: string,
    disabledCause: string
  ): boolean {
    this.assertOpen()
    const current = this.rows.get(id)
    if (!current || credentialData(current.credential) !== expectedData) return false
    this.rows.delete(id)
    this.deleteCredentialBlocks(id)
    this.options.onSnapshotChanged?.()
    void disabledCause
    return true
  }

  tryUpdateAuthCredentialIfMatches(
    id: number,
    expectedData: string,
    credential: AuthCredential
  ): boolean {
    this.assertOpen()
    const current = this.rows.get(id)
    if (!current || credentialData(current.credential) !== expectedData) return false
    this.rows.set(id, { ...current, credential: cloneCredential(credential) })
    this.options.onSnapshotChanged?.()
    return true
  }

  replaceAuthCredentials(): Promise<StoredAuthCredential[]> {
    return Promise.reject(new ModelAccessReadOnlyError('set'))
  }

  upsertAuthCredential(): Promise<StoredAuthCredential[]> {
    return Promise.reject(new ModelAccessReadOnlyError('upsert'))
  }

  deleteAuthCredentials(): Promise<void> {
    return Promise.reject(new ModelAccessReadOnlyError('remove'))
  }

  getCache(key: string, options?: { includeExpired?: boolean }): string | null {
    this.assertOpen()
    const entry = this.cache.get(key)
    if (!entry) return null
    if (!options?.includeExpired && entry.expiresAtSec <= Date.now() / 1000) return null
    return entry.value
  }

  setCache(key: string, value: string, expiresAtSec: number): void {
    this.assertOpen()
    this.cache.set(key, { value, expiresAtSec })
  }

  deleteCachePrefix(prefix: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key)
    }
  }

  cleanExpiredCache(): void {
    const nowSec = Date.now() / 1000
    for (const [key, entry] of this.cache) {
      if (entry.expiresAtSec <= nowSec) this.cache.delete(key)
    }
  }

  getCredentialBlock(
    credentialId: number,
    providerKey: string,
    blockScope: string
  ): number | undefined {
    const block = this.blocks.get(blockKey(credentialId, providerKey, blockScope))
    return block && block.blockedUntilMs > Date.now() ? block.blockedUntilMs : undefined
  }

  getCredentialBlockScopes(credentialId: number, providerKey: string): ReadonlyMap<string, number> {
    const result = new Map<string, number>()
    const now = Date.now()
    for (const block of this.blocks.values()) {
      if (
        block.credentialId === credentialId &&
        block.providerKey === providerKey &&
        block.blockedUntilMs > now
      ) {
        result.set(block.blockScope, block.blockedUntilMs)
      }
    }
    return result
  }

  getCredentialBlockReconcileAfter(): number | undefined {
    return undefined
  }

  upsertCredentialBlock(block: StoredCredentialBlock): void {
    const key = blockKey(block.credentialId, block.providerKey, block.blockScope)
    const current = this.blocks.get(key)
    if (!current || current.blockedUntilMs < block.blockedUntilMs) {
      this.blocks.set(key, { ...block })
    }
  }

  deleteCredentialBlock(credentialId: number, providerKey: string, blockScope: string): void {
    this.blocks.delete(blockKey(credentialId, providerKey, blockScope))
  }

  deleteCredentialBlocks(credentialId: number): void {
    for (const [key, block] of this.blocks) {
      if (block.credentialId === credentialId) this.blocks.delete(key)
    }
  }

  cleanExpiredCredentialBlocks(nowMs: number): void {
    for (const [key, block] of this.blocks) {
      if (block.blockedUntilMs <= nowMs) this.blocks.delete(key)
    }
  }

  listCredentialBlocks(credentialIds: readonly number[]): StoredCredentialBlock[] {
    const ids = new Set(credentialIds)
    const now = Date.now()
    return [...this.blocks.values()]
      .filter((block) => ids.has(block.credentialId) && block.blockedUntilMs > now)
      .map((block) => ({ ...block }))
  }

  tryAcquireCredentialRefreshLease(id: number, owner: string, expiresAtMs: number): boolean {
    const current = this.refreshLeases.get(id)
    if (current && current.expiresAtMs > Date.now() && current.owner !== owner) return false
    this.refreshLeases.set(id, { owner, expiresAtMs })
    return true
  }

  getCredentialRefreshLeaseExpiresAt(id: number): number | undefined {
    const lease = this.refreshLeases.get(id)
    if (!lease) return undefined
    if (lease.expiresAtMs <= Date.now()) {
      this.refreshLeases.delete(id)
      return undefined
    }
    return lease.expiresAtMs
  }

  releaseCredentialRefreshLease(id: number, owner: string): void {
    if (this.refreshLeases.get(id)?.owner === owner) this.refreshLeases.delete(id)
  }

  renewCredentialRefreshLease(id: number, owner: string, expiresAtMs: number): boolean {
    const current = this.refreshLeases.get(id)
    if (!current || current.owner !== owner || current.expiresAtMs <= Date.now()) return false
    this.refreshLeases.set(id, { owner, expiresAtMs })
    return true
  }

  async refreshOAuthCredential(
    provider: Provider,
    credentialId: number,
    credential: OAuthCredential,
    signal?: AbortSignal,
    reason?: OAuthRefreshReason
  ): Promise<OAuthCredentials> {
    if (!this.options.refreshCredential) {
      throw new Error(`No desktop credential refresher is available for ${provider}.`)
    }
    const existing = this.refreshes.get(credentialId)
    const refresh =
      existing ??
      this.options
        .refreshCredential(provider, credentialId, credential, signal, reason)
        .then((entry) => {
          if (entry.id !== credentialId || entry.provider !== provider) {
            throw new Error('Desktop credential refresh returned the wrong credential row.')
          }
          this.rows.set(entry.id, {
            id: entry.id,
            provider: entry.provider,
            credential: cloneCredential(entry.credential),
            disabledCause: null
          })
          this.options.onSnapshotChanged?.()
          if (entry.credential.type !== 'oauth') {
            throw new Error('Desktop credential refresh did not return an OAuth credential.')
          }
          return entry
        })
        .finally(() => {
          if (this.refreshes.get(credentialId) === refresh) this.refreshes.delete(credentialId)
        })
    if (!existing) this.refreshes.set(credentialId, refresh)
    const entry = await this.waitForSharedRefresh(refresh, signal)
    if (entry.credential.type !== 'oauth') {
      throw new Error('Desktop credential refresh did not return an OAuth credential.')
    }
    return cloneCredential(entry.credential)
  }

  invalidateUsageCache(): Promise<void> {
    this.deleteCachePrefix('usage:')
    return Promise.resolve()
  }

  recordUsageSnapshots(entries: UsageHistoryEntry[]): void {
    this.usageHistory.push(...entries.map((entry) => ({ ...entry })))
  }

  listUsageHistory(query: UsageHistoryQuery = {}): UsageHistoryEntry[] {
    return this.usageHistory
      .filter(
        (entry) =>
          (query.provider === undefined || entry.provider === query.provider) &&
          (query.sinceMs === undefined || entry.recordedAt >= query.sinceMs)
      )
      .map((entry) => ({ ...entry }))
  }

  recordObservedUsage(entries: ObservedUsageEntry[], client?: ClientUsageIdentity): void {
    this.recordClientUsage({
      installId: client?.installId ?? 'kernel',
      ...(client?.hostname ? { hostname: client.hostname } : {}),
      ...(client?.app ? { app: client.app } : {}),
      entries
    })
  }

  recordClientUsage(report: ClientUsageReport): void {
    this.observedUsage.push({
      ...report,
      entries: report.entries.map((entry) => ({ ...entry }))
    })
  }

  getClientUsageSummary(sinceMs: number): ClientUsageSummary {
    const clients = new Map<string, ClientUsageAggregate>()
    for (const report of this.observedUsage) {
      const entries = report.entries.filter((entry) => entry.at >= sinceMs)
      if (entries.length === 0) continue
      const client = clients.get(report.installId) ?? newClientUsageAggregate(report, entries)
      for (const entry of entries) mergeClientUsage(client, report, entry)
      clients.set(report.installId, client)
    }
    return { clients: [...clients.values()].map(summarizeClientUsage) }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Model credential store is closed.')
  }

  private snapshotFingerprint(rows: ReadonlyMap<number, StoredAuthCredential>): string {
    return JSON.stringify(
      [...rows.values()]
        .sort((left, right) => left.id - right.id)
        .map((row) => [row.id, row.provider, row.credential])
    )
  }

  private waitForSharedRefresh(
    refresh: Promise<AuthCredentialSnapshotEntry>,
    signal?: AbortSignal
  ): Promise<AuthCredentialSnapshotEntry> {
    if (!signal) return refresh
    if (signal.aborted) return Promise.reject(signal.reason)
    return new Promise((resolve, reject) => {
      const abort = (): void => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      refresh.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }
}
