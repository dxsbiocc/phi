import type { AssistantInbox, AssistantInboxEntry, AssistantInboxScope } from './assistant-inbox'
import {
  createAssistantInboxDispatch,
  type AssistantInboxDispatch
} from './assistant-inbox-dispatch'
import type { IndependentTaskChannel, IndependentTaskStoreOps } from './independent-tasks'

export function independentTaskStoreOps(
  store: AssistantInbox,
  scope: AssistantInboxScope
): IndependentTaskStoreOps {
  return {
    read: async (id) => (await store.list(scope)).find((entry) => entry.id === id),
    bindChild: (id, attemptId, childRunId) => store.bindChild(scope, id, attemptId, childRunId),
    requestCancel: (id, attemptId) => store.requestCancel(scope, id, attemptId)
  }
}

interface IndependentDispatchOptions {
  store: AssistantInbox
  channel: IndependentTaskChannel
  capacity(): number
  queued(): Promise<readonly AssistantInboxEntry[]>
  initialEntries: readonly AssistantInboxEntry[]
  paused(sessionId: string): boolean
  changed(sessionId: string): void
  log(error: unknown): void
}

export function createIndependentInboxDispatch(
  options: IndependentDispatchOptions
): AssistantInboxDispatch {
  const { store, channel } = options
  const shutdown = new AbortController()
  const claimed = new Set<string>()
  const recovered = new Set(
    options.initialEntries
      .filter((entry) => entry.independent && entry.status === 'running')
      .map((entry) => entry.id)
  )
  let recovery: Promise<void> | undefined

  const dispatch = createAssistantInboxDispatch({
    inbox: {
      queued: async () => (await options.queued()).filter((entry) => entry.independent),
      claim: async (scope, attemptId, id) => {
        const entry = await store.claimIndependent(scope, attemptId, id)
        if (entry) claimed.add(entry.id)
        return entry
      },
      settle: async (scope, id, attemptId, result, resultText) => {
        try {
          return await store.settle(scope, id, attemptId, result, resultText)
        } finally {
          claimed.delete(id)
        }
      }
    },
    async prepare(entry) {
      if (options.paused(entry.scope.conversationId)) return 'wait'
      const { entries } = await store.snapshot()
      const running = entries.filter(
        (candidate) => candidate.independent && candidate.status === 'running'
      )
      if (running.length >= options.capacity()) return 'wait'
      return channel.prepare(
        entry,
        running.filter((item) => item.scope.conversationId === entry.scope.conversationId).length
      )
    },
    capacity: options.capacity,
    async execute(entry) {
      let outcome: Awaited<ReturnType<IndependentTaskChannel['execute']>>
      try {
        outcome = await channel.execute(
          entry,
          independentTaskStoreOps(store, entry.scope),
          shutdown.signal
        )
        return outcome
      } catch (error) {
        options.log(error)
        return undefined
      } finally {
        if (!outcome) claimed.delete(entry.id)
      }
    },
    laneKey: (entry) => entry.id,
    changed: options.changed,
    log: options.log
  })

  return {
    wake() {
      if (shutdown.signal.aborted) return
      dispatch.wake()
      recovery ??= reconcile(options, shutdown.signal, claimed, recovered, dispatch.wake)
        .catch(options.log)
        .finally(() => {
          recovery = undefined
        })
    },
    stop() {
      shutdown.abort()
      dispatch.stop()
    },
    async drained() {
      await Promise.all([recovery, dispatch.drained()])
    }
  }
}

async function reconcile(
  options: IndependentDispatchOptions,
  signal: AbortSignal,
  claimed: ReadonlySet<string>,
  recovered: Set<string>,
  wake: () => void
): Promise<void> {
  for (const entry of (await options.store.snapshot()).entries) {
    if (signal.aborted) return
    if (
      !entry.independent ||
      entry.status !== 'running' ||
      !entry.attemptId ||
      claimed.has(entry.id)
    )
      continue
    try {
      const verdict = await options.channel.reconcile(
        entry,
        independentTaskStoreOps(options.store, entry.scope),
        recovered.has(entry.id)
      )
      if (
        verdict &&
        (await options.store.settle(
          entry.scope,
          entry.id,
          entry.attemptId,
          verdict.status,
          verdict.result
        ))
      ) {
        recovered.delete(entry.id)
        options.changed(entry.scope.conversationId)
        wake()
      }
    } catch (error) {
      options.log(error)
    }
  }
}
