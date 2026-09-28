import { Alert, AlertTitle, Box, Button, Typography } from '@mui/material'
import { memo, type ReactNode } from 'react'
import MarkdownContent, { type LocalPathKind } from '../MarkdownContent'
import { getProviderErrorDisplay } from '../../lib/providerErrors'
import type { ChatMessage } from '../../types'
import {
  ChatUserMessage,
  type UserMessageRetryTarget,
  type UserMessageState
} from './ChatUserMessage'
import { ThinkingBlock } from './ThinkingBlock'
import type { ChatContentResizeHandler } from './useCollapseResizeNotifier'

function compactionActionLabel(action: string): string {
  switch (action) {
    case 'manual':
      return '手动压缩'
    case 'remote':
      return '自动压缩 · 服务端'
    case 'context-full':
    case 'soft':
      return '自动压缩 · 摘要'
    case 'handoff':
      return '自动压缩 · 交接摘要'
    case 'shake':
      return '自动压缩 · 精简内容'
    case 'snapcompact':
      return '自动压缩 · 图像归档'
    default:
      return '方式未记录'
  }
}

export type ChatBubbleProps = {
  message: ChatMessage
  userMessageState?: UserMessageState
  onEditUserMessage?: (content: string) => void
  onRetryUserMessage?: (message: UserMessageRetryTarget) => void
  onForkUserMessage?: (messageId: string) => void
  onGoSettings: () => void
  onOpenLocalPath?: (path: string, pathKind: LocalPathKind) => void
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
    prev.onForkUserMessage === next.onForkUserMessage
  )
}

export const ChatBubble = memo(function ChatBubble({
  message,
  userMessageState,
  onEditUserMessage,
  onRetryUserMessage,
  onForkUserMessage,
  onGoSettings,
  onOpenLocalPath,
  onContentResize,
  cwd = ''
}: ChatBubbleProps): ReactNode {
  if (message.contextCompaction) {
    const detail = message.contextCompaction
    const failed = message.role === 'error'
    const before = detail.tokensBefore?.toLocaleString('zh-CN') ?? '未提供'
    const after = detail.tokensAfter?.toLocaleString('zh-CN') ?? '未提供'
    const description = failed
      ? message.content.replace(/^上下文压缩失败[：:]?/, '') || '原因未提供'
      : message.content.replace(/^上下文已压缩，?/, '')
    return (
      <Alert severity={failed ? 'error' : 'info'} variant="outlined">
        <AlertTitle>{failed ? '上下文压缩失败' : '上下文已压缩'}</AlertTitle>
        <Typography variant="caption" sx={{ color: 'inherit', display: 'block', mb: 0.5 }}>
          {compactionActionLabel(detail.action)}
        </Typography>
        <Typography variant="body2" sx={{ color: 'inherit', whiteSpace: 'pre-wrap' }}>
          {description}
        </Typography>
        {!failed && (detail.tokensBefore !== undefined || detail.tokensAfter !== undefined) && (
          <Typography variant="body2" sx={{ color: 'inherit', mt: 0.75 }}>
            压缩前 {before} tokens → 压缩后{' '}
            {detail.tokensAfter === undefined ? '未提供' : `约 ${after} tokens`}
          </Typography>
        )}
        {detail.shortSummary && (
          <Typography variant="body2" sx={{ color: 'inherit', mt: 0.75, whiteSpace: 'pre-wrap' }}>
            摘要：{detail.shortSummary}
          </Typography>
        )}
        {detail.summary && detail.summary !== detail.shortSummary && (
          <Box component="details" sx={{ mt: 0.75 }}>
            <Box component="summary" sx={{ cursor: 'pointer', fontSize: '0.875rem' }}>
              查看完整摘要
            </Box>
            <Typography variant="body2" sx={{ color: 'inherit', mt: 0.75, whiteSpace: 'pre-wrap' }}>
              {detail.summary}
            </Typography>
          </Box>
        )}
      </Alert>
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
      <MarkdownContent text={message.content} cwd={cwd} onOpenLocalPath={onOpenLocalPath} />
    </Box>
  )
}, chatBubblePropsEqual)
