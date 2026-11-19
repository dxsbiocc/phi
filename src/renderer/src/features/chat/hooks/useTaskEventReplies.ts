import { useCallback, useEffect, useState } from 'react'
import type { TaskEventNotice } from '../../../../../shared/taskEventTypes'
import type { RendererApi } from '../../../types'
import type { TaskEventReply } from '../components/TaskEventResults'
import { taskEventFeedback } from '../lib/taskEventCopy'

function removeApproval(reply: TaskEventReply | null, requestId?: string): TaskEventReply | null {
  if (reply?.notice.kind !== 'approval' || !reply.notice.requests.length) return reply
  if (!requestId) return null
  const requests = reply.notice.requests.filter((request) => request.id !== requestId)
  if (requests.length === reply.notice.requests.length) return reply
  return requests.length ? { ...reply, notice: { ...reply.notice, requests } } : null
}

export function useTaskEventReplies(
  api: Pick<RendererApi, 'routeTaskEvent' | 'onToolApprovalCancelled'>,
  onError: (error: unknown) => void,
  openJobs: (taskId?: string) => void,
  notify: (message: string, severity: 'info' | 'success' | 'warning') => void
): {
  reply: TaskEventReply | null
  show(notice: TaskEventNotice): void
  dismiss(key: string): void
  decide(key: string, taskId: string, approvalId: string, action: 'approve' | 'deny'): void
} {
  const [reply, setReply] = useState<TaskEventReply | null>(null)
  const dismiss = useCallback((key: string): void => {
    setReply((previous) => (previous?.key === key ? null : previous))
  }, [])

  useEffect(
    () =>
      api.onToolApprovalCancelled((requestId) => {
        setReply((previous) => removeApproval(previous, requestId))
      }),
    [api]
  )

  const show = useCallback(
    (notice: TaskEventNotice): void => {
      if (notice.kind === 'status' || notice.kind === 'list') {
        setReply(null)
        openJobs(notice.kind === 'status' ? notice.task.id : undefined)
      } else if (
        notice.kind === 'approval' ||
        (notice.kind === 'clarify' && notice.reason !== 'attachments')
      ) {
        setReply({ key: crypto.randomUUID(), notice })
        openJobs(notice.kind === 'approval' ? notice.task.id : undefined)
      } else {
        if (notice.kind === 'decided') {
          setReply((previous) => removeApproval(previous, notice.approvalId))
        }
        const feedback = taskEventFeedback(notice)
        if (feedback) notify(feedback.message, feedback.severity)
      }
    },
    [notify, openJobs]
  )

  const decide = useCallback(
    (key: string, taskId: string, approvalId: string, action: 'approve' | 'deny'): void => {
      void api
        .routeTaskEvent(`/task ${action} ${taskId} ${approvalId}`, null, crypto.randomUUID())
        .then((result) => {
          if (result.kind !== 'decided' && result.kind !== 'unavailable') return
          setReply((previous) =>
            previous?.key === key ? removeApproval(previous, approvalId) : previous
          )
          const feedback = taskEventFeedback(result)
          if (feedback) notify(feedback.message, feedback.severity)
        })
        .catch(onError)
    },
    [api, notify, onError]
  )
  return { reply, show, dismiss, decide }
}
