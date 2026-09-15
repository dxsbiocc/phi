import {
  memo,
  useEffect,
  useState,
  type DragEvent,
  type MouseEvent,
  type PointerEvent
} from 'react'
import {
  Box,
  Divider,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import { alpha, type Theme } from '@mui/material/styles'
import { TbGripVertical } from 'react-icons/tb'

import { PhiIcons } from '../../../icons'
import {
  formatExecutionDuration,
  notebookCellAccent,
  type CanvasCell
} from '../lib/notebookViewModel'
import type { NotebookCellType } from '../../../../../shared/notebookDocument'
import MarkdownContent from '../../../components/MarkdownContent'
import NotebookCodeCellSource from './NotebookCodeCellSource'
import NotebookCodeEditor, { type NotebookCompletionProvider } from './NotebookCodeEditor'
import {
  notebookCodeGutterDividerWidth,
  notebookCodeGutterWidth,
  notebookCodeMinHeight,
  notebookCodeContentPaddingBottom,
  notebookCodeContentPaddingTop
} from './notebookCellLayout'
import NotebookOutputArea from './NotebookOutputArea'
import {
  notebookAccentColor,
  notebookAccentSelectionShadow,
  notebookCaretColor
} from './notebookCellStyles'

export type CellPlacement = 'before' | 'after'

const AddIcon = PhiIcons.action.add
const CodeIcon = PhiIcons.tool.command
const FileIcon = PhiIcons.tool.read
const MarkdownIcon = PhiIcons.file.markdown
const PlayIcon = PhiIcons.action.run
const RefreshIcon = PhiIcons.action.refresh
const StopIcon = PhiIcons.action.stop
const DeleteIcon = PhiIcons.action.delete
const FormatIcon = PhiIcons.action.format
const MoreIcon = PhiIcons.action.more

type NotebookCellProps = {
  cell: CanvasCell
  cellNumber?: number
  editable?: boolean
  selected?: boolean
  notebookPath?: string | null
  agentHighlighted?: boolean
  onSourceChange?: (cellId: string, source: string) => void
  onCompleteSource?: (
    cellId: string,
    source: string,
    cursorPosition: number
  ) => ReturnType<NotebookCompletionProvider>
  onFormatSource?: (
    cellId: string,
    source: string,
    language?: CanvasCell['language']
  ) => void | Promise<void>
  onInsertBefore?: (
    cellId: string,
    cellType?: Extract<NotebookCellType, 'code' | 'markdown'>
  ) => void | Promise<void>
  onInsertAfter?: (
    cellId: string,
    cellType?: Extract<NotebookCellType, 'code' | 'markdown'>
  ) => void | Promise<void>
  onClearOutputs?: (cellId: string) => void
  onDeleteCell?: (cellId: string) => void
  onConvertCell?: (cellId: string, cellType: Extract<NotebookCellType, 'code' | 'markdown'>) => void
  onMoveCell?: (sourceCellId: string, targetCellId: string, placement: CellPlacement) => void
  onMoveAiPrompt?: (targetCellId: string, placement: CellPlacement) => void
  onSelectCell?: (cellId: string) => void
  onRunCell?: (cellId: string) => void
  onStopCell?: (cellId: string) => void
  canRunCells?: boolean
  provisional?: boolean
}

// NotebookCanvas passes several callbacks that are only conditionally
// undefined based on `isAiPreviewCell`/`editable`/`canRunCells` — signals
// already covered by the `provisional`/`editable`/`canRunCells` props below
// — so their identity can be ignored entirely; whichever closure is current
// only ever reads its args or writes via a setState updater, never stale
// captured state. `onInsertBefore`/`onInsertAfter`/`onRunCell`/`onStopCell`/
// `onMoveAiPrompt`/`onFormatSource` are the exception: they (or what they
// wrap) read notebook document/cell-list state directly from a closure, so a
// stale reference from a bailed-out render could act on outdated data —
// NotebookCanvas keeps those specific ones behind useCallback so comparing
// them by reference is both correct and still an effective memo boundary.
// `onCompleteSource` only toggles defined/undefined based on kernel
// availability (invisible elsewhere in props), so it's compared by
// presence rather than identity.
function notebookCellPropsEqual(prev: NotebookCellProps, next: NotebookCellProps): boolean {
  return (
    prev.cell === next.cell &&
    prev.cellNumber === next.cellNumber &&
    prev.editable === next.editable &&
    prev.selected === next.selected &&
    prev.agentHighlighted === next.agentHighlighted &&
    prev.provisional === next.provisional &&
    prev.canRunCells === next.canRunCells &&
    prev.notebookPath === next.notebookPath &&
    Boolean(prev.onCompleteSource) === Boolean(next.onCompleteSource) &&
    prev.onFormatSource === next.onFormatSource &&
    prev.onInsertBefore === next.onInsertBefore &&
    prev.onInsertAfter === next.onInsertAfter &&
    prev.onRunCell === next.onRunCell &&
    prev.onStopCell === next.onStopCell &&
    prev.onMoveAiPrompt === next.onMoveAiPrompt
  )
}

function NotebookCellImpl({
  cell,
  cellNumber,
  editable = false,
  selected = false,
  onSourceChange,
  onCompleteSource,
  onFormatSource,
  onInsertBefore,
  onInsertAfter,
  onClearOutputs,
  onDeleteCell,
  onConvertCell,
  onMoveCell,
  onMoveAiPrompt,
  onSelectCell,
  onRunCell,
  onStopCell,
  canRunCells = false,
  notebookPath,
  agentHighlighted = false,
  provisional = false
}: NotebookCellProps): React.JSX.Element {
  const isMarkdown = cell.type === 'markdown'
  const [isEditing, setIsEditing] = useState(false)
  const [initialEditorSelection, setInitialEditorSelection] = useState<number | undefined>()
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const [dropPlacement, setDropPlacement] = useState<CellPlacement | null>(null)
  const [runningTimer, setRunningTimer] = useState({ cellId: '', elapsedMs: 0 })
  const [isCellActive, setIsCellActive] = useState(false)
  const cellAccent = notebookCellAccent(cell)
  const isCellSelected = Boolean(selected)
  const showEditor = editable && isEditing && isCellSelected
  const showAccentShadow = showEditor || isCellSelected || agentHighlighted || provisional
  const isCodeCell = cell.type === 'code'
  const isCodeSelectionChromeOnly = isCodeCell && !agentHighlighted && !provisional
  const canRun = isCodeCell && Boolean(onRunCell) && canRunCells && cell.state !== 'running'
  const isRunning = cell.state === 'running'
  const canStop = isRunning && Boolean(onStopCell)
  const isRenderedMarkdown = isMarkdown && !showEditor
  const isCodeSourceView = isCodeCell && !showEditor
  const hasOutputs = cell.outputs.length > 0
  const canMove = editable && Boolean(onMoveCell) && !provisional
  const showCellActions = !provisional
  const runningElapsedMs = isRunning && runningTimer.cellId === cell.id ? runningTimer.elapsedMs : 0
  const executionMetaLabel = isRunning
    ? formatExecutionDuration(runningElapsedMs)
    : cell.executionDurationMs !== undefined
      ? formatExecutionDuration(cell.executionDurationMs)
      : null
  const showExecutionMeta = isRunning || isCellActive
  const primaryActionTitle = isRenderedMarkdown
    ? '编辑 Markdown'
    : isRunning
      ? '停止 cell'
      : isCodeCell
        ? '运行 cell'
        : '此 cell 无需运行'
  const primaryActionLabel = primaryActionTitle
  const isPrimaryActionDisabled = isRenderedMarkdown ? !editable : isRunning ? !canStop : !canRun
  const showPrimaryActionAccent = !isRunning && (isRenderedMarkdown || canRun)
  const runCellFromKeyboard = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (
      !isCodeCell ||
      event.key !== 'Enter' ||
      (!event.shiftKey && !event.metaKey && !event.ctrlKey)
    ) {
      return
    }

    const target = event.target instanceof HTMLElement ? event.target : null
    if (target?.closest('[data-phi-notebook-code-editor="codemirror"]')) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    if (canRun) onRunCell?.(cell.id)
  }

  useEffect(() => {
    if (!isRunning) return

    const startedAt = Date.now()
    const resetTimer = window.setTimeout(() => {
      setRunningTimer({ cellId: cell.id, elapsedMs: 0 })
    }, 0)
    const timer = window.setInterval(() => {
      setRunningTimer({ cellId: cell.id, elapsedMs: Math.max(0, Date.now() - startedAt) })
    }, 250)

    return () => {
      window.clearTimeout(resetTimer)
      window.clearInterval(timer)
    }
  }, [cell.id, isRunning])

  const closeMenu = (): void => setMenuAnchor(null)
  const runMenuAction = (action: () => void | Promise<void>): void => {
    closeMenu()
    void action()
  }
  const insertionButtonSx = {
    width: 22,
    height: 22,
    color: 'text.secondary',
    opacity: 0,
    transition: 'opacity 140ms ease, color 140ms ease',
    '&:hover': {
      color: 'text.primary'
    }
  } as const
  const actionButtonSx = {
    width: 30,
    height: 30,
    border: 1,
    borderColor: (theme: Theme) => alpha(theme.palette.text.primary, 0.18),
    bgcolor: (theme: Theme) => theme.palette.background.paper,
    opacity: 1,
    boxShadow: (theme: Theme) => `0 1px 5px ${alpha(theme.palette.common.black, 0.22)}`,
    '&:hover': {
      bgcolor: (theme: Theme) => theme.palette.background.paper
    },
    '&.Mui-disabled': {
      bgcolor: (theme: Theme) => theme.palette.background.paper,
      opacity: 1
    }
  } as const
  return (
    <Box
      data-phi-notebook-cell="marimo-like"
      data-phi-notebook-cell-accent={cellAccent}
      data-phi-notebook-cell-id={cell.id}
      data-phi-notebook-cell-provisional={provisional ? 'true' : undefined}
      data-phi-notebook-cell-selected={isCellSelected ? 'true' : undefined}
      data-phi-notebook-cell-agent-highlighted={agentHighlighted ? 'true' : undefined}
      data-phi-notebook-cell-editing={showEditor ? 'true' : undefined}
      data-phi-notebook-cell-spacing="roomy"
      data-phi-notebook-cell-has-duration={
        cell.executionDurationMs !== undefined ? 'true' : undefined
      }
      onPointerDown={() => onSelectCell?.(cell.id)}
      onKeyDown={runCellFromKeyboard}
      onMouseEnter={() => setIsCellActive(true)}
      onMouseLeave={() => setIsCellActive(false)}
      onFocusCapture={() => {
        setIsCellActive(true)
        onSelectCell?.(cell.id)
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsCellActive(false)
        }
      }}
      onDragOver={(event: DragEvent<HTMLDivElement>) => {
        const isAiPromptDrag = Array.from(event.dataTransfer.types).includes(
          'application/x-phi-notebook-ai-prompt'
        )
        if (!canMove && !isAiPromptDrag) return
        event.preventDefault()
        const rect = event.currentTarget.getBoundingClientRect()
        setDropPlacement(event.clientY < rect.top + rect.height / 2 ? 'before' : 'after')
      }}
      onDragLeave={(event: DragEvent<HTMLDivElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDropPlacement(null)
        }
      }}
      onDrop={(event: DragEvent<HTMLDivElement>) => {
        const isAiPromptDrag = event.dataTransfer.getData('application/x-phi-notebook-ai-prompt')
        if (!canMove && !isAiPromptDrag) return
        event.preventDefault()
        const placement = dropPlacement ?? 'after'
        setDropPlacement(null)
        if (isAiPromptDrag) {
          onMoveAiPrompt?.(cell.id, placement)
          return
        }

        const sourceCellId = event.dataTransfer.getData('application/x-phi-notebook-cell-id')
        if (!sourceCellId || sourceCellId === cell.id) return
        onMoveCell?.(sourceCellId, cell.id, placement)
      }}
      sx={{
        display: 'grid',
        gridTemplateColumns: '32px minmax(0, 1fr) 32px',
        gap: 0.5,
        py: 0.45,
        '&:hover .cell-floating-actions': {
          opacity: 1,
          transform: 'translateY(0)'
        },
        '&:hover .cell-run-button': {
          opacity: 1
        },
        '&:focus-within .cell-floating-actions': {
          opacity: 1,
          transform: 'translateY(0)'
        },
        '&:focus-within .cell-run-button': {
          opacity: 1
        },
        '&:hover .cell-insert-button': {
          opacity: 1
        },
        '&:hover .cell-delete-button': {
          opacity: 1
        },
        '&:hover .cell-drag-handle': {
          opacity: 1
        },
        '&:hover .cell-execution-meta': {
          opacity: 1
        },
        '&:focus-within .cell-insert-button': {
          opacity: 1
        },
        '&:focus-within .cell-delete-button': {
          opacity: 1
        },
        '&:focus-within .cell-drag-handle': {
          opacity: 1
        },
        '&:focus-within .cell-execution-meta': {
          opacity: 1
        },
        '&:hover .cell-number': {
          color: 'text.secondary'
        },
        '&:hover .cell-shell': {
          borderColor: (theme: Theme) => alpha(notebookAccentColor(theme, cellAccent), 0.42),
          bgcolor: (theme) => alpha(theme.palette.text.primary, 0.015)
        }
      }}
    >
      <Box
        sx={{
          minHeight: notebookCodeMinHeight,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          py: 0.15
        }}
      >
        {editable ? (
          <Tooltip title="上方插入 Code cell">
            <IconButton
              className="cell-insert-button"
              size="small"
              aria-label="上方插入 Code cell"
              onClick={() => onInsertBefore?.(cell.id, 'code')}
              sx={{
                ...insertionButtonSx,
                position: 'absolute',
                top: -9,
                left: 5
              }}
            >
              <AddIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        ) : null}
        {cellNumber !== undefined ? (
          <Typography
            className="cell-number"
            variant="caption"
            aria-label={`Cell ${cellNumber}`}
            data-phi-notebook-cell-number={cellNumber}
            sx={{
              color: 'text.disabled',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.72rem',
              lineHeight: 1,
              userSelect: 'none',
              transition: 'color 140ms ease'
            }}
          >
            {cellNumber}
          </Typography>
        ) : null}
        {editable ? (
          <Tooltip title="下方插入 Code cell">
            <IconButton
              className="cell-insert-button"
              size="small"
              aria-label="下方插入 Code cell"
              onClick={() => onInsertAfter?.(cell.id, 'code')}
              sx={{
                ...insertionButtonSx,
                position: 'absolute',
                bottom: -9,
                left: 5
              }}
            >
              <AddIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        ) : null}
      </Box>
      <Box
        className={isRenderedMarkdown ? 'cell-shell cell-shell-markdown' : 'cell-shell'}
        data-phi-notebook-cell-surface={isRenderedMarkdown ? 'markdown-rendered' : 'framed'}
        sx={{
          minWidth: 0,
          position: 'relative',
          border: 1,
          borderColor: (theme) => {
            const accentColor = notebookAccentColor(theme, provisional ? 'ai' : cellAccent)
            if (isRenderedMarkdown && !showAccentShadow) return 'transparent'
            if (provisional) return alpha(accentColor, 0.72)
            if (agentHighlighted) return alpha(theme.palette.primary.main, 0.82)
            if (cell.state === 'error') return theme.palette.error.main
            if (cell.state === 'running') return alpha(accentColor, 0.34)
            if (showEditor) return alpha(accentColor, 0.62)
            if (isCellSelected) return alpha(accentColor, 0.72)
            return alpha(accentColor, 0.22)
          },
          borderRadius: 1.75,
          bgcolor: (theme) => {
            const accentColor = notebookAccentColor(theme, provisional ? 'ai' : cellAccent)
            if (isRenderedMarkdown && !showAccentShadow) return 'transparent'
            if (provisional) return alpha(accentColor, 0.045)
            if (agentHighlighted) return alpha(accentColor, 0.075)
            if (cell.state === 'error') return alpha(theme.palette.error.main, 0.035)
            if (cell.state === 'running') return alpha(accentColor, 0.03)
            if (isCodeSelectionChromeOnly) return 'transparent'
            if (showEditor) return alpha(accentColor, 0.055)
            if (isCellSelected) return alpha(accentColor, 0.065)
            return 'transparent'
          },
          boxShadow: (theme) =>
            showEditor
              ? notebookAccentSelectionShadow(theme, cellAccent, 0.2)
              : provisional
                ? notebookAccentSelectionShadow(theme, 'ai', 0.16)
                : agentHighlighted
                  ? `0 0 0 3px ${alpha(theme.palette.primary.main, 0.16)}`
                  : isCellSelected
                    ? notebookAccentSelectionShadow(theme, cellAccent, 0.18)
                    : 'none',
          overflow: 'visible',
          transition: 'background-color 140ms ease, border-color 140ms ease, box-shadow 140ms ease',
          ...(dropPlacement === 'before'
            ? { boxShadow: (theme) => `0 -2px 0 ${theme.palette.primary.main}` }
            : {}),
          ...(dropPlacement === 'after'
            ? { boxShadow: (theme) => `0 2px 0 ${theme.palette.primary.main}` }
            : {})
        }}
      >
        <Box
          className="cell-source-frame"
          sx={{
            position: 'relative',
            minWidth: 0,
            minHeight: notebookCodeMinHeight,
            ...(isCodeSourceView
              ? {
                  '&::after': {
                    content: '""',
                    position: 'absolute',
                    top: `${notebookCodeContentPaddingTop}px`,
                    bottom: `${notebookCodeContentPaddingBottom}px`,
                    left: `calc(${notebookCodeGutterWidth}px - ${notebookCodeGutterDividerWidth}px)`,
                    width: `${notebookCodeGutterDividerWidth}px`,
                    bgcolor: (theme: Theme) => alpha(theme.palette.text.primary, 0.12),
                    zIndex: 1,
                    pointerEvents: 'none'
                  }
                }
              : {})
          }}
        >
          {editable && onDeleteCell ? (
            <Tooltip title={isRunning ? '运行中的 cell 不能删除' : '删除 cell'}>
              <IconButton
                className="cell-delete-button"
                size="small"
                aria-label="删除 cell"
                aria-disabled={isRunning ? 'true' : undefined}
                data-phi-notebook-cell-delete="marimo"
                onPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
                onMouseDown={(event: MouseEvent<HTMLButtonElement>) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
                onClick={() => {
                  if (!isRunning) onDeleteCell(cell.id)
                }}
                sx={{
                  position: 'absolute',
                  right: 2,
                  bottom: -2,
                  zIndex: 2,
                  width: 28,
                  height: 28,
                  p: 0,
                  opacity: 0,
                  color: (theme) => alpha(theme.palette.error.main, 0.62),
                  bgcolor: 'transparent',
                  boxShadow: 'none',
                  transition: 'opacity 140ms ease, color 140ms ease',
                  '&:hover': {
                    color: 'error.main',
                    bgcolor: 'transparent'
                  },
                  '&[aria-disabled="true"]': {
                    color: 'text.disabled',
                    cursor: 'default'
                  },
                  '&[aria-disabled="true"]:hover': {
                    color: 'text.disabled',
                    bgcolor: 'transparent'
                  }
                }}
              >
                <DeleteIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
          ) : null}
          {showEditor && cell.type === 'code' ? (
            <NotebookCodeEditor
              value={cell.source}
              language={cell.language ?? 'plain'}
              initialSelection={initialEditorSelection}
              onChange={(source) => onSourceChange?.(cell.id, source)}
              completionProvider={
                onCompleteSource
                  ? (request) => onCompleteSource(cell.id, request.source, request.cursorPosition)
                  : undefined
              }
              onFormat={
                onFormatSource
                  ? (source, language) => onFormatSource(cell.id, source, language)
                  : undefined
              }
              onRun={canRun ? () => onRunCell?.(cell.id) : undefined}
              onRequestClose={() => setIsEditing(false)}
            />
          ) : showEditor ? (
            <TextField
              autoFocus
              fullWidth
              multiline
              minRows={isMarkdown ? 2 : 3}
              value={cell.source}
              variant="standard"
              onChange={(event) => onSourceChange?.(cell.id, event.target.value)}
              onBlur={() => setIsEditing(false)}
              slotProps={{
                input: {
                  disableUnderline: true,
                  sx: {
                    p: isMarkdown ? 1.7 : 1.35,
                    pr: 5.5,
                    alignItems: 'flex-start',
                    fontFamily: isMarkdown ? 'inherit' : 'var(--font-mono)',
                    fontSize: isMarkdown ? '0.95rem' : '0.82rem',
                    lineHeight: 1.65,
                    caretColor: (theme: Theme) => notebookCaretColor(theme)
                  }
                }
              }}
            />
          ) : isMarkdown ? (
            <Box
              data-phi-notebook-markdown="rendered"
              data-phi-notebook-markdown-edit-trigger="double-click"
              data-phi-notebook-markdown-select-trigger="single-click"
              role={editable ? 'button' : undefined}
              tabIndex={editable ? 0 : undefined}
              onClick={(event) => {
                if (editable) event.currentTarget.focus()
              }}
              onDoubleClick={() => {
                if (editable) setIsEditing(true)
              }}
              onKeyDown={(event) => {
                if (!editable) return
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setIsEditing(true)
                }
              }}
              sx={{
                minHeight: notebookCodeMinHeight,
                p: 1.3,
                pr: 5.5,
                cursor: editable ? 'text' : 'default',
                '&:focus-visible': {
                  outline: (theme) => `2px solid ${theme.palette.primary.main}`,
                  outlineOffset: -2
                }
              }}
            >
              {cell.source.trim() ? (
                <MarkdownContent text={cell.source} enableMath />
              ) : (
                <Typography color="text.disabled">Markdown</Typography>
              )}
            </Box>
          ) : cell.type === 'code' ? (
            <NotebookCodeCellSource
              source={cell.source}
              language={cell.language ?? 'plain'}
              editable={editable}
              onEdit={(selection) => {
                onSelectCell?.(cell.id)
                setInitialEditorSelection(selection)
                setIsEditing(true)
              }}
              onRun={canRun ? () => onRunCell?.(cell.id) : undefined}
            />
          ) : (
            <Typography
              component="pre"
              variant="body2"
              sx={{
                m: 0,
                p: isMarkdown ? 1.3 : 1.15,
                pr: 5.5,
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                fontFamily: isMarkdown ? 'inherit' : 'var(--font-mono)',
                fontSize: isMarkdown ? '0.95rem' : '0.82rem',
                lineHeight: 1.65
              }}
            >
              {cell.source}
            </Typography>
          )}
        </Box>
        {showCellActions ? (
          <>
            <Box
              className="cell-floating-actions"
              data-phi-notebook-cell-actions="marimo"
              data-phi-notebook-rendered-markdown-actions={
                isRenderedMarkdown ? 'solid-hover' : undefined
              }
              sx={{
                position: 'absolute',
                top: -18,
                right: 8,
                zIndex: 2,
                display: 'flex',
                alignItems: 'center',
                gap: 0.45,
                opacity: menuAnchor ? 1 : 0,
                transform: menuAnchor ? 'translateY(0)' : 'translateY(-2px)',
                transition: 'opacity 150ms ease, transform 150ms ease'
              }}
            >
              <Tooltip title={primaryActionTitle}>
                <span>
                  <IconButton
                    className="cell-run-button"
                    size="small"
                    aria-label={primaryActionLabel}
                    data-phi-notebook-cell-action-surface="opaque"
                    data-phi-notebook-cell-primary-action={
                      isRenderedMarkdown ? 'edit-markdown' : isRunning ? 'stop' : 'run'
                    }
                    data-phi-notebook-cell-primary-action-enabled={
                      isPrimaryActionDisabled ? 'false' : 'true'
                    }
                    disabled={isPrimaryActionDisabled}
                    onClick={
                      isRenderedMarkdown
                        ? () => setIsEditing(true)
                        : isRunning
                          ? () => onStopCell?.(cell.id)
                          : () => onRunCell?.(cell.id)
                    }
                    sx={{
                      ...actionButtonSx,
                      color: (theme: Theme) =>
                        isRunning
                          ? theme.palette.text.disabled
                          : showPrimaryActionAccent
                            ? notebookAccentColor(theme, cellAccent)
                            : theme.palette.text.disabled,
                      bgcolor: (theme) => theme.palette.background.paper,
                      '&:hover': {
                        bgcolor: (theme: Theme) => theme.palette.background.paper
                      },
                      '&.Mui-disabled': {
                        bgcolor: (theme) => theme.palette.background.paper,
                        color: 'text.disabled',
                        opacity: 1
                      }
                    }}
                  >
                    {isRenderedMarkdown ? (
                      <MarkdownIcon
                        data-phi-notebook-rendered-markdown-action-icon="solid"
                        sx={{
                          fontSize: 16,
                          opacity: 1,
                          '& svg, & path': {
                            opacity: 1
                          }
                        }}
                      />
                    ) : isRunning ? (
                      <StopIcon sx={{ fontSize: 15 }} />
                    ) : (
                      <PlayIcon sx={{ fontSize: 16 }} />
                    )}
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Cell 操作">
                <IconButton
                  size="small"
                  aria-label="Cell 操作"
                  data-phi-notebook-cell-action-surface="opaque"
                  onClick={(event: MouseEvent<HTMLButtonElement>) =>
                    setMenuAnchor(event.currentTarget)
                  }
                  sx={actionButtonSx}
                >
                  <MoreIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            </Box>
            <Menu
              anchorEl={menuAnchor}
              open={Boolean(menuAnchor)}
              onClose={closeMenu}
              slotProps={{ paper: { sx: { minWidth: 230 } } }}
            >
              <MenuItem onClick={() => runMenuAction(() => onInsertAfter?.(cell.id, 'code'))}>
                <ListItemIcon>
                  <CodeIcon sx={{ fontSize: 17 }} />
                </ListItemIcon>
                <ListItemText primary="下方添加 Code cell" />
              </MenuItem>
              <MenuItem onClick={() => runMenuAction(() => onInsertAfter?.(cell.id, 'markdown'))}>
                <ListItemIcon>
                  <FileIcon sx={{ fontSize: 17 }} />
                </ListItemIcon>
                <ListItemText primary="下方添加 Markdown cell" />
              </MenuItem>
              <Divider />
              <MenuItem
                disabled={cell.type === 'code'}
                onClick={() => runMenuAction(() => onConvertCell?.(cell.id, 'code'))}
              >
                <ListItemIcon>
                  <CodeIcon sx={{ fontSize: 17 }} />
                </ListItemIcon>
                <ListItemText primary="转为 Code" />
              </MenuItem>
              <MenuItem
                disabled={cell.type === 'markdown'}
                onClick={() => runMenuAction(() => onConvertCell?.(cell.id, 'markdown'))}
              >
                <ListItemIcon>
                  <FileIcon sx={{ fontSize: 17 }} />
                </ListItemIcon>
                <ListItemText primary="转为 Markdown" />
              </MenuItem>
              <MenuItem
                disabled={!hasOutputs}
                onClick={() => runMenuAction(() => onClearOutputs?.(cell.id))}
              >
                <ListItemIcon>
                  <RefreshIcon sx={{ fontSize: 17 }} />
                </ListItemIcon>
                <ListItemText primary="清空输出" />
              </MenuItem>
              <MenuItem
                disabled={cell.type !== 'code' || !onFormatSource}
                onClick={() =>
                  runMenuAction(() => onFormatSource?.(cell.id, cell.source, cell.language))
                }
              >
                <ListItemIcon>
                  <FormatIcon sx={{ fontSize: 17 }} />
                </ListItemIcon>
                <ListItemText primary="格式化 cell" />
              </MenuItem>
              <Divider />
              <MenuItem
                disabled={isRunning}
                onClick={() =>
                  runMenuAction(() => {
                    if (!isRunning) onDeleteCell?.(cell.id)
                  })
                }
              >
                <ListItemIcon>
                  <DeleteIcon color="error" sx={{ fontSize: 17 }} />
                </ListItemIcon>
                <ListItemText primary="删除 cell" />
              </MenuItem>
            </Menu>
          </>
        ) : null}
        {cell.outputs.length > 0 ? (
          // NotebookOutputArea already draws its own top border as the
          // code/output divider -- an extra <Divider /> here just stacked a
          // second hairline right against it, making the seam look thicker
          // than the single clean line Marimo (and this one) is going for.
          <NotebookOutputArea outputs={cell.outputs} notebookPath={notebookPath} />
        ) : null}
      </Box>
      <Box
        sx={{
          minHeight: notebookCodeMinHeight,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexDirection: 'column',
          py: 0.25
        }}
      >
        {executionMetaLabel ? (
          <Typography
            className="cell-execution-meta"
            variant="caption"
            data-phi-notebook-cell-execution-duration={executionMetaLabel}
            sx={{
              minHeight: 18,
              opacity: showExecutionMeta ? 1 : 0,
              color: isRunning ? 'primary.main' : 'text.secondary',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.68rem',
              lineHeight: '18px',
              transition: 'opacity 140ms ease, color 140ms ease',
              whiteSpace: 'nowrap'
            }}
          >
            {executionMetaLabel}
          </Typography>
        ) : (
          <Box sx={{ minHeight: 18 }} />
        )}
        {canMove ? (
          <Tooltip title="拖动 cell">
            <IconButton
              className="cell-drag-handle"
              size="small"
              aria-label="拖动 cell"
              draggable
              data-phi-notebook-cell-drag-handle="true"
              onDragStart={(event: DragEvent<HTMLButtonElement>) => {
                event.dataTransfer.setData('application/x-phi-notebook-cell-id', cell.id)
                event.dataTransfer.effectAllowed = 'move'
              }}
              onDragEnd={() => setDropPlacement(null)}
              sx={{
                width: 22,
                height: 30,
                borderRadius: 0.75,
                opacity: 0,
                color: 'text.disabled',
                cursor: 'grab',
                transition: 'opacity 140ms ease, color 140ms ease',
                '&:active': { cursor: 'grabbing' },
                '&:hover': {
                  color: 'text.secondary',
                  bgcolor: 'transparent'
                }
              }}
            >
              <TbGripVertical size={18} />
            </IconButton>
          </Tooltip>
        ) : null}
      </Box>
    </Box>
  )
}

const NotebookCell = memo(NotebookCellImpl, notebookCellPropsEqual)

export default NotebookCell
