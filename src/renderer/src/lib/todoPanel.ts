import type { ChatItem } from '../types'
import { isTodoToolName } from './chatItems'
import type { TodoPhaseSnapshot, TodoSnapshot, TodoTaskSnapshot } from './todoTypes'

/**
 * The `todo` tool snapshots the *whole* task list on every call (see
 * TodoToolDetails in @oh-my-pi/pi-coding-agent), not a diff, so the most
 * recent completed `todo` call in the timeline already is the full current
 * state. No need to replay every op from the first call.
 */
export function latestTodoSnapshot(items: readonly ChatItem[]): TodoSnapshot | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.role === 'tool' && isTodoToolName(item.toolName) && item.todo) {
      return item.todo
    }
  }
  return undefined
}

const CLOSED_TODO_STATUSES = new Set<TodoTaskSnapshot['status']>(['completed', 'abandoned'])

/** A settled task: done or deliberately dropped. Neither needs attention any more. */
export function isClosedTodoTask(task: TodoTaskSnapshot): boolean {
  return CLOSED_TODO_STATUSES.has(task.status)
}

export function flattenTodoTasks(phases: readonly TodoPhaseSnapshot[]): TodoTaskSnapshot[] {
  return phases.flatMap((phase) => phase.tasks)
}

/** The task the panel should highlight: the one in progress, else the next pending one. */
export function nextActionableTodoTask(
  phases: readonly TodoPhaseSnapshot[]
): TodoTaskSnapshot | undefined {
  const tasks = flattenTodoTasks(phases)
  return (
    tasks.find((task) => task.status === 'in_progress') ??
    tasks.find((task) => task.status === 'pending')
  )
}

export interface TodoProgress {
  total: number
  completed: number
  currentTask?: TodoTaskSnapshot
}

export function todoProgress(snapshot: TodoSnapshot): TodoProgress {
  const tasks = flattenTodoTasks(snapshot.phases)
  const completed = tasks.filter(isClosedTodoTask).length
  const currentTask = nextActionableTodoTask(snapshot.phases)
  return { total: tasks.length, completed, ...(currentTask ? { currentTask } : {}) }
}

const TODO_STATUS_LABELS: Record<TodoTaskSnapshot['status'], string> = {
  pending: '待办',
  in_progress: '进行中',
  completed: '已完成',
  abandoned: '已放弃',
  blocked: '已阻塞'
}

export function todoStatusLabel(status: TodoTaskSnapshot['status']): string {
  return TODO_STATUS_LABELS[status]
}
