import type { AgentRunSnapshot } from '../../agents/registry'

export type AgentRunCompletion = Pick<AgentRunSnapshot, 'id' | 'state'> &
  Partial<Omit<AgentRunSnapshot, 'id' | 'state'>>

export interface AgentRunCompletions {
  expect(runtimeSessionId: string, runId: string): Promise<AgentRunCompletion>
  deliver(runtimeSessionId: string, run: AgentRunCompletion): boolean
  abandonSession(runtimeSessionId: string, reason: string): void
}

export interface AgentRunCompletionOptions {
  maxCached?: number
  cacheTtlMs?: number
  now?: () => number
}

interface Waiter {
  promise: Promise<AgentRunCompletion>
  resolve: (run: AgentRunCompletion) => void
}

interface CachedCompletion {
  run: AgentRunCompletion
  expiresAt: number
}

const DEFAULT_MAX_CACHED = 128
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000

function completionKey(runtimeSessionId: string, runId: string): string {
  return `${runtimeSessionId}\0${runId}`
}

function sessionFromKey(key: string): string {
  return key.slice(0, key.indexOf('\0'))
}

export function createAgentRunCompletions(
  options: AgentRunCompletionOptions = {}
): AgentRunCompletions {
  const maxCached = options.maxCached ?? DEFAULT_MAX_CACHED
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  const now = options.now ?? Date.now
  const waiters = new Map<string, Waiter>()
  const cached = new Map<string, CachedCompletion>()

  const prune = (): void => {
    const current = now()
    for (const [key, entry] of cached) {
      if (entry.expiresAt <= current) cached.delete(key)
    }
    while (cached.size > maxCached) cached.delete(cached.keys().next().value as string)
  }

  return {
    expect(runtimeSessionId, runId) {
      prune()
      const key = completionKey(runtimeSessionId, runId)
      const ready = cached.get(key)
      if (ready) {
        cached.delete(key)
        return Promise.resolve(ready.run)
      }
      const existing = waiters.get(key)
      if (existing) return existing.promise
      let resolve!: (run: AgentRunCompletion) => void
      const promise = new Promise<AgentRunCompletion>((done) => {
        resolve = done
      })
      waiters.set(key, { promise, resolve })
      return promise
    },
    deliver(runtimeSessionId, run) {
      prune()
      const key = completionKey(runtimeSessionId, run.id)
      const waiter = waiters.get(key)
      if (waiter) {
        waiters.delete(key)
        waiter.resolve(run)
        return true
      }
      cached.delete(key)
      cached.set(key, { run, expiresAt: now() + cacheTtlMs })
      prune()
      return false
    },
    abandonSession(runtimeSessionId, reason) {
      for (const [key, waiter] of waiters) {
        if (sessionFromKey(key) !== runtimeSessionId) continue
        waiters.delete(key)
        const runId = key.slice(key.indexOf('\0') + 1)
        waiter.resolve({ id: runId, state: 'cancelled', origin: 'host', error: reason })
      }
      for (const key of cached.keys()) {
        if (sessionFromKey(key) === runtimeSessionId) cached.delete(key)
      }
    }
  }
}

export const agentRunCompletions = createAgentRunCompletions()
