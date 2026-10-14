import type { ContextUsageSnapshot } from '../../../../shared/contextUsageTypes'
import { contextUsageSnapshot } from '../context-usage-snapshot'
import { withRemoteSignal } from './history-pager'
import type { RemoteRuntimeSnapshot } from './remote-session-runtime'

export interface RuntimeRenamePolicy {
  /** Synchronous trusted Phi desired-title commit, after exclusive admission. */
  beforeWrite(): void
  /** Reject replacement generations, anchors, references or newer desired titles. */
  assertCurrent(): void
}
interface MetadataOwner {
  signal(): AbortSignal
  claim(): () => void
  active(): void
  snapshot(): RemoteRuntimeSnapshot
  readState(): Promise<unknown>
  setName(name: string): Promise<unknown>
  checkpoint(name: string): Promise<RemoteRuntimeSnapshot>
  withCheckpoint<T>(operation: () => Promise<T>): Promise<T>
  close(error: unknown): Promise<void>
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** Pinned SessionManager.cleanTitle, with an explicit bounded remote metadata contract. */
export function canonicalRemoteSessionName(raw: string): string {
  if (typeof raw !== 'string' || Buffer.from(raw, 'utf8').toString('utf8') !== raw)
    throw new Error('Remote session name must be valid UTF8 text')
  const name = Array.from(raw, (character) => {
    const code = character.codePointAt(0)!
    return code <= 31 || (code >= 127 && code <= 159) ? ' ' : character
  })
    .join('')
    .replace(/ +/g, ' ')
    .trim()
  if (!name || Buffer.byteLength(name, 'utf8') > 4096)
    throw new Error('Remote session name must contain 1–4096 UTF8 bytes')
  return name
}
function stateIdentity(raw: unknown, snapshot: RemoteRuntimeSnapshot): Record<string, unknown> {
  if (
    !record(raw) ||
    !record(raw.model) ||
    raw.sessionId !== snapshot.reference.ompSessionId ||
    raw.sessionFile !== snapshot.checkpoint.journalPath ||
    raw.model.provider !== snapshot.model.provider ||
    raw.model.id !== snapshot.model.id ||
    raw.thinkingLevel !== snapshot.thinkingLevel ||
    (snapshot.sessionName !== undefined && raw.sessionName !== snapshot.sessionName) ||
    raw.isStreaming !== false ||
    raw.isCompacting !== false ||
    raw.isSettled !== true ||
    raw.hasPendingAsyncWork !== false ||
    raw.queuedMessageCount !== 0 ||
    (raw.sessionName !== undefined && typeof raw.sessionName !== 'string')
  )
    throw new Error('Remote metadata state is not the verified idle session')
  return raw
}

/** Exact public context DTO only; unknown/absent limits are unavailable, not zero. */
export function projectRemoteContextUsage(usage: unknown): ContextUsageSnapshot | null {
  return record(usage) &&
    typeof usage.tokens === 'number' &&
    typeof usage.contextWindow === 'number' &&
    typeof usage.percent === 'number'
    ? contextUsageSnapshot({
        tokens: usage.tokens,
        contextWindow: usage.contextWindow,
        percent: usage.percent
      })
    : null
}

/** Named idle metadata operations. The connection and exclusive gate stay with the real runtime. */
export function createRuntimeMetadataControl(owner: MetadataOwner): {
  readContextUsage(): Promise<ContextUsageSnapshot | null>
  rename(name: string, policy?: RuntimeRenamePolicy): Promise<RemoteRuntimeSnapshot>
  reconcileInitialName(name: string, snapshot: RemoteRuntimeSnapshot): Promise<void>
} {
  async function idle<T>(operation: () => Promise<T>): Promise<T> {
    const reopen = owner.claim()
    try {
      const signal = owner.signal()
      const result = await withRemoteSignal(operation(), signal)
      owner.active()
      reopen()
      return result
    } catch (error) {
      await owner.close(error)
      throw error
    }
  }
  async function applyName(
    name: string,
    snapshot: RemoteRuntimeSnapshot,
    policy?: RuntimeRenamePolicy
  ): Promise<void> {
    owner.active()
    const before = stateIdentity(await owner.readState(), snapshot)
    owner.active()
    policy?.assertCurrent()
    policy?.beforeWrite()
    owner.active()
    if (before.sessionName !== name) await owner.setName(name)
    owner.active()
    policy?.assertCurrent()
    const after = stateIdentity(await owner.readState(), { ...snapshot, sessionName: name })
    owner.active()
    policy?.assertCurrent()
    if (after.sessionName !== name)
      throw new Error('Remote SDK title did not match the requested canonical name')
  }
  return {
    readContextUsage: () =>
      idle(async () => {
        const raw = stateIdentity(await owner.readState(), owner.snapshot())
        owner.active()
        return projectRemoteContextUsage(raw.contextUsage)
      }),
    rename(raw, policy) {
      const name = canonicalRemoteSessionName(raw)
      return idle(() =>
        owner.withCheckpoint(async () => {
          owner.active()
          policy?.assertCurrent()
          await applyName(name, owner.snapshot(), policy)
          const result = await owner.checkpoint(name)
          owner.active()
          policy?.assertCurrent()
          return result
        })
      )
    },
    reconcileInitialName(raw, snapshot) {
      return applyName(canonicalRemoteSessionName(raw), snapshot)
    }
  }
}
