export type BackgroundAgentJob = {
  agentSessionId: string
  agentRunId: string
  sessionId: string
  sessionPath: string
  sessionTitle: string
  agentName: string
  task: string
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'interrupted'
  /** False for restart metadata, which has no live SDK handle. */
  canControl?: boolean
  historyAvailable?: boolean
  background: boolean
  startedAt: string
  completedAt?: string
  lastStep?: string
  toolCalls?: number
  toolCallId?: string
}

/** A Bash command running in the background of a conversation. */
export type BackgroundShellJob = {
  agentSessionId: string
  jobId: string
  sessionId: string
  sessionPath: string
  sessionTitle: string
  command: string
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  startedAt: string
  completedAt?: string
  exitCode?: number
  output?: string
  outputPath?: string
  outputTruncated?: boolean
}

export type StartChatShellJobRequest = { sessionId: string; command: string }

export type ShellJobTimelineEvent =
  | { type: 'shell_job_started'; shellJob: BackgroundShellJob; shellJobLaunchId: string }
  | { type: 'shell_job_finished'; shellJob: BackgroundShellJob }

export type ShellJobFinishedEvent = Extract<ShellJobTimelineEvent, { type: 'shell_job_finished' }>
