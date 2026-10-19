import { useCallback, useMemo, useState } from 'react'

import type { PromptTarget } from '../../../lib/sessionTypes'
import {
  appendQueuedPrompt,
  dropQueuedPrompt,
  retargetQueuedPrompts,
  shiftQueuedPrompt,
  type QueuedPrompt,
  type QueuedPromptsBySession,
  type SendPromptOptions
} from '../lib/promptQueue'

/**
 * Prompts waiting behind a run, owned per draft key.
 *
 * A prompt typed while the session is busy is not dropped: it is parked under the
 * draft key it was typed in and replayed when the session goes idle. The rules
 * live in `lib/promptQueue`; this hook only holds the state and binds it to the
 * visible draft.
 *
 * The caller drains the queue, because draining means sending and the send
 * pipeline is still the shell's.
 */
export type PromptQueue = {
  activeQueuedPrompts: QueuedPrompt[]
  queuePromptText: (text: string, target: PromptTarget, sendOptions?: SendPromptOptions) => void
  removeQueuedPrompt: (id: string) => void
  /** Removes the head prompt only if it is still `id`; the drain races the session. */
  dequeueQueuedPrompt: (id: string) => void
  moveQueuedPromptsToSession: (targetKey: string, target: PromptTarget) => void
}

export function usePromptQueue(
  activeDraftKey: string,
  setActiveInput: (value: string) => void
): PromptQueue {
  const [queuedPromptsBySession, setQueuedPromptsBySession] = useState<QueuedPromptsBySession>({})

  const activeQueuedPrompts = useMemo(
    () => queuedPromptsBySession[activeDraftKey] ?? [],
    [activeDraftKey, queuedPromptsBySession]
  )

  const removeQueuedPrompt = useCallback(
    (id: string): void => {
      setQueuedPromptsBySession((queue) => dropQueuedPrompt(queue, activeDraftKey, id))
    },
    [activeDraftKey]
  )

  const dequeueQueuedPrompt = useCallback(
    (id: string): void => {
      setQueuedPromptsBySession((queue) => shiftQueuedPrompt(queue, activeDraftKey, id))
    },
    [activeDraftKey]
  )

  const queuePromptText = useCallback(
    (text: string, target: PromptTarget, sendOptions?: SendPromptOptions): void => {
      setQueuedPromptsBySession((queue) =>
        appendQueuedPrompt(queue, activeDraftKey, {
          id: `queued-${Date.now()}-${(queue[activeDraftKey] ?? []).length}`,
          text,
          target,
          sendOptions
        })
      )
      setActiveInput('')
    },
    [activeDraftKey, setActiveInput]
  )

  const moveQueuedPromptsToSession = useCallback(
    (targetKey: string, target: PromptTarget): void => {
      setQueuedPromptsBySession((queue) =>
        retargetQueuedPrompts(queue, activeDraftKey, targetKey, target)
      )
    },
    [activeDraftKey]
  )

  return {
    activeQueuedPrompts,
    queuePromptText,
    removeQueuedPrompt,
    dequeueQueuedPrompt,
    moveQueuedPromptsToSession
  }
}
