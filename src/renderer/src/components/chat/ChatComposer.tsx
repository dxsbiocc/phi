import { useUiLanguage } from '../../lib/i18n'
import { inlineReferenceInsertion } from '../../lib/composerReferences'
import { Box, IconButton, Paper } from '@mui/material'
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEventHandler,
  type DragEventHandler,
  type MouseEventHandler,
  type ReactNode,
  type RefObject
} from 'react'
import { GoPaperAirplane } from 'react-icons/go'
import type { SessionMode } from '../../../../shared/sessionMode'
import { SessionModeSelector } from '../../features/plan/components/SessionModeSelector'
import type { ChatResourceMention } from '../../lib/chatResourceMentions'
import type { ModelOption, PromptAgentSummary, SkillSummary, ThinkingLevel } from '../../types'
import { ComposerTextEditor, type ComposerTextEditorHandle } from './ComposerTextEditor'
import { PromptBarSparkles } from './PromptBarSparkles'
import { ModelSelectorControl } from './ChatComposerControls'
import { resolveThinkingSelection } from './composerThinkingLevel'
import { InputAddControl, InputAddPanel } from './InputAddMenu'
import {
  COMPOSER_ICON_SIZE,
  COMPOSER_STOP_MARK_SIZE,
  COMPACT_COMPOSER_CONTROL_SIZE,
  REGULAR_COMPOSER_ACTION_SIZE,
  composerSurfaceSx
} from './composerControlStyles'

function useComposerAddMenu(
  surfaceRef: RefObject<HTMLDivElement | null>,
  onOpenAddMenu?: () => void
): {
  open: boolean
  panelId: string
  panelRef: RefObject<HTMLDivElement | null>
  buttonRef: RefObject<HTMLButtonElement | null>
  toggle: () => void
  close: () => void
} {
  const panelId = useId()
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const toggle = useCallback(() => {
    setOpen((current) => {
      const next = !current
      if (next) onOpenAddMenu?.()
      return next
    })
  }, [onOpenAddMenu])
  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return undefined
    const handleDocumentMouseDown = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (panelRef.current?.contains(target)) return
      if (buttonRef.current?.contains(target)) return
      close()
    }
    document.addEventListener('mousedown', handleDocumentMouseDown, true)
    return () => document.removeEventListener('mousedown', handleDocumentMouseDown, true)
  }, [close, open])

  useEffect(() => {
    const form = surfaceRef.current?.closest('form')
    if (!form) return undefined
    form.addEventListener('submit', close)
    return () => form.removeEventListener('submit', close)
  }, [close, surfaceRef])

  return { open, panelId, panelRef, buttonRef, toggle, close }
}

function insertComposerReference(
  inputRef: RefObject<ComposerTextEditorHandle | null>,
  reference: string
): void {
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
}

function ComposerSubmitButton({
  showStop,
  compact,
  sendDisabled,
  sendLabel,
  stopLabel,
  stopTitle,
  markHomeSend,
  onStop
}: {
  showStop: boolean
  compact: boolean
  sendDisabled: boolean
  sendLabel: string
  stopLabel: string
  stopTitle: string
  markHomeSend: boolean
  onStop?: () => void
}): React.JSX.Element {
  const actionControlSize = compact ? COMPACT_COMPOSER_CONTROL_SIZE : REGULAR_COMPOSER_ACTION_SIZE
  return (
    <IconButton
      type={showStop ? 'button' : 'submit'}
      onClick={showStop ? onStop : undefined}
      disabled={!showStop && sendDisabled}
      aria-label={showStop ? stopLabel : sendLabel}
      title={showStop ? stopTitle : undefined}
      data-phi-composer-action={showStop ? 'stop' : 'send'}
      data-phi-home-send={!showStop && markHomeSend ? 'true' : undefined}
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
      {showStop ? (
        <Box
          aria-hidden="true"
          data-phi-stop-mark-size={COMPOSER_STOP_MARK_SIZE}
          sx={{
            width: COMPOSER_STOP_MARK_SIZE,
            height: COMPOSER_STOP_MARK_SIZE,
            borderRadius: '3px',
            bgcolor: 'currentColor',
            flexShrink: 0
          }}
        />
      ) : (
        <GoPaperAirplane size={COMPOSER_ICON_SIZE} aria-hidden="true" />
      )}
    </IconButton>
  )
}

export type ChatComposerProps = {
  inputRef: RefObject<ComposerTextEditorHandle | null>
  editorKey?: string
  value: string
  resources?: readonly ChatResourceMention[]
  placeholder: string
  placeholderKind?: string
  ariaLabel: string
  editorDisabled?: boolean
  editorMinHeight?: number
  compact?: boolean
  dragActive?: boolean
  fileDropTarget?: boolean
  markHomeSend?: boolean
  sendDisabled?: boolean
  showStop?: boolean
  onStop?: () => void
  sessionMode: SessionMode
  onSelectSessionMode: (mode: SessionMode) => void
  disableSessionModeSelect?: boolean
  remoteSession?: boolean
  models: ModelOption[]
  selectedModel: ModelOption | null
  onSelectModel: (model: ModelOption | null) => void
  disableModelControls?: boolean
  thinkingLevel: ThinkingLevel
  onSelectThinkingLevel: (level: ThinkingLevel) => void | Promise<void>
  onChange: (value: string, cursor: number) => void
  onCursorChange?: (cursor: number) => void
  onKeyDown?: (event: KeyboardEvent, editor: ComposerTextEditorHandle) => boolean
  onPaste?: ClipboardEventHandler<HTMLDivElement>
  onMouseDownCapture?: MouseEventHandler<HTMLDivElement>
  onDragEnter?: DragEventHandler<HTMLDivElement>
  onDragOver?: DragEventHandler<HTMLDivElement>
  onDragLeave?: DragEventHandler<HTMLDivElement>
  onDrop?: DragEventHandler<HTMLDivElement>
  onOpenWebUrl?: (url: string) => void
  aboveEditor?: ReactNode
  accessory?: ReactNode
  skills?: SkillSummary[]
  promptAgents?: PromptAgentSummary[]
  cwd?: string
  onPickFiles?: () => Promise<string[]>
  onInsertReference?: (reference: string) => void
  onRefreshPromptAgents?: () => Promise<void>
  onOpenAddMenu?: () => void
  sendLabel: string
  stopLabel?: string
  stopTitle?: string
}

export function ChatComposer({
  inputRef,
  editorKey,
  value,
  resources = [],
  placeholder,
  placeholderKind,
  ariaLabel,
  editorDisabled = false,
  editorMinHeight,
  compact = false,
  dragActive = false,
  fileDropTarget = false,
  markHomeSend = false,
  sendDisabled = false,
  showStop = false,
  onStop,
  sessionMode,
  onSelectSessionMode,
  disableSessionModeSelect = false,
  remoteSession = false,
  models,
  selectedModel,
  onSelectModel,
  disableModelControls = false,
  thinkingLevel,
  onSelectThinkingLevel,
  onChange,
  onCursorChange,
  onKeyDown,
  onPaste,
  onMouseDownCapture,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  onOpenWebUrl,
  aboveEditor,
  accessory,
  skills = [],
  promptAgents = [],
  cwd = '',
  onPickFiles,
  onInsertReference,
  onRefreshPromptAgents,
  onOpenAddMenu,
  sendLabel,
  stopLabel = '',
  stopTitle = ''
}: ChatComposerProps): React.JSX.Element {
  useUiLanguage()
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const thinkingCommitRef = useRef(0)
  const [previewThinkingLevel, setPreviewThinkingLevel] = useState<{
    level: ThinkingLevel
    baseLevel: ThinkingLevel
    modelKey: string
  } | null>(null)
  const modelKey = selectedModel ? `${selectedModel.providerId}/${selectedModel.modelId}` : ''
  const visualThinkingLevel =
    previewThinkingLevel?.baseLevel === thinkingLevel && previewThinkingLevel.modelKey === modelKey
      ? previewThinkingLevel.level
      : thinkingLevel
  const effortSelection = resolveThinkingSelection(
    visualThinkingLevel,
    selectedModel?.thinkingLevels ?? null
  )
  const highestEffort =
    !effortSelection.modelDisabled && effortSelection.currentIndex === effortSelection.maxIndex
  const commitThinkingLevel = async (level: ThinkingLevel): Promise<void> => {
    const request = ++thinkingCommitRef.current
    try {
      await onSelectThinkingLevel(level)
    } finally {
      if (request === thinkingCommitRef.current) setPreviewThinkingLevel(null)
    }
  }
  const addMenu = useComposerAddMenu(surfaceRef, onOpenAddMenu)
  const insertReference = (reference: string): void => {
    if (onInsertReference) {
      onInsertReference(reference)
      return
    }
    insertComposerReference(inputRef, reference)
  }

  return (
    <Box ref={surfaceRef} sx={{ display: 'contents' }}>
      {addMenu.open ? (
        <InputAddPanel
          panelId={addMenu.panelId}
          panelRef={addMenu.panelRef}
          skills={skills}
          promptAgents={promptAgents}
          resources={resources}
          cwd={cwd}
          onPickFiles={onPickFiles}
          onInsertReference={insertReference}
          onTrustChanged={onRefreshPromptAgents}
          onClose={addMenu.close}
        />
      ) : null}
      <Paper
        variant="outlined"
        onMouseDownCapture={onMouseDownCapture}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onPaste={onPaste}
        aria-label={ariaLabel}
        data-phi-highest-effort={highestEffort ? 'true' : undefined}
        data-phi-file-drop-target={fileDropTarget ? 'chat-composer' : undefined}
        sx={composerSurfaceSx({ compact, dragActive, highestEffort })}
      >
        <PromptBarSparkles active={highestEffort} value={value} />
        {aboveEditor}
        <Box sx={editorMinHeight ? { minHeight: editorMinHeight } : undefined}>
          <ComposerTextEditor
            key={editorKey}
            inputRef={inputRef}
            value={value}
            resources={resources}
            disabled={editorDisabled}
            ariaLabel={ariaLabel}
            onOpenWebUrl={onOpenWebUrl}
            placeholder={placeholder}
            placeholderKind={placeholderKind}
            onChange={onChange}
            onCursorChange={onCursorChange}
            onKeyDown={onKeyDown}
          />
        </Box>
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
              open={addMenu.open}
              controls={addMenu.panelId}
              buttonRef={addMenu.buttonRef}
              onToggle={addMenu.toggle}
            />
            <SessionModeSelector
              mode={sessionMode}
              disabled={disableSessionModeSelect}
              remote={remoteSession}
              onSelectMode={onSelectSessionMode}
              compact={compact}
            />
          </Box>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: compact ? 0.25 : 1,
              minWidth: 0
            }}
          >
            <ModelSelectorControl
              models={models}
              selectedModel={selectedModel}
              onSelectModel={onSelectModel}
              disabled={disableModelControls}
              compact={compact}
              thinkingLevel={thinkingLevel}
              supportedThinkingLevels={selectedModel?.thinkingLevels ?? null}
              onSelectThinkingLevel={commitThinkingLevel}
              onPreviewThinkingLevel={(level) =>
                setPreviewThinkingLevel({ level, baseLevel: thinkingLevel, modelKey })
              }
            />
            {accessory}
            <ComposerSubmitButton
              showStop={showStop}
              compact={compact}
              sendDisabled={sendDisabled}
              sendLabel={sendLabel}
              stopLabel={stopLabel}
              stopTitle={stopTitle}
              markHomeSend={markHomeSend}
              onStop={onStop}
            />
          </Box>
        </Box>
      </Paper>
    </Box>
  )
}
