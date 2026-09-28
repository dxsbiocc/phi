import { Box, IconButton, Typography } from '@mui/material'
import { PhiIcons } from '../../icons'
import { parseInputFileReferences } from '../../lib/inputReferences'
import type { ChatMessage } from '../../types'
import { FileReferenceCards } from './FileReferenceCards'
import { ChatUserImage } from '../../features/chat/components/ChatUserImage'

const CopyIcon = PhiIcons.action.copy
const EditIcon = PhiIcons.action.edit
const RetryIcon = PhiIcons.action.refresh
const ForkIcon = PhiIcons.action.fork

export type UserMessageState = 'normal' | 'failed'
export type UserMessageRetryTarget = Pick<ChatMessage, 'id' | 'content' | 'images'>

function copyMessageContent(content: string): void {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return
  void navigator.clipboard.writeText(content)
}

export function ChatUserMessage({
  message,
  state = 'normal',
  onEdit,
  onRetry,
  onFork
}: {
  message: ChatMessage
  state?: UserMessageState
  onEdit?: (content: string) => void
  onRetry?: (message: UserMessageRetryTarget) => void
  onFork?: (messageId: string) => void
}): React.JSX.Element {
  const parsedMessage = parseInputFileReferences(message.content)
  const failed = state === 'failed'
  const actionButtonSx = {
    width: 28,
    height: 28,
    bgcolor: 'transparent',
    color: failed ? 'primary.main' : 'text.secondary',
    '&:hover': {
      bgcolor: failed ? 'primary.main' : 'action.hover',
      color: failed ? 'primary.contrastText' : 'text.primary'
    }
  } as const

  return (
    <>
      <FileReferenceCards paths={parsedMessage.references} variant="message" />
      {parsedMessage.body || message.images?.length ? (
        <Box
          sx={{
            alignSelf: 'flex-end',
            maxWidth: '75%',
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: 0.5,
            '& [data-phi-user-message-actions="true"]': {
              opacity: 0,
              pointerEvents: 'none',
              transform: 'translateY(-2px)',
              transition: 'opacity 120ms, transform 120ms'
            },
            '&:hover [data-phi-user-message-actions="true"], &:focus-within [data-phi-user-message-actions="true"]':
              {
                opacity: 1,
                pointerEvents: 'auto',
                transform: 'translateY(0)'
              },
            '@media (hover: none)': {
              '& [data-phi-user-message-actions="true"]': {
                opacity: 1,
                pointerEvents: 'auto',
                transform: 'none'
              }
            }
          }}
        >
          <Box
            sx={{
              minWidth: 0,
              px: 2,
              py: 1.25,
              bgcolor: 'primary.main',
              color: 'background.default',
              borderRadius: '18px'
            }}
          >
            {message.images?.map((image, index) => (
              <ChatUserImage image={image} index={index} key={index} />
            ))}
            {parsedMessage.body && (
              <Typography
                variant="body1"
                sx={{
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  lineHeight: 1.6,
                  fontSize: '0.95rem'
                }}
              >
                {parsedMessage.body}
              </Typography>
            )}
          </Box>
          {(failed || parsedMessage.body || !message.images?.length || onFork) && (
            <Box
              data-phi-user-message-actions="true"
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
                minHeight: 28
              }}
            >
              {failed ? (
                <IconButton
                  type="button"
                  size="small"
                  aria-label="重试消息"
                  title="重试消息"
                  onClick={() =>
                    onRetry?.({ id: message.id, content: message.content, images: message.images })
                  }
                  sx={actionButtonSx}
                >
                  <RetryIcon size={14} />
                </IconButton>
              ) : (
                <>
                  {parsedMessage.body && (
                    <IconButton
                      type="button"
                      size="small"
                      aria-label="复制消息"
                      title="复制消息"
                      onClick={() => copyMessageContent(message.content)}
                      sx={actionButtonSx}
                    >
                      <CopyIcon size={14} />
                    </IconButton>
                  )}
                  {!message.images?.length && (
                    <IconButton
                      type="button"
                      size="small"
                      aria-label="编辑消息"
                      title="编辑消息"
                      onClick={() => onEdit?.(message.content)}
                      sx={actionButtonSx}
                    >
                      <EditIcon size={14} />
                    </IconButton>
                  )}
                  {onFork && (
                    <IconButton
                      type="button"
                      size="small"
                      aria-label="从此消息分叉会话"
                      title="从此消息分叉会话"
                      onClick={() => onFork(message.id)}
                      sx={actionButtonSx}
                    >
                      <ForkIcon size={14} />
                    </IconButton>
                  )}
                </>
              )}
            </Box>
          )}
        </Box>
      ) : null}
    </>
  )
}
