export interface AgentExecutionStep {
  id: string
  toolName: string
  argsPreview: string
  argsJson: string
  output: string
  status: 'running' | 'done' | 'error'
  createdAt?: string
  completedAt?: string
  durationMs?: number
  outputPath?: string
  outputBytes?: number
  outputTruncated?: boolean
  outputArtifact?: {
    kind: 'tool_output'
    path: string
    bytes: number
  }
  error?: string
}

export interface AgentExecutionSteer {
  text: string
  createdAt?: string
}

export interface AgentExecutionItem {
  id: string
  role: 'agent_execution'
  runId?: string
  /** The agent run this card shows, and the agent session that owns it: what steer/stop address. */
  agentRunId?: string
  agentSessionId?: string
  /** Started with `background: true`: it carries on after the chat run that started it is over. */
  background?: boolean
  /** Somebody stopped it: it did not fail, so it is not an error. */
  cancelled?: boolean
  /** What the user told the agent while it ran, oldest first. */
  steers?: AgentExecutionSteer[]
  agentName: string
  task: string
  argsPreview: string
  argsJson: string
  status: 'running' | 'done' | 'error'
  steps: AgentExecutionStep[]
  createdAt?: string
  completedAt?: string
  durationMs?: number
  finalReport?: string
  finalReportPath?: string
  finalReportBytes?: number
  finalReportTruncated?: boolean
  finalReportArtifact?: {
    kind: 'tool_output'
    path: string
    bytes: number
  }
  toolCalls?: number
  error?: string
}
