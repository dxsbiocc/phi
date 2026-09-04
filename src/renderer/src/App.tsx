import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'

type Role = 'user' | 'assistant' | 'error'

type AgentEventSummary = {
  type: string
  message?: {
    role?: string
    stopReason?: string
    errorMessage?: string
    content?: Array<{ type?: string; text?: string }>
  }
  assistantMessageEvent?: {
    type?: string
    delta?: string
  }
}

type ChatMessage = {
  id: string
  role: Role
  content: string
}

type ProviderAuthStatus = {
  providerId: string
  name: string
  configured: boolean
  source?: 'stored' | 'runtime' | 'environment' | 'fallback' | 'models_json_key' | 'models_json_command'
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
  | { type: 'info'; message: string; links?: ReadonlyArray<{ url: string; label?: string }> }
  | { type: 'auth_url'; url: string; instructions?: string }
  | {
      type: 'device_code'
      userCode: string
      verificationUri: string
      intervalSeconds?: number
      expiresInSeconds?: number
    }
  | { type: 'progress'; message: string }

type AuthInteractionEvent =
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

type RendererApi = {
  sendPrompt: (text: string) => Promise<void>
  onAgentEvent: (cb: (event: AgentEventSummary) => void) => () => void
  getAuthStatus: () => Promise<ProviderAuthStatus[]>
  loginApiKey: (providerId: string, key: string) => Promise<ProviderAuthStatus[]>
  loginOAuth: (providerId: string) => Promise<ProviderAuthStatus[]>
  logout: (providerId: string) => Promise<void>
  submitAuthInteraction: (requestId: string, value: string) => Promise<void>
  onAuthInteraction: (cb: (event: AuthInteractionEvent) => void) => () => void
}

type ActivePrompt = {
  requestId: string
  providerId: string
  prompt: AuthPrompt
  value: string
}

function getRendererApi(): RendererApi {
  return (window as unknown as {
    api: RendererApi
  }).api
}

function extractTextFromMessage(message: AgentEventSummary['message']): string {
  if (!message || !Array.isArray(message.content)) {
    return ''
  }

  return message.content
    .map((part) => {
      if (part.type === 'text' && typeof part.text === 'string') {
        return part.text
      }
      return ''
    })
    .join('')
}

function App(): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const assistantIdRef = useRef<string | null>(null)
  const [listRef, setListRef] = useState<HTMLDivElement | null>(null)
  const [view, setView] = useState<'chat' | 'accounts'>('chat')

  const [providerStatuses, setProviderStatuses] = useState<ProviderAuthStatus[]>([])
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({})
  const [activePrompts, setActivePrompts] = useState<Record<string, ActivePrompt>>({})
  const [providerHints, setProviderHints] = useState<Record<string, string>>({})

  const rendererApi = getRendererApi()
  const listRefSetter = (value: HTMLDivElement | null): void => {
    setListRef(value)
  }

  const setPromptValue = (requestId: string, value: string): void => {
    setActivePrompts((prev) => {
      const next = { ...prev }
      const current = next[requestId]
      if (!current) return prev
      return {
        ...next,
        [requestId]: {
          ...current,
          value,
        },
      }
    })
  }

  const clearPrompt = (requestId: string): void => {
    setActivePrompts((prev) => {
      const next = { ...prev }
      delete next[requestId]
      return next
    })
  }

  const refreshAuthStatuses = async (): Promise<void> => {
    try {
      const data = await rendererApi.getAuthStatus()
      setProviderStatuses(data)
    } catch {
      setProviderStatuses([])
    }
  }

  useEffect(() => {
    const unsubscribe = rendererApi.onAgentEvent((event) => {
      setMessages((prev) => {
        const next = [...prev]

        if (event.type === 'message_start' && event.message?.role === 'assistant') {
          const nextId = `assistant-${Date.now()}`
          assistantIdRef.current = nextId
          next.push({ id: nextId, role: 'assistant', content: '' })
          return next
        }

        if (event.type === 'message_update' && event.message?.role === 'assistant') {
          let targetId = assistantIdRef.current
          if (!targetId) {
            targetId = `assistant-${Date.now()}`
            assistantIdRef.current = targetId
            next.push({ id: targetId, role: 'assistant', content: '' })
          }

          const delta = event.assistantMessageEvent?.delta
          if (typeof delta === 'string' && targetId) {
            const index = next.findIndex((item) => item.id === targetId)
            if (index >= 0) {
              const item = next[index]
              next[index] = {
                ...item,
                content: item.content + delta,
              }
            }
          }

          return next
        }

        if (event.type === 'message_end' && event.message?.role === 'assistant') {
          const finalMessage = extractTextFromMessage(event.message)
          const errorText = event.message.stopReason === 'error' ? event.message.errorMessage || 'Request failed' : ''
          const current = assistantIdRef.current

          if (event.message.stopReason === 'error') {
            if (current) {
              const index = next.findIndex((item) => item.id === current)
              if (index >= 0) {
                next[index] = {
                  ...next[index],
                  role: 'error',
                  content: errorText,
                }
              }
            } else {
              next.push({ id: `error-${Date.now()}`, role: 'error', content: errorText })
            }
            assistantIdRef.current = null
            return next
          }

          if (current) {
            const index = next.findIndex((item) => item.id === current)
            if (index >= 0) {
              next[index] = {
                ...next[index],
                role: 'assistant',
                content: finalMessage || next[index].content,
              }
            }
          }

          assistantIdRef.current = null
        }

        return next
      })
    })

    const unsubscribeAuthInteraction = rendererApi.onAuthInteraction((event) => {
      if (event.type === 'prompt') {
        setActivePrompts((prev) => ({
          ...prev,
          [event.requestId]: {
            requestId: event.requestId,
            providerId: event.providerId,
            prompt: event.prompt,
            value: '',
          },
        }))
      } else {
        const msg =
          event.event.type === 'auth_url'
            ? `已打开授权页：${event.event.url}`
            : event.event.type === 'info'
              ? event.event.message
              : event.event.type === 'progress'
                ? event.event.message
                : event.event.type === 'device_code'
                  ? `验证码：${event.event.userCode}`
                  : '收到授权提示'
        setProviderHints((prev) => ({
          ...prev,
          [event.providerId]: msg,
        }))
      }
    })

    return () => {
      unsubscribe()
      unsubscribeAuthInteraction()
    }
  }, [])

  useEffect(() => {
    if (listRef) {
      listRef.scrollTop = listRef.scrollHeight
    }
  }, [listRef, messages])

  useEffect(() => {
    if (view === 'accounts') {
      void refreshAuthStatuses()
    }
  }, [view])

  const submitAuthPrompt = async (requestId: string): Promise<void> => {
    const prompt = activePrompts[requestId]
    if (!prompt) {
      return
    }

    await rendererApi.submitAuthInteraction(requestId, prompt.value)
    clearPrompt(requestId)
    await refreshAuthStatuses()
  }

  const loginApiKey = async (providerId: string): Promise<void> => {
    const key = apiKeyInputs[providerId]?.trim()
    if (!key) {
      return
    }

    await rendererApi.loginApiKey(providerId, key)
    setApiKeyInputs((prev) => ({ ...prev, [providerId]: '' }))
    await refreshAuthStatuses()
  }

  const loginOAuth = async (providerId: string): Promise<void> => {
    await rendererApi.loginOAuth(providerId)
    await refreshAuthStatuses()
  }

  const logoutProvider = async (providerId: string): Promise<void> => {
    await rendererApi.logout(providerId)
    setProviderHints((prev) => ({
      ...prev,
      [providerId]: '已登出',
    }))
    await refreshAuthStatuses()
  }

  const onChatSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const text = input.trim()
    if (!text) {
      return
    }

    const userId = `user-${Date.now()}`
    setMessages((prev) => [...prev, { id: userId, role: 'user', content: text }])
    setInput('')
    assistantIdRef.current = null

    try {
      await rendererApi.sendPrompt(text)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to send prompt'
      setMessages((prev) => [...prev, { id: `error-${Date.now()}`, role: 'error', content: message }])
    }
  }

  const statusBadge = useMemo(
    () => (status: ProviderAuthStatus): React.CSSProperties => {
      if (status.hasConfigError) {
        return {
          color: '#9a3412',
          background: '#ffedd5',
          border: '1px solid #f59e0b',
          borderRadius: 999,
          padding: '2px 8px',
          fontSize: 12,
        }
      }
      if (status.configured) {
        return {
          color: '#166534',
          background: '#dcfce7',
          border: '1px solid #86efac',
          borderRadius: 999,
          padding: '2px 8px',
          fontSize: 12,
        }
      }

      return {
        color: '#334155',
        background: '#f1f5f9',
        border: '1px solid #cbd5e1',
        borderRadius: 999,
        padding: '2px 8px',
        fontSize: 12,
      }
    },
    [],
  )

  const renderAccounts = (): React.JSX.Element => {
    const promptsByProvider = Object.values(activePrompts)

    return (
      <div style={{ width: '100%', maxWidth: 980, height: '100vh', margin: '0 auto', display: 'flex', flexDirection: 'column', padding: 16, boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Provider 凭证管理</h2>
          <button
            type="button"
            onClick={refreshAuthStatuses}
            style={{ border: '1px solid #1f2937', borderRadius: 8, padding: '8px 12px', background: '#1f2937', color: '#fff' }}
          >
            刷新状态
          </button>
        </div>

        <div style={{ display: 'grid', gap: 12 }}>
          {providerStatuses.map((provider) => (
            <div key={provider.providerId} style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: 12, background: '#fff' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{provider.name}</div>
                  <div style={{ color: '#64748b', fontSize: 12 }}>{provider.providerId}</div>
                </div>
                <span style={statusBadge(provider)}>{provider.statusText || (provider.configured ? '已配置' : '未配置')}</span>
              </div>

              {provider.hasConfigError && (
                <div style={{ color: '#b45309', marginBottom: 6 }}>
                  {provider.label ? `${provider.label}（异常态）` : '认证异常，请重新登录'}
                </div>
              )}

              {providerHints[provider.providerId] && (
                <div style={{ color: '#334155', marginBottom: 6, fontSize: 13 }}>{providerHints[provider.providerId]}</div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {provider.hasApiKey && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      value={apiKeyInputs[provider.providerId] ?? ''}
                      onChange={(event) => {
                        const next = event.target.value
                        setApiKeyInputs((prev) => ({ ...prev, [provider.providerId]: next }))
                      }}
                      type="password"
                      placeholder="输入 API Key"
                      style={{ flex: 1, border: '1px solid #cbd5e1', borderRadius: 8, padding: '8px 10px' }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        void loginApiKey(provider.providerId)
                      }}
                      style={{ border: '1px solid #1f2937', borderRadius: 8, background: '#1f2937', color: '#fff', padding: '8px 12px' }}
                    >
                      API Key 登录
                    </button>
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8 }}>
                  {provider.hasOAuth && (
                    <button
                      type="button"
                      onClick={() => {
                        void loginOAuth(provider.providerId)
                      }}
                      style={{ border: '1px solid #0f766e', borderRadius: 8, background: '#0f766e', color: '#fff', padding: '8px 12px' }}
                    >
                      OAuth 登录
                    </button>
                  )}

                  {provider.configured && (
                    <button
                      type="button"
                      onClick={() => {
                        void logoutProvider(provider.providerId)
                      }}
                      style={{ border: '1px solid #be123c', borderRadius: 8, background: '#be123c', color: '#fff', padding: '8px 12px' }}
                    >
                      登出
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {promptsByProvider.length > 0 && (
          <div style={{ marginTop: 16, border: '1px solid #e2e8f0', borderRadius: 10, padding: 12 }}>
            <h3 style={{ margin: '0 0 10px 0' }}>授权交互输入</h3>
            {promptsByProvider.map((item) => {
              const isSelect = item.prompt.type === 'select'
              return (
                <form
                  key={item.requestId}
                  onSubmit={(event) => {
                    event.preventDefault()
                    void submitAuthPrompt(item.requestId)
                  }}
                  style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, color: '#334155', marginBottom: 4 }}>{item.prompt.message}</div>
                    {isSelect ? (
                      <select
                        value={item.value || item.prompt.options?.[0]?.id || ''}
                        onChange={(event) => {
                          setPromptValue(item.requestId, event.target.value)
                        }}
                        style={{ width: '100%', border: '1px solid #cbd5e1', borderRadius: 8, padding: '8px 10px' }}
                      >
                        {item.prompt.options?.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                            {option.description ? ` (${option.description})` : ''}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={item.value}
                        onChange={(event) => {
                          setPromptValue(item.requestId, event.target.value)
                        }}
                        type={item.prompt.type === 'secret' ? 'password' : 'text'}
                        placeholder={item.prompt.placeholder}
                        style={{ width: '100%', border: '1px solid #cbd5e1', borderRadius: 8, padding: '8px 10px' }}
                      />
                    )}
                  </div>
                  <button type="submit" style={{ border: '1px solid #1f2937', borderRadius: 8, background: '#1f2937', color: '#fff', padding: '8px 12px' }}>
                    提交
                  </button>
                </form>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{ width: '100%', height: '100vh', display: 'flex', flexDirection: 'column', padding: 16, boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-start', gap: 10, marginBottom: 10 }}>
        <button
          type="button"
          onClick={() => {
            setView('chat')
          }}
          style={{
            border: '1px solid #1f2937',
            borderRadius: 8,
            background: view === 'chat' ? '#1f2937' : '#fff',
            color: view === 'chat' ? '#fff' : '#1f2937',
            padding: '8px 12px',
          }}
        >
          聊天
        </button>
        <button
          type="button"
          onClick={() => {
            setView('accounts')
          }}
          style={{
            border: '1px solid #1f2937',
            borderRadius: 8,
            background: view === 'accounts' ? '#1f2937' : '#fff',
            color: view === 'accounts' ? '#fff' : '#1f2937',
            padding: '8px 12px',
          }}
        >
          设置/账户
        </button>
      </div>

      {view === 'chat' ? (
        <>
          <div
            ref={listRefSetter}
            style={{ flex: 1, overflowY: 'auto', padding: 8, marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 10 }}
          >
            {messages.map((item) => (
              <div
                key={item.id}
                style={{
                  alignSelf: item.role === 'user' ? 'flex-end' : 'flex-start',
                  maxWidth: '80%',
                  padding: '10px 12px',
                  borderRadius: 10,
                  whiteSpace: 'pre-wrap',
                  color: item.role === 'error' ? '#e54b4b' : '#1f2937',
                  backgroundColor: item.role === 'user' ? '#e0f2ff' : item.role === 'error' ? '#ffe8e8' : '#f3f4f6',
                  border: item.role === 'error' ? '1px solid #f5a6a6' : undefined,
                }}
              >
                {item.content}
              </div>
            ))}
          </div>

          <form onSubmit={onChatSubmit} style={{ display: 'flex', gap: 8 }}>
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              style={{ flex: 1, border: '1px solid #cbd5e1', borderRadius: 8, padding: '10px 12px' }}
              placeholder="Type a message and press Enter..."
            />
            <button
              type="submit"
              style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid #1f2937', background: '#1f2937', color: '#fff' }}
            >
              Send
            </button>
          </form>
        </>
      ) : (
        renderAccounts()
      )}
    </div>
  )
}

export default App
