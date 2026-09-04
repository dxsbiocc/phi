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
import MarkdownContent from './MarkdownContent'
import ToolCallCard from './ToolCallCard'
import type { ChatItem, ChatMessage, ModelOption } from '../types'

type ViewProps = {
  messages: ChatItem[]
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

  if (message.role === 'user') {
    return (
      <Box
        sx={{
          alignSelf: 'flex-end',
          maxWidth: '75%',
          minWidth: 0,
          px: 2,
          py: 1.25,
          bgcolor: 'primary.main',
          color: 'background.default',
          borderRadius: '18px 18px 4px 18px'
        }}
      >
        <Typography
          variant="body1"
          sx={{
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            lineHeight: 1.6,
            fontSize: '0.95rem'
          }}
        >
          {message.content}
        </Typography>
      </Box>
    )
  }

  return (
    <Box sx={{ alignSelf: 'stretch', minWidth: 0, px: 0.5 }}>
      <MarkdownContent text={message.content} />
    </Box>
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
        sx={{ flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto', overflowX: 'hidden' }}
      >
        <Box
          sx={{
            maxWidth: 860,
            mx: 'auto',
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            p: 3
          }}
        >
          {messages.map((message) =>
            message.role === 'tool' ? (
              <ToolCallCard key={message.id} item={message} />
            ) : (
              <ChatBubble key={message.id} message={message} onGoSettings={onGoSettings} />
            )
          )}
        </Box>
      </Box>
      <Box
        component="form"
        onSubmit={onChatSubmit}
        sx={{ px: 2, pb: 2, pt: 1, maxWidth: 892, mx: 'auto', width: '100%' }}
      >
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
              noOptionsText="无可用模型 — 请先在设置中配置 Provider"
              sx={{ width: 220 }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  variant="standard"
                  placeholder="自动选择"
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
