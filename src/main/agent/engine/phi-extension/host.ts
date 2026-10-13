export interface PhiExtensionFallbackConfig {
  afterFailures: number
  tools: string[]
  match: string[]
}

export interface PhiExtensionAgentConfig {
  name: string
  delegationMode?: 'required-first' | 'preferred' | 'optional'
  fallback?: PhiExtensionFallbackConfig
}

export interface PhiExtensionEnvironmentBinding {
  ref: string
  variables: Record<string, string>
  pluginId?: string
}

/** Plain per-session data that can be uploaded with the extension package. */
export interface PhiExtensionConfig {
  cwd: string
  projectBound: boolean
  remote: boolean
  enableToolApproval: boolean
  sessionId: string
  agentRunId?: string
  useBrowserTextVault: boolean
  environmentBinding?: PhiExtensionEnvironmentBinding
  phiAgents: PhiExtensionAgentConfig[]
}

export interface PhiExtensionToolApprovalRequest {
  sessionId: string
  agentRunId?: string
  toolCallId: string
  toolName: string
  input: unknown
}

export interface PhiExtensionFallbackReadiness {
  allowed: boolean
  failures: number
  reason?: string
}

export interface PhiRemoteMcpGuardState {
  allowedToolNames: ReadonlySet<string>
  blockedServerReasons: ReadonlyMap<string, string>
  agentDir: string
  localProjectAnchor: string
}

/** Live Phi-side state used by otherwise self-contained extension factories. */
export interface PhiExtensionHost {
  nextActionSuggestionsEnabled(): Promise<boolean>
  planModeActive(): boolean
  requestToolApproval(request: PhiExtensionToolApprovalRequest): Promise<unknown>
  browserApprovalInput(toolCallId: string, input: unknown): unknown
  markBrowserTextDenied(toolCallId: string): void
  fallbackReadiness(agent: string, afterFailures: number): PhiExtensionFallbackReadiness
  remoteSkillToolNames(): ReadonlySet<string>
  remoteAgentToolDescriptions(): ReadonlyMap<string, string>
  remoteMcpToolState(): PhiRemoteMcpGuardState | undefined
  environmentBinding(): PhiExtensionEnvironmentBinding | undefined
  hostEnvironment(): Readonly<Record<string, string | undefined>>
}
