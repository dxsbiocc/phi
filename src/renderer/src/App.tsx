import { FormEvent, useEffect, useRef, useState } from 'react'

type Role = 'user' | 'assistant' | 'error'

interface ChatMessage {
  id: string
  role: Role
  content: string
}

interface AgentEventSummary {
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

type RendererApi = {
  sendPrompt: (text: string) => Promise<void>
  onAgentEvent: (cb: (event: AgentEventSummary) => void) => () => void
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
  const listRef = useRef<HTMLDivElement | null>(null)
  const rendererApi = getRendererApi()

  useEffect(() => {
    const unsubscribe = rendererApi.onAgentEvent((event) => {
      setMessages((prev) => {
        const next = [...prev]

        if (
          event.type === 'message_start' &&
          event.message?.role === 'assistant'
        ) {
          const id = `assistant-${Date.now()}`
          assistantIdRef.current = id
          next.push({ id, role: 'assistant', content: '' })
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
                content: item.content + delta
              }
            }
          }

          return next
        }

        if (event.type === 'message_end' && event.message?.role === 'assistant') {
          const finalMessage = extractTextFromMessage(event.message)
          const errorText = event.message.stopReason === 'error'
            ? event.message.errorMessage || 'Request failed'
            : ''
          const targetId = assistantIdRef.current

          if (event.message.stopReason === 'error') {
            if (targetId) {
              const index = next.findIndex((item) => item.id === targetId)
              if (index >= 0) {
                next[index] = {
                  ...next[index],
                  role: 'error',
                  content: errorText
                }
              }
            } else {
              next.push({ id: `error-${Date.now()}`, role: 'error', content: errorText })
            }
            assistantIdRef.current = null
            return next
          }

          if (targetId) {
            const index = next.findIndex((item) => item.id === targetId)
            if (index >= 0) {
              next[index] = {
                ...next[index],
                role: 'assistant',
                content: finalMessage || next[index].content
              }
            }
          }

          assistantIdRef.current = null
        }

        return next
      })
    })

    return unsubscribe
  }, [])

  useEffect(() => {
    const current = listRef.current
    if (current) {
      current.scrollTop = current.scrollHeight
    }
  }, [messages])

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const text = input.trim()
    if (!text) {
      return
    }

    const userId = `user-${Date.now()}`
    setMessages((prev) => [...prev, { id: userId, role: 'user', content: text }])
    setInput('')

    try {
      await rendererApi.sendPrompt(text)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unable to send prompt'
      setMessages((prev) => [...prev, { id: `error-${Date.now()}`, role: 'error', content: message }])
    }
  }

  return (
    <div style={{ width: '100%', maxWidth: 840, height: '100vh', display: 'flex', flexDirection: 'column', padding: 16, boxSizing: 'border-box' }}>
      <div
        ref={listRef}
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
              border: item.role === 'error' ? '1px solid #f5a6a6' : undefined
            }}
          >
            {item.content}
          </div>
        ))}
      </div>

      <form onSubmit={onSubmit} style={{ display: 'flex', gap: 8 }}>
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
    </div>
  )
}

export default App
