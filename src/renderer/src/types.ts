export type MessageRole = 'user' | 'assistant' | 'error' | 'thinking'

export type Role = MessageRole

export interface ChatMessage {
  id: string
  role: Role
  content: string
}

export interface ToolCallItem {
  id: string
  role: 'tool'
  toolName: string
  argsPreview: string
  argsJson: string
  output: string
  status: 'running' | 'done' | 'error'
}

export type ChatItem = ChatMessage | ToolCallItem

export interface ProviderAuthStatus {
  providerId: string
  name: string
  configured: boolean
  source?:
    'stored' | 'runtime' | 'environment' | 'fallback' | 'models_json_key' | 'models_json_command'
  label?: string
  hasApiKey: boolean
  hasOAuth: boolean
  hasConfigError: boolean
  statusText: string
}

export type AuthPromptType = 'text' | 'secret' | 'select' | 'manual_code'

export interface AuthPrompt {
  type: AuthPromptType
  message: string
  placeholder?: string
  options?: ReadonlyArray<{ id: string; label: string; description?: string }>
}

export interface AuthPromptInteraction {
  requestId: string
  providerId: string
  prompt: AuthPrompt
  value: string
}

export type ActiveAuthPrompt = AuthPromptInteraction

export interface ModelOption {
  providerId: string
  modelId: string
  name: string
}

export interface AuthProgressEvent {
  type: 'info' | 'auth_url' | 'device_code' | 'progress'
  message?: string
  url?: string
  userCode?: string
  verificationUri?: string
  intervalSeconds?: number
  expiresInSeconds?: number
}

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type RendererApi = {
  sendPrompt: (text: string) => Promise<void>
  onAgentEvent: (cb: (event: AgentEventSummary) => void) => () => void
  getAuthStatus: () => Promise<ProviderAuthStatus[]>
  loginApiKey: (providerId: string, key: string) => Promise<ProviderAuthStatus[]>
  loginOAuth: (providerId: string) => Promise<ProviderAuthStatus[]>
  logout: (providerId: string) => Promise<void>
  submitAuthInteraction: (requestId: string, value: string) => Promise<void>
  onAuthInteraction: (cb: (event: AuthInteractionEvent) => void) => () => void
  listModels: () => Promise<ModelOption[]>
  selectModel: (providerId: string, modelId: string) => Promise<void>
  getSelectedModel: () => Promise<{ providerId: string; modelId: string } | null>
  selectThinkingLevel: (level: ThinkingLevel) => Promise<void>
  getThinkingLevel: () => Promise<ThinkingLevel>
}

export interface AgentMessage {
  role?: string
  stopReason?: string
  errorMessage?: string
  content?: Array<{ type?: string; text?: string }>
}

export interface AgentEventSummary {
  type: string
  message?: AgentMessage
  assistantMessageEvent?: {
    type?: string
    delta?: string
    contentIndex?: number
  }
  toolCallId?: string
  toolName?: string
  args?: unknown
  partialResult?: unknown
  result?: unknown
  isError?: boolean
}

export type AuthEvent =
  | {
      type: 'info'
      message: string
      links?: ReadonlyArray<{ url: string; label?: string }>
    }
  | { type: 'auth_url'; url: string; instructions?: string }
  | {
      type: 'device_code'
      userCode: string
      verificationUri: string
      intervalSeconds?: number
      expiresInSeconds?: number
    }
  | { type: 'progress'; message: string }

export type AuthInteractionEvent =
  | {
      type: 'prompt'
      requestId: string
      providerId: string
      prompt: AuthPrompt
    }
  | {
      type: 'notify'
      providerId: string
      event: AuthEvent
    }
