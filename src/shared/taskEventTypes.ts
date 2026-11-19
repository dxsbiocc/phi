import type { ChatQueueItem, ChatQueueReceipt } from './chatQueueTypes'

export type TaskControl = 'status' | 'cancel' | 'approve' | 'deny' | 'supplement'
export type TaskStatus = ChatQueueItem['status'] | 'needs_approval'

export interface TaskEventTask {
  id: string
  sessionId: string
  title?: string
  preview: string
  status: TaskStatus
  result?: string
  independent?: true
  supplementTo?: string
}

export interface TaskEventApproval {
  id: string
  tool: string
  summary: string
}

export type TaskEventNotice =
  | { kind: 'list'; tasks: TaskEventTask[]; more: boolean }
  | {
      kind: 'clarify'
      reason: 'syntax' | 'missing-target' | 'ambiguous' | 'not-found' | 'attachments'
      action?: TaskControl
      tasks?: TaskEventTask[]
      more?: boolean
    }
  | { kind: 'status' | 'cancelled' | 'stopping' | 'unavailable'; task: TaskEventTask }
  | {
      kind: 'approval'
      task: TaskEventTask
      action: 'approve' | 'deny'
      requests: TaskEventApproval[]
    }
  | { kind: 'decided'; task: TaskEventTask; action: 'approve' | 'deny'; approvalId: string }
  | { kind: 'supplemented'; task: TaskEventTask; id: string }

export type TaskEventResult = { kind: 'submitted'; receipt: ChatQueueReceipt } | TaskEventNotice
