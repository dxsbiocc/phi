declare global {
  interface Window {
    api: {
      sendPrompt: (text: string) => Promise<void>
      onAgentEvent: (cb: (event: Record<string, unknown>) => void) => () => void
      getAuthStatus: () => Promise<
        Array<{
          providerId: string
          name: string
          configured: boolean
          source?:
            | 'stored'
            | 'runtime'
            | 'environment'
            | 'fallback'
            | 'models_json_key'
            | 'models_json_command'
          label?: string
          hasApiKey: boolean
          hasOAuth: boolean
          hasConfigError: boolean
          statusText: string
        }>
      >
      loginApiKey: (
        providerId: string,
        key: string
      ) => Promise<
        Array<{
          providerId: string
          name: string
          configured: boolean
          source?:
            | 'stored'
            | 'runtime'
            | 'environment'
            | 'fallback'
            | 'models_json_key'
            | 'models_json_command'
          label?: string
          hasApiKey: boolean
          hasOAuth: boolean
          hasConfigError: boolean
          statusText: string
        }>
      >
      loginOAuth: (providerId: string) => Promise<
        Array<{
          providerId: string
          name: string
          configured: boolean
          source?:
            | 'stored'
            | 'runtime'
            | 'environment'
            | 'fallback'
            | 'models_json_key'
            | 'models_json_command'
          label?: string
          hasApiKey: boolean
          hasOAuth: boolean
          hasConfigError: boolean
          statusText: string
        }>
      >
      logout: (providerId: string) => Promise<void>
      submitAuthInteraction: (requestId: string, value: string) => Promise<void>
      onAuthInteraction: (
        cb: (
          event:
            | {
                type: 'prompt'
                requestId: string
                providerId: string
                prompt: {
                  type: 'text' | 'secret' | 'select' | 'manual_code'
                  message: string
                  placeholder?: string
                  options?: ReadonlyArray<{ id: string; label: string; description?: string }>
                }
              }
            | {
                type: 'notify'
                providerId: string
                event:
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
              }
        ) => void
      ) => () => void
      listModels: () => Promise<Array<{ providerId: string; modelId: string; name: string }>>
      selectModel: (providerId: string, modelId: string) => Promise<void>
      getSelectedModel: () => Promise<{ providerId: string; modelId: string } | null>
      selectThinkingLevel: (
        level: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
      ) => Promise<void>
      getThinkingLevel: () => Promise<'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>
    }
  }
}

export {}
