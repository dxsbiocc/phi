import { useEffect } from 'react'

import { getPromptReadiness } from '../../../lib/promptReadiness'
import type { PromptTarget } from '../../../lib/sessionTypes'
import type { ModelOption, ProviderAuthStatus } from '../../../types'
import type { QueuedPrompt, SendPromptOptions } from '../lib/promptQueue'

/**
 * Drains the prompt backlog when the session goes idle.
 *
 * Draining means sending, so this lives beside the send pipeline. The guards are
 * the subject: a paused runtime, a changing session, a compaction, or an in-flight
 * send must all keep the queue parked. The dequeue happens inside the microtask
 * and is keyed by the prompt id, so a queue that changed between the decision and
 * the dispatch cannot lose someone else's prompt.
 */
export type QueuedPromptDrainInput = {
  queue: {
    activeQueuedPrompts: QueuedPrompt[]
    dequeueQueuedPrompt: (id: string) => void
  }
  session: {
    currentSessionIsBusy: boolean
    currentSessionIsCompacting: boolean
    queuedPromptsPaused: boolean
    isSessionChanging: boolean
    isBusy: boolean
  }
  readiness: {
    modelStateReady: boolean
    providers: ProviderAuthStatus[]
    availableModels: ModelOption[]
  }
  isSendingRef: { current: boolean }
  sendPromptText: (
    text: string,
    target: PromptTarget,
    options?: SendPromptOptions
  ) => Promise<boolean>
}

export function useQueuedPromptDrain(input: QueuedPromptDrainInput): void {
  const { activeQueuedPrompts, dequeueQueuedPrompt } = input.queue
  const {
    currentSessionIsBusy,
    currentSessionIsCompacting,
    queuedPromptsPaused,
    isSessionChanging,
    isBusy
  } = input.session
  const { modelStateReady, providers, availableModels } = input.readiness
  const { isSendingRef, sendPromptText } = input

  useEffect(() => {
    if (
      currentSessionIsBusy ||
      queuedPromptsPaused ||
      currentSessionIsCompacting ||
      isSessionChanging ||
      isBusy ||
      isSendingRef.current
    ) {
      return
    }
    const nextPrompt = activeQueuedPrompts[0]
    if (!nextPrompt) return
    const readiness = getPromptReadiness({
      modelStateReady,
      providers,
      availableModels
    })
    if (!readiness.ready) return

    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      dequeueQueuedPrompt(nextPrompt.id)
      void sendPromptText(nextPrompt.text, nextPrompt.target, nextPrompt.sendOptions)
    })
    return () => {
      cancelled = true
    }
  }, [
    activeQueuedPrompts,
    availableModels,
    currentSessionIsBusy,
    currentSessionIsCompacting,
    dequeueQueuedPrompt,
    isBusy,
    isSendingRef,
    isSessionChanging,
    modelStateReady,
    providers,
    queuedPromptsPaused,
    sendPromptText
  ])
}
