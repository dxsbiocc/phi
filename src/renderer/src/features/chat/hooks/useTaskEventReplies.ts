import { useCallback, useEffect, useState } from 'react'
import type { TaskEventNotice } from '../../../../../shared/taskEventTypes'
import type { RendererApi } from '../../../types'
import type { TaskEventReply } from '../components/TaskEventResults'

export function useTaskEventReplies(
  api: Pick<RendererApi, 'routeTaskEvent' | 'onToolApprovalCancelled'>,
  onError: (error: unknown) => void
): {
  replies: readonly TaskEventReply[]
  show(notice: TaskEventNotice): void
  dismiss(key: string): void
  decide(key: string, taskId: string, approvalId: string, action: 'approve' | 'deny'): void
} {
  const [replies, setReplies] = useState<TaskEventReply[]>([])
  const dismiss = useCallback((key: string): void => {
    setReplies((previous) => previous.filter((reply) => reply.key !== key))
  }, [])
  useEffect(
    () =>
      api.onToolApprovalCancelled((requestId) => {
        setReplies((previous) =>
          previous.flatMap((reply) => {
            if (reply.notice.kind !== 'approval' || !reply.notice.requests.length) return [reply]
            if (!requestId) return []
            const requests = reply.notice.requests.filter((request) => request.id !== requestId)
            if (requests.length === reply.notice.requests.length) return [reply]
            return requests.length ? [{ ...reply, notice: { ...reply.notice, requests } }] : []
          })
        )
      }),
    [api]
  )
  const show = useCallback((notice: TaskEventNotice): void => {
    const key = crypto.randomUUID()
    setReplies((previous) => [{ key, notice }, ...previous].slice(0, 5))
  }, [])
  const decide = useCallback(
    (key: string, taskId: string, approvalId: string, action: 'approve' | 'deny'): void => {
      void api
        .routeTaskEvent(`/task ${action} ${taskId} ${approvalId}`, null, crypto.randomUUID())
        .then((result) => {
          if (result.kind === 'unavailable') dismiss(key)
          if (result.kind !== 'submitted') show(result)
        })
        .catch(onError)
    },
    [api, dismiss, onError, show]
  )
  return { replies, show, dismiss, decide }
}
