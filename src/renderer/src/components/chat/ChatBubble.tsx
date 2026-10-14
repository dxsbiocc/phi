import { Alert, AlertTitle, Box, Button, Typography } from '@mui/material'
import { memo, type ReactNode } from 'react'
import MarkdownContent, { type LocalPathKind } from '../MarkdownContent'
import { getProviderErrorDisplay } from '../../lib/providerErrors'
import { PhiIcons } from '../../icons'
import type { ChatMessage } from '../../types'
import {
  ChatUserMessage,
  type UserMessageRetryTarget,
  type UserMessageState
} from './ChatUserMessage'
import { ThinkingBlock } from './ThinkingBlock'
import type { ChatContentResizeHandler } from './useCollapseResizeNotifier'

export type ChatBubbleProps = {
  message: ChatMessage
  userMessageState?: UserMessageState
  onEditUserMessage?: (content: string) => void
  onRetryUserMessage?: (message: UserMessageRetryTarget) => void
  onForkUserMessage?: (messageId: string) => void
  onGoSettings: () => void
  onOpenBackgroundJobs: () => void
  onOpenLocalPath?: (path: string, pathKind: LocalPathKind) => void
  onOpenWebUrl?: (url: string) => void
  onContentResize?: ChatContentResizeHandler
  cwd?: string
}

// `message` keeps a stable object reference across reducer updates for every
// item that isn't the one currently being mutated (see agentEventReducer's
// `next[index] = { ...current, ... }` update), so a reference check here is
// enough to skip re-rendering (and re-parsing markdown for) every past
// message while the latest one streams in.
function chatBubblePropsEqual(prev: ChatBubbleProps, next: ChatBubbleProps): boolean {
  return (
    prev.message === next.message &&
    prev.cwd === next.cwd &&
    prev.userMessageState === next.userMessageState &&
    prev.onEditUserMessage === next.onEditUserMessage &&
    prev.onRetryUserMessage === next.onRetryUserMessage &&
    prev.onForkUserMessage === next.onForkUserMessage &&
    prev.onOpenBackgroundJobs === next.onOpenBackgroundJobs &&
    prev.onOpenWebUrl === next.onOpenWebUrl
  )
}

export const ChatBubble = memo(function ChatBubble({
  message,
  userMessageState,
  onEditUserMessage,
  onRetryUserMessage,
  onForkUserMessage,
  onGoSettings,
  onOpenBackgroundJobs,
  onOpenLocalPath,
  onOpenWebUrl,
  onContentResize,
  cwd = ''
}: ChatBubbleProps): ReactNode {
  if (message.contextCompaction) {
    const failed = message.role === 'error'
    const Icon = failed ? PhiIcons.state.blocked : PhiIcons.action.refresh
    return (
      <Box
        role={failed ? 'alert' : 'status'}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          minWidth: 0,
          px: 0.5,
          py: 0.5,
          color: failed ? 'error.main' : 'text.secondary'
        }}
      >
        <Icon aria-hidden sx={{ fontSize: 16, flexShrink: 0 }} />
        <Typography component="span" variant="body2" noWrap>
          {failed ? '上下文压缩失败' : '上下文已压缩'}
        </Typography>
      </Box>
    )
  }

  if (message.role === 'error') {
    const display = getProviderErrorDisplay(message.content)
    return (
      <Alert
        severity="error"
        variant="outlined"
        action={
          display.action === 'providerSettings' ? (
            <Button size="small" color="inherit" onClick={onGoSettings} sx={{ minHeight: 44 }}>
              {display.actionLabel}
            </Button>
          ) : undefined
        }
      >
        <AlertTitle>{display.title}</AlertTitle>
        <Typography variant="body2" sx={{ color: 'inherit', mb: 0.75 }}>
          {display.description}
        </Typography>
        {display.showRawMessage ? (
          <Typography variant="body2" sx={{ color: 'inherit', whiteSpace: 'pre-wrap' }}>
            原始错误：{display.rawMessage}
          </Typography>
        ) : null}
      </Alert>
    )
  }

  if (message.role === 'warning') {
    if (message.backgroundJobNotice) {
      return (
        <Button
          size="small"
          color={message.backgroundJobNotice.state === 'failed' ? 'error' : 'primary'}
          onClick={onOpenBackgroundJobs}
          sx={{ alignSelf: 'flex-start', textTransform: 'none' }}
        >
          {message.content.split('\n', 1)[0]} · 查看后台任务
        </Button>
      )
    }
    return (
      <Alert severity="info" variant="outlined">
        <Typography variant="body2" sx={{ color: 'inherit', whiteSpace: 'pre-wrap' }}>
          {message.content}
        </Typography>
      </Alert>
    )
  }

  if (message.role === 'thinking') {
    return (
      <ThinkingBlock
        content={message.content}
        durationMs={message.durationMs}
        onContentResize={onContentResize}
      />
    )
  }

  if (message.role === 'user') {
    return (
      <ChatUserMessage
        message={message}
        state={userMessageState}
        onEdit={onEditUserMessage}
        onRetry={onRetryUserMessage}
        onFork={onForkUserMessage}
      />
    )
  }

  return (
    <Box sx={{ alignSelf: 'stretch', minWidth: 0, px: 0.5 }}>
      <MarkdownContent
        text={message.content}
        cwd={cwd}
        onOpenLocalPath={onOpenLocalPath}
        onOpenWebUrl={onOpenWebUrl}
        showColorPalettes
      />
    </Box>
  )
}, chatBubblePropsEqual)
