import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode
} from 'react'
import { Box, Button, Typography } from '@mui/material'

import type { SyntaxLanguage } from '../../../lib/syntaxHighlight'
import { PhiIcons, fileIconForPath } from '../../../icons'
import { hasLiveNotebookSession, isNotebookSessionRunnable } from '../lib/notebookSession'
import {
  acceptStagedNotebookCell,
  contextReferenceForSelectedCell,
  isNotebookAiPreviewCell,
  notebookCellsWithAiPreview,
  rejectStagedNotebookCell,
  shouldIgnoreNotebookAiRefactorShortcut,
  stageGeneratedNotebookCells,
  type NotebookAiPromptDraft
} from '../lib/notebookAiPromptDraft'
import type { NotebookCanvasProps, PendingKernelSwitch } from '../lib/notebookCanvasTypes'
import { notebookAiEmptyGenerationMessage, notebookAiPromptError } from '../lib/notebookAiErrors'
import {
  isNotebookCodeEditorShortcutTarget,
  isNotebookPromptShortcutTarget,
  isNotebookTextEntryShortcutTarget
} from '../lib/notebookShortcuts'
import { notebookAiGeneratedCellsFromResult } from '../lib/notebookAiGenerationResult'
import { useNotebookAutoConnect } from '../lib/useNotebookAutoConnect'
import {
  clearNotebookCellOutput,
  deleteNotebookCell,
  insertNotebookCell,
  moveNotebookCell,
  updateNotebookCell,
  type NotebookCellType,
  type NotebookDocument
} from '../../../../../shared/notebookDocument'
import {
  buildNotebookAiContextOptions,
  documentCells,
  contextReferenceForFilePath,
  kernelAvailabilityColor,
  kernelAvailabilityLabel,
  kernelOptionLabel,
  compactPath,
  notebookKernelName,
  notebookLanguage,
  notebookOutline,
  notebookSessionStateColor,
  notebookSessionStateLabel,
  notebookSyntaxLanguage,
  withNotebookKernel,
  type NotebookListEntry,
  type NotebookOutlineItem
} from '../lib/notebookViewModel'
import {
  normalizedNotebookVirtualRowHeight,
  notebookVirtualWindow,
  type NotebookVirtualViewport
} from '../lib/notebookVirtualization'
import type { AnalysisNotebookContextReference, ModelOption } from '../../../types'
import { NotebookHeader } from '../components/NotebookHeader'
import { useNotebookSourceServices } from '../hooks/useNotebookSourceServices'
import NotebookAiPromptCell, {
  type NotebookAiPromptReferenceAddOptions
} from './NotebookAiPromptCell'
import NotebookAiPreviewActions from './NotebookAiPreviewActions'
import NotebookCell, { type CellPlacement } from './NotebookCell'
import NotebookFloatingActions, {
  notebookFloatingActionInset,
  type NotebookFloatingActionAnchor
} from './NotebookFloatingActions'
import NotebookInsertDock from './NotebookInsertDock'
import NotebookKernelSwitchDialog from './NotebookKernelSwitchDialog'
import NotebookScrollProgressRail from './NotebookScrollProgressRail'

const notebookSiblingSpacingSelector =
  '& > [data-phi-notebook-cell] + [data-phi-notebook-cell], & > [data-phi-notebook-cell] + [data-phi-notebook-ai-prompt-cell], & > [data-phi-notebook-ai-prompt-cell] + [data-phi-notebook-cell], & > [data-phi-notebook-cell] + [data-phi-notebook-ai-preview-actions], & > [data-phi-notebook-ai-preview-actions] + [data-phi-notebook-cell], & > [data-phi-notebook-ai-preview-actions] + [data-phi-notebook-ai-prompt-cell]'

const AddIcon = PhiIcons.action.add
const initialVirtualViewport: NotebookVirtualViewport = { scrollTop: 0, viewportHeight: 0 }

type NotebookVirtualRowHeightState = {
  documentKey: string | null
  heights: Record<string, number>
}

function notebookVirtualListScrollTop(
  scrollViewport: HTMLElement,
  virtualList: HTMLElement | null
): number {
  if (!virtualList) return 0
  const viewportRect = scrollViewport.getBoundingClientRect()
  const listRect = virtualList.getBoundingClientRect()
  return Math.max(0, scrollViewport.scrollTop + listRect.top - viewportRect.top)
}

function NotebookVirtualRowShell({
  cellId,
  index,
  onMeasure,
  children
}: {
  cellId: string
  index: number
  onMeasure: (cellId: string, element: HTMLDivElement | null) => void
  children: ReactNode
}): React.JSX.Element {
  const onRowRef = useCallback(
    (element: HTMLDivElement | null) => onMeasure(cellId, element),
    [cellId, onMeasure]
  )

  return (
    <Box
      ref={onRowRef}
      data-phi-notebook-virtual-row="true"
      data-phi-notebook-virtual-row-index={index}
      sx={{ pt: index === 0 ? 0 : 1.35 }}
    >
      {children}
    </Box>
  )
}

function EmptyNotebookState({
  notebooks,
  projectCwd,
  onSelectNotebook,
  onCreateNotebook
}: {
  notebooks: NotebookListEntry[]
  projectCwd?: string | null
  onSelectNotebook?: (notebook: NotebookListEntry) => void
  onCreateNotebook?: (cwd: string) => void
}): React.JSX.Element {
  const visibleNotebooks = notebooks.slice(0, 5)
  const canCreateNotebook = Boolean(projectCwd && onCreateNotebook)

  return (
    <Box
      data-phi-notebook-empty-state="true"
      sx={{
        border: 1,
        borderColor: 'divider',
        borderRadius: 2,
        px: 2,
        py: 3,
        color: 'text.secondary'
      }}
    >
      <Typography variant="body2">选择或创建 notebook 后开始分析。</Typography>
      {visibleNotebooks.length > 0 ? (
        <Box
          data-phi-notebook-empty-options="true"
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: 0.75,
            mt: 2
          }}
        >
          {visibleNotebooks.map((notebook) => {
            const notebookIcon = fileIconForPath(notebook.path)
            const NotebookFileIcon = notebookIcon.Icon
            return (
              <Button
                key={notebook.id}
                data-phi-notebook-empty-select={notebook.path}
                variant="outlined"
                startIcon={
                  <NotebookFileIcon
                    data-phi-notebook-empty-select-icon={notebookIcon.materialIconName}
                    fontSize="small"
                    sx={{ color: notebookIcon.color }}
                  />
                }
                onClick={() => onSelectNotebook?.(notebook)}
                sx={{
                  justifyContent: 'flex-start',
                  minHeight: 36,
                  minWidth: 0,
                  textTransform: 'none',
                  color: 'text.primary'
                }}
              >
                <Box component="span" sx={{ minWidth: 0, textAlign: 'left' }}>
                  <Typography component="span" noWrap sx={{ display: 'block', fontWeight: 700 }}>
                    {compactPath(notebook.path)}
                  </Typography>
                  <Typography
                    component="span"
                    noWrap
                    sx={{ display: 'block', color: 'text.secondary', fontSize: '0.75rem' }}
                  >
                    {notebook.status}
                  </Typography>
                </Box>
              </Button>
            )
          })}
        </Box>
      ) : null}
      {canCreateNotebook ? (
        <Button
          data-phi-notebook-empty-create="true"
          variant={visibleNotebooks.length > 0 ? 'text' : 'outlined'}
          startIcon={<AddIcon fontSize="small" />}
          onClick={() => {
            if (projectCwd) onCreateNotebook?.(projectCwd)
          }}
          sx={{ mt: visibleNotebooks.length > 0 ? 1.25 : 2, textTransform: 'none' }}
        >
          新建 notebook
        </Button>
      ) : null}
    </Box>
  )
}

export default function NotebookCanvas({
  activeNotebookPath,
  notebooks,
  notebookFile,
  initialDocument,
  isOpening,
  error,
  hideNotebookTabs,
  kernelDiagnostics,
  isLoadingKernels,
  kernelError,
  notebookSessionStatus,
  isStartingNotebookSession,
  notebookSessionError,
  executingCellId,
  cellExecutionError,
  availableNotebooks,
  projectCwd,
  onSaveNotebook,
  onSyncNotebookDraft,
  onNotebookDirtyChange,
  onStartNotebookSession,
  onStopNotebookSession,
  onRunNotebookCell,
  onStopNotebookCell,
  onCompleteNotebookCell,
  onFormatNotebookCell,
  onGenerateNotebookCode,
  onNotebookCodeGenerationProgress,
  aiModelOptions,
  aiDefaultModel,
  onPickContextFiles,
  onSelectNotebook,
  onCreateNotebook,
  onCloseNotebook,
  agentFocus
}: NotebookCanvasProps): React.JSX.Element {
  const [draftDocument, setDraftDocument] = useState<NotebookDocument | null>(initialDocument)
  const [draftNotebookPath, setDraftNotebookPath] = useState<string | null>(
    notebookFile?.path ?? null
  )
  const [selectedCellId, setSelectedCellId] = useState<string | null>(null)
  const [agentHighlightedCellId, setAgentHighlightedCellId] = useState<string | null>(null)
  const [aiPromptDraft, setAiPromptDraft] = useState<NotebookAiPromptDraft | null>(null)
  const [pendingKernelSwitch, setPendingKernelSwitch] = useState<PendingKernelSwitch | null>(null)
  const notebookCanvasRef = useRef<HTMLDivElement | null>(null)
  const scrollViewportRef = useRef<HTMLDivElement | null>(null)
  const virtualListRef = useRef<HTMLDivElement | null>(null)
  const aiPromptDraftRef = useRef<NotebookAiPromptDraft | null>(null)
  const scrollFrameRef = useRef<number | null>(null)
  const virtualRowObserversRef = useRef<Map<string, ResizeObserver>>(new Map())
  const notebookDocumentKey = notebookFile?.path ?? activeNotebookPath ?? null
  const previousNotebookDocumentKeyRef = useRef<string | null>(notebookDocumentKey)
  const latestDraftForFlushRef = useRef<{
    file: NonNullable<NotebookCanvasProps['notebookFile']>
    document: NotebookDocument
    sync: NonNullable<NotebookCanvasProps['onSyncNotebookDraft']>
  } | null>(null)
  const lastReportedDirtyRef = useRef<{ path: string; dirty: boolean } | null>(null)
  const [virtualViewport, setVirtualViewport] =
    useState<NotebookVirtualViewport>(initialVirtualViewport)
  const [virtualRowHeightState, setVirtualRowHeightState] = useState<NotebookVirtualRowHeightState>(
    {
      documentKey: notebookDocumentKey,
      heights: {}
    }
  )
  const virtualRowHeights = useMemo(
    () =>
      virtualRowHeightState.documentKey === notebookDocumentKey
        ? virtualRowHeightState.heights
        : {},
    [notebookDocumentKey, virtualRowHeightState]
  )
  const [floatingActionAnchor, setFloatingActionAnchor] = useState<NotebookFloatingActionAnchor>({
    right: notebookFloatingActionInset,
    bottom: notebookFloatingActionInset
  })
  const cells = useMemo(
    () => (draftDocument ? documentCells(draftDocument, executingCellId) : []),
    [draftDocument, executingCellId]
  )
  const aiContextOptions = useMemo(() => buildNotebookAiContextOptions(cells), [cells])
  const insertCodeLanguage = draftDocument ? notebookSyntaxLanguage(draftDocument) : 'plain'
  const displayCells = useMemo(
    () => notebookCellsWithAiPreview(cells, aiPromptDraft, insertCodeLanguage),
    [aiPromptDraft, cells, insertCodeLanguage]
  )
  const virtualCells = useMemo(
    () => notebookVirtualWindow(displayCells, virtualRowHeights, virtualViewport),
    [displayCells, virtualRowHeights, virtualViewport]
  )
  const cellIndexById = useMemo(
    () => new Map(displayCells.map((cell, index) => [cell.id, index])),
    [displayCells]
  )
  const outline = useMemo(() => notebookOutline(displayCells), [displayCells])
  const [activeOutlineId, setActiveOutlineId] = useState<string | null>(outline[0]?.id ?? null)

  useEffect(() => {
    aiPromptDraftRef.current = aiPromptDraft
  }, [aiPromptDraft])

  useEffect(() => {
    const virtualRowObservers = virtualRowObserversRef.current
    return () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current)
      }
      for (const observer of virtualRowObservers.values()) {
        observer.disconnect()
      }
      virtualRowObservers.clear()
    }
  }, [])

  const syncVirtualViewport = useCallback((): void => {
    const scrollViewport = scrollViewportRef.current
    if (!scrollViewport) return
    const listTop = notebookVirtualListScrollTop(scrollViewport, virtualListRef.current)
    const nextViewport = {
      scrollTop: Math.max(0, scrollViewport.scrollTop - listTop),
      viewportHeight: scrollViewport.clientHeight
    }
    setVirtualViewport((current) =>
      current.scrollTop === nextViewport.scrollTop &&
      current.viewportHeight === nextViewport.viewportHeight
        ? current
        : nextViewport
    )
  }, [])

  const findOutlineCellElement = useCallback((cellId: string): HTMLElement | null => {
    const scrollViewport = scrollViewportRef.current
    if (!scrollViewport) return null
    return (
      Array.from(scrollViewport.querySelectorAll<HTMLElement>('[data-phi-notebook-cell-id]')).find(
        (element) => element.dataset.phiNotebookCellId === cellId
      ) ?? null
    )
  }, [])

  const updateActiveOutline = useCallback(() => {
    const scrollViewport = scrollViewportRef.current
    if (!scrollViewport || outline.length === 0) {
      setActiveOutlineId(null)
      return
    }

    const isAtScrollEnd =
      scrollViewport.scrollTop + scrollViewport.clientHeight >= scrollViewport.scrollHeight - 8
    if (isAtScrollEnd) {
      const activeId = outline.at(-1)?.id ?? null
      setActiveOutlineId((currentId) => (currentId === activeId ? currentId : activeId))
      return
    }

    if (virtualCells.enabled) {
      const listTop = notebookVirtualListScrollTop(scrollViewport, virtualListRef.current)
      const thresholdTop = Math.max(0, scrollViewport.scrollTop - listTop + 24)
      let activeId = outline[0].id
      for (const item of outline) {
        const index = cellIndexById.get(item.cellId)
        if (index === undefined) continue
        const itemTop = virtualCells.offsets[index] ?? 0
        if (itemTop <= thresholdTop) {
          activeId = item.id
          continue
        }
        break
      }
      setActiveOutlineId((currentId) => (currentId === activeId ? currentId : activeId))
      return
    }

    let activeId = outline[0].id
    const thresholdTop = scrollViewport.scrollTop + 24
    for (const item of outline) {
      const element = findOutlineCellElement(item.cellId)
      if (!element) continue
      if (element.offsetTop <= thresholdTop) {
        activeId = item.id
        continue
      }
      break
    }
    setActiveOutlineId((currentId) => (currentId === activeId ? currentId : activeId))
  }, [cellIndexById, findOutlineCellElement, outline, virtualCells])

  const scrollToNotebookCell = useCallback(
    (cellId: string, block: ScrollLogicalPosition): void => {
      const element = findOutlineCellElement(cellId)
      if (element) {
        element.scrollIntoView({ block, behavior: block === 'nearest' ? 'auto' : 'smooth' })
        return
      }
      if (!virtualCells.enabled) return
      const scrollViewport = scrollViewportRef.current
      const index = cellIndexById.get(cellId)
      if (!scrollViewport || index === undefined) return
      const listTop = notebookVirtualListScrollTop(scrollViewport, virtualListRef.current)
      const itemTop = virtualCells.offsets[index] ?? 0
      const itemHeight = virtualCells.heights[index] ?? 0
      const cellTop = listTop + itemTop
      const cellBottom = cellTop + itemHeight
      if (block === 'nearest') {
        const viewportTop = scrollViewport.scrollTop
        const viewportBottom = viewportTop + scrollViewport.clientHeight
        if (cellTop >= viewportTop && cellBottom <= viewportBottom) return
        const targetTop =
          cellTop < viewportTop ? cellTop : Math.max(0, cellBottom - scrollViewport.clientHeight)
        scrollViewport.scrollTo({ top: targetTop, behavior: 'auto' })
        return
      }
      const targetTop =
        block === 'center'
          ? cellTop - Math.max(0, (scrollViewport.clientHeight - itemHeight) / 2)
          : cellTop
      scrollViewport.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' })
    },
    [cellIndexById, findOutlineCellElement, virtualCells]
  )

  const measureVirtualRow = useCallback(
    (cellId: string, element: HTMLDivElement | null): void => {
      const existingObserver = virtualRowObserversRef.current.get(cellId)
      if (existingObserver) {
        existingObserver.disconnect()
        virtualRowObserversRef.current.delete(cellId)
      }
      if (!element) return

      const updateHeight = (): void => {
        const height = normalizedNotebookVirtualRowHeight(element.getBoundingClientRect().height)
        setVirtualRowHeightState((current) => {
          const currentHeights = current.documentKey === notebookDocumentKey ? current.heights : {}
          if (current.documentKey === notebookDocumentKey && currentHeights[cellId] === height) {
            return current
          }
          return {
            documentKey: notebookDocumentKey,
            heights: { ...currentHeights, [cellId]: height }
          }
        })
      }
      updateHeight()

      if (typeof ResizeObserver === 'undefined') return
      const observer = new ResizeObserver(updateHeight)
      observer.observe(element)
      virtualRowObserversRef.current.set(cellId, observer)
    },
    [notebookDocumentKey]
  )

  const updateNotebookScrollState = useCallback(() => {
    syncVirtualViewport()
    updateActiveOutline()
  }, [syncVirtualViewport, updateActiveOutline])

  const scheduleNotebookScrollState = useCallback(() => {
    if (scrollFrameRef.current !== null) return
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null
      updateNotebookScrollState()
    })
  }, [updateNotebookScrollState])

  const handleNotebookScroll = scheduleNotebookScrollState

  useEffect(() => {
    scheduleNotebookScrollState()
  }, [displayCells.length, scheduleNotebookScrollState])

  const onSelectOutlineItem = useCallback(
    (item: NotebookOutlineItem): void => {
      scrollToNotebookCell(item.cellId, 'start')
      setActiveOutlineId(item.id)
    },
    [scrollToNotebookCell]
  )

  useEffect(() => {
    if (!agentFocus || !notebookFile) return
    if (
      agentFocus.path !== notebookFile.path &&
      agentFocus.relativePath !== notebookFile.relativePath
    ) {
      return
    }
    if (!cells.some((cell) => cell.id === agentFocus.cellId)) return

    const focusTimer = window.setTimeout(() => {
      setSelectedCellId(agentFocus.cellId)
      setAgentHighlightedCellId(agentFocus.cellId)
      scrollToNotebookCell(agentFocus.cellId, 'center')
    }, 0)
    const clearTimer = window.setTimeout(() => {
      setAgentHighlightedCellId((current) => (current === agentFocus.cellId ? null : current))
    }, 2600)

    return () => {
      window.clearTimeout(focusTimer)
      window.clearTimeout(clearTimer)
    }
  }, [agentFocus, cells, notebookFile, scrollToNotebookCell])

  useEffect(() => {
    const notebookChanged = previousNotebookDocumentKeyRef.current !== notebookDocumentKey
    previousNotebookDocumentKeyRef.current = notebookDocumentKey
    const notebookPath = notebookFile?.path ?? null
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) {
        setDraftDocument(initialDocument)
        setDraftNotebookPath(notebookPath)
        setSelectedCellId(null)
        if (notebookChanged) setAiPromptDraft(null)
      }
    })
    return () => {
      cancelled = true
    }
  }, [initialDocument, notebookDocumentKey, notebookFile?.path])

  useEffect(() => {
    if (!onNotebookCodeGenerationProgress) return undefined
    return onNotebookCodeGenerationProgress((progress) => {
      const draftSnapshot = aiPromptDraftRef.current
      if (
        !draftSnapshot ||
        draftSnapshot.isGenerating ||
        draftSnapshot.id !== progress.requestId ||
        progress.cells.length === 0
      ) {
        return
      }
      setAiPromptDraft((draft) => {
        if (
          !draft ||
          !draftDocument ||
          draft.isGenerating ||
          draft.id !== progress.requestId ||
          progress.cells.length === 0
        ) {
          return draft
        }
        if (
          notebookFile &&
          progress.path !== notebookFile.path &&
          progress.relativePath !== notebookFile.relativePath
        ) {
          return draft
        }
        return {
          ...draft,
          stagedCells: stageGeneratedNotebookCells(draftDocument, draft, progress.cells),
          error: null,
          errorDetail: null
        }
      })
    })
  }, [draftDocument, notebookFile, onNotebookCodeGenerationProgress])

  useEffect(() => {
    if (!notebookFile || !draftDocument || !onSyncNotebookDraft) return
    const timeout = window.setTimeout(() => {
      onSyncNotebookDraft(notebookFile, draftDocument)
    }, 300)
    return () => {
      window.clearTimeout(timeout)
    }
  }, [draftDocument, notebookFile, onSyncNotebookDraft])

  useEffect(() => {
    scheduleNotebookScrollState()
    const scrollViewport = scrollViewportRef.current
    if (!scrollViewport) return

    const content = scrollViewport.firstElementChild
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleNotebookScrollState)
    resizeObserver?.observe(scrollViewport)
    if (content) resizeObserver?.observe(content)
    window.addEventListener('resize', scheduleNotebookScrollState)

    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', scheduleNotebookScrollState)
    }
  }, [draftDocument?.revision, displayCells.length, outline.length, scheduleNotebookScrollState])

  useEffect(() => {
    const updateFloatingActionAnchor = (): void => {
      const canvas = notebookCanvasRef.current
      if (!canvas) return

      const rect = canvas.getBoundingClientRect()
      const nextAnchor = {
        right: Math.max(
          notebookFloatingActionInset,
          Math.round(window.innerWidth - rect.right + notebookFloatingActionInset)
        ),
        bottom: Math.max(
          notebookFloatingActionInset,
          Math.round(window.innerHeight - rect.bottom + notebookFloatingActionInset)
        )
      }
      setFloatingActionAnchor((currentAnchor) =>
        currentAnchor.right === nextAnchor.right && currentAnchor.bottom === nextAnchor.bottom
          ? currentAnchor
          : nextAnchor
      )
    }

    updateFloatingActionAnchor()
    const canvas = notebookCanvasRef.current
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateFloatingActionAnchor)
    if (canvas) resizeObserver?.observe(canvas)
    window.addEventListener('resize', updateFloatingActionAnchor)

    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', updateFloatingActionAnchor)
    }
  }, [])

  const canRunCells = Boolean(
    notebookFile && draftDocument && onRunNotebookCell && !executingCellId
  )
  const {
    canUseCompletionProvider,
    formattingError,
    isFormattingNotebook,
    onCompleteCellSource,
    onFormatCellSource,
    onFormatNotebook
  } = useNotebookSourceServices({
    notebookFile,
    draftDocument,
    setDraftDocument,
    onCompleteNotebookCell,
    onFormatNotebookCell
  })
  const selectedKernelName = draftDocument ? notebookKernelName(draftDocument) : ''
  const draftMatchesOpenNotebook = Boolean(notebookFile && draftNotebookPath === notebookFile.path)
  const autoConnectKey =
    notebookFile && draftDocument && draftMatchesOpenNotebook
      ? `${notebookFile.path}:${selectedKernelName || notebookLanguage(draftDocument)}`
      : null
  const { autoConnectKeyRef } = useNotebookAutoConnect({
    autoConnectKey,
    notebookFile,
    draftDocument: draftMatchesOpenNotebook ? draftDocument : null,
    onStartNotebookSession,
    requestedKernelName: selectedKernelName || undefined,
    kernelDiagnostics,
    isStartingNotebookSession,
    notebookSessionStatus,
    notebookSessionError
  })
  const kernelLabel = draftDocument
    ? isNotebookSessionRunnable(notebookSessionStatus)
      ? (notebookSessionStatus?.kernelDisplayName ??
        notebookSessionStatus?.kernelName ??
        notebookLanguage(draftDocument))
      : `${notebookLanguage(draftDocument)} notebook`
    : 'No notebook'
  const kernelStatusLabel = notebookSessionStatus
    ? notebookSessionStateLabel(notebookSessionStatus)
    : kernelAvailabilityLabel(
        draftDocument,
        kernelDiagnostics,
        Boolean(isLoadingKernels),
        kernelError
      )
  const kernelStatusColor = notebookSessionStatus
    ? notebookSessionStateColor(notebookSessionStatus)
    : kernelAvailabilityColor(kernelStatusLabel)
  const isDirty = Boolean(
    notebookFile && draftDocument && draftDocument.revision !== notebookFile.savedRevision
  )
  useLayoutEffect(() => {
    const path = notebookFile?.path
    return () => {
      const latest = latestDraftForFlushRef.current
      if (
        latest &&
        latest.file.path === path &&
        latest.document.revision !== latest.file.savedRevision
      ) {
        latest.sync(latest.file, latest.document)
      }
    }
  }, [notebookFile?.path])

  useLayoutEffect(() => {
    if (
      !notebookFile ||
      !draftDocument ||
      previousNotebookDocumentKeyRef.current !== notebookDocumentKey
    ) {
      return
    }
    latestDraftForFlushRef.current = onSyncNotebookDraft
      ? { file: notebookFile, document: draftDocument, sync: onSyncNotebookDraft }
      : null
    if (
      lastReportedDirtyRef.current?.path !== notebookFile.path ||
      lastReportedDirtyRef.current.dirty !== isDirty
    ) {
      lastReportedDirtyRef.current = { path: notebookFile.path, dirty: isDirty }
      onNotebookDirtyChange?.(notebookFile, isDirty)
    }
  }, [
    draftDocument,
    isDirty,
    notebookDocumentKey,
    notebookFile,
    onNotebookDirtyChange,
    onSyncNotebookDraft
  ])

  const saveNotebookDocument = useCallback(
    async (document: NotebookDocument): Promise<void> => {
      if (notebookFile && onSaveNotebook) {
        await onSaveNotebook(notebookFile, document)
      }
    },
    [notebookFile, onSaveNotebook]
  )
  const onUpdateCellSource = (cellId: string, source: string): void => {
    setDraftDocument((document) =>
      document ? updateNotebookCell(document, cellId, { source }) : document
    )
  }
  const onInsertCell = useCallback(
    async (
      cellId: string,
      placement: CellPlacement,
      cellType: Extract<NotebookCellType, 'code' | 'markdown'> = 'code'
    ): Promise<void> => {
      if (!draftDocument) return

      const index = draftDocument.cells.findIndex((cell) => cell.id === cellId)
      const nextDocument = insertNotebookCell(
        draftDocument,
        index + (placement === 'after' ? 1 : 0),
        {
          cellType,
          source: ''
        }
      )
      setDraftDocument(nextDocument)
      await saveNotebookDocument(nextDocument)
    },
    [draftDocument, saveNotebookDocument]
  )
  // Stable per-direction wrappers so NotebookCell (memoized) doesn't see a
  // fresh function identity on every render — onInsertCell itself reads
  // draftDocument directly (not via a setState updater), so a stale
  // reference here could insert against an outdated document snapshot;
  // keeping both in lockstep via useCallback avoids that without needing
  // NotebookCell to treat them as always-safe-to-ignore.
  const onInsertCellBefore = useCallback(
    (cellId: string, cellType?: Extract<NotebookCellType, 'code' | 'markdown'>) =>
      onInsertCell(cellId, 'before', cellType),
    [onInsertCell]
  )
  const onInsertCellAfter = useCallback(
    (cellId: string, cellType?: Extract<NotebookCellType, 'code' | 'markdown'>) =>
      onInsertCell(cellId, 'after', cellType),
    [onInsertCell]
  )
  const openAiPrompt = useCallback(
    (options: { mode?: 'insert' | 'refactor'; targetCellId?: string | null } = {}): void => {
      const mode = options.mode ?? 'insert'
      const requestedTargetCellId = options.targetCellId ?? null
      const targetIndex = requestedTargetCellId
        ? cells.findIndex((cell) => cell.id === requestedTargetCellId)
        : -1
      const targetCell = targetIndex >= 0 ? cells[targetIndex] : null
      if (mode === 'refactor' && !targetCell) return
      const targetCellId = mode === 'refactor' ? (targetCell?.id ?? null) : null

      const liveSelectedCellId =
        selectedCellId && cells.some((cell) => cell.id === selectedCellId) ? selectedCellId : null
      const afterCellId =
        mode === 'refactor' ? targetCellId : (liveSelectedCellId ?? cells.at(-1)?.id ?? null)
      const targetLanguage =
        mode === 'refactor' && targetCell?.type === 'markdown' ? 'markdown' : insertCodeLanguage
      const references =
        mode === 'refactor' && targetCell
          ? [contextReferenceForSelectedCell(targetCell, targetIndex)]
          : []

      setSelectedCellId(null)
      setAiPromptDraft({
        id: `phi-ai-${Date.now()}`,
        mode,
        afterCellId,
        targetCellId,
        prompt: '',
        language: targetLanguage,
        model: aiDefaultModel ?? null,
        references,
        stagedCells: [],
        isGenerating: false,
        error: null,
        errorDetail: null
      })
    },
    [aiDefaultModel, cells, insertCodeLanguage, selectedCellId]
  )
  useEffect(() => {
    const handleNotebookAiRefactorShortcut = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== 'e') {
        return
      }
      if (!draftDocument || !notebookFile || isOpening || aiPromptDraft?.isGenerating) return
      if (shouldIgnoreNotebookAiRefactorShortcut(event.target)) return
      const liveSelectedCellId =
        selectedCellId && cells.some((cell) => cell.id === selectedCellId) ? selectedCellId : null
      if (!liveSelectedCellId) return

      event.preventDefault()
      event.stopPropagation()
      openAiPrompt({ mode: 'refactor', targetCellId: liveSelectedCellId })
    }

    document.addEventListener('keydown', handleNotebookAiRefactorShortcut, true)
    return () => {
      document.removeEventListener('keydown', handleNotebookAiRefactorShortcut, true)
    }
  }, [
    aiPromptDraft?.isGenerating,
    cells,
    draftDocument,
    isOpening,
    notebookFile,
    openAiPrompt,
    selectedCellId
  ])
  const updateAiPrompt = (prompt: string): void => {
    setAiPromptDraft((draft) =>
      draft ? { ...draft, prompt, stagedCells: [], error: null, errorDetail: null } : draft
    )
  }
  const updateAiPromptLanguage = (language: SyntaxLanguage): void => {
    setAiPromptDraft((draft) =>
      draft ? { ...draft, language, stagedCells: [], error: null, errorDetail: null } : draft
    )
  }
  const updateAiPromptModel = (model: ModelOption | null): void => {
    setAiPromptDraft((draft) =>
      draft
        ? {
            ...draft,
            model,
            stagedCells: [],
            error: null,
            errorDetail: null
          }
        : draft
    )
  }
  const addAiPromptReference = (
    reference: AnalysisNotebookContextReference,
    options: NotebookAiPromptReferenceAddOptions = {}
  ): void => {
    setAiPromptDraft((draft) => {
      if (!draft) return draft
      const references = draft.references.some((item) => item.id === reference.id)
        ? draft.references
        : [...draft.references, reference]
      const token = `@${reference.name}`
      const prompt =
        options.prompt ??
        (/(?:^|\s)@$/.test(draft.prompt)
          ? draft.prompt.replace(
              /(?:^|\s)@$/,
              (match) => `${match.startsWith(' ') ? ' ' : ''}${token} `
            )
          : `${draft.prompt}${draft.prompt.endsWith(' ') || draft.prompt.length === 0 ? '' : ' '}${token} `)
      return { ...draft, references, prompt, stagedCells: [], error: null, errorDetail: null }
    })
  }
  const pickAiPromptContextFiles = async (): Promise<void> => {
    if (!onPickContextFiles) return
    const paths = await onPickContextFiles()
    for (const path of paths) {
      addAiPromptReference(contextReferenceForFilePath(path))
    }
  }
  const closeAiPrompt = (): void => {
    setAiPromptDraft(null)
  }
  const submitAiPrompt = async (): Promise<void> => {
    const draft = aiPromptDraft
    if (!draft || !draft.prompt.trim() || draft.isGenerating) return

    if (!notebookFile || !draftDocument || !onGenerateNotebookCode) {
      setAiPromptDraft((current) =>
        current?.id === draft.id
          ? {
              ...current,
              error: 'Notebook AI 生成 API 尚未加载',
              errorDetail: 'Notebook AI 生成 API 尚未加载',
              isGenerating: false
            }
          : current
      )
      return
    }

    setAiPromptDraft((current) =>
      current?.id === draft.id
        ? { ...current, isGenerating: true, stagedCells: [], error: null, errorDetail: null }
        : current
    )

    try {
      const prompt =
        draft.mode === 'refactor'
          ? [
              'Refactor the selected notebook cell according to the user request.',
              'Return replacement notebook cell(s) for the selected cell only.',
              '',
              `User request: ${draft.prompt.trim()}`
            ].join('\n')
          : draft.prompt.trim()
      const result = await onGenerateNotebookCode(notebookFile, draftDocument, {
        prompt,
        language: draft.language,
        requestId: draft.id,
        model: draft.model
          ? { providerId: draft.model.providerId, modelId: draft.model.modelId }
          : undefined,
        afterCellId: draft.afterCellId,
        references: draft.references
      })
      const generatedCells = notebookAiGeneratedCellsFromResult(result, draft.language)
      if (generatedCells.length === 0) {
        throw new Error(notebookAiEmptyGenerationMessage)
      }

      setAiPromptDraft((current) =>
        current?.id === draft.id
          ? {
              ...current,
              isGenerating: false,
              stagedCells: stageGeneratedNotebookCells(draftDocument, draft, generatedCells),
              error: null,
              errorDetail: null
            }
          : current
      )
    } catch (error) {
      const { message, detail } = notebookAiPromptError(error)
      setAiPromptDraft((current) =>
        current?.id === draft.id
          ? {
              ...current,
              isGenerating: false,
              stagedCells: [],
              error: message,
              errorDetail: detail
            }
          : current
      )
    }
  }
  const acceptAiPreviewCell = useCallback(
    async (previewId: string): Promise<void> => {
      const draft = aiPromptDraft
      if (!draft || draft.isGenerating || !draftDocument || draft.stagedCells.length === 0) return

      const { document: nextDocument, draft: nextDraft } = acceptStagedNotebookCell(
        draftDocument,
        draft,
        previewId
      )
      await saveNotebookDocument(nextDocument)
      setDraftDocument(nextDocument)
      setAiPromptDraft((current) => (current?.id === draft.id ? nextDraft : current))
    },
    [aiPromptDraft, draftDocument, saveNotebookDocument]
  )
  const acceptFirstAiPreviewCell = useCallback(async (): Promise<void> => {
    const previewId = aiPromptDraft?.stagedCells[0]?.previewId
    if (previewId) {
      await acceptAiPreviewCell(previewId)
    }
  }, [acceptAiPreviewCell, aiPromptDraft?.stagedCells])
  const rejectAiPreviewCell = useCallback((previewId: string): void => {
    setAiPromptDraft((current) => {
      if (!current || current.isGenerating) return current
      return rejectStagedNotebookCell(current, previewId)
    })
  }, [])
  const rejectAiPrompt = useCallback((): void => {
    setAiPromptDraft(null)
  }, [])
  const onAppendCell = async (
    cellType: Extract<NotebookCellType, 'code' | 'markdown'>
  ): Promise<void> => {
    if (!draftDocument) return

    const nextDocument = insertNotebookCell(draftDocument, draftDocument.cells.length, {
      cellType,
      source: ''
    })
    setDraftDocument(nextDocument)
    await saveNotebookDocument(nextDocument)
  }
  const onClearCellOutputs = (cellId: string): void => {
    setDraftDocument((document) =>
      document ? clearNotebookCellOutput(document, cellId) : document
    )
  }
  const onDeleteCell = (cellId: string): void => {
    setDraftDocument((document) => (document ? deleteNotebookCell(document, cellId) : document))
  }
  const onConvertCell = (
    cellId: string,
    cellType: Extract<NotebookCellType, 'code' | 'markdown'>
  ): void => {
    setDraftDocument((document) =>
      document ? updateNotebookCell(document, cellId, { cellType }) : document
    )
  }
  const onMoveCell = (
    sourceCellId: string,
    targetCellId: string,
    placement: CellPlacement
  ): void => {
    setDraftDocument((document) => {
      if (!document || sourceCellId === targetCellId) return document
      const sourceIndex = document.cells.findIndex((cell) => cell.id === sourceCellId)
      const targetIndex = document.cells.findIndex((cell) => cell.id === targetCellId)
      if (sourceIndex < 0 || targetIndex < 0) return document
      const targetInsertionIndex = targetIndex + (placement === 'after' ? 1 : 0)
      const adjustedInsertionIndex =
        sourceIndex < targetInsertionIndex ? targetInsertionIndex - 1 : targetInsertionIndex
      if (sourceIndex === adjustedInsertionIndex) return document
      return moveNotebookCell(document, sourceCellId, adjustedInsertionIndex)
    })
  }
  // useCallback below: this reads `cells` directly (not via a setState
  // updater), and is handed to the memoized NotebookCell as onMoveAiPrompt
  // — an identity that changes only when it actually needs to keeps that
  // memoization meaningful without risking a stale `cells` snapshot.
  const onMoveAiPrompt = useCallback(
    (targetCellId: string, placement: CellPlacement): void => {
      const targetIndex = cells.findIndex((cell) => cell.id === targetCellId)
      if (targetIndex < 0) return
      const afterCellId =
        placement === 'after' ? targetCellId : targetIndex > 0 ? cells[targetIndex - 1].id : null

      setAiPromptDraft((current) => {
        if (!current) return current
        if (current.mode === 'refactor') return current
        return current.afterCellId === afterCellId ? current : { ...current, afterCellId }
      })
    },
    [cells]
  )
  const onDragAiPrompt = (event: DragEvent<HTMLButtonElement>): void => {
    event.dataTransfer.setData('application/x-phi-notebook-ai-prompt', 'true')
    event.dataTransfer.effectAllowed = 'move'
  }
  const onSave = (): void => {
    if (notebookFile && draftDocument) {
      onSaveNotebook?.(notebookFile, draftDocument)
    }
  }
  // Same rationale as onInsertCell/onMoveAiPrompt above: onRunCell/onStopCell
  // read notebookFile/draftDocument directly, so NotebookCell needs their
  // real identity (not a blanket "ignore all functions") to avoid running a
  // stale document snapshot from a bailed-out memoized cell.
  const onAdvanceCell = useCallback(
    (cellId: string): void => {
      const nextCell = cells[cells.findIndex((cell) => cell.id === cellId) + 1]
      if (nextCell) setSelectedCellId(nextCell.id)
    },
    [cells]
  )
  const onRunCell = useCallback(
    (cellId: string): void => {
      if (notebookFile && draftDocument) {
        onRunNotebookCell?.(notebookFile, draftDocument, cellId)
      }
    },
    [draftDocument, notebookFile, onRunNotebookCell]
  )
  useEffect(() => {
    const handleNotebookShortcut = (event: KeyboardEvent): void => {
      const canvas = notebookCanvasRef.current
      const target = event.target instanceof HTMLElement ? event.target : null
      if (!canvas || !target || !canvas.contains(target) || !draftDocument || !notebookFile) return

      const key = event.key.toLowerCase()
      const mod = event.metaKey || event.ctrlKey
      if (mod && !event.shiftKey && !event.altKey && key === 's') {
        event.preventDefault()
        event.stopPropagation()
        if (isDirty && !isOpening) onSave()
        return
      }

      if (mod && event.shiftKey && !event.altKey && key === 'f') {
        if (isNotebookCodeEditorShortcutTarget(target) || isOpening || isFormattingNotebook) return
        event.preventDefault()
        event.stopPropagation()
        void onFormatNotebook()
        return
      }

      if (
        (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
        !mod &&
        !event.altKey &&
        !event.shiftKey &&
        !event.isComposing &&
        !isNotebookTextEntryShortcutTarget(target)
      ) {
        const liveSelectedCellId =
          selectedCellId && cells.some((cell) => cell.id === selectedCellId) ? selectedCellId : null
        if (!liveSelectedCellId) return
        const selectedIndex = cells.findIndex((cell) => cell.id === liveSelectedCellId)
        const adjacentCell = cells[selectedIndex + (event.key === 'ArrowDown' ? 1 : -1)] ?? null
        event.preventDefault()
        event.stopPropagation()
        if (!adjacentCell) return
        setSelectedCellId(adjacentCell.id)
        scrollToNotebookCell(adjacentCell.id, 'nearest')
        return
      }

      if (key !== 'enter' || event.altKey || isNotebookPromptShortcutTarget(target)) return
      const runInPlace = mod && !event.shiftKey
      const runAndAdvance = event.shiftKey && !mod
      if (!runInPlace && !runAndAdvance) return

      const liveSelectedCellId =
        selectedCellId && cells.some((cell) => cell.id === selectedCellId) ? selectedCellId : null
      const selectedCell = cells.find((cell) => cell.id === liveSelectedCellId)
      if (!liveSelectedCellId || selectedCell?.type !== 'code' || !canRunCells) return

      event.preventDefault()
      event.stopPropagation()
      onRunCell(liveSelectedCellId)
      if (!runAndAdvance) return
      const nextCell = cells[cells.findIndex((cell) => cell.id === liveSelectedCellId) + 1]
      if (nextCell) setSelectedCellId(nextCell.id)
    }

    document.addEventListener('keydown', handleNotebookShortcut, true)
    return () => {
      document.removeEventListener('keydown', handleNotebookShortcut, true)
    }
  }, [
    canRunCells,
    cells,
    draftDocument,
    isDirty,
    isFormattingNotebook,
    isOpening,
    notebookFile,
    onFormatNotebook,
    onRunCell,
    onSave,
    scrollToNotebookCell,
    selectedCellId
  ])
  const onStopCell = useCallback(
    (cellId: string): void => {
      if (notebookFile) {
        onStopNotebookCell?.(notebookFile, cellId)
      }
    },
    [notebookFile, onStopNotebookCell]
  )
  const onKernelChange = async (kernelName: string): Promise<void> => {
    const kernel = kernelDiagnostics?.kernels.find((candidate) => candidate.name === kernelName)
    if (!kernel || !draftDocument || !notebookFile) return
    const currentKernelName = notebookKernelName(draftDocument)
    if (kernel.name === currentKernelName) return

    const hasCurrentLiveSession = hasLiveNotebookSession(notebookSessionStatus)
    const currentKernel = kernelDiagnostics?.kernels.find(
      (candidate) => candidate.name === currentKernelName
    )
    const nextDocument = withNotebookKernel(draftDocument, kernel)
    setPendingKernelSwitch({
      file: notebookFile,
      currentKernelLabel: currentKernel ? kernelOptionLabel(currentKernel) : kernelLabel,
      nextKernelLabel: kernelOptionLabel(kernel),
      hasCurrentLiveSession,
      nextDocument,
      nextAutoConnectKey: `${notebookFile.path}:${kernel.name}`
    })
  }

  const confirmKernelSwitch = async (): Promise<void> => {
    const pending = pendingKernelSwitch
    if (!pending) return

    setPendingKernelSwitch(null)
    autoConnectKeyRef.current = pending.nextAutoConnectKey
    setDraftDocument(pending.nextDocument)

    if (pending.hasCurrentLiveSession) {
      if (onStopNotebookSession) {
        await onStopNotebookSession(pending.file)
      }
    }

    if (onStartNotebookSession) {
      await onStartNotebookSession(pending.file, pending.nextDocument)
    }
  }
  const aiPromptCell = aiPromptDraft ? (
    <NotebookAiPromptCell
      mode={aiPromptDraft.mode}
      language={aiPromptDraft.language}
      codeLanguage={insertCodeLanguage}
      prompt={aiPromptDraft.prompt}
      references={aiPromptDraft.references}
      contextOptions={aiContextOptions}
      modelOptions={aiModelOptions ?? []}
      selectedModel={aiPromptDraft.model}
      isGenerating={aiPromptDraft.isGenerating}
      hasStagedCells={aiPromptDraft.stagedCells.length > 0}
      error={aiPromptDraft.error}
      errorDetail={aiPromptDraft.errorDetail}
      canPickContextFiles={Boolean(onPickContextFiles)}
      onSelect={() => setSelectedCellId(null)}
      onPromptChange={updateAiPrompt}
      onLanguageChange={updateAiPromptLanguage}
      onModelChange={updateAiPromptModel}
      onReferenceAdd={addAiPromptReference}
      onPickContextFiles={() => {
        void pickAiPromptContextFiles()
      }}
      onSubmit={submitAiPrompt}
      onAccept={() => {
        void acceptFirstAiPreviewCell()
      }}
      onReject={rejectAiPrompt}
      onCancel={closeAiPrompt}
      onDragStart={onDragAiPrompt}
    />
  ) : null
  const hasAiPreviewCells = Boolean(
    aiPromptDraft && !aiPromptDraft.isGenerating && aiPromptDraft.stagedCells.length > 0
  )
  const aiPromptSurface = hasAiPreviewCells ? null : aiPromptCell

  return (
    <Box
      ref={notebookCanvasRef}
      sx={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        position: 'relative'
      }}
    >
      <NotebookHeader
        activeNotebookPath={activeNotebookPath}
        notebooks={notebooks}
        hideNotebookTabs={hideNotebookTabs}
        onSelectNotebook={onSelectNotebook}
        onCloseNotebook={onCloseNotebook}
      />
      <Box
        ref={scrollViewportRef}
        onScroll={handleNotebookScroll}
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          px: { xs: 2, md: 4 },
          pt: { xs: 3.5, md: 3.75 },
          pb: 24
        }}
      >
        <Box
          sx={{
            maxWidth: 920,
            mx: 'auto',
            [notebookSiblingSpacingSelector]: {
              mt: 1.35
            }
          }}
        >
          {isOpening ? <Typography color="text.secondary">正在打开 notebook...</Typography> : null}
          {error ? (
            <Typography color="error.main" sx={{ mb: 2 }}>
              {error}
            </Typography>
          ) : null}
          {notebookSessionError ? (
            <Typography color="error.main" sx={{ mb: 2 }}>
              {notebookSessionError}
            </Typography>
          ) : null}
          {cellExecutionError ? (
            <Typography color="error.main" sx={{ mb: 2 }}>
              {cellExecutionError}
            </Typography>
          ) : null}
          {formattingError ? (
            <Typography color="warning.main" sx={{ mb: 2 }}>
              {formattingError}
            </Typography>
          ) : null}
          {!isOpening && cells.length > 0 && aiPromptDraft?.afterCellId === null
            ? aiPromptSurface
            : null}
          <Box ref={virtualListRef} data-phi-notebook-virtual-list="true">
            {!isOpening && virtualCells.beforeHeight > 0 ? (
              <Box
                aria-hidden="true"
                data-phi-notebook-virtual-spacer="before"
                sx={{ height: virtualCells.beforeHeight }}
              />
            ) : null}
            {!isOpening &&
              virtualCells.items.map(({ item: cell, index }) => {
                const isAiPreviewCell = isNotebookAiPreviewCell(cell.id, aiPromptDraft)
                return (
                  <NotebookVirtualRowShell
                    key={cell.id}
                    cellId={cell.id}
                    index={index}
                    onMeasure={measureVirtualRow}
                  >
                    <NotebookCell
                      cell={cell}
                      cellNumber={index + 1}
                      editable={Boolean(draftDocument) && !isAiPreviewCell}
                      selected={selectedCellId === cell.id}
                      agentHighlighted={agentHighlightedCellId === cell.id}
                      provisional={isAiPreviewCell}
                      onSourceChange={isAiPreviewCell ? undefined : onUpdateCellSource}
                      onCompleteSource={
                        isAiPreviewCell || !canUseCompletionProvider
                          ? undefined
                          : onCompleteCellSource
                      }
                      onFormatSource={isAiPreviewCell ? undefined : onFormatCellSource}
                      onInsertBefore={isAiPreviewCell ? undefined : onInsertCellBefore}
                      onInsertAfter={isAiPreviewCell ? undefined : onInsertCellAfter}
                      onClearOutputs={isAiPreviewCell ? undefined : onClearCellOutputs}
                      onDeleteCell={isAiPreviewCell ? undefined : onDeleteCell}
                      onConvertCell={isAiPreviewCell ? undefined : onConvertCell}
                      onMoveCell={isAiPreviewCell ? undefined : onMoveCell}
                      onMoveAiPrompt={isAiPreviewCell ? undefined : onMoveAiPrompt}
                      onSelectCell={isAiPreviewCell ? undefined : setSelectedCellId}
                      onRunCell={isAiPreviewCell ? undefined : onRunCell}
                      onAdvanceCell={isAiPreviewCell ? undefined : onAdvanceCell}
                      onStopCell={isAiPreviewCell ? undefined : onStopCell}
                      canRunCells={canRunCells && !isAiPreviewCell}
                      notebookPath={notebookFile?.path}
                    />
                    {isAiPreviewCell ? (
                      <Box sx={{ mt: 1.35 }}>
                        <NotebookAiPreviewActions
                          isGenerating={Boolean(aiPromptDraft?.isGenerating)}
                          onAccept={() => {
                            void acceptAiPreviewCell(cell.id)
                          }}
                          onReject={() => rejectAiPreviewCell(cell.id)}
                        />
                      </Box>
                    ) : null}
                    {!isAiPreviewCell && aiPromptDraft?.afterCellId === cell.id ? (
                      <Box sx={{ mt: 1.35 }}>{aiPromptSurface}</Box>
                    ) : null}
                  </NotebookVirtualRowShell>
                )
              })}
            {!isOpening && virtualCells.afterHeight > 0 ? (
              <Box
                aria-hidden="true"
                data-phi-notebook-virtual-spacer="after"
                sx={{ height: virtualCells.afterHeight }}
              />
            ) : null}
          </Box>
          {!isOpening && cells.length === 0 && aiPromptDraft ? (aiPromptSurface ?? null) : null}
          {!isOpening && cells.length > 0 ? (
            <NotebookInsertDock
              disabled={!draftDocument}
              codeLanguage={insertCodeLanguage}
              onGenerateCode={openAiPrompt}
              onInsert={onAppendCell}
            />
          ) : null}
          {!isOpening && cells.length === 0 ? (
            draftDocument ? (
              <NotebookInsertDock
                codeLanguage={insertCodeLanguage}
                onGenerateCode={openAiPrompt}
                onInsert={onAppendCell}
              />
            ) : (
              <>
                <EmptyNotebookState
                  notebooks={availableNotebooks ?? notebooks}
                  projectCwd={projectCwd}
                  onSelectNotebook={onSelectNotebook}
                  onCreateNotebook={onCreateNotebook}
                />
                <NotebookInsertDock
                  disabled={!draftDocument}
                  codeLanguage={insertCodeLanguage}
                  onGenerateCode={openAiPrompt}
                  onInsert={onAppendCell}
                />
              </>
            )
          ) : null}
        </Box>
      </Box>
      <NotebookFloatingActions
        hasDocument={Boolean(notebookFile && draftDocument)}
        isDirty={isDirty}
        isOpening={Boolean(isOpening)}
        isStartingNotebookSession={isStartingNotebookSession}
        anchor={floatingActionAnchor}
        notebookFile={notebookFile}
        notebookSessionStatus={notebookSessionStatus}
        kernelLabel={kernelLabel}
        kernelStatusLabel={kernelStatusLabel}
        kernelStatusColor={kernelStatusColor}
        draftDocument={draftDocument}
        kernelDiagnostics={kernelDiagnostics}
        onKernelChange={onKernelChange}
        onSave={onSave}
        onFormat={onFormatNotebook}
        isFormatting={isFormattingNotebook}
        onStopNotebookSession={onStopNotebookSession}
      />
      <NotebookKernelSwitchDialog
        pending={pendingKernelSwitch}
        onCancel={() => setPendingKernelSwitch(null)}
        onConfirm={() => {
          void confirmKernelSwitch()
        }}
      />
      <NotebookScrollProgressRail
        outline={outline}
        activeId={activeOutlineId ?? outline[0]?.id ?? null}
        onSelect={onSelectOutlineItem}
      />
    </Box>
  )
}
