import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Box,
  createTheme,
  CssBaseline,
  Drawer,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ThemeProvider,
  Toolbar
} from '@mui/material'
import { Chat as ChatIcon, Settings as SettingsIcon } from '@mui/icons-material'
import ChatView from './components/ChatView'
import SettingsView from './components/SettingsView'
import AddProviderDialog from './components/AddProviderDialog'
import type {
  ActiveAuthPrompt,
  AgentEventSummary,
  AuthInteractionEvent,
  ChatItem,
  ModelOption,
  ProviderAuthStatus,
  RendererApi
} from './types'

const drawerWidth = 200

const theme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: '#22C55E'
    },
    background: {
      default: '#0F172A',
      paper: '#1E293B'
    },
    secondary: {
      main: '#334155'
    },
    text: {
      primary: '#F8FAFC'
    }
  },
  typography: {
    fontFamily:
      "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif"
  },
  shape: {
    borderRadius: 12
  },
  transitions: {
    duration: {
      shortest: 150,
      shorter: 200,
      short: 250,
      standard: 250,
      complex: 300,
      enteringScreen: 250,
      leavingScreen: 200
    }
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          transition: 'all 0.2s ease',
          ':hover': {
            transform: 'translateY(-1px)'
          }
        }
      }
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          transition: 'all 0.2s ease',
          borderRadius: 10,
          margin: '0 8px 4px',
          ':hover': {
            transform: 'translateX(2px)'
          }
        }
      }
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          transition: 'all 0.2s ease'
        }
      }
    }
  }
})

function getRendererApi(): RendererApi {
  return (window as unknown as { api: RendererApi }).api
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

function extractToolText(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (value && typeof value === 'object') {
    const record = value as { content?: unknown; output?: unknown; text?: unknown }
    if (Array.isArray(record.content)) {
      const text = record.content
        .map((part) =>
          part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
            ? (part as { text: string }).text
            : ''
        )
        .join('')
      if (text) {
        return text
      }
    }
    if (typeof record.output === 'string') {
      return record.output
    }
    if (typeof record.text === 'string') {
      return record.text
    }
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }
  return value == null ? '' : String(value)
}

function toolArgsPreview(args: unknown): string {
  if (!args || typeof args !== 'object') {
    return ''
  }
  const record = args as Record<string, unknown>
  const preferred = ['command', 'path', 'file_path', 'pattern', 'code', 'query']
  for (const key of preferred) {
    if (typeof record[key] === 'string' && record[key]) {
      return record[key] as string
    }
  }
  const firstString = Object.values(record).find(
    (item): item is string => typeof item === 'string' && item.length > 0
  )
  return firstString ?? ''
}

function App(): React.JSX.Element {
  const [messages, setMessages] = useState<ChatItem[]>([])
  const [input, setInput] = useState('')
  const [view, setView] = useState<'chat' | 'settings'>('chat')
  const [providerStatuses, setProviderStatuses] = useState<ProviderAuthStatus[]>([])
  const [activePrompts, setActivePrompts] = useState<ActiveAuthPrompt[]>([])
  const [providerHints, setProviderHints] = useState<Record<string, string>>({})
  const [isProviderDialogOpen, setIsProviderDialogOpen] = useState(false)
  const [providerDialogProviderId, setProviderDialogProviderId] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const [isSendingMessage, setIsSendingMessage] = useState(false)
  const [models, setModels] = useState<ModelOption[]>([])
  const [selectedModel, setSelectedModel] = useState<ModelOption | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const isSendingRef = useRef(false)
  const textBlockIdsRef = useRef<Map<number, string>>(new Map())
  const thinkingBlockIdsRef = useRef<Map<number, string>>(new Map())
  const rendererApi = getRendererApi()

  const refreshAuthStatuses = async (): Promise<void> => {
    const data = await rendererApi.getAuthStatus()
    setProviderStatuses(data)
  }

  const closeProviderDialog = (): void => {
    setIsProviderDialogOpen(false)
    setProviderDialogProviderId(null)
    setActivePrompts([])
  }

  const openProviderDialog = (providerId: string | null = null): void => {
    setProviderDialogProviderId(providerId)
    setIsProviderDialogOpen(true)
  }

  useEffect(() => {
    const unsubscribe = rendererApi.onAgentEvent((event: AgentEventSummary) => {
      setMessages((prev) => {
        const next = [...prev]

        if (event.type === 'tool_execution_start' && typeof event.toolCallId === 'string') {
          let argsJson = ''
          try {
            argsJson = JSON.stringify(event.args, null, 2) ?? ''
          } catch {
            argsJson = ''
          }
          next.push({
            id: event.toolCallId,
            role: 'tool',
            toolName: typeof event.toolName === 'string' ? event.toolName : 'tool',
            argsPreview: toolArgsPreview(event.args),
            argsJson,
            output: '',
            status: 'running'
          })
          return next
        }

        if (
          (event.type === 'tool_execution_update' || event.type === 'tool_execution_end') &&
          typeof event.toolCallId === 'string'
        ) {
          const index = next.findIndex((item) => item.id === event.toolCallId)
          const current = index >= 0 ? next[index] : null
          if (current && current.role === 'tool') {
            if (event.type === 'tool_execution_update') {
              const partial = extractToolText(event.partialResult)
              next[index] = { ...current, output: partial || current.output }
            } else {
              const output = extractToolText(event.result)
              next[index] = {
                ...current,
                output: output || current.output,
                status: event.isError ? 'error' : 'done'
              }
            }
          }
          return next
        }

        if (event.type === 'message_start' && event.message?.role === 'assistant') {
          // Each assistant message can carry multiple streamed content blocks
          // (thinking, text, tool-call) distinguished by contentIndex — start a
          // fresh mapping per turn rather than assuming a single block.
          textBlockIdsRef.current = new Map()
          thinkingBlockIdsRef.current = new Map()
          return next
        }

        if (event.type === 'message_update' && event.message?.role === 'assistant') {
          const ame = event.assistantMessageEvent
          if (!ame || (ame.type !== 'text_delta' && ame.type !== 'thinking_delta')) {
            return next
          }

          const isThinking = ame.type === 'thinking_delta'
          const blockIds = isThinking ? thinkingBlockIdsRef.current : textBlockIdsRef.current
          const contentIndex = ame.contentIndex ?? 0
          let targetId = blockIds.get(contentIndex)
          if (!targetId) {
            targetId = `${isThinking ? 'thinking' : 'assistant'}-${Date.now()}-${contentIndex}`
            blockIds.set(contentIndex, targetId)
            next.push(
              isThinking
                ? { id: targetId, role: 'thinking', content: '' }
                : { id: targetId, role: 'assistant', content: '' }
            )
          }

          const delta = ame.delta
          if (typeof delta === 'string') {
            const index = next.findIndex((item) => item.id === targetId)
            const current = index >= 0 ? next[index] : null
            if (current && (current.role === 'assistant' || current.role === 'thinking')) {
              next[index] = {
                ...current,
                content: `${current.content}${delta}`
              }
            }
          }

          return next
        }

        if (event.type === 'message_end' && event.message?.role === 'assistant') {
          const isError = event.message.stopReason === 'error'
          const errorText = isError ? event.message.errorMessage || '请求失败' : ''
          const textIds = [...textBlockIdsRef.current.values()]

          if (isError) {
            // Fold the error into the last streamed text block if there is one,
            // instead of leaving a dangling empty bubble plus a separate error.
            const lastTextId = textIds[textIds.length - 1]
            const index = lastTextId ? next.findIndex((item) => item.id === lastTextId) : -1
            const current = index >= 0 ? next[index] : null
            if (current && current.role === 'assistant') {
              next[index] = {
                ...current,
                role: 'error',
                content: current.content || errorText
              }
            } else if (errorText) {
              next.push({ id: `error-${Date.now()}`, role: 'error', content: errorText })
            }
          } else if (textIds.length === 0) {
            // No text_delta streamed at all (e.g. an instantly-final message) —
            // fall back to the message's own content.
            const finalMessage = extractTextFromMessage(event.message)
            if (finalMessage) {
              next.push({ id: `assistant-${Date.now()}`, role: 'assistant', content: finalMessage })
            }
          }

          // Drop any thinking/text block left with no content (e.g. a thinking
          // block that started but never received a delta before the turn ended).
          for (let i = next.length - 1; i >= 0; i -= 1) {
            const item = next[i]
            if ((item.role === 'thinking' || item.role === 'assistant') && !item.content) {
              next.splice(i, 1)
            }
          }

          textBlockIdsRef.current = new Map()
          thinkingBlockIdsRef.current = new Map()
        }

        return next
      })
    })

    const unsubscribeAuthInteraction = rendererApi.onAuthInteraction(
      (event: AuthInteractionEvent) => {
        if (event.type === 'prompt') {
          setActivePrompts((prev) => {
            const exists = prev.some((item) => item.requestId === event.requestId)
            if (exists) {
              return prev.map((item) =>
                item.requestId === event.requestId
                  ? {
                      ...item,
                      prompt: event.prompt,
                      value: item.value
                    }
                  : item
              )
            }

            return [
              ...prev,
              {
                requestId: event.requestId,
                providerId: event.providerId,
                prompt: event.prompt,
                value: ''
              }
            ]
          })

          setProviderDialogProviderId(event.providerId)
          setIsProviderDialogOpen(true)
          setView('settings')
          return
        }

        const hint =
          event.event.type === 'auth_url'
            ? `授权链接：${event.event.url}`
            : event.event.type === 'info'
              ? event.event.message
              : event.event.type === 'progress'
                ? event.event.message
                : event.event.type === 'device_code'
                  ? `验证码：${event.event.userCode}`
                  : '收到授权提示'

        setProviderHints((prev) => ({
          ...prev,
          [event.providerId]: hint
        }))

        setProviderDialogProviderId(event.providerId)
        if (
          event.event.type === 'progress' ||
          event.event.type === 'auth_url' ||
          event.event.type === 'device_code'
        ) {
          setIsProviderDialogOpen(true)
        }
      }
    )

    return () => {
      unsubscribe()
      unsubscribeAuthInteraction()
    }
  }, [])

  useEffect(() => {
    void refreshAuthStatuses()
    void (async () => {
      try {
        const [available, selected] = await Promise.all([
          rendererApi.listModels(),
          rendererApi.getSelectedModel()
        ])
        setModels(available)
        if (selected) {
          setSelectedModel(
            available.find(
              (item) => item.providerId === selected.providerId && item.modelId === selected.modelId
            ) ?? null
          )
        }
      } catch {
        // 模型列表加载失败不阻塞聊天；发送时会给出明确错误
      }
    })()
  }, [])

  const onSelectModel = async (model: ModelOption | null): Promise<void> => {
    if (!model) {
      setSelectedModel(null)
      return
    }

    const previous = selectedModel
    setSelectedModel(model)
    try {
      await rendererApi.selectModel(model.providerId, model.modelId)
    } catch (error) {
      setSelectedModel(previous)
      const message = error instanceof Error ? error.message : '切换模型失败'
      setMessages((prev) => [
        ...prev,
        { id: `error-${Date.now()}`, role: 'error', content: message }
      ])
    }
  }

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [messages])

  const configuredCount = useMemo(
    () => providerStatuses.filter((provider) => provider.configured).length,
    [providerStatuses]
  )

  const availableModels = useMemo(() => {
    const configuredIds = new Set(
      providerStatuses
        .filter((provider) => provider.configured)
        .map((provider) => provider.providerId)
    )
    return models.filter((model) => configuredIds.has(model.providerId))
  }, [models, providerStatuses])

  const onChatSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const text = input.trim()
    // isSendingRef is checked-and-set synchronously so a second submit fired in the
    // same tick (before the isSendingMessage state update commits) can't slip through.
    if (!text || isSendingRef.current) {
      return
    }
    isSendingRef.current = true

    setMessages((prev) => [...prev, { id: `user-${Date.now()}`, role: 'user', content: text }])
    setInput('')
    setIsSendingMessage(true)

    try {
      await rendererApi.sendPrompt(text)
      if (!selectedModel) {
        const active = await rendererApi.getSelectedModel()
        if (active) {
          setSelectedModel(
            (prev) =>
              prev ??
              models.find(
                (item) => item.providerId === active.providerId && item.modelId === active.modelId
              ) ??
              prev
          )
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to send prompt'
      setMessages((prev) => [
        ...prev,
        { id: `error-${Date.now()}`, role: 'error', content: message }
      ])
    } finally {
      isSendingRef.current = false
      setIsSendingMessage(false)
    }
  }

  const onSubmitAuthPrompt = async (requestId: string, value: string): Promise<void> => {
    if (!value.trim()) {
      return
    }

    setIsBusy(true)
    try {
      await rendererApi.submitAuthInteraction(requestId, value)
      setActivePrompts((prev) => prev.filter((item) => item.requestId !== requestId))
    } finally {
      setIsBusy(false)
    }
  }

  const onUpdatePromptValue = (requestId: string, value: string): void => {
    setActivePrompts((prev) =>
      prev.map((prompt) => (prompt.requestId === requestId ? { ...prompt, value } : prompt))
    )
  }

  const submitProviderApiKey = async (providerId: string, key: string): Promise<void> => {
    if (!key.trim()) {
      return
    }

    setIsBusy(true)
    try {
      const next = await rendererApi.loginApiKey(providerId, key)
      setProviderStatuses(next)
      setProviderHints((prev) => ({
        ...prev,
        [providerId]: 'API Key 已提交（实际校验延后到发送消息时）'
      }))
    } finally {
      setIsBusy(false)
    }
  }

  const submitProviderOAuth = async (providerId: string): Promise<void> => {
    setIsBusy(true)
    try {
      const next = await rendererApi.loginOAuth(providerId)
      setProviderStatuses(next)
      setProviderHints((prev) => ({
        ...prev,
        [providerId]: 'OAuth 已触发，授权状态会在对话中完成'
      }))
    } finally {
      setIsBusy(false)
    }
  }

  const logoutProvider = async (providerId: string): Promise<void> => {
    await rendererApi.logout(providerId)
    await refreshAuthStatuses()
  }

  const selectedPrompts = activePrompts.filter(
    (item) => item.providerId === providerDialogProviderId
  )

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box
        sx={{
          display: 'flex',
          width: '100vw',
          height: '100vh',
          bgcolor: 'background.default',
          overflow: 'hidden'
        }}
      >
        <Drawer
          variant="permanent"
          sx={{
            width: drawerWidth,
            flexShrink: 0,
            '& .MuiDrawer-paper': {
              width: drawerWidth,
              boxSizing: 'border-box',
              bgcolor: 'background.paper',
              borderRightColor: 'secondary.main'
            }
          }}
        >
          <Toolbar />
          <List>
            <ListItemButton
              selected={view === 'chat'}
              onClick={() => {
                setView('chat')
              }}
            >
              <ListItemIcon>
                <ChatIcon />
              </ListItemIcon>
              <ListItemText primary="聊天" />
            </ListItemButton>
            <ListItemButton
              selected={view === 'settings'}
              onClick={() => {
                setView('settings')
              }}
            >
              <ListItemIcon>
                <SettingsIcon />
              </ListItemIcon>
              <ListItemText
                primary="设置"
                secondary={configuredCount > 0 ? `${configuredCount} 个已配置` : '未配置'}
              />
            </ListItemButton>
          </List>
        </Drawer>

        <Box component="main" sx={{ flex: 1, minWidth: 0, height: '100vh', overflow: 'hidden' }}>
          {view === 'chat' ? (
            <ChatView
              messages={messages}
              input={input}
              messagesContainerRef={(node) => {
                listRef.current = node
              }}
              canSend={!isSendingMessage && !isBusy}
              models={availableModels}
              selectedModel={selectedModel}
              onSelectModel={(model) => {
                void onSelectModel(model)
              }}
              onInputChange={setInput}
              onChatSubmit={onChatSubmit}
              onGoSettings={() => {
                setView('settings')
              }}
            />
          ) : (
            <SettingsView
              providers={providerStatuses}
              providerHints={providerHints}
              onRefresh={refreshAuthStatuses}
              onOpenAddProvider={() => {
                openProviderDialog(null)
              }}
              onLogout={logoutProvider}
            />
          )}
        </Box>

        <AddProviderDialog
          open={isProviderDialogOpen}
          providers={providerStatuses}
          initialProviderId={providerDialogProviderId}
          activePrompts={selectedPrompts}
          providerHint={providerDialogProviderId ? providerHints[providerDialogProviderId] : ''}
          isProcessing={isBusy}
          onClose={closeProviderDialog}
          onSelectProvider={(provider) => {
            setProviderDialogProviderId(provider.providerId)
          }}
          onBackToList={() => {
            setProviderDialogProviderId(null)
          }}
          onSubmitApiKey={submitProviderApiKey}
          onStartOAuth={submitProviderOAuth}
          onSubmitPrompt={onSubmitAuthPrompt}
          onUpdatePromptValue={onUpdatePromptValue}
        />
      </Box>
    </ThemeProvider>
  )
}

export default App
