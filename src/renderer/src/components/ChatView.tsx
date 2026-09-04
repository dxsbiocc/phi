import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Collapse,
  createFilterOptions,
  IconButton,
  Paper,
  Popover,
  Slider,
  TextField,
  Typography
} from '@mui/material'
import {
  Bolt as BoltIcon,
  ChevronRight as ChevronRightIcon,
  Send as SendIcon
} from '@mui/icons-material'
import { useId, useState, type FormEvent, type ReactNode } from 'react'
import MarkdownContent from './MarkdownContent'
import ToolCallCard from './ToolCallCard'
import type { ChatItem, ChatMessage, ModelOption, ThinkingLevel } from '../types'

const THINKING_LEVEL_ORDER: ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max'
}

function ThinkingLevelControl({
  thinkingLevel,
  onSelectThinkingLevel,
  supportedLevels
}: {
  thinkingLevel: ThinkingLevel
  onSelectThinkingLevel: (level: ThinkingLevel) => void
  supportedLevels: ThinkingLevel[] | null
}): ReactNode {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const popoverId = useId()

  // supportedLevels is null when no model is explicitly selected (unknown until
  // the SDK resolves a default) — in that case don't constrain the slider.
  const disabled = supportedLevels !== null && supportedLevels.length === 0
  const minIndex = supportedLevels?.length ? THINKING_LEVEL_ORDER.indexOf(supportedLevels[0]) : 0
  const maxIndex = supportedLevels?.length
    ? THINKING_LEVEL_ORDER.indexOf(supportedLevels[supportedLevels.length - 1])
    : THINKING_LEVEL_ORDER.length - 1
  const currentIndex = Math.min(
    Math.max(THINKING_LEVEL_ORDER.indexOf(thinkingLevel), minIndex),
    maxIndex
  )

  return (
    <>
      <Button
        size="small"
        onClick={(event) => setAnchorEl(event.currentTarget)}
        disabled={disabled}
        aria-describedby={popoverId}
        startIcon={<BoltIcon sx={{ fontSize: 16 }} />}
        sx={{
          textTransform: 'none',
          color: 'text.secondary',
          fontSize: '0.85rem',
          minHeight: 32,
          // Fixed width so the button (and therefore the popover's anchor point)
          // never shifts as the label text changes length between levels.
          width: 104,
          justifyContent: 'flex-start',
          px: 1
        }}
      >
        {disabled ? 'Off' : THINKING_LEVEL_LABELS[THINKING_LEVEL_ORDER[currentIndex]]}
      </Button>
      <Popover
        id={popoverId}
        open={Boolean(anchorEl)}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { sx: { py: 3, px: 3.5, width: 320 } } }}
      >
        <Slider
          value={currentIndex}
          min={minIndex}
          max={maxIndex}
          step={1}
          sx={{ mx: 1, width: 'calc(100% - 16px)' }}
          marks={THINKING_LEVEL_ORDER.map((level, index) => ({
            value: index,
            label: (
              <Typography variant="caption" sx={{ fontSize: '0.7rem' }}>
                {THINKING_LEVEL_LABELS[level]}
              </Typography>
            )
          }))}
          onChange={(_, value) => {
            const index = Array.isArray(value) ? value[0] : value
            onSelectThinkingLevel(THINKING_LEVEL_ORDER[index])
          }}
          aria-label="Thinking level"
        />
      </Popover>
    </>
  )
}

function ThinkingBlock({ content }: { content: string }): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const toggle = (): void => setExpanded((value) => !value)
  const preview = content.replace(/\s+/g, ' ').trim()

  return (
    <Box sx={{ alignSelf: 'stretch', minWidth: 0 }}>
      <Box
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            toggle()
          }
        }}
        aria-expanded={expanded}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          minWidth: 0,
          py: 0.5,
          px: 0.5,
          borderRadius: 1,
          cursor: 'pointer',
          color: 'text.secondary',
          transition: 'background-color 150ms',
          '&:hover': { bgcolor: 'action.hover' },
          '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' }
        }}
      >
        <ChevronRightIcon
          sx={{
            fontSize: 16,
            flexShrink: 0,
            transition: 'transform 150ms',
            transform: expanded ? 'rotate(90deg)' : 'none'
          }}
        />
        <Typography component="span" variant="body2" sx={{ fontStyle: 'italic', flexShrink: 0 }}>
          思考
        </Typography>
        {!expanded ? (
          <Typography
            component="span"
            variant="body2"
            noWrap
            sx={{ fontStyle: 'italic', flex: 1, minWidth: 0 }}
          >
            {preview}
          </Typography>
        ) : null}
      </Box>
      <Collapse in={expanded} unmountOnExit>
        <Box sx={{ ml: 2.5, pl: 1.5, py: 1, minWidth: 0, borderLeft: 2, borderColor: 'grey.800' }}>
          <Typography
            variant="body2"
            sx={{
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              fontStyle: 'italic',
              color: 'text.secondary'
            }}
          >
            {content}
          </Typography>
        </Box>
      </Collapse>
    </Box>
  )
}

type ViewProps = {
  messages: ChatItem[]
  input: string
  messagesContainerRef: (node: HTMLDivElement | null) => void
  canSend: boolean
  models: ModelOption[]
  selectedModel: ModelOption | null
  onSelectModel: (model: ModelOption | null) => void
  thinkingLevel: ThinkingLevel
  onSelectThinkingLevel: (level: ThinkingLevel) => void
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

  if (message.role === 'thinking') {
    return <ThinkingBlock content={message.content} />
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
  thinkingLevel,
  onSelectThinkingLevel,
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
            <ThinkingLevelControl
              thinkingLevel={thinkingLevel}
              onSelectThinkingLevel={onSelectThinkingLevel}
              supportedLevels={selectedModel?.thinkingLevels ?? null}
            />
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
