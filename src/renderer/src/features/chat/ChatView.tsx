import { chatCopy } from './lib/chatCopy'
import { useUiLanguage } from '../../lib/i18n'
import { Box, Button, IconButton, Paper, Stack, Typography } from '@mui/material'
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
import { useChatResourceCatalog } from './hooks/useChatResourceCatalog'
import {
  ComposerTextEditor,
  type ComposerTextEditorHandle
} from '../../components/chat/ComposerTextEditor'
import { inlineReferenceInsertion } from '../../lib/composerReferences'
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
import ChatMessageList from '../../components/chat/ChatMessageList'
import { ResourceMentionsProvider } from '../../components/ResourceMention'
import type { ChatResourceMention } from '../../lib/chatResourceMentions'
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
import { chatComposerLayoutSx, chatLayoutVariables, type ChatPlacement } from './lib/chatLayout'
import { GoPaperAirplane, GoSquare } from 'react-icons/go'
import {
  canNavigatePromptHistory,
  nextPromptHistoryCursor,
  promptHistoryFromMessages,
  type PromptHistoryDirection
} from '../../lib/promptHistory'
import {
  composeInputWithFileReferences,
  findActiveInputInvocationReference,
  mergeInputFileReferences,
  parseInputFileReferences
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
  PromptAgentSummary,
  SkillSummary,
  ThinkingLevel,
  ToolApprovalRequest
} from '../../types'

export { ThinkingBlock } from '../../components/chat/ThinkingBlock'

const CloseIcon = PhiIcons.action.close

function isTextInputAtHistoryBoundary(
  inputElement: ComposerTextEditorHandle,
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
  resourceMentions?: readonly ChatResourceMention[]
  promptAgents?: PromptAgentSummary[]
  onSelectModel: (model: ModelOption | null) => void
  thinkingLevel: ThinkingLevel
  onSelectThinkingLevel: (level: ThinkingLevel) => void
  onInputChange: (value: string) => void
  onRetryUserMessage?: (message: UserMessageRetryTarget) => Promise<void> | void
  onForkUserMessage?: (messageId: string) => Promise<void> | void
  onOpenInputAddMenu?: () => void
  onRefreshPromptAgents?: () => Promise<void>
  onPickInputFiles?: () => Promise<string[]>
  onGetPathForInputFile?: (file: File) => string
  onInputFilesDropped?: (
    cb: (
      paths: string[],
      target: { kind: 'chat-composer' | 'wrapper-input' | 'remote-file-tree'; path?: string }
    ) => void
  ) => () => void
  onListInputDirectory?: (path: string) => Promise<DirectoryListing>
  onChatSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>
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
  placement?: ChatPlacement
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
  resourceMentions,
  promptAgents = [],
  onSelectModel,
  thinkingLevel,
  onSelectThinkingLevel,
  onInputChange,
  onRetryUserMessage,
  onForkUserMessage,
  onOpenInputAddMenu,
  onRefreshPromptAgents,
  onPickInputFiles,
  onGetPathForInputFile,
  onInputFilesDropped,
  onListInputDirectory,
  onChatSubmit,
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
  placement = 'tab',
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
  useUiLanguage()
  const { resources: messageResources, details: agentDetails } = useChatResourceCatalog({
    resources: resourceMentions,
    skills,
    agents: promptAgents
  })
  const contextUsage = useContextUsage(
    contextUsageTarget,
    selectedModel ? `${selectedModel.providerId}/${selectedModel.modelId}` : null,
    isGenerating || contextCompacting,
    contextUsageRefreshKey
  )
  const inputRef = useRef<ComposerTextEditorHandle | null>(null)
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
    ? chatCopy.message
    : isGenerating && canQueue
      ? chatCopy.messageEnterToQueueShiftEnterForANewLine
      : chatCopy.messageEnterToSendShiftEnterForANewLine
  const inputPlaceholder = suggestedNextAction ?? defaultInputPlaceholder
  const parsedComposerInput = useMemo(() => parseInputFileReferences(input), [input])
  const composerFileReferences = parsedComposerInput.references
  const composerInputText = parsedComposerInput.body
  const editableComposerTextFromInput = useCallback(
    (value: string): string => parseInputFileReferences(value).body,
    []
  )

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
  const applyInvocationReferenceInput = useCallback(
    (_nextBody: string, referenceText: string): void => {
      const editor = inputRef.current
      if (!editor) return
      resetPromptHistoryNavigation()
      const query = findActiveInputInvocationReference(editor.value, editor.selectionStart)
      const insertion = inlineReferenceInsertion(
        editor.value,
        query?.start ?? editor.selectionStart,
        query?.end ?? editor.selectionEnd,
        referenceText
      )
      editor.replaceRange(insertion.from, insertion.to, insertion.insert)
      editor.setSelectionRange(insertion.cursor, insertion.cursor)
      editor.focus({ preventScroll: true })
    },
    [resetPromptHistoryNavigation]
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
        'button, a, input, textarea, select, [contenteditable="true"], .cm-editor, [role="button"], [role="menuitem"], [aria-haspopup="true"]'
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
      const parsed = parseInputFileReferences(reference)
      if (parsed.references.length && !parsed.body) {
        const next = composeInputWithFileReferences(
          mergeInputFileReferences(composerFileReferences, parsed.references),
          composerInputText
        )
        promptHistoryDraftRef.current = next
        onInputChange(next)
        window.requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
        return
      }
      const editor = inputRef.current
      if (!editor) return
      const insertion = inlineReferenceInsertion(
        editor.value,
        editor.selectionStart,
        editor.selectionEnd,
        reference
      )
      editor.replaceRange(insertion.from, insertion.to, insertion.insert)
      editor.setSelectionRange(insertion.cursor, insertion.cursor)
      editor.focus({ preventScroll: true })
    },
    [composerFileReferences, composerInputText, onInputChange, resetPromptHistoryNavigation]
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
      data-phi-chat-placement={placement}
      onPointerDownCapture={onAcknowledgeActiveSession}
      onFocusCapture={onAcknowledgeActiveSession}
      sx={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        containerType: 'inline-size',
        containerName: 'phi-chat',
        ...chatLayoutVariables(placement)
      }}
    >
      {agentDetails}
      <ResourceMentionsProvider resources={messageResources}>
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
      </ResourceMentionsProvider>
      <Box sx={chatComposerLayoutSx}>
        <Box
          component="form"
          onSubmit={handleChatSubmit}
          sx={{ maxWidth: 'var(--phi-chat-content-max-width)', mx: 'auto' }}
        >
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
              aria-label={chatCopy.messageQueue}
              sx={{ width: '100%', mb: 1, borderRadius: 2, p: 1.25 }}
            >
              <Stack spacing={0.75}>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>
                  {queuedPromptsPaused
                    ? chatCopy.valuePausedResumesAfterANewMessageIsSent(queuedPrompts.length)
                    : chatCopy.valueQueued(queuedPrompts.length)}
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
                        aria-label={chatCopy.removeQueuedMessage}
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
              resources={messageResources}
              cwd={cwd}
              onPickFiles={onPickInputFiles}
              onInsertReference={insertInputReference}
              onTrustChanged={onRefreshPromptAgents}
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
              cwd={cwd}
              highlightedIndex={invocationReferenceMenu.highlightedIndex}
              onHighlight={invocationReferenceMenu.onHighlight}
              onSelect={invocationReferenceMenu.onSelect}
              onTrustChanged={onRefreshPromptAgents}
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
            aria-label={chatCopy.messageInput}
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
            <PastedImagePreview images={images} error={pasteError} onRemove={onRemoveImage} />
            <ComposerTextEditor
              key={scrollResetKey}
              inputRef={inputRef}
              value={composerInputText}
              resources={messageResources}
              onOpenWebUrl={onOpenWebUrl}
              placeholder={inputPlaceholder}
              placeholderKind={suggestedNextAction ? 'suggested-next-action' : 'default'}
              onChange={(value, cursor) => {
                resetPromptHistoryNavigation()
                const selection = { selectionStart: cursor }
                fileReferenceMenu.onInputChanged(selection)
                invocationReferenceMenu.onInputChanged(selection)
                const next = composeInputWithFileReferences(composerFileReferences, value)
                promptHistoryDraftRef.current = next
                onInputChange(next)
              }}
              onCursorChange={(cursor) => {
                const selection = { selectionStart: cursor }
                fileReferenceMenu.onInputCursorChanged(selection)
                invocationReferenceMenu.onInputCursorChanged(selection)
              }}
              onKeyDown={(event, editor) => {
                const menuEvent = {
                  key: event.key,
                  nativeEvent: event,
                  preventDefault: () => event.preventDefault()
                }
                if (fileReferenceMenu.onKeyDown(menuEvent)) {
                  return true
                }
                if (invocationReferenceMenu.onKeyDown(menuEvent)) {
                  return true
                }

                const acceptedSuggestion = suggestedNextActionToAccept(
                  {
                    key: event.key,
                    shiftKey: event.shiftKey,
                    altKey: event.altKey,
                    metaKey: event.metaKey,
                    ctrlKey: event.ctrlKey,
                    isComposing: event.isComposing
                  },
                  input,
                  suggestedNextAction
                )
                if (acceptedSuggestion) {
                  event.preventDefault()
                  onInputChange(acceptedSuggestion)
                  return true
                }

                const historyDirection =
                  event.key === 'ArrowUp' ? 'previous' : event.key === 'ArrowDown' ? 'next' : null
                if (
                  historyDirection &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.isComposing
                ) {
                  const inputElement = editor
                  if (
                    inputElement &&
                    isTextInputAtHistoryBoundary(inputElement, historyDirection) &&
                    navigatePromptHistory(historyDirection)
                  ) {
                    event.preventDefault()
                    return true
                  }
                }

                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.isComposing &&
                  (canSend || canQueue) &&
                  (input.trim() || images.length > 0) &&
                  !isReadingPastedImage
                ) {
                  event.preventDefault()
                  const form = (event.target as HTMLElement).closest('form')
                  form?.requestSubmit()
                  return true
                }
                return false
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
                    aria-label={chatCopy.planFirstAndWaitForReview}
                    aria-pressed={planReviewEnabled}
                    title={chatCopy.exploreAndSubmitAPlanThenWaitForYourApproval}
                    disabled={disablePlanReview}
                    onClick={onTogglePlanReview}
                    sx={{ minWidth: 0, px: 1, flexShrink: 0, whiteSpace: 'nowrap' }}
                  >
                    {chatCopy.planFirst}
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
                {!isGenerating && !contextCompacting ? (
                  <IconButton
                    type="submit"
                    disabled={
                      !canSend || (!input.trim() && images.length === 0) || isReadingPastedImage
                    }
                    aria-label={chatCopy.sendMessage}
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
                    aria-label={chatCopy.stopGenerating}
                    title={chatCopy.runningClickToStopGenerating}
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
