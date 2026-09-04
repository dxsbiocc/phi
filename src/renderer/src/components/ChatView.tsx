import { Alert, Box, Button, IconButton, Paper, TextField, Typography } from '@mui/material'
import { Send as SendIcon } from '@mui/icons-material'
import type { FormEvent, ReactNode } from 'react'
import type { ChatMessage } from '../types'

type ViewProps = {
  messages: ChatMessage[]
  input: string
  messagesContainerRef: (node: HTMLDivElement | null) => void
  canSend: boolean
  onInputChange: (value: string) => void
  onChatSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>
  onGoSettings: () => void
}

function ChatBubble({ message, onGoSettings }: { message: ChatMessage; onGoSettings: () => void }): ReactNode {
  if (message.role === 'error') {
    return (
      <Alert
        severity="error"
        variant="outlined"
        action={
          <Button size="small" color="inherit" onClick={onGoSettings} sx={{ minHeight: 44 }}>
            去配置 Provider
          </Button>
        }
      >
        <Typography variant="body2" sx={{ color: 'inherit', whiteSpace: 'pre-wrap' }}>
          {message.content}
        </Typography>
      </Alert>
    )
  }

  const isUser = message.role === 'user'

  return (
    <Paper
      variant="outlined"
      sx={{
        px: 2,
        py: 1,
        maxWidth: '80%',
        alignSelf: isUser ? 'flex-end' : 'flex-start',
        bgcolor: isUser ? 'primary.main' : 'background.paper',
        color: isUser ? 'background.default' : 'text.primary',
        borderColor: isUser ? 'primary.main' : 'grey.700',
        borderRadius: 2,
        boxShadow: 1,
      }}
    >
      <Typography
        variant="body2"
        sx={{
          fontFamily: message.role === 'assistant' ? 'var(--font-stack)' : 'monospace',
          whiteSpace: 'pre-wrap',
          lineHeight: 1.6,
        }}
      >
        {message.content}
      </Typography>
    </Paper>
  )
}

function ChatView({
  messages,
  input,
  messagesContainerRef,
  canSend,
  onInputChange,
  onChatSubmit,
  onGoSettings,
}: ViewProps): React.JSX.Element {
  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Box
        ref={messagesContainerRef}
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 1.5,
          p: 2,
        }}
      >
        {messages.map((message) => (
          <ChatBubble key={message.id} message={message} onGoSettings={onGoSettings} />
        ))}
      </Box>
      <Paper component="form" onSubmit={onChatSubmit} elevation={0} sx={{ p: 2, borderTop: 1, borderColor: 'grey.700' }}>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <TextField
            fullWidth
            multiline
            minRows={1}
            maxRows={5}
            value={input}
            onChange={(event) => {
              onInputChange(event.target.value)
            }}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            slotProps={{
              input: {
                sx: {
                  borderRadius: 999,
                  minHeight: 44,
                },
              },
              inputLabel: {
                sx: {
                  color: 'text.secondary',
                },
              },
            }}
            disabled={!canSend}
          />
          <IconButton
            type="submit"
            color="primary"
            size="large"
            disabled={!canSend || !input.trim()}
            aria-label="发送消息"
            sx={{ width: 44, height: 44 }}
          >
            <SendIcon />
          </IconButton>
        </Box>
      </Paper>
    </Box>
  )
}

export default ChatView
