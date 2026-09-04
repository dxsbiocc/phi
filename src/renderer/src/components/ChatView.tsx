import {
  Alert,
  Autocomplete,
  Box,
  Button,
  createFilterOptions,
  IconButton,
  Paper,
  TextField,
  Typography
} from '@mui/material'
import { Send as SendIcon } from '@mui/icons-material'
import type { FormEvent, ReactNode } from 'react'
import type { ChatMessage, ModelOption } from '../types'

type ViewProps = {
  messages: ChatMessage[]
  input: string
  messagesContainerRef: (node: HTMLDivElement | null) => void
  canSend: boolean
  models: ModelOption[]
  selectedModel: ModelOption | null
  onSelectModel: (model: ModelOption | null) => void
  onInputChange: (value: string) => void
  onChatSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>
  onGoSettings: () => void
}

function ChatBubble({
  message,
  onGoSettings
}: {
  message: ChatMessage
  onGoSettings: () => void
}): ReactNode {
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
        boxShadow: 1
      }}
    >
      <Typography
        variant="body2"
        sx={{
          fontFamily: message.role === 'assistant' ? 'var(--font-stack)' : 'monospace',
          whiteSpace: 'pre-wrap',
          lineHeight: 1.6
        }}
      >
        {message.content}
      </Typography>
    </Paper>
  )
}

const modelFilterOptions = createFilterOptions<ModelOption>({
  limit: 60,
  stringify: (option) => `${option.name} ${option.providerId} ${option.modelId}`
})

function ChatView({
  messages,
  input,
  messagesContainerRef,
  canSend,
  models,
  selectedModel,
  onSelectModel,
  onInputChange,
  onChatSubmit,
  onGoSettings
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
          p: 2
        }}
      >
        {messages.map((message) => (
          <ChatBubble key={message.id} message={message} onGoSettings={onGoSettings} />
        ))}
      </Box>
      <Box component="form" onSubmit={onChatSubmit} sx={{ px: 2, pb: 2, pt: 1 }}>
        <Paper
          variant="outlined"
          sx={{
            borderRadius: 4,
            px: 2,
            pt: 1.5,
            pb: 1,
            transition: 'border-color 200ms',
            '&:focus-within': { borderColor: 'primary.main' }
          }}
        >
          <TextField
            fullWidth
            multiline
            variant="standard"
            minRows={1}
            maxRows={8}
            value={input}
            onChange={(event) => {
              onInputChange(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                if (canSend && input.trim()) {
                  event.currentTarget.closest('form')?.requestSubmit()
                }
              }
            }}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            slotProps={{
              input: {
                disableUnderline: true,
                sx: { fontSize: '0.95rem', lineHeight: 1.6 }
              }
            }}
          />
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 1,
              mt: 1
            }}
          >
            <Autocomplete
              options={models}
              value={selectedModel}
              filterOptions={modelFilterOptions}
              onChange={(_, value) => onSelectModel(value)}
              groupBy={(option) => option.providerId}
              getOptionLabel={(option) => option.name}
              isOptionEqualToValue={(option, value) =>
                option.providerId === value.providerId && option.modelId === value.modelId
              }
              size="small"
              disableClearable={false}
              sx={{ width: 220 }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  variant="standard"
                  placeholder="默认模型"
                  aria-label="选择模型"
                  slotProps={{
                    ...params.slotProps,
                    input: {
                      ...params.slotProps.input,
                      disableUnderline: true,
                      sx: { fontSize: '0.85rem', color: 'text.secondary' }
                    }
                  }}
                />
              )}
            />
            <IconButton
              type="submit"
              disabled={!canSend || !input.trim()}
              aria-label="发送消息"
              sx={{
                width: 36,
                height: 36,
                bgcolor: 'primary.main',
                color: 'background.default',
                transition: 'background-color 200ms',
                '&:hover': { bgcolor: 'primary.dark' },
                '&.Mui-disabled': { bgcolor: 'action.disabledBackground', color: 'action.disabled' }
              }}
            >
              <SendIcon fontSize="small" />
            </IconButton>
          </Box>
        </Paper>
      </Box>
    </Box>
  )
}

export default ChatView
