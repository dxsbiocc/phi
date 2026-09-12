import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Collapse,
  IconButton,
  Paper,
  TextField,
  Typography
} from '@mui/material'
import {
  useEffect,
  useId,
  useMemo,
  memo,
  useCallback,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type ReactNode
} from 'react'
import MarkdownContent, { type LocalPathKind } from './MarkdownContent'
import ToolCallCard, { StatusIndicator } from './ToolCallCard'
import ToolGroupCard from './ToolGroupCard'
import ToolApprovalDialog from './ToolApprovalDialog'
import { WrapperPlanCard } from '../features/wrapper/components/WrapperPlanCard'
import {
  ModelSelectorControl,
  PermissionModeControl,
  ThinkingLevelControl
} from './chat/ChatComposerControls'
import { InputAddControl, InputAddPanel } from './chat/InputAddMenu'
import { ThinkingBlock } from './chat/ThinkingBlock'
import {
  COMPACT_COMPOSER_CONTROL_SIZE,
  REGULAR_COMPOSER_ACTION_SIZE
} from './chat/composerControlStyles'
import { PhiIcons } from '../icons'
import {
  nextPromptHistoryCursor,
  promptHistoryFromMessages,
  type PromptHistoryDirection
} from '../lib/promptHistory'
import { appendInputReference } from '../lib/inputReferences'
import { getProviderErrorDisplay } from '../lib/providerErrors'
import {
  groupMessages,
  groupProcessingItems,
  processingGroupStatus,
  processingStatusText,
  timestampMs,
  type ProcessingItem
} from '../lib/chatRenderGroups'
import { suggestedNextActionPlaceholderFromMessages } from '../lib/suggestedNextAction'
import type {
  ChatItem,
  ChatMessage,
  ModelOption,
  NotebookCellJumpTarget,
  PermissionMode,
  PluginCatalogItem,
  PromptAgentSummary,
  SkillSummary,
  ThinkingLevel,
  ToolApprovalRequest
} from '../types'

export { ThinkingBlock } from './chat/ThinkingBlock'

const ChevronRightIcon = PhiIcons.action.back
const ExpandLessIcon = PhiIcons.action.collapse
const SendIcon = PhiIcons.action.send
const StopIcon = PhiIcons.action.stop

function textInputFromEventTarget(
  target: EventTarget | null
): HTMLInputElement | HTMLTextAreaElement | null {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return target
  }
  return null
}

function isTextInputAtHistoryBoundary(
  inputElement: HTMLInputElement | HTMLTextAreaElement,
  direction: PromptHistoryDirection
): boolean {
  const { selectionStart, selectionEnd, value } = inputElement
  if (selectionStart === null || selectionEnd === null) return true
  if (selectionStart !== selectionEnd) return false
  if (value.length === 0) return true

  if (direction === 'previous') {
    return value.lastIndexOf('\n', Math.max(0, selectionStart - 1)) === -1
  }
  return value.indexOf('\n', selectionEnd) === -1
}

function ProcessingGroup({
  items,
  onGoSettings,
  onOpenLocalPath,
  onJumpToNotebookCell,
  cwd = '',
  isActive = false,
  startedAtMs,
  completedAtMs,
  durationMs
}: {
  items: ProcessingItem[]
  onGoSettings: () => void
  onOpenLocalPath?: (path: string, pathKind: LocalPathKind) => void
  onJumpToNotebookCell?: (target: NotebookCellJumpTarget) => void
  cwd?: string
  isActive?: boolean
  startedAtMs?: number
  completedAtMs?: number
  durationMs?: number
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const [fallbackStartedAtMs] = useState(() => Date.now())
  const [nowMs, setNowMs] = useState(() => Date.now())
  const toggle = (): void => setExpanded((value) => !value)
  const groupedItems = groupProcessingItems(items)
  const status = processingGroupStatus(items, isActive)
  const isProcessingActive = status === 'running'
  const summary = processingStatusText({
    items,
    isActive: isProcessingActive,
    nowMs,
    fallbackStartedAtMs,
    startedAtMs,
    completedAtMs,
    durationMs
  })

  useEffect(() => {
    if (!isProcessingActive) return undefined
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [isProcessingActive])

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
        aria-label={expanded ? '折叠处理过程' : '展开处理过程'}
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
        <Typography component="span" variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
          {summary}
        </Typography>
        {status ? (
          <Box sx={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
            <StatusIndicator status={status} />
          </Box>
        ) : null}
      </Box>
      <Collapse in={expanded} unmountOnExit>
        <Box sx={{ ml: 2.5, pl: 1.5, minWidth: 0, borderLeft: 2, borderColor: 'grey.800' }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, py: 0.5 }}>
            {groupedItems.map((group) => {
              if (group.kind === 'tool-group') {
                return (
                  <ToolGroupCard
                    key={group.key}
                    items={group.items}
                    cwd={cwd}
                    onJumpToNotebookCell={onJumpToNotebookCell}
                  />
                )
              }
              if (group.kind === 'processing-group') {
                return (
                  <ProcessingGroup
                    key={group.key}
                    items={group.items}
                    onGoSettings={onGoSettings}
                    onOpenLocalPath={onOpenLocalPath}
                    onJumpToNotebookCell={onJumpToNotebookCell}
                    cwd={cwd}
                    isActive={false}
                    startedAtMs={group.startedAtMs}
                    completedAtMs={group.completedAtMs}
                    durationMs={group.durationMs}
                  />
                )
              }
              if (group.item.role === 'tool') {
                return (
                  <ToolCallCard
                    key={group.key}
                    item={group.item}
                    cwd={cwd}
                    onJumpToNotebookCell={onJumpToNotebookCell}
                  />
                )
              }
              if (group.item.role === 'wrapper_plan') {
                return <WrapperPlanCard key={group.key} item={group.item} />
              }
              return (
                <ChatBubble
                  key={group.key}
                  message={group.item}
                  onGoSettings={onGoSettings}
                  onOpenLocalPath={onOpenLocalPath}
                  cwd={cwd}
                />
              )
            })}
          </Box>
          <Box sx={{ display: 'flex', justifyContent: 'flex-start', pb: 0.5 }}>
            <IconButton
              size="small"
              aria-label="折叠处理过程"
              title="折叠处理过程"
              onClick={toggle}
              sx={{
                width: 28,
                height: 28,
                color: 'text.secondary'
              }}
            >
              <ExpandLessIcon fontSize="small" />
            </IconButton>
          </Box>
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
  isGenerating: boolean
  currentRunStartedAt?: string
  models: ModelOption[]
  selectedModel: ModelOption | null
  skills?: SkillSummary[]
  promptAgents?: PromptAgentSummary[]
  plugins?: PluginCatalogItem[]
  onSelectModel: (model: ModelOption | null) => void
  thinkingLevel: ThinkingLevel
  onSelectThinkingLevel: (level: ThinkingLevel) => void
  onInputChange: (value: string) => void
  onOpenInputAddMenu?: () => void
  onPickInputFiles?: () => Promise<string[]>
  onChatSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>
  onStopGeneration: () => Promise<void>
  onGoSettings: () => void
  permissionMode: PermissionMode
  onSelectPermissionMode: (mode: PermissionMode) => void
  disablePermissionModeSelect?: boolean
  disableModelControls?: boolean
  compactComposerControls?: boolean
  pendingApproval: ToolApprovalRequest | null
  onRespondApproval: (requestId: string, approved: boolean) => void
  onOpenApprovalSession: (path: string) => void
  onOpenLocalPath?: (path: string, pathKind: LocalPathKind) => void
  onJumpToNotebookCell?: (target: NotebookCellJumpTarget) => void
  cwd?: string
}

function ChatBubble({
  message,
  onGoSettings,
  onOpenLocalPath,
  cwd = ''
}: {
  message: ChatMessage
  onGoSettings: () => void
  onOpenLocalPath?: (path: string, pathKind: LocalPathKind) => void
  cwd?: string
}): ReactNode {
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
    return <ThinkingBlock content={message.content} durationMs={message.durationMs} />
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
      <MarkdownContent text={message.content} cwd={cwd} onOpenLocalPath={onOpenLocalPath} />
    </Box>
  )
}

type ChatMessageListProps = {
  messages: ChatItem[]
  messagesContainerRef: (node: HTMLDivElement | null) => void
  isGenerating: boolean
  currentRunStartedAt?: string
  onGoSettings: () => void
  onOpenLocalPath?: (path: string, pathKind: LocalPathKind) => void
  onJumpToNotebookCell?: (target: NotebookCellJumpTarget) => void
  cwd?: string
}

const ChatMessageList = memo(function ChatMessageList({
  messages,
  messagesContainerRef,
  isGenerating,
  currentRunStartedAt,
  onGoSettings,
  onOpenLocalPath,
  onJumpToNotebookCell,
  cwd = ''
}: ChatMessageListProps): React.JSX.Element {
  const renderGroups = useMemo(
    () => groupMessages(messages, { activeRun: isGenerating }),
    [isGenerating, messages]
  )

  return (
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
        {renderGroups.map((group, index) => {
          if (group.kind === 'tool-group') {
            return (
              <ToolGroupCard
                key={group.key}
                items={group.items}
                cwd={cwd}
                onJumpToNotebookCell={onJumpToNotebookCell}
              />
            )
          }
          if (group.kind === 'processing-group') {
            const isActiveProcessingGroup = isGenerating && index === renderGroups.length - 1
            return (
              <ProcessingGroup
                key={group.key}
                items={group.items}
                onGoSettings={onGoSettings}
                onOpenLocalPath={onOpenLocalPath}
                onJumpToNotebookCell={onJumpToNotebookCell}
                cwd={cwd}
                isActive={isActiveProcessingGroup}
                startedAtMs={
                  isActiveProcessingGroup
                    ? (timestampMs(currentRunStartedAt) ?? group.startedAtMs)
                    : group.startedAtMs
                }
                completedAtMs={group.completedAtMs}
                durationMs={group.durationMs}
              />
            )
          }
          if (group.item.role === 'tool') {
            return (
              <ToolCallCard
                key={group.key}
                item={group.item}
                cwd={cwd}
                onJumpToNotebookCell={onJumpToNotebookCell}
              />
            )
          }
          if (group.item.role === 'wrapper_plan') {
            return <WrapperPlanCard key={group.key} item={group.item} />
          }
          return (
            <ChatBubble
              key={group.key}
              message={group.item}
              onGoSettings={onGoSettings}
              onOpenLocalPath={onOpenLocalPath}
              cwd={cwd}
            />
          )
        })}
      </Box>
    </Box>
  )
})

function ChatView({
  messages,
  input,
  messagesContainerRef,
  canSend,
  isGenerating,
  currentRunStartedAt,
  models,
  selectedModel,
  skills = [],
  promptAgents = [],
  plugins = [],
  onSelectModel,
  thinkingLevel,
  onSelectThinkingLevel,
  onInputChange,
  onOpenInputAddMenu,
  onPickInputFiles,
  onChatSubmit,
  onStopGeneration,
  onGoSettings,
  permissionMode,
  onSelectPermissionMode,
  disablePermissionModeSelect = false,
  disableModelControls = false,
  compactComposerControls = false,
  pendingApproval,
  onRespondApproval,
  onOpenApprovalSession,
  onOpenLocalPath,
  onJumpToNotebookCell,
  cwd = ''
}: ViewProps): React.JSX.Element {
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)
  const promptHistory = useMemo(() => promptHistoryFromMessages(messages), [messages])
  const promptHistoryKey = useMemo(() => promptHistory.join('\u0000'), [promptHistory])
  const promptHistoryCursorRef = useRef<number | null>(null)
  const promptHistoryDraftRef = useRef('')
  const promptHistoryKeyRef = useRef(promptHistoryKey)
  const inputAddPanelId = useId()
  const [inputAddMenuOpen, setInputAddMenuOpen] = useState(false)
  const inputAddPanelRef = useRef<HTMLDivElement | null>(null)
  const inputAddButtonRef = useRef<HTMLButtonElement | null>(null)
  const actionControlSize = compactComposerControls
    ? COMPACT_COMPOSER_CONTROL_SIZE
    : REGULAR_COMPOSER_ACTION_SIZE
  const suggestedNextAction = useMemo(
    () => (!isGenerating ? suggestedNextActionPlaceholderFromMessages(messages) : null),
    [isGenerating, messages]
  )
  const defaultInputPlaceholder = compactComposerControls
    ? '输入消息'
    : '输入消息，Enter 发送，Shift+Enter 换行'
  const inputPlaceholder = suggestedNextAction ?? defaultInputPlaceholder

  const resetPromptHistoryNavigation = useCallback((): void => {
    promptHistoryKeyRef.current = promptHistoryKey
    promptHistoryCursorRef.current = null
    promptHistoryDraftRef.current = ''
  }, [promptHistoryKey])

  const syncPromptHistoryKey = useCallback((): void => {
    if (promptHistoryKeyRef.current !== promptHistoryKey) {
      resetPromptHistoryNavigation()
    }
  }, [promptHistoryKey, resetPromptHistoryNavigation])

  const focusInputFromComposerSurface = useCallback((event: MouseEvent<HTMLElement>): void => {
    const target = event.target
    if (!(target instanceof HTMLElement)) {
      inputRef.current?.focus({ preventScroll: true })
      return
    }

    if (
      target.closest(
        'button, a, input, textarea, select, [role="button"], [role="menuitem"], [aria-haspopup="true"]'
      )
    ) {
      return
    }

    event.preventDefault()
    inputRef.current?.focus({ preventScroll: true })
  }, [])

  const navigatePromptHistory = useCallback(
    (direction: PromptHistoryDirection): boolean => {
      syncPromptHistoryKey()
      if (promptHistory.length === 0) return false
      const currentCursor = promptHistoryCursorRef.current
      if (direction === 'next' && currentCursor === null) return false

      const nextCursor = nextPromptHistoryCursor(promptHistory.length, currentCursor, direction)
      if (currentCursor === null) {
        promptHistoryDraftRef.current = input
      }

      promptHistoryCursorRef.current = nextCursor
      const nextValue =
        nextCursor === null ? promptHistoryDraftRef.current : promptHistory[nextCursor]
      onInputChange(nextValue)

      window.requestAnimationFrame(() => {
        const inputElement = inputRef.current
        inputElement?.focus({ preventScroll: true })
        inputElement?.setSelectionRange(nextValue.length, nextValue.length)
      })

      return true
    },
    [input, onInputChange, promptHistory, syncPromptHistoryKey]
  )
  const closeInputAddMenu = useCallback((): void => {
    setInputAddMenuOpen(false)
  }, [])
  const toggleInputAddMenu = useCallback((): void => {
    setInputAddMenuOpen((open) => {
      const nextOpen = !open
      if (nextOpen) {
        onOpenInputAddMenu?.()
      }
      return nextOpen
    })
  }, [onOpenInputAddMenu])
  useEffect(() => {
    if (!inputAddMenuOpen) return undefined

    const handleDocumentMouseDown = (event: globalThis.MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (inputAddPanelRef.current?.contains(target)) return
      if (inputAddButtonRef.current?.contains(target)) return
      closeInputAddMenu()
    }

    document.addEventListener('mousedown', handleDocumentMouseDown, true)
    return () => {
      document.removeEventListener('mousedown', handleDocumentMouseDown, true)
    }
  }, [closeInputAddMenu, inputAddMenuOpen])
  const insertInputReference = useCallback(
    (reference: string): void => {
      resetPromptHistoryNavigation()
      const nextValue = appendInputReference(input, reference)
      promptHistoryDraftRef.current = nextValue
      onInputChange(nextValue)

      window.requestAnimationFrame(() => {
        const inputElement = inputRef.current
        inputElement?.focus({ preventScroll: true })
        inputElement?.setSelectionRange(nextValue.length, nextValue.length)
      })
    },
    [input, onInputChange, resetPromptHistoryNavigation]
  )
  const applySuggestedNextAction = useCallback(
    (event: MouseEvent<HTMLElement>): void => {
      if (event.button !== 0 || !suggestedNextAction || input.trim()) return
      event.preventDefault()
      resetPromptHistoryNavigation()
      promptHistoryDraftRef.current = suggestedNextAction
      onInputChange(suggestedNextAction)

      window.requestAnimationFrame(() => {
        const inputElement = inputRef.current
        inputElement?.focus({ preventScroll: true })
        inputElement?.setSelectionRange(suggestedNextAction.length, suggestedNextAction.length)
      })
    },
    [input, onInputChange, resetPromptHistoryNavigation, suggestedNextAction]
  )
  const handleChatSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): Promise<void> => {
      closeInputAddMenu()
      return onChatSubmit(event)
    },
    [closeInputAddMenu, onChatSubmit]
  )

  return (
    <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ChatMessageList
        messages={messages}
        messagesContainerRef={messagesContainerRef}
        isGenerating={isGenerating}
        currentRunStartedAt={currentRunStartedAt}
        onGoSettings={onGoSettings}
        onOpenLocalPath={onOpenLocalPath}
        onJumpToNotebookCell={onJumpToNotebookCell}
        cwd={cwd}
      />
      <Box
        sx={{
          px: 2,
          pt: 1.5,
          pb: 2,
          flexShrink: 0
        }}
      >
        <Box component="form" onSubmit={handleChatSubmit} sx={{ maxWidth: 892, mx: 'auto' }}>
          <ToolApprovalDialog
            request={pendingApproval}
            onRespond={onRespondApproval}
            onOpenSession={onOpenApprovalSession}
          />
          {inputAddMenuOpen && (
            <InputAddPanel
              panelId={inputAddPanelId}
              panelRef={inputAddPanelRef}
              skills={skills}
              promptAgents={promptAgents}
              plugins={plugins}
              onPickFiles={onPickInputFiles}
              onInsertReference={insertInputReference}
              onClose={closeInputAddMenu}
            />
          )}
          <Paper
            variant="outlined"
            onMouseDownCapture={focusInputFromComposerSurface}
            sx={{
              borderRadius: 2,
              px: compactComposerControls ? 1.25 : 2,
              pt: 1.5,
              pb: 1,
              cursor: 'text',
              borderColor: (theme) =>
                theme.palette.mode === 'dark'
                  ? 'rgba(241, 246, 246, 0.18)'
                  : 'rgba(15, 42, 48, 0.14)',
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
              inputRef={inputRef}
              value={input}
              onMouseDown={applySuggestedNextAction}
              onChange={(event) => {
                resetPromptHistoryNavigation()
                promptHistoryDraftRef.current = event.target.value
                onInputChange(event.target.value)
              }}
              onKeyDown={(event) => {
                const historyDirection =
                  event.key === 'ArrowUp' ? 'previous' : event.key === 'ArrowDown' ? 'next' : null
                if (
                  historyDirection &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.nativeEvent.isComposing
                ) {
                  const inputElement = textInputFromEventTarget(event.target)
                  if (
                    inputElement &&
                    isTextInputAtHistoryBoundary(inputElement, historyDirection) &&
                    navigatePromptHistory(historyDirection)
                  ) {
                    event.preventDefault()
                    return
                  }
                }

                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  canSend &&
                  input.trim()
                ) {
                  event.preventDefault()
                  event.currentTarget.closest('form')?.requestSubmit()
                }
              }}
              placeholder={inputPlaceholder}
              slotProps={{
                htmlInput: {
                  'data-phi-focus': 'chat-input',
                  'data-phi-placeholder-kind': suggestedNextAction
                    ? 'suggested-next-action'
                    : 'default'
                },
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
                justifyContent: 'space-between',
                gap: 1,
                mt: 1
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, minWidth: 0 }}>
                <InputAddControl
                  open={inputAddMenuOpen}
                  controls={inputAddPanelId}
                  buttonRef={inputAddButtonRef}
                  onToggle={toggleInputAddMenu}
                />
                <PermissionModeControl
                  permissionMode={permissionMode}
                  disabled={disablePermissionModeSelect}
                  onSelectPermissionMode={onSelectPermissionMode}
                  compact={compactComposerControls}
                />
              </Box>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: compactComposerControls ? 0.25 : 1,
                  minWidth: 0
                }}
              >
                <ThinkingLevelControl
                  thinkingLevel={thinkingLevel}
                  onSelectThinkingLevel={onSelectThinkingLevel}
                  supportedLevels={selectedModel?.thinkingLevels ?? null}
                  disabled={disableModelControls}
                  compact={compactComposerControls}
                />
                <ModelSelectorControl
                  models={models}
                  selectedModel={selectedModel}
                  onSelectModel={onSelectModel}
                  disabled={disableModelControls}
                  compact={compactComposerControls}
                />
                {!isGenerating ? (
                  <IconButton
                    type="submit"
                    disabled={!canSend || !input.trim()}
                    aria-label="发送消息"
                    data-phi-composer-action="send"
                    data-phi-composer-size={actionControlSize}
                    sx={{
                      boxSizing: 'border-box',
                      width: actionControlSize,
                      height: actionControlSize,
                      minWidth: actionControlSize,
                      minHeight: actionControlSize,
                      p: 0,
                      flexShrink: 0,
                      bgcolor: 'primary.main',
                      color: 'background.default',
                      transition: 'background-color 200ms',
                      '&:hover': { bgcolor: 'primary.dark' },
                      '&.Mui-disabled': {
                        bgcolor: 'action.disabledBackground',
                        color: 'action.disabled'
                      }
                    }}
                  >
                    <SendIcon fontSize="small" />
                  </IconButton>
                ) : (
                  <IconButton
                    type="button"
                    onClick={() => {
                      void onStopGeneration()
                    }}
                    aria-label="停止生成"
                    data-phi-composer-action="stop"
                    data-phi-composer-size={actionControlSize}
                    sx={{
                      boxSizing: 'border-box',
                      width: actionControlSize,
                      height: actionControlSize,
                      minWidth: actionControlSize,
                      minHeight: actionControlSize,
                      p: 0,
                      flexShrink: 0,
                      bgcolor: 'error.main',
                      color: 'error.contrastText',
                      transition: 'background-color 200ms',
                      '&:hover': { bgcolor: 'error.dark' }
                    }}
                  >
                    <StopIcon fontSize="small" />
                  </IconButton>
                )}
              </Box>
            </Box>
          </Paper>
        </Box>
      </Box>
    </Box>
  )
}

export default ChatView
