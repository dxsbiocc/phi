import { Box, Button, IconButton, Paper, Stack, TextField, Typography } from '@mui/material'
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
import type { PromptImageInput } from '../../../../shared/promptImageTypes'
import { PastedImagePreview } from './components/PastedImagePreview'
import { ContextUsageIndicator } from './components/ContextUsageIndicator'
import { usePastedImages } from './hooks/usePastedImages'
import { useContextUsage, type ContextUsageTarget } from './hooks/useContextUsage'
import { type LocalPathKind } from '../../components/MarkdownContent'
import ToolApprovalDialog from '../../components/ToolApprovalDialog'
import UserInteractionPanel from '../../components/UserInteractionPanel'
import {
  ModelSelectorControl,
  PermissionModeControl,
  ThinkingLevelControl
} from '../../components/chat/ChatComposerControls'
import { FileReferenceCards } from '../../components/chat/FileReferenceCards'
import { InputAddControl, InputAddPanel } from '../../components/chat/InputAddMenu'
import { InputFileReferenceMenu } from '../../components/chat/InputFileReferenceMenu'
import { InputInvocationReferenceMenu } from '../../components/chat/InputInvocationReferenceMenu'
import { InputReferenceChips } from '../../components/chat/InputReferenceChips'
import ChatMessageList from '../../components/chat/ChatMessageList'
import type { UserMessageRetryTarget } from '../../components/chat/ChatUserMessage'
import {
  COMPOSER_ICON_SIZE,
  COMPACT_COMPOSER_CONTROL_SIZE,
  REGULAR_COMPOSER_ACTION_SIZE,
  composerSurfaceSx
} from '../../components/chat/composerControlStyles'
import { useComposerFileDrop } from '../../components/chat/useComposerFileDrop'
import { useInputFileReferenceMenu } from '../../components/chat/useInputFileReferenceMenu'
import { useInputInvocationReferenceMenu } from '../../components/chat/useInputInvocationReferenceMenu'
import { PhiIcons } from '../../icons'
import { OfficeTargetChip } from '../office/components/OfficeTargetChip'
import type { OfficeComposerTarget } from '../office/lib/officePromptTarget'
import { GoPaperAirplane, GoSquare } from 'react-icons/go'
import {
  canNavigatePromptHistory,
  nextPromptHistoryCursor,
  promptHistoryFromMessages,
  type PromptHistoryDirection
} from '../../lib/promptHistory'
import {
  appendInputReference,
  composeInputWithFileReferences,
  composeInputWithInvocationReferences,
  mergeInputFileReferences,
  mergeInputInvocationReferences,
  parseInputInvocationReferences,
  parseInputFileReferences,
  type InputInvocationReference
} from '../../lib/inputReferences'
import {
  suggestedNextActionPlaceholderFromMessages,
  suggestedNextActionToAccept
} from '../../lib/suggestedNextAction'
import type {
  AgentUserInteractionRequest,
  AgentUserInteractionResponse,
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
} from '../../types'

export { ThinkingBlock } from '../../components/chat/ThinkingBlock'

const CloseIcon = PhiIcons.action.close

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
  images?: PromptImageInput[]
  onImagesAdded?: (images: PromptImageInput[]) => void
  onRemoveImage?: (index: number) => void
  messagesContainerRef?: (node: HTMLDivElement | null) => void
  scrollResetKey?: string
  scrollPositionStore?: Map<string, number>
  canSend: boolean
  canQueue?: boolean
  isGenerating: boolean
  currentRunStartedAt?: string
  models: ModelOption[]
  selectedModel: ModelOption | null
  contextUsageTarget?: ContextUsageTarget
  contextUsageRefreshKey?: number
  contextCompacting?: boolean
  skills?: SkillSummary[]
  promptAgents?: PromptAgentSummary[]
  plugins?: PluginCatalogItem[]
  onSelectModel: (model: ModelOption | null) => void
  thinkingLevel: ThinkingLevel
  onSelectThinkingLevel: (level: ThinkingLevel) => void
  onInputChange: (value: string) => void
  onRetryUserMessage?: (message: UserMessageRetryTarget) => Promise<void> | void
  onForkUserMessage?: (messageId: string) => Promise<void> | void
  onOpenInputAddMenu?: () => void
  onPickInputFiles?: () => Promise<string[]>
  onGetPathForInputFile?: (file: File) => string
  onInputFilesDropped?: (cb: (paths: string[]) => void) => () => void
  onListInputDirectory?: (path: string) => Promise<DirectoryListing>
  onChatSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>
  officeTarget?: OfficeComposerTarget
  onRemoveOfficeTarget?: () => void
  onClearOfficeSelection?: () => void
  planReviewEnabled?: boolean
  onTogglePlanReview?: () => void
  disablePlanReview?: boolean
  onStopGeneration: () => Promise<void>
  onAcknowledgeActiveSession?: () => void
  onGoSettings: () => void
  onOpenBackgroundJobs: () => void
  permissionMode: PermissionMode
  onSelectPermissionMode: (mode: PermissionMode) => void
  disablePermissionModeSelect?: boolean
  disableModelControls?: boolean
  compactComposerControls?: boolean
  pendingApproval: ToolApprovalRequest | null
  pendingUserInteraction: AgentUserInteractionRequest | null
  queuedPrompts?: Array<{ id: string; text: string }>
  queuedPromptsPaused?: boolean
  onRespondApproval: (requestId: string, approved: boolean) => void
  onRespondUserInteraction: (
    requestId: string,
    response: AgentUserInteractionResponse,
    cancelled?: boolean
  ) => void
  onRemoveQueuedPrompt?: (id: string) => void
  onOpenApprovalSession: (path: string) => void
  onOpenLocalPath?: (path: string, pathKind: LocalPathKind) => void
  onOpenWebUrl?: (url: string) => void
  onJumpToNotebookCell?: (target: NotebookCellJumpTarget) => void
  cwd?: string
}

function ChatView({
  messages,
  input,
  images = [],
  onImagesAdded,
  onRemoveImage,
  messagesContainerRef,
  scrollResetKey,
  scrollPositionStore,
  canSend,
  canQueue = false,
  isGenerating,
  currentRunStartedAt,
  models,
  selectedModel,
  contextUsageTarget,
  contextUsageRefreshKey = 0,
  contextCompacting = false,
  skills = [],
  promptAgents = [],
  plugins = [],
  onSelectModel,
  thinkingLevel,
  onSelectThinkingLevel,
  onInputChange,
  onRetryUserMessage,
  onForkUserMessage,
  onOpenInputAddMenu,
  onPickInputFiles,
  onGetPathForInputFile,
  onInputFilesDropped,
  onListInputDirectory,
  onChatSubmit,
  officeTarget,
  onRemoveOfficeTarget,
  onClearOfficeSelection,
  planReviewEnabled = false,
  onTogglePlanReview,
  disablePlanReview = false,
  onStopGeneration,
  onAcknowledgeActiveSession,
  onGoSettings,
  onOpenBackgroundJobs,
  permissionMode,
  onSelectPermissionMode,
  disablePermissionModeSelect = false,
  disableModelControls = false,
  compactComposerControls = false,
  pendingApproval,
  pendingUserInteraction,
  queuedPrompts = [],
  queuedPromptsPaused = false,
  onRespondApproval,
  onRespondUserInteraction,
  onRemoveQueuedPrompt,
  onOpenApprovalSession,
  onOpenLocalPath,
  onOpenWebUrl,
  onJumpToNotebookCell,
  cwd = ''
}: ViewProps): React.JSX.Element {
  const contextUsage = useContextUsage(
    contextUsageTarget,
    selectedModel ? `${selectedModel.providerId}/${selectedModel.modelId}` : null,
    isGenerating || contextCompacting,
    contextUsageRefreshKey
  )
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
    : isGenerating && canQueue
      ? '输入消息，Enter 加入队列，Shift+Enter 换行'
      : '输入消息，Enter 发送，Shift+Enter 换行'
  const inputPlaceholder = suggestedNextAction ?? defaultInputPlaceholder
  const parsedComposerInput = useMemo(() => parseInputFileReferences(input), [input])
  const composerFileReferences = parsedComposerInput.references
  const parsedInvocationInput = useMemo(
    () => parseInputInvocationReferences(parsedComposerInput.body, skills, promptAgents),
    [parsedComposerInput.body, promptAgents, skills]
  )
  const composerInvocationReferences = parsedInvocationInput.references
  const composerInputText = parsedInvocationInput.body

  const resetPromptHistoryNavigation = useCallback((): void => {
    promptHistoryKeyRef.current = promptHistoryKey
    promptHistoryCursorRef.current = null
    promptHistoryDraftRef.current = ''
  }, [promptHistoryKey])
  const composeComposerInput = useCallback(
    (
      fileReferences: string[],
      invocationReferences: readonly InputInvocationReference[],
      body: string
    ): string =>
      composeInputWithFileReferences(
        fileReferences,
        composeInputWithInvocationReferences(invocationReferences, body)
      ),
    []
  )
  const editableComposerTextFromInput = useCallback(
    (value: string): string =>
      parseInputInvocationReferences(parseInputFileReferences(value).body, skills, promptAgents)
        .body,
    [promptAgents, skills]
  )
  const applyFileReferenceInput = useCallback(
    (nextValue: string, cursor: number): void => {
      resetPromptHistoryNavigation()
      const parsedNextValue = parseInputFileReferences(nextValue)
      const nextReferences = mergeInputFileReferences(
        composerFileReferences,
        parsedNextValue.references
      )
      const nextFullValue = composeComposerInput(
        nextReferences,
        composerInvocationReferences,
        parsedNextValue.body
      )
      promptHistoryDraftRef.current = nextFullValue
      onInputChange(nextFullValue)

      window.requestAnimationFrame(() => {
        const inputElement = inputRef.current
        inputElement?.focus({ preventScroll: true })
        const nextCursor = Math.min(cursor, parsedNextValue.body.length)
        inputElement?.setSelectionRange(nextCursor, nextCursor)
      })
    },
    [
      composeComposerInput,
      composerFileReferences,
      composerInvocationReferences,
      onInputChange,
      resetPromptHistoryNavigation
    ]
  )
  const applyInvocationReferenceInput = useCallback(
    (nextBody: string, referenceText: string, cursor: number): void => {
      resetPromptHistoryNavigation()
      const parsedReference = parseInputInvocationReferences(referenceText, skills, promptAgents)
      const nextValue = composeComposerInput(
        composerFileReferences,
        mergeInputInvocationReferences(composerInvocationReferences, parsedReference.references),
        nextBody
      )
      promptHistoryDraftRef.current = nextValue
      onInputChange(nextValue)

      window.requestAnimationFrame(() => {
        const inputElement = inputRef.current
        inputElement?.focus({ preventScroll: true })
        const nextCursor = Math.min(cursor, nextBody.length)
        inputElement?.setSelectionRange(nextCursor, nextCursor)
      })
    },
    [
      composeComposerInput,
      composerFileReferences,
      composerInvocationReferences,
      onInputChange,
      promptAgents,
      resetPromptHistoryNavigation,
      skills
    ]
  )
  const fileReferenceMenu = useInputFileReferenceMenu({
    input: composerInputText,
    cwd,
    onListInputDirectory,
    onInsertReference: applyFileReferenceInput
  })
  const invocationReferenceMenu = useInputInvocationReferenceMenu({
    input: composerInputText,
    skills,
    promptAgents,
    onInsertReference: applyInvocationReferenceInput
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
      const parsedInvocationReference = parseInputInvocationReferences(
        reference,
        skills,
        promptAgents
      )
      const nextValue =
        parsedReference.references.length > 0 && !parsedReference.body
          ? composeComposerInput(
              mergeInputFileReferences(composerFileReferences, parsedReference.references),
              composerInvocationReferences,
              composerInputText
            )
          : parsedInvocationReference.references.length > 0 && !parsedInvocationReference.body
            ? composeComposerInput(
                composerFileReferences,
                mergeInputInvocationReferences(
                  composerInvocationReferences,
                  parsedInvocationReference.references
                ),
                composerInputText
              )
            : appendInputReference(input, reference)
      promptHistoryDraftRef.current = nextValue
      onInputChange(nextValue)

      window.requestAnimationFrame(() => {
        const inputElement = inputRef.current
        inputElement?.focus({ preventScroll: true })
        const nextComposerText = editableComposerTextFromInput(nextValue)
        inputElement?.setSelectionRange(nextComposerText.length, nextComposerText.length)
      })
    },
    [
      composeComposerInput,
      composerFileReferences,
      composerInputText,
      composerInvocationReferences,
      editableComposerTextFromInput,
      input,
      onInputChange,
      promptAgents,
      resetPromptHistoryNavigation,
      skills
    ]
  )
  const editUserMessage = useCallback(
    (content: string): void => {
      resetPromptHistoryNavigation()
      promptHistoryDraftRef.current = content
      onInputChange(content)

      window.requestAnimationFrame(() => {
        const inputElement = inputRef.current
        const nextComposerText = editableComposerTextFromInput(content)
        inputElement?.focus({ preventScroll: true })
        inputElement?.setSelectionRange(nextComposerText.length, nextComposerText.length)
      })
    },
    [editableComposerTextFromInput, onInputChange, resetPromptHistoryNavigation]
  )
  const retryUserMessage = useCallback(
    (message: UserMessageRetryTarget): void => {
      void onRetryUserMessage?.(message)
    },
    [onRetryUserMessage]
  )
  const removeFileReference = useCallback(
    (index: number): void => {
      resetPromptHistoryNavigation()
      const nextReferences = composerFileReferences.filter((_, itemIndex) => itemIndex !== index)
      const nextValue = composeComposerInput(
        nextReferences,
        composerInvocationReferences,
        composerInputText
      )
      promptHistoryDraftRef.current = nextValue
      onInputChange(nextValue)
      window.requestAnimationFrame(() => {
        inputRef.current?.focus({ preventScroll: true })
      })
    },
    [
      composeComposerInput,
      composerFileReferences,
      composerInputText,
      composerInvocationReferences,
      onInputChange,
      resetPromptHistoryNavigation
    ]
  )
  const removeInvocationReference = useCallback(
    (index: number): void => {
      resetPromptHistoryNavigation()
      const nextInvocationReferences = composerInvocationReferences.filter(
        (_, itemIndex) => itemIndex !== index
      )
      const nextValue = composeComposerInput(
        composerFileReferences,
        nextInvocationReferences,
        composerInputText
      )
      promptHistoryDraftRef.current = nextValue
      onInputChange(nextValue)
      window.requestAnimationFrame(() => {
        inputRef.current?.focus({ preventScroll: true })
      })
    },
    [
      composeComposerInput,
      composerFileReferences,
      composerInputText,
      composerInvocationReferences,
      onInputChange,
      resetPromptHistoryNavigation
    ]
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

  const {
    pasteError,
    isReading: isReadingPastedImage,
    onPaste
  } = usePastedImages({
    images,
    supportsImages: selectedModel?.supportsImages,
    onImagesAdded
  })

  return (
    <Box
      onPointerDownCapture={onAcknowledgeActiveSession}
      onFocusCapture={onAcknowledgeActiveSession}
      sx={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        containerType: 'inline-size',
        containerName: 'phi-chat'
      }}
    >
      <ChatMessageList
        messages={messages}
        messagesContainerRef={messagesContainerRef}
        scrollResetKey={scrollResetKey}
        scrollPositionStore={scrollPositionStore}
        isGenerating={isGenerating}
        currentRunStartedAt={currentRunStartedAt}
        onGoSettings={onGoSettings}
        onOpenBackgroundJobs={onOpenBackgroundJobs}
        onOpenLocalPath={onOpenLocalPath}
        onOpenWebUrl={onOpenWebUrl}
        onJumpToNotebookCell={onJumpToNotebookCell}
        onEditUserMessage={editUserMessage}
        onRetryUserMessage={retryUserMessage}
        onForkUserMessage={onForkUserMessage}
        cwd={cwd}
      />
      <Box
        sx={{
          px: 2,
          pt: 1.5,
          pb: 2,
          flexShrink: 0,
          '@container phi-chat (max-width: 560px)': { px: 1, pt: 1, pb: 1 }
        }}
      >
        <Box component="form" onSubmit={handleChatSubmit} sx={{ maxWidth: 892, mx: 'auto' }}>
          <ToolApprovalDialog
            request={pendingApproval}
            onRespond={onRespondApproval}
            onOpenSession={onOpenApprovalSession}
          />
          <UserInteractionPanel
            request={pendingUserInteraction}
            onRespond={onRespondUserInteraction}
          />
          {queuedPrompts.length > 0 && (
            <Paper
              variant="outlined"
              aria-label="消息队列"
              sx={{ width: '100%', mb: 1, borderRadius: 2, p: 1.25 }}
            >
              <Stack spacing={0.75}>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>
                  {queuedPromptsPaused
                    ? `已暂停 ${queuedPrompts.length} 条 · 发送新消息成功后继续`
                    : `排队中 ${queuedPrompts.length} 条`}
                </Typography>
                {queuedPrompts.map((item) => (
                  <Box
                    key={item.id}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1,
                      minWidth: 0,
                      bgcolor: 'action.hover',
                      borderRadius: 1,
                      px: 1,
                      py: 0.75
                    }}
                  >
                    <Typography
                      variant="body2"
                      sx={{
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}
                      title={item.text}
                    >
                      {item.text}
                    </Typography>
                    {onRemoveQueuedPrompt && (
                      <IconButton
                        size="small"
                        aria-label="移除排队消息"
                        onClick={() => onRemoveQueuedPrompt(item.id)}
                      >
                        <CloseIcon fontSize="small" />
                      </IconButton>
                    )}
                  </Box>
                ))}
              </Stack>
            </Paper>
          )}
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
          ) : invocationReferenceMenu.menuState ? (
            <InputInvocationReferenceMenu
              state={invocationReferenceMenu.menuState}
              highlightedIndex={invocationReferenceMenu.highlightedIndex}
              onHighlight={invocationReferenceMenu.onHighlight}
              onSelect={invocationReferenceMenu.onSelect}
            />
          ) : null}
          <Paper
            variant="outlined"
            onMouseDownCapture={focusInputFromComposerSurface}
            onDragEnter={composerDragHandlers.onDragEnter}
            onDragOver={composerDragHandlers.onDragOver}
            onDragLeave={composerDragHandlers.onDragLeave}
            onDrop={composerDragHandlers.onDrop}
            onPaste={onPaste}
            aria-label="消息输入框"
            data-phi-file-drop-target="chat-composer"
            sx={composerSurfaceSx({
              compact: compactComposerControls,
              dragActive: composerDragActive
            })}
          >
            {officeTarget && onRemoveOfficeTarget && (
              <OfficeTargetChip
                target={officeTarget}
                onClearSelection={onClearOfficeSelection}
                onRemove={onRemoveOfficeTarget}
              />
            )}
            <FileReferenceCards
              paths={composerFileReferences}
              variant="composer"
              onRemove={removeFileReference}
            />
            <InputReferenceChips
              references={composerInvocationReferences}
              onRemove={removeInvocationReference}
            />
            <PastedImagePreview images={images} error={pasteError} onRemove={onRemoveImage} />
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
                invocationReferenceMenu.onInputChanged(event.target)
                const nextValue = composeComposerInput(
                  composerFileReferences,
                  composerInvocationReferences,
                  event.target.value
                )
                promptHistoryDraftRef.current = nextValue
                onInputChange(nextValue)
              }}
              onSelect={(event) => {
                const inputElement = textInputFromEventTarget(event.target)
                fileReferenceMenu.onInputCursorChanged(inputElement)
                invocationReferenceMenu.onInputCursorChanged(inputElement)
              }}
              onKeyDown={(event) => {
                if (fileReferenceMenu.onKeyDown(event)) {
                  return
                }
                if (invocationReferenceMenu.onKeyDown(event)) {
                  return
                }

                const acceptedSuggestion = suggestedNextActionToAccept(
                  {
                    key: event.key,
                    shiftKey: event.shiftKey,
                    altKey: event.altKey,
                    metaKey: event.metaKey,
                    ctrlKey: event.ctrlKey,
                    isComposing: event.nativeEvent.isComposing
                  },
                  input,
                  suggestedNextAction
                )
                if (acceptedSuggestion) {
                  event.preventDefault()
                  onInputChange(acceptedSuggestion)
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
                  (canSend || canQueue) &&
                  (input.trim() || images.length > 0) &&
                  !isReadingPastedImage
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
                {onTogglePlanReview && (
                  <Button
                    type="button"
                    size="small"
                    variant={planReviewEnabled ? 'contained' : 'text'}
                    aria-label="先计划并等待评审"
                    aria-pressed={planReviewEnabled}
                    title="先探索并提交计划，等你确认后再执行"
                    disabled={disablePlanReview}
                    onClick={onTogglePlanReview}
                    sx={{ minWidth: 0, px: 1, flexShrink: 0, whiteSpace: 'nowrap' }}
                  >
                    先计划
                  </Button>
                )}
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
                {contextUsageTarget && (
                  <ContextUsageIndicator
                    usage={contextUsage.usage}
                    loading={contextUsage.loading}
                  />
                )}
                {!isGenerating ? (
                  <IconButton
                    type="submit"
                    disabled={
                      !canSend || (!input.trim() && images.length === 0) || isReadingPastedImage
                    }
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
                      bgcolor: 'transparent',
                      color: 'primary.main',
                      transition: 'background-color 200ms',
                      '&:hover': { bgcolor: 'action.hover' },
                      '&.Mui-disabled': {
                        bgcolor: 'transparent',
                        color: 'action.disabled'
                      }
                    }}
                  >
                    <GoPaperAirplane size={COMPOSER_ICON_SIZE} aria-hidden="true" />
                  </IconButton>
                ) : (
                  <IconButton
                    type="button"
                    onClick={() => {
                      void onStopGeneration()
                    }}
                    aria-label="停止生成"
                    title="运行中，点击停止生成"
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
                      bgcolor: 'transparent',
                      color: 'primary.main',
                      transition: 'background-color 200ms',
                      '&:hover': { bgcolor: 'action.hover' }
                    }}
                  >
                    <GoSquare size={COMPOSER_ICON_SIZE} aria-hidden="true" />
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
