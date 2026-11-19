import { z } from 'zod'
import type {
  TaskControl,
  TaskEventNotice,
  TaskEventResult,
  TaskEventTask
} from '../../shared/taskEventTypes'
import type { ToolApprovalRequest } from '../agent/tool-approval'
import type { AssistantInboxEntry } from './assistant-inbox'
import { chatQueuePreview, type ChatQueueJobOwner } from './chat-queue-jobs'
import type { DurableChat } from './durable-chat'
import { parseTaskEvent, resolveTaskTargets } from './task-event-router'

const MAX_TASKS_IN_REPLY = 16
const requestIdSchema = z.uuidv4()

interface TaskEventSender {
  responder: unknown
  authorize(): void
}

interface RouteOptions<TRun> {
  queue: Pick<DurableChat, 'submit' | 'supplement' | 'taskEntries' | 'cancel'>
  owner(sessionId: string): ChatQueueJobOwner | null
  activeRun(entry: AssistantInboxEntry): TRun | undefined
  stop(run: TRun): Promise<void>
  approvals(
    sessionId: string,
    runId: string,
    responder: unknown
  ): readonly Readonly<ToolApprovalRequest>[]
  respond(id: string, approved: boolean, responder: unknown): boolean
}

export interface TaskEventService {
  route(
    text: unknown,
    target: unknown,
    requestId: unknown,
    sender: TaskEventSender
  ): Promise<TaskEventResult>
}

interface OwnedTask {
  id: string
  owner: ChatQueueJobOwner
  entry: AssistantInboxEntry
}

function approvalRequests<TRun>(
  options: RouteOptions<TRun>,
  entry: AssistantInboxEntry,
  sender: TaskEventSender
): readonly Readonly<ToolApprovalRequest>[] {
  if (entry.status !== 'running' || !entry.attemptId || !options.activeRun(entry)) return []
  return options.approvals(entry.scope.conversationId, entry.attemptId, sender.responder)
}

function taskDetails<TRun>(
  options: RouteOptions<TRun>,
  { entry, owner }: OwnedTask,
  sender: TaskEventSender
): TaskEventTask {
  const title = owner.title ? chatQueuePreview(owner.title) : undefined
  return {
    id: entry.id,
    sessionId: entry.scope.conversationId,
    ...(title ? { title } : {}),
    preview: chatQueuePreview(entry.text),
    status: approvalRequests(options, entry, sender).length ? 'needs_approval' : entry.status,
    ...(entry.supplementTo ? { supplementTo: entry.supplementTo } : {})
  }
}

function replyTasks<TRun>(
  options: RouteOptions<TRun>,
  tasks: OwnedTask[],
  sender: TaskEventSender
): { tasks: TaskEventTask[]; more: boolean } {
  return {
    tasks: tasks.slice(0, MAX_TASKS_IN_REPLY).map((task) => taskDetails(options, task, sender)),
    more: tasks.length > MAX_TASKS_IN_REPLY
  }
}

function readImages(target: unknown): unknown {
  return target && typeof target === 'object' && 'images' in target ? target.images : undefined
}

function clarification(
  reason: Extract<TaskEventNotice, { kind: 'clarify' }>['reason'],
  action?: TaskControl
): TaskEventNotice {
  return { kind: 'clarify', reason, ...(action ? { action } : {}) }
}

export function createTaskEventService<TRun>(options: RouteOptions<TRun>): TaskEventService {
  async function readTasks(): Promise<OwnedTask[]> {
    const entries = await options.queue.taskEntries()
    const owners = new Map<string, ChatQueueJobOwner | null>()
    const tasks: OwnedTask[] = []
    for (const entry of entries) {
      const sessionId = entry.scope.conversationId
      if (!owners.has(sessionId)) owners.set(sessionId, options.owner(sessionId))
      const owner = owners.get(sessionId)
      if (owner && owner.projectId === entry.scope.projectId)
        tasks.push({ id: entry.id, owner, entry })
    }
    return tasks.reverse()
  }

  async function cancel(entry: AssistantInboxEntry, task: TaskEventTask): Promise<TaskEventNotice> {
    if (
      entry.status === 'queued' &&
      (await options.queue.cancel(entry.scope.conversationId, entry.id))
    ) {
      return { kind: 'cancelled', task: { ...task, status: 'cancelled' } }
    }
    const active = entry.status === 'running' && entry.attemptId && options.activeRun(entry)
    if (!active) return { kind: 'unavailable', task }
    await options.stop(active)
    return { kind: 'stopping', task }
  }

  return {
    async route(input, target, request, sender) {
      const id = requestIdSchema.parse(request)
      if (typeof input !== 'string' || Buffer.byteLength(input) > 64 * 1024) {
        throw new Error('Invalid task message.')
      }
      const intent = parseTaskEvent(input)
      if (intent.kind === 'new-task') {
        return { kind: 'submitted', receipt: await options.queue.submit(input, target, id) }
      }
      if (intent.kind === 'clarify') return clarification('syntax')
      const images = readImages(target)
      if (
        intent.kind !== 'supplement' &&
        images !== undefined &&
        (!Array.isArray(images) || images.length)
      ) {
        return clarification('attachments')
      }

      const tasks = await readTasks()
      sender.authorize()
      if (intent.kind === 'list') {
        const active = tasks.filter(
          ({ entry }) => entry.status === 'queued' || entry.status === 'running'
        )
        const recent = tasks.filter(
          ({ entry }) => entry.status !== 'queued' && entry.status !== 'running'
        )
        return { kind: 'list', ...replyTasks(options, [...active, ...recent], sender) }
      }
      if (!intent.target) {
        // Candidate suggestions never choose the target on the user's behalf.
        const candidates = tasks.filter(({ entry }) => {
          if (intent.kind === 'approve' || intent.kind === 'deny')
            return approvalRequests(options, entry, sender).length > 0
          if (intent.kind === 'status') return true
          if (intent.kind === 'supplement' && entry.status === 'succeeded') return true
          return entry.status === 'queued' || entry.status === 'running'
        })
        return {
          kind: 'clarify',
          action: intent.kind,
          reason: 'missing-target',
          ...replyTasks(options, candidates, sender)
        }
      }

      const matches = resolveTaskTargets(tasks, intent.target)
      if (matches.length === 0) return clarification('not-found', intent.kind)
      if (matches.length > 1) {
        return {
          kind: 'clarify',
          action: intent.kind,
          reason: 'ambiguous',
          ...replyTasks(options, matches, sender)
        }
      }
      const [match] = matches
      const { entry } = match
      const task = taskDetails(options, match, sender)
      if (intent.kind === 'status') return { kind: 'status', task }
      if (intent.kind === 'cancel') return cancel(entry, task)
      if (intent.kind === 'supplement') {
        const receipt = await options.queue.supplement(
          entry,
          intent.text,
          images,
          id,
          sender.authorize
        )
        return receipt
          ? { kind: 'supplemented', task, id: receipt.id }
          : { kind: 'unavailable', task }
      }

      const requests = approvalRequests(options, entry, sender)
      if (!intent.approvalId) {
        return {
          kind: 'approval',
          task,
          action: intent.kind,
          requests: requests.map(({ requestId, toolName, summary }) => ({
            id: requestId,
            tool: toolName,
            summary
          }))
        }
      }
      const exact = requests.find((request) => request.requestId === intent.approvalId)
      if (
        !exact ||
        !options.respond(exact.requestId, intent.kind === 'approve', sender.responder)
      ) {
        return { kind: 'unavailable', task }
      }
      return { kind: 'decided', task, action: intent.kind, approvalId: exact.requestId }
    }
  }
}
