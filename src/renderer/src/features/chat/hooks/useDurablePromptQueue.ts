import { useCallback, useMemo } from 'react'
import type { ChatQueueJob } from '../../../../../shared/chatQueueTypes'
import type { RendererApi } from '../../../types'
import {
  refreshBackgroundJobs,
  useChatQueueJobsForSession
} from '../../jobs/hooks/useBackgroundJobsData'
import { jobsCopy } from '../../jobs/lib/jobsCopy'

type ComposerJob = ChatQueueJob & { status: 'queued' | 'failed' | 'interrupted' }

export function useDurablePromptQueue(
  api: Pick<RendererApi, 'cancelQueuedPrompt'>,
  sessionId: string | null,
  onError: (error: unknown) => void
): {
  activeQueuedPrompts: ComposerJob[]
  removeQueuedPrompt: (itemId: string) => void
} {
  const items = useChatQueueJobsForSession(sessionId)
  const activeQueuedPrompts = useMemo(() => {
    const visible = items.filter(
      (item): item is ComposerJob =>
        item.status === 'queued' || item.status === 'failed' || item.status === 'interrupted'
    )
    const queued = visible.filter((item) => item.status === 'queued')
    const failures = visible.filter((item) => item.status !== 'queued').slice(-5)
    return [...failures, ...queued]
  }, [items])

  const removeQueuedPrompt = useCallback(
    (itemId: string): void => {
      if (!sessionId) return
      void api
        .cancelQueuedPrompt(sessionId, itemId)
        .then((cancelled) => {
          if (!cancelled) throw new Error(jobsCopy.unableToCancelQueuedMessage)
        })
        .catch(onError)
        .finally(() => {
          void refreshBackgroundJobs()
        })
    },
    [api, onError, sessionId]
  )

  return {
    activeQueuedPrompts,
    removeQueuedPrompt
  }
}
