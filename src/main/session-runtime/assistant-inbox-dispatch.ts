import { randomUUID } from 'node:crypto'
import type {
  AssistantInbox,
  AssistantInboxEntry,
  ClaimedEntry,
  SettleResult
} from './assistant-inbox'

export interface AssistantInboxDispatchDeps {
  inbox: Pick<AssistantInbox, 'queued' | 'claim' | 'settle'>
  prepare(entry: AssistantInboxEntry): Promise<'ready' | 'wait' | 'invalid'>
  capacity(): number
  execute(entry: ClaimedEntry): Promise<SettleResult>
  changed(sessionId: string): void
  log(error: unknown): void
}

export interface AssistantInboxDispatch {
  wake(): void
  stop(): void
  drained(): Promise<void>
}

export function createAssistantInboxDispatch(
  deps: AssistantInboxDispatchDeps
): AssistantInboxDispatch {
  const active = new Map<string, Promise<void>>()
  const blocked = new Set<string>()
  let scanPromise: Promise<void> | undefined
  let wakeRequested = false
  let stopped = false

  function report(error: unknown): void {
    try {
      deps.log(error)
    } catch {
      // Diagnostic failures must not interrupt ownership cleanup.
    }
  }

  function notify(sessionId: string): void {
    try {
      deps.changed(sessionId)
    } catch (error) {
      report(error)
    }
  }

  async function retryWrite<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write()
    } catch (error) {
      report(error)
      return write()
    }
  }

  async function finish(entry: ClaimedEntry, verdict: 'ready' | 'invalid'): Promise<void> {
    const { conversationId } = entry.scope
    let result: SettleResult = verdict === 'invalid' ? 'failed' : 'defer'
    if (verdict === 'ready' && !stopped) {
      try {
        result = await deps.execute(entry)
      } catch (error) {
        report(error)
        result = 'interrupted'
      }
    }
    try {
      const settled = await retryWrite(() =>
        deps.inbox.settle(entry.scope, entry.id, entry.attemptId, result)
      )
      if (!settled) throw new Error('Assistant inbox attempt lost ownership before settlement.')
      notify(conversationId)
    } catch (error) {
      blocked.add(conversationId)
      report(error)
    } finally {
      active.delete(conversationId)
    }
    // Deferrals rely on the next state change or periodic wake, not a tight retry loop.
    if (result !== 'defer') wake()
  }

  async function scan(): Promise<void> {
    const seen = new Set<string>()
    for (const entry of await deps.inbox.queued()) {
      if (stopped || active.size >= deps.capacity()) return
      const { conversationId } = entry.scope
      if (seen.has(conversationId) || active.has(conversationId) || blocked.has(conversationId)) {
        continue
      }
      seen.add(conversationId)
      let verdict: Awaited<ReturnType<AssistantInboxDispatchDeps['prepare']>>
      try {
        verdict = await deps.prepare(entry)
      } catch (error) {
        report(error)
        continue
      }
      if (stopped) return
      if (verdict === 'wait') continue
      const attemptId = randomUUID()
      try {
        const claimed = await retryWrite(() => deps.inbox.claim(entry.scope, attemptId, entry.id))
        if (!claimed) continue
        notify(conversationId)
        active.set(conversationId, finish(claimed, verdict))
      } catch (error) {
        // This claim may have reached disk. Refuse another attempt in its conversation.
        blocked.add(conversationId)
        report(error)
      }
    }
  }

  async function run(): Promise<void> {
    while (wakeRequested && !stopped) {
      wakeRequested = false
      await scan().catch(report)
    }
  }

  function wake(): void {
    if (stopped) return
    wakeRequested = true
    if (scanPromise) return
    scanPromise = run().finally(() => {
      scanPromise = undefined
      if (wakeRequested) wake()
    })
  }

  return {
    wake,
    stop() {
      stopped = true
      wakeRequested = false
    },
    async drained() {
      // Call after stop. A scan may still be publishing its last claim.
      await scanPromise
      await Promise.all(active.values())
    }
  }
}
