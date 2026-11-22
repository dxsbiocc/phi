import { chatCopy } from '../../features/chat/lib/chatCopy'
import { useUiLanguage } from '../../lib/i18n'
import { Box, Button, IconButton, Paper, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { useEffect, useRef, useState } from 'react'
import { PhiIcons } from '../../icons'
import { parseInputFileReferences } from '../../lib/inputReferences'
import type { ChatMessage } from '../../types'
import { FileReferenceCards } from './FileReferenceCards'
import { ChatUserImage } from '../../features/chat/components/ChatUserImage'
import { ResourceMentionText } from '../ResourceMention'
import { composerSurfaceSx, REGULAR_COMPOSER_ACTION_SIZE } from './composerControlStyles'
import { ComposerTextEditor, type ComposerTextEditorHandle } from './ComposerTextEditor'

const CopyIcon = PhiIcons.action.copy
const CopiedIcon = PhiIcons.state.check
const EditIcon = PhiIcons.action.edit
const RetryIcon = PhiIcons.action.refresh

export type UserMessageState = 'normal' | 'failed'
export type UserMessageRetryTarget = Pick<ChatMessage, 'id' | 'content' | 'images'>

export function ChatUserMessage({
  message,
  state = 'normal',
  onEdit,
  onRetry
}: {
  message: ChatMessage
  state?: UserMessageState
  onEdit?: (message: UserMessageRetryTarget) => Promise<void> | void
  onRetry?: (message: UserMessageRetryTarget) => Promise<void> | void
}): React.JSX.Element {
  useUiLanguage()
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const [saving, setSaving] = useState(false)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const editorRef = useRef<ComposerTextEditorHandle | null>(null)
  const parsedMessage = parseInputFileReferences(message.content)
  const failed = state === 'failed'

  useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
    },
    []
  )

  const copyMessage = async (): Promise<void> => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return
    try {
      await navigator.clipboard.writeText(message.content)
      setCopied(true)
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }
  const saveEdit = async (): Promise<void> => {
    const content = draft.trim()
    if (!content || saving || !onEdit) return
    setSaving(true)
    try {
      await onEdit({ id: message.id, content, images: message.images })
      setEditing(false)
    } catch {
      return
    } finally {
      setSaving(false)
    }
  }
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

  if (editing) {
    return (
      <>
        <FileReferenceCards paths={parsedMessage.references} variant="message" />
        <Box data-phi-user-message-editor sx={{ alignSelf: 'stretch', width: '100%', minWidth: 0 }}>
          <Paper variant="outlined" sx={composerSurfaceSx({ compact: false, dragActive: false })}>
            <ComposerTextEditor
              inputRef={editorRef}
              value={draft}
              resources={[]}
              disabled={saving}
              ariaLabel={chatCopy.editMessage}
              focusKey="message-edit"
              autoFocus
              onChange={(value) => setDraft(value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setEditing(false)
                  return true
                }
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  void saveEdit()
                  return true
                }
                return false
              }}
            />
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                gap: 1,
                minHeight: REGULAR_COMPOSER_ACTION_SIZE,
                mt: 1
              }}
            >
              <Button
                size="small"
                variant="outlined"
                color="inherit"
                disabled={saving}
                onClick={() => setEditing(false)}
              >
                {chatCopy.cancelMessageEdit}
              </Button>
              <Button
                size="small"
                variant="contained"
                disabled={!draft.trim() || saving}
                onClick={() => void saveEdit()}
              >
                {chatCopy.saveMessageEdit}
              </Button>
            </Box>
          </Paper>
        </Box>
      </>
    )
  }

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
              bgcolor: (theme) =>
                alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.22 : 0.12),
              color: 'text.primary',
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
                <ResourceMentionText text={parsedMessage.body} inheritColor protectCode />
              </Typography>
            )}
          </Box>
          {(failed || parsedMessage.body || !message.images?.length) && (
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
                  aria-label={chatCopy.retryMessage}
                  title={chatCopy.retryMessage}
                  onClick={() =>
                    onRetry?.({
                      id: message.id,
                      content: message.content,
                      images: message.images
                    })
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
                      aria-label={copied ? chatCopy.messageCopied : chatCopy.copyMessage}
                      title={copied ? chatCopy.messageCopied : chatCopy.copyMessage}
                      onClick={() => void copyMessage()}
                      sx={actionButtonSx}
                    >
                      {copied ? <CopiedIcon size={14} /> : <CopyIcon size={14} />}
                    </IconButton>
                  )}
                  {!message.images?.length && onEdit && (
                    <IconButton
                      type="button"
                      size="small"
                      aria-label={chatCopy.editMessage}
                      title={chatCopy.editMessage}
                      onClick={() => {
                        setDraft(message.content)
                        setEditing(true)
                      }}
                      sx={actionButtonSx}
                    >
                      <EditIcon size={14} />
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
