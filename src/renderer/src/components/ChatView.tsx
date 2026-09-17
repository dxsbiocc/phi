import { Box, IconButton, Paper, TextField } from '@mui/material'
import {
  useEffect,
  useId,
  useMemo,
  useCallback,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent
} from 'react'
import { type LocalPathKind } from './MarkdownContent'
import ToolApprovalDialog from './ToolApprovalDialog'
import {
  ModelSelectorControl,
  PermissionModeControl,
  ThinkingLevelControl
} from './chat/ChatComposerControls'
import { FileReferenceCards } from './chat/FileReferenceCards'
import { InputAddControl, InputAddPanel } from './chat/InputAddMenu'
import { InputFileReferenceMenu } from './chat/InputFileReferenceMenu'
import ChatMessageList from './chat/ChatMessageList'
import {
  COMPACT_COMPOSER_CONTROL_SIZE,
  REGULAR_COMPOSER_ACTION_SIZE,
  composerSurfaceSx
} from './chat/composerControlStyles'
import { useComposerFileDrop } from './chat/useComposerFileDrop'
import { useInputFileReferenceMenu } from './chat/useInputFileReferenceMenu'
import { PhiIcons } from '../icons'
import {
  canNavigatePromptHistory,
  nextPromptHistoryCursor,
  promptHistoryFromMessages,
  type PromptHistoryDirection
} from '../lib/promptHistory'
import {
  appendInputReference,
  composeInputWithFileReferences,
  mergeInputFileReferences,
  parseInputFileReferences
} from '../lib/inputReferences'
import { suggestedNextActionPlaceholderFromMessages } from '../lib/suggestedNextAction'
import type {
  ChatItem,
  DirectoryListing,
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

type ViewProps = {
  messages: ChatItem[]
  input: string
  messagesContainerRef?: (node: HTMLDivElement | null) => void
  scrollResetKey?: string
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
  onRetryUserMessage?: (content: string) => Promise<void> | void
  onOpenInputAddMenu?: () => void
  onPickInputFiles?: () => Promise<string[]>
  onGetPathForInputFile?: (file: File) => string
  onInputFilesDropped?: (cb: (paths: string[]) => void) => () => void
  onListInputDirectory?: (path: string) => Promise<DirectoryListing>
  onChatSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>
  onStopGeneration: () => Promise<void>
  onAcknowledgeActiveSession?: () => void
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

function ChatView({
  messages,
  input,
  messagesContainerRef,
  scrollResetKey,
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
  onRetryUserMessage,
  onOpenInputAddMenu,
  onPickInputFiles,
  onGetPathForInputFile,
  onInputFilesDropped,
  onListInputDirectory,
  onChatSubmit,
  onStopGeneration,
  onAcknowledgeActiveSession,
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
  const parsedComposerInput = useMemo(() => parseInputFileReferences(input), [input])
  const composerFileReferences = parsedComposerInput.references
  const composerInputText = parsedComposerInput.body

  const resetPromptHistoryNavigation = useCallback((): void => {
    promptHistoryKeyRef.current = promptHistoryKey
    promptHistoryCursorRef.current = null
    promptHistoryDraftRef.current = ''
  }, [promptHistoryKey])
  const applyFileReferenceInput = useCallback(
    (nextValue: string, cursor: number): void => {
      resetPromptHistoryNavigation()
      const parsedNextValue = parseInputFileReferences(nextValue)
      const nextReferences = mergeInputFileReferences(
        composerFileReferences,
        parsedNextValue.references
      )
      const nextFullValue = composeInputWithFileReferences(nextReferences, parsedNextValue.body)
      promptHistoryDraftRef.current = nextFullValue
      onInputChange(nextFullValue)

      window.requestAnimationFrame(() => {
        const inputElement = inputRef.current
        inputElement?.focus({ preventScroll: true })
        const nextCursor = Math.min(cursor, parsedNextValue.body.length)
        inputElement?.setSelectionRange(nextCursor, nextCursor)
      })
    },
    [composerFileReferences, onInputChange, resetPromptHistoryNavigation]
  )
  const fileReferenceMenu = useInputFileReferenceMenu({
    input: composerInputText,
    cwd,
    onListInputDirectory,
    onInsertReference: applyFileReferenceInput
  })

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
      if (!canNavigatePromptHistory(input, currentCursor, direction)) return false

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
      const parsedReference = parseInputFileReferences(reference)
      const nextValue =
        parsedReference.references.length > 0 && !parsedReference.body
          ? composeInputWithFileReferences(
              mergeInputFileReferences(composerFileReferences, parsedReference.references),
              composerInputText
            )
          : appendInputReference(input, reference)
      promptHistoryDraftRef.current = nextValue
      onInputChange(nextValue)

      window.requestAnimationFrame(() => {
        const inputElement = inputRef.current
        inputElement?.focus({ preventScroll: true })
        const nextComposerText = parseInputFileReferences(nextValue).body
        inputElement?.setSelectionRange(nextComposerText.length, nextComposerText.length)
      })
    },
    [composerFileReferences, composerInputText, input, onInputChange, resetPromptHistoryNavigation]
  )
  const editUserMessage = useCallback(
    (content: string): void => {
      resetPromptHistoryNavigation()
      promptHistoryDraftRef.current = content
      onInputChange(content)

      window.requestAnimationFrame(() => {
        const inputElement = inputRef.current
        const nextComposerText = parseInputFileReferences(content).body
        inputElement?.focus({ preventScroll: true })
        inputElement?.setSelectionRange(nextComposerText.length, nextComposerText.length)
      })
    },
    [onInputChange, resetPromptHistoryNavigation]
  )
  const retryUserMessage = useCallback(
    (content: string): void => {
      void onRetryUserMessage?.(content)
    },
    [onRetryUserMessage]
  )
  const removeFileReference = useCallback(
    (index: number): void => {
      resetPromptHistoryNavigation()
      const nextReferences = composerFileReferences.filter((_, itemIndex) => itemIndex !== index)
      const nextValue = composeInputWithFileReferences(nextReferences, composerInputText)
      promptHistoryDraftRef.current = nextValue
      onInputChange(nextValue)
      window.requestAnimationFrame(() => {
        inputRef.current?.focus({ preventScroll: true })
      })
    },
    [composerFileReferences, composerInputText, onInputChange, resetPromptHistoryNavigation]
  )
  const { isDragActive: composerDragActive, dragHandlers: composerDragHandlers } =
    useComposerFileDrop({
      cwd,
      onGetPathForFile: onGetPathForInputFile,
      onInputFilesDropped,
      onInsertReference: insertInputReference
    })
  const handleChatSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): Promise<void> => {
      closeInputAddMenu()
      return onChatSubmit(event)
    },
    [closeInputAddMenu, onChatSubmit]
  )

  return (
    <Box
      onPointerDownCapture={onAcknowledgeActiveSession}
      onFocusCapture={onAcknowledgeActiveSession}
      sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}
    >
      <ChatMessageList
        messages={messages}
        messagesContainerRef={messagesContainerRef}
        scrollResetKey={scrollResetKey}
        isGenerating={isGenerating}
        currentRunStartedAt={currentRunStartedAt}
        onGoSettings={onGoSettings}
        onOpenLocalPath={onOpenLocalPath}
        onJumpToNotebookCell={onJumpToNotebookCell}
        onEditUserMessage={editUserMessage}
        onRetryUserMessage={retryUserMessage}
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
              cwd={cwd}
              onPickFiles={onPickInputFiles}
              onInsertReference={insertInputReference}
              onClose={closeInputAddMenu}
            />
          )}
          {fileReferenceMenu.menuState ? (
            <InputFileReferenceMenu
              state={fileReferenceMenu.menuState}
              highlightedIndex={fileReferenceMenu.highlightedIndex}
              onHighlight={fileReferenceMenu.onHighlight}
              onSelect={fileReferenceMenu.onSelect}
            />
          ) : null}
          <Paper
            variant="outlined"
            onMouseDownCapture={focusInputFromComposerSurface}
            onDragEnter={composerDragHandlers.onDragEnter}
            onDragOver={composerDragHandlers.onDragOver}
            onDragLeave={composerDragHandlers.onDragLeave}
            onDrop={composerDragHandlers.onDrop}
            aria-label="消息输入框"
            data-phi-file-drop-target="chat-composer"
            sx={composerSurfaceSx({
              compact: compactComposerControls,
              dragActive: composerDragActive
            })}
          >
            <FileReferenceCards
              paths={composerFileReferences}
              variant="composer"
              onRemove={removeFileReference}
            />
            <TextField
              fullWidth
              multiline
              variant="standard"
              minRows={1}
              maxRows={8}
              inputRef={inputRef}
              value={composerInputText}
              onChange={(event) => {
                resetPromptHistoryNavigation()
                fileReferenceMenu.onInputChanged(event.target)
                const nextValue = composeInputWithFileReferences(
                  composerFileReferences,
                  event.target.value
                )
                promptHistoryDraftRef.current = nextValue
                onInputChange(nextValue)
              }}
              onSelect={(event) =>
                fileReferenceMenu.onInputCursorChanged(textInputFromEventTarget(event.target))
              }
              onKeyDown={(event) => {
                if (fileReferenceMenu.onKeyDown(event)) {
                  return
                }

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
