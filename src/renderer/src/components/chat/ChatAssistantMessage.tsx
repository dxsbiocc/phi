import { chatCopy } from '../../features/chat/lib/chatCopy'
import { useUiLanguage } from '../../lib/i18n'
import { stripSuggestedNextActionFromText } from '../../lib/suggestedNextAction'
import { Box, IconButton } from '@mui/material'
import { useEffect, useRef, useState } from 'react'
import { PhiIcons } from '../../icons'
import type { ChatMessage } from '../../types'
import MarkdownContent, { type LocalPathKind } from '../MarkdownContent'

const CopyIcon = PhiIcons.action.copy
const CopiedIcon = PhiIcons.state.check
const ForkIcon = PhiIcons.action.fork

export function ChatAssistantMessage({
  message,
  forkUserMessageId,
  onFork,
  onOpenLocalPath,
  onOpenWebUrl,
  showActions = true,
  cwd
}: {
  message: ChatMessage
  forkUserMessageId?: string
  onFork?: (messageId: string) => void
  onOpenLocalPath?: (path: string, pathKind: LocalPathKind) => void
  onOpenWebUrl?: (url: string) => void
  showActions?: boolean
  cwd: string
}): React.JSX.Element {
  useUiLanguage()
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
    },
    []
  )

  const displayContent = showActions
    ? stripSuggestedNextActionFromText(message.content)
    : message.content

  const copyMessage = async (): Promise<void> => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return
    try {
      await navigator.clipboard.writeText(displayContent)
      setCopied(true)
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Box
      sx={{
        alignSelf: 'stretch',
        minWidth: 0,
        ...(showActions
          ? {
              '& [data-phi-assistant-message-actions="true"]': {
                opacity: 0,
                pointerEvents: 'none',
                transform: 'translateY(-2px)',
                transition: 'opacity 120ms, transform 120ms'
              },
              '&:hover [data-phi-assistant-message-actions="true"], &:focus-within [data-phi-assistant-message-actions="true"]':
                {
                  opacity: 1,
                  pointerEvents: 'auto',
                  transform: 'translateY(0)'
                },
              '@media (hover: none)': {
                '& [data-phi-assistant-message-actions="true"]': {
                  opacity: 1,
                  pointerEvents: 'auto',
                  transform: 'none'
                }
              }
            }
          : null)
      }}
    >
      <MarkdownContent
        text={displayContent}
        cwd={cwd}
        onOpenLocalPath={onOpenLocalPath}
        onOpenWebUrl={onOpenWebUrl}
        allowCodeActions
        showColorPalettes
      />
      {showActions && displayContent && (
        <Box
          data-phi-assistant-message-actions="true"
          sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minHeight: 28 }}
        >
          <IconButton
            type="button"
            size="small"
            aria-label={copied ? chatCopy.messageCopied : chatCopy.copyMessage}
            title={copied ? chatCopy.messageCopied : chatCopy.copyMessage}
            onClick={() => void copyMessage()}
            sx={{ width: 28, height: 28, color: 'text.secondary' }}
          >
            {copied ? <CopiedIcon size={14} /> : <CopyIcon size={14} />}
          </IconButton>
          {onFork && forkUserMessageId && (
            <IconButton
              type="button"
              size="small"
              data-testid="gui-e2e-fork-message"
              aria-label={chatCopy.forkConversationFromThisMessage}
              title={chatCopy.forkConversationFromThisMessage}
              onClick={() => onFork(forkUserMessageId)}
              sx={{ width: 28, height: 28, color: 'text.secondary' }}
            >
              <ForkIcon size={14} />
            </IconButton>
          )}
        </Box>
      )}
    </Box>
  )
}
