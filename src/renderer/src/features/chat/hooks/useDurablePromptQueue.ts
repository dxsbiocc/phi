import { useCallback, useEffect, useState } from 'react'
import type { ChatQueueItem } from '../../../../../shared/chatQueueTypes'
import type { RendererApi } from '../../../types'

export type VisibleChatQueueItem = ChatQueueItem & {
  status: 'queued' | 'failed' | 'interrupted'
}

type QueueApi = Pick<
  RendererApi,
  'listQueuedPrompts' | 'cancelQueuedPrompt' | 'onQueuedPromptsChanged'
>

function visibleItem(item: ChatQueueItem): item is VisibleChatQueueItem {
  return item.status === 'queued' || item.status === 'failed' || item.status === 'interrupted'
}

export function useDurablePromptQueue(
  api: QueueApi,
  sessionId: string | null,
  onError: (error: unknown) => void
): {
  activeQueuedPrompts: VisibleChatQueueItem[]
  removeQueuedPrompt: (itemId: string) => void
} {
  const [snapshot, setSnapshot] = useState<{
    sessionId: string
    items: VisibleChatQueueItem[]
  } | null>(null)
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    if (!sessionId) return
    let previousRequest = 0
    let disposed = false
    const pull = (): void => {
      const request = ++previousRequest
      void api.listQueuedPrompts(sessionId).then(
        (items) => {
          if (disposed || request !== previousRequest) return
          const visible = items.filter(visibleItem)
          const queued = visible.filter((item) => item.status === 'queued')
          const failures = visible.filter((item) => item.status !== 'queued').slice(-5)
          setSnapshot({ sessionId, items: [...failures, ...queued] })
        },
        () => {
          // Preserve the last known same-session snapshot if a refresh failed.
        }
      )
    }
    const unsubscribe = api.onQueuedPromptsChanged((changed) => {
      if (changed === sessionId) pull()
    })
    pull()
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [api, refresh, sessionId])

  const removeQueuedPrompt = useCallback(
    (itemId: string): void => {
      if (!sessionId) return
      void api
        .cancelQueuedPrompt(sessionId, itemId)
        .catch(onError)
        .finally(() => setRefresh((value) => value + 1))
    },
    [api, onError, sessionId]
  )

  return {
    activeQueuedPrompts: snapshot && snapshot.sessionId === sessionId ? snapshot.items : [],
    removeQueuedPrompt
  }
}
