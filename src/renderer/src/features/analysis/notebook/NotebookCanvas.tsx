import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Box, Typography } from '@mui/material'

import type { SyntaxLanguage } from '../../../lib/syntaxHighlight'
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
  notebookKernelName,
  notebookLanguage,
  notebookOutline,
  notebookSessionStateColor,
  notebookSessionStateLabel,
  notebookSyntaxLanguage,
  withNotebookKernel,
  type NotebookOutlineItem
} from '../lib/notebookViewModel'
import type { AnalysisNotebookContextReference, ModelOption } from '../../../types'
import { NotebookHeader } from '../components/NotebookHeader'
import NotebookAiPromptCell from './NotebookAiPromptCell'
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

export default function NotebookCanvas({
  activeNotebookPath,
  notebooks,
  notebookFile,
  initialDocument,
  isOpening,
  error,
  kernelDiagnostics,
  isLoadingKernels,
  kernelError,
  notebookSessionStatus,
  isStartingNotebookSession,
  notebookSessionError,
  executingCellId,
  cellExecutionError,
  onSaveNotebook,
  onSyncNotebookDraft,
  onStartNotebookSession,
  onStopNotebookSession,
  onRunNotebookCell,
  onGenerateNotebookCode,
  onNotebookCodeGenerationProgress,
  aiModelOptions,
  aiDefaultModel,
  onPickContextFiles,
  onSelectNotebook,
  onCloseNotebook,
  agentFocus,
  topRightControls
}: NotebookCanvasProps): React.JSX.Element {
  const [draftDocument, setDraftDocument] = useState<NotebookDocument | null>(initialDocument)
  const [selectedCellId, setSelectedCellId] = useState<string | null>(null)
  const [agentHighlightedCellId, setAgentHighlightedCellId] = useState<string | null>(null)
  const [aiPromptDraft, setAiPromptDraft] = useState<NotebookAiPromptDraft | null>(null)
  const [pendingKernelSwitch, setPendingKernelSwitch] = useState<PendingKernelSwitch | null>(null)
  const notebookCanvasRef = useRef<HTMLDivElement | null>(null)
  const scrollViewportRef = useRef<HTMLDivElement | null>(null)
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
  const outline = useMemo(() => notebookOutline(displayCells), [displayCells])
  const [activeOutlineId, setActiveOutlineId] = useState<string | null>(outline[0]?.id ?? null)

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
  }, [findOutlineCellElement, outline])

  const onSelectOutlineItem = useCallback(
    (item: NotebookOutlineItem): void => {
      const element = findOutlineCellElement(item.cellId)
      element?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      setActiveOutlineId(item.id)
    },
    [findOutlineCellElement]
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
      findOutlineCellElement(agentFocus.cellId)?.scrollIntoView({
        block: 'center',
        behavior: 'smooth'
      })
    }, 0)
    const clearTimer = window.setTimeout(() => {
      setAgentHighlightedCellId((current) => (current === agentFocus.cellId ? null : current))
    }, 2600)

    return () => {
      window.clearTimeout(focusTimer)
      window.clearTimeout(clearTimer)
    }
  }, [agentFocus, cells, findOutlineCellElement, notebookFile])

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) {
        setDraftDocument(initialDocument)
        setSelectedCellId(null)
        setAiPromptDraft(null)
      }
    })
    return () => {
      cancelled = true
    }
  }, [initialDocument])

  useEffect(() => {
    if (!onNotebookCodeGenerationProgress) return undefined
    return onNotebookCodeGenerationProgress((progress) => {
      setAiPromptDraft((draft) => {
        if (
          !draft ||
          !draftDocument ||
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
    updateActiveOutline()
    const scrollViewport = scrollViewportRef.current
    if (!scrollViewport) return

    const content = scrollViewport.firstElementChild
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateActiveOutline)
    resizeObserver?.observe(scrollViewport)
    if (content) resizeObserver?.observe(content)
    window.addEventListener('resize', updateActiveOutline)

    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', updateActiveOutline)
    }
  }, [draftDocument?.revision, displayCells.length, outline.length, updateActiveOutline])

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
  const selectedKernelName = draftDocument ? notebookKernelName(draftDocument) : ''
  const autoConnectKey =
    notebookFile && draftDocument
      ? `${notebookFile.path}:${selectedKernelName || notebookLanguage(draftDocument)}`
      : null
  const { autoConnectKeyRef } = useNotebookAutoConnect({
    autoConnectKey,
    notebookFile,
    draftDocument,
    onStartNotebookSession,
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
  const onInsertCell = async (
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
  }
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
  const addAiPromptReference = (reference: AnalysisNotebookContextReference): void => {
    setAiPromptDraft((draft) => {
      if (!draft) return draft
      const references = draft.references.some((item) => item.id === reference.id)
        ? draft.references
        : [...draft.references, reference]
      const token = `@${reference.name}`
      const prompt = /(?:^|\s)@$/.test(draft.prompt)
        ? draft.prompt.replace(
            /(?:^|\s)@$/,
            (match) => `${match.startsWith(' ') ? ' ' : ''}${token} `
          )
        : `${draft.prompt}${draft.prompt.endsWith(' ') || draft.prompt.length === 0 ? '' : ' '}${token} `
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
  const onMoveAiPrompt = (targetCellId: string, placement: CellPlacement): void => {
    const targetIndex = cells.findIndex((cell) => cell.id === targetCellId)
    if (targetIndex < 0) return
    const afterCellId =
      placement === 'after' ? targetCellId : targetIndex > 0 ? cells[targetIndex - 1].id : null

    setAiPromptDraft((current) => {
      if (!current) return current
      if (current.mode === 'refactor') return current
      return current.afterCellId === afterCellId ? current : { ...current, afterCellId }
    })
  }
  const onDragAiPrompt = (event: DragEvent<HTMLButtonElement>): void => {
    event.dataTransfer.setData('application/x-phi-notebook-ai-prompt', 'true')
    event.dataTransfer.effectAllowed = 'move'
  }
  const onSave = (): void => {
    if (notebookFile && draftDocument) {
      onSaveNotebook?.(notebookFile, draftDocument)
    }
  }
  const onRunCell = (cellId: string): void => {
    if (notebookFile && draftDocument) {
      onRunNotebookCell?.(notebookFile, draftDocument, cellId)
    }
  }
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
  const hasAiPreviewCells = Boolean(aiPromptDraft && aiPromptDraft.stagedCells.length > 0)
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
        kernelLabel={kernelLabel}
        kernelStatusLabel={kernelStatusLabel}
        kernelStatusColor={kernelStatusColor}
        draftDocument={draftDocument}
        kernelDiagnostics={kernelDiagnostics}
        onKernelChange={onKernelChange}
        onSelectNotebook={onSelectNotebook}
        onCloseNotebook={onCloseNotebook}
        topRightControls={topRightControls}
      />
      <Box
        ref={scrollViewportRef}
        onScroll={updateActiveOutline}
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          px: { xs: 2, md: 4 },
          pt: { xs: 3.5, md: 3.75 },
          pb: 16
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
          {!isOpening && cells.length > 0 && aiPromptDraft?.afterCellId === null
            ? aiPromptSurface
            : null}
          {!isOpening &&
            displayCells.map((cell, index) => {
              const isAiPreviewCell = isNotebookAiPreviewCell(cell.id, aiPromptDraft)
              return (
                <Fragment key={cell.id}>
                  <NotebookCell
                    cell={cell}
                    cellNumber={index + 1}
                    editable={Boolean(draftDocument) && !isAiPreviewCell}
                    selected={selectedCellId === cell.id}
                    agentHighlighted={agentHighlightedCellId === cell.id}
                    provisional={isAiPreviewCell}
                    onSourceChange={isAiPreviewCell ? undefined : onUpdateCellSource}
                    onInsertBefore={
                      isAiPreviewCell
                        ? undefined
                        : (cellId, cellType) => onInsertCell(cellId, 'before', cellType)
                    }
                    onInsertAfter={
                      isAiPreviewCell
                        ? undefined
                        : (cellId, cellType) => onInsertCell(cellId, 'after', cellType)
                    }
                    onClearOutputs={isAiPreviewCell ? undefined : onClearCellOutputs}
                    onDeleteCell={isAiPreviewCell ? undefined : onDeleteCell}
                    onConvertCell={isAiPreviewCell ? undefined : onConvertCell}
                    onMoveCell={isAiPreviewCell ? undefined : onMoveCell}
                    onMoveAiPrompt={isAiPreviewCell ? undefined : onMoveAiPrompt}
                    onSelectCell={isAiPreviewCell ? undefined : setSelectedCellId}
                    onRunCell={isAiPreviewCell ? undefined : onRunCell}
                    canRunCells={canRunCells && !isAiPreviewCell}
                    notebookPath={notebookFile?.path}
                  />
                  {isAiPreviewCell ? (
                    <NotebookAiPreviewActions
                      isGenerating={Boolean(aiPromptDraft?.isGenerating)}
                      onAccept={() => {
                        void acceptAiPreviewCell(cell.id)
                      }}
                      onReject={() => rejectAiPreviewCell(cell.id)}
                    />
                  ) : null}
                  {!isAiPreviewCell && aiPromptDraft?.afterCellId === cell.id
                    ? aiPromptSurface
                    : null}
                </Fragment>
              )
            })}
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
                <Box
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
                </Box>
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
        onSave={onSave}
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
