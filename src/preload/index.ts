import { contextBridge, ipcRenderer } from 'electron'

type AgentEventSummary = Record<string, unknown>
type Unsubscribe = () => void

type AuthStatusItem = {
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

type AuthPrompt = {
  type: 'text' | 'secret' | 'select' | 'manual_code'
  message: string
  placeholder?: string
  options?: ReadonlyArray<{ id: string; label: string; description?: string }>
}

type AuthEvent =
  | {
      type: 'info'
      message: string
      links?: ReadonlyArray<{ url: string; label?: string }>
    }
  | {
      type: 'auth_url'
      url: string
      instructions?: string
    }
  | {
      type: 'device_code'
      userCode: string
      verificationUri: string
      intervalSeconds?: number
      expiresInSeconds?: number
    }
  | {
      type: 'progress'
      message: string
    }

type AuthInteractionPromptEvent = {
  type: 'prompt'
  requestId: string
  providerId: string
  prompt: AuthPrompt
}

type AuthInteractionNotifyEvent = {
  type: 'notify'
  providerId: string
  event: AuthEvent
}

type AuthInteractionEvent = AuthInteractionPromptEvent | AuthInteractionNotifyEvent

type ModelOption = {
  providerId: string
  modelId: string
  name: string
  thinkingLevels: ThinkingLevel[]
}

type SelectedModel = {
  providerId: string
  modelId: string
} | null

type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

type RendererAuthApi = {
  sendPrompt: (text: string) => Promise<void>
  onAgentEvent: (cb: (event: AgentEventSummary) => void) => Unsubscribe
  getAuthStatus: () => Promise<AuthStatusItem[]>
  loginApiKey: (providerId: string, key: string) => Promise<AuthStatusItem[]>
  loginOAuth: (providerId: string) => Promise<AuthStatusItem[]>
  logout: (providerId: string) => Promise<void>
  submitAuthInteraction: (requestId: string, value: string) => Promise<void>
  onAuthInteraction: (cb: (event: AuthInteractionEvent) => void) => Unsubscribe
  listModels: () => Promise<ModelOption[]>
  selectModel: (providerId: string, modelId: string) => Promise<void>
  getSelectedModel: () => Promise<SelectedModel>
  selectThinkingLevel: (level: ThinkingLevel) => Promise<void>
  getThinkingLevel: () => Promise<ThinkingLevel>
}

const api: RendererAuthApi = {
  sendPrompt: (text: string): Promise<void> => ipcRenderer.invoke('agent:prompt', text),
  onAgentEvent: (cb: (event: AgentEventSummary) => void): Unsubscribe => {
    const handler = (_: unknown, event: AgentEventSummary): void => {
      cb(event)
    }

    ipcRenderer.on('agent:event', handler)

    return () => {
      ipcRenderer.removeListener('agent:event', handler)
    }
  },
  getAuthStatus: (): Promise<AuthStatusItem[]> => ipcRenderer.invoke('auth:status'),
  loginApiKey: (providerId: string, key: string): Promise<AuthStatusItem[]> =>
    ipcRenderer.invoke('auth:loginApiKey', providerId, key),
  loginOAuth: (providerId: string): Promise<AuthStatusItem[]> =>
    ipcRenderer.invoke('auth:loginOAuth', providerId),
  logout: (providerId: string): Promise<void> => ipcRenderer.invoke('auth:logout', providerId),
  submitAuthInteraction: (requestId: string, value: string): Promise<void> =>
    ipcRenderer.invoke('auth:interaction-response', requestId, value),
  onAuthInteraction: (cb: (event: AuthInteractionEvent) => void): Unsubscribe => {
    const handler = (_: unknown, event: AuthInteractionEvent): void => {
      cb(event)
    }

    ipcRenderer.on('auth:interaction', handler)

    return () => {
      ipcRenderer.removeListener('auth:interaction', handler)
    }
  },
  listModels: (): Promise<ModelOption[]> => ipcRenderer.invoke('models:list'),
  selectModel: (providerId: string, modelId: string): Promise<void> =>
    ipcRenderer.invoke('models:select', providerId, modelId),
  getSelectedModel: (): Promise<SelectedModel> => ipcRenderer.invoke('models:selected'),
  selectThinkingLevel: (level: ThinkingLevel): Promise<void> =>
    ipcRenderer.invoke('thinking:select', level),
  getThinkingLevel: (): Promise<ThinkingLevel> => ipcRenderer.invoke('thinking:selected')
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api
}
