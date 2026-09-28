/**
 * The main agent's `todo` tool (see @oh-my-pi/pi-coding-agent's TodoTool)
 * snapshots the *whole* task list on every call, not a diff — so the most
 * recent one seen in the chat timeline is the full current state.
 */
export type TodoTaskStatus = 'pending' | 'in_progress' | 'completed' | 'abandoned' | 'blocked'

export interface TodoTaskSnapshot {
  content: string
  status: TodoTaskStatus
  /** Set when `status === 'blocked'`: what the task is waiting for. */
  blocker?: string
}

export interface TodoPhaseSnapshot {
  name: string
  tasks: TodoTaskSnapshot[]
}

export interface TodoSnapshot {
  /** The op that produced this snapshot (init/start/done/...), when known. */
  op?: string
  phases: TodoPhaseSnapshot[]
}
