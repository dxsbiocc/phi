import { useCallback, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import { Box } from '@mui/material'
import { type Theme } from '@mui/material/styles'
import { LeftRail, type LeftPanel } from './components/AnalysisLeftRail'
import NotebookCanvas from './notebook/NotebookCanvas'
import type { AnalysisNotebookAgentFocus } from './lib/notebookCanvasTypes'
import { type NotebookDocument } from '../../../../shared/notebookDocument'
import {
  notebookFileEntry,
  registryNotebooks,
  type NotebookListEntry
} from './lib/notebookViewModel'
import type {
  AnalysisNotebookCodeGenerationInput,
  AnalysisNotebookCodeGenerationProgress,
  AnalysisNotebookCodeGenerationResult,
  AnalysisNotebookCompletionResult,
  AnalysisNotebookFormatResult,
  AnalysisKernelDiagnostics,
  AnalysisNotebookFile,
  AnalysisNotebookRegistry,
  AnalysisNotebookSessionStatus,
  ModelOption
} from '../../types'

export type { AnalysisNotebookAgentFocus } from './lib/notebookCanvasTypes'

export type AnalysisWorkspaceFileTab = {
  id: string
  path: string
  name: string
  status: string
  absolutePath?: string
}

export type AnalysisViewProps = {
  notebookRegistry?: AnalysisNotebookRegistry | null
  notebookFile?: AnalysisNotebookFile | null
  workspaceFileTabs?: AnalysisWorkspaceFileTab[]
  activeWorkspaceFilePath?: string | null
  hideLeftRail?: boolean
  initialLeftPanel?: LeftPanel
  initialLeftSidebarFullscreen?: boolean
  isLoadingNotebooks?: boolean
  isOpeningNotebook?: boolean
  notebookError?: string | null
  notebookContentError?: string | null
  kernelDiagnostics?: AnalysisKernelDiagnostics | null
  isLoadingKernels?: boolean
  kernelError?: string | null
  notebookSessionStatus?: AnalysisNotebookSessionStatus | null
  isStartingNotebookSession?: boolean
  notebookSessionError?: string | null
  onRefreshNotebooks?: () => void
  onStartNotebookSession?: (
    file: AnalysisNotebookFile,
    document: NotebookDocument
  ) => void | Promise<void>
  onStopNotebookSession?: (file: AnalysisNotebookFile) => void | Promise<void>
  onRunNotebookCell?: (
    file: AnalysisNotebookFile,
    document: NotebookDocument,
    cellId: string
  ) => void
  onStopNotebookCell?: (file: AnalysisNotebookFile, cellId: string) => void
  onCompleteNotebookCell?: (
    file: AnalysisNotebookFile,
    document: NotebookDocument,
    cellId: string,
    source: string,
    cursorPosition: number
  ) => Promise<AnalysisNotebookCompletionResult>
  onFormatNotebookCell?: (
    file: AnalysisNotebookFile,
    document: NotebookDocument,
    cellId: string,
    source: string,
    language?: string
  ) => Promise<AnalysisNotebookFormatResult>
  onGenerateNotebookCode?: (
    file: AnalysisNotebookFile,
    document: NotebookDocument,
    input: AnalysisNotebookCodeGenerationInput
  ) => Promise<AnalysisNotebookCodeGenerationResult>
  onNotebookCodeGenerationProgress?: (
    cb: (progress: AnalysisNotebookCodeGenerationProgress) => void
  ) => () => void
  notebookAiModelOptions?: ModelOption[]
  notebookAiDefaultModel?: ModelOption | null
  onPickNotebookContextFiles?: () => Promise<string[]>
  executingNotebookCellId?: string | null
  notebookCellExecutionError?: string | null
  agentFocus?: AnalysisNotebookAgentFocus | null
  onInitializeProjectAnalysis?: (cwd: string) => void
  onOpenNotebook?: (path: string) => void
  onCloseNotebook?: () => void
  onSelectWorkspaceFileTab?: (tab: AnalysisWorkspaceFileTab) => void
  onCloseWorkspaceFileTab?: (tab: AnalysisWorkspaceFileTab) => void
  onSaveNotebook?: (file: AnalysisNotebookFile, document: NotebookDocument) => void | Promise<void>
  onSyncNotebookDraft?: (file: AnalysisNotebookFile, document: NotebookDocument) => void
  onCreateNotebook?: (cwd: string) => void
  chatPanel?: ReactNode
}

const leftRailWidth = 300
const minLeftRailWidth = 220
const maxLeftRailWidth = 460

function ResizeSeparator({
  label,
  onMouseDown
}: {
  label: string
  onMouseDown: (event: MouseEvent<HTMLDivElement>) => void
}): React.JSX.Element {
  return (
    <Box
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      onMouseDown={onMouseDown}
      sx={{
        width: '1px',
        flexShrink: 0,
        position: 'relative',
        cursor: 'col-resize',
        bgcolor: (theme) =>
          theme.palette.mode === 'dark' ? 'rgba(241, 246, 246, 0.18)' : 'rgba(15, 42, 48, 0.18)',
        zIndex: 5,
        WebkitAppRegion: 'no-drag',
        '&::before': {
          content: '""',
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: -4,
          right: -4
        }
      }}
    />
  )
}

export default function AnalysisView({
  notebookRegistry,
  notebookFile,
  workspaceFileTabs,
  activeWorkspaceFilePath,
  hideLeftRail = false,
  initialLeftPanel = 'chat',
  initialLeftSidebarFullscreen = false,
  isLoadingNotebooks = false,
  isOpeningNotebook = false,
  notebookError = null,
  notebookContentError = null,
  kernelDiagnostics = null,
  isLoadingKernels = false,
  kernelError = null,
  notebookSessionStatus = null,
  isStartingNotebookSession = false,
  notebookSessionError = null,
  executingNotebookCellId = null,
  notebookCellExecutionError = null,
  agentFocus = null,
  onRefreshNotebooks,
  onStartNotebookSession,
  onStopNotebookSession,
  onRunNotebookCell,
  onStopNotebookCell,
  onCompleteNotebookCell,
  onFormatNotebookCell,
  onGenerateNotebookCode,
  onNotebookCodeGenerationProgress,
  notebookAiModelOptions,
  notebookAiDefaultModel,
  onPickNotebookContextFiles,
  onInitializeProjectAnalysis,
  onOpenNotebook,
  onCloseNotebook,
  onSelectWorkspaceFileTab,
  onCloseWorkspaceFileTab,
  onSaveNotebook,
  onSyncNotebookDraft,
  onCreateNotebook,
  chatPanel
}: AnalysisViewProps = {}): React.JSX.Element {
  const [leftPanel, setLeftPanel] = useState<LeftPanel>(initialLeftPanel)
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [leftSidebarFullscreen, setLeftSidebarFullscreen] = useState(initialLeftSidebarFullscreen)
  const [leftWidth, setLeftWidth] = useState(leftRailWidth)
  const showLeftRail = !hideLeftRail
  const effectiveLeftSidebarFullscreen = showLeftRail && !leftCollapsed && leftSidebarFullscreen
  const onToggleLeftCollapsed = useCallback((): void => {
    setLeftCollapsed((value) => {
      const nextValue = !value
      if (nextValue) setLeftSidebarFullscreen(false)
      return nextValue
    })
  }, [])
  const notebooks = useMemo(() => registryNotebooks(notebookRegistry), [notebookRegistry])
  const activeNotebookEntry = useMemo(() => notebookFileEntry(notebookFile), [notebookFile])
  const [openNotebookPaths, setOpenNotebookPaths] = useState<string[]>([])
  const [selectedNotebookPath, setSelectedNotebookPath] = useState<string | null>(
    notebooks[0]?.path ?? null
  )
  const selectedPathIsAvailable = Boolean(
    selectedNotebookPath && notebooks.some((notebook) => notebook.path === selectedNotebookPath)
  )
  const activeNotebookPath =
    notebookFile?.relativePath ?? (selectedPathIsAvailable ? selectedNotebookPath : null)
  const openNotebookTabs = useMemo(() => {
    const byPath = new Map(notebooks.map((notebook) => [notebook.path, notebook]))
    if (activeNotebookEntry) byPath.set(activeNotebookEntry.path, activeNotebookEntry)
    const paths =
      activeNotebookEntry && !openNotebookPaths.includes(activeNotebookEntry.path)
        ? [...openNotebookPaths, activeNotebookEntry.path]
        : openNotebookPaths
    return paths
      .map((path) => byPath.get(path))
      .filter((notebook): notebook is NotebookListEntry => Boolean(notebook))
  }, [activeNotebookEntry, notebooks, openNotebookPaths])
  const headerTabs = workspaceFileTabs ?? openNotebookTabs
  const headerActivePath = activeWorkspaceFilePath ?? activeNotebookPath

  const onSelectNotebook = (notebook: NotebookListEntry): void => {
    if (onSelectWorkspaceFileTab) {
      const matchingWorkspaceTab = workspaceFileTabs?.find(
        (tab) =>
          tab.path === notebook.path ||
          tab.path === notebook.absolutePath ||
          tab.absolutePath === notebook.path ||
          tab.absolutePath === notebook.absolutePath
      )
      if (matchingWorkspaceTab) {
        onSelectWorkspaceFileTab(matchingWorkspaceTab)
        return
      }
      if (onOpenNotebook) {
        onOpenNotebook(notebook.absolutePath ?? notebook.path)
        return
      }
    }
    setOpenNotebookPaths((paths) =>
      paths.includes(notebook.path) ? paths : [...paths, notebook.path]
    )
    setSelectedNotebookPath(notebook.path)
    if (notebook.absolutePath) {
      onOpenNotebook?.(notebook.absolutePath)
    }
  }
  const onCloseNotebookTab = (notebook: NotebookListEntry): void => {
    if (onCloseWorkspaceFileTab) {
      onCloseWorkspaceFileTab(notebook)
      return
    }
    const remainingTabs = openNotebookTabs.filter((tab) => tab.path !== notebook.path)
    setOpenNotebookPaths((paths) => paths.filter((path) => path !== notebook.path))
    if (notebook.path !== activeNotebookPath) return

    const nextTab = remainingTabs.at(-1) ?? null
    if (nextTab) {
      onSelectNotebook(nextTab)
      return
    }

    setSelectedNotebookPath(null)
    onCloseNotebook?.()
  }
  const onStartLeftResize = useCallback(
    (event: MouseEvent<HTMLDivElement>): void => {
      event.preventDefault()

      const startX = event.clientX
      const startWidth = leftWidth
      const onMouseMove = (moveEvent: globalThis.MouseEvent): void => {
        const delta = moveEvent.clientX - startX
        setLeftWidth(Math.min(maxLeftRailWidth, Math.max(minLeftRailWidth, startWidth + delta)))
      }

      const onMouseUp = (): void => {
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    },
    [leftWidth]
  )

  return (
    <Box
      component="main"
      sx={{
        flex: 1,
        minWidth: 0,
        height: '100vh',
        display: 'flex',
        position: 'relative',
        overflow: 'hidden',
        bgcolor: (theme: Theme) =>
          theme.palette.mode === 'dark' ? theme.palette.background.default : '#FFFFFF'
      }}
    >
      {showLeftRail ? (
        <LeftRail
          panel={leftPanel}
          collapsed={leftCollapsed}
          width={effectiveLeftSidebarFullscreen ? '100%' : leftWidth}
          fullscreen={effectiveLeftSidebarFullscreen}
          notebooks={notebooks}
          activeNotebookPath={activeNotebookPath}
          notebookRegistry={notebookRegistry}
          isLoadingNotebooks={isLoadingNotebooks}
          notebookError={notebookError}
          onPanelChange={setLeftPanel}
          onSelectNotebook={onSelectNotebook}
          onRefreshNotebooks={onRefreshNotebooks}
          onInitializeProjectAnalysis={onInitializeProjectAnalysis}
          onCreateNotebook={onCreateNotebook}
          chatPanel={chatPanel}
          onToggleCollapsed={onToggleLeftCollapsed}
        />
      ) : null}
      {showLeftRail && !leftCollapsed && !effectiveLeftSidebarFullscreen ? (
        <ResizeSeparator label="调整分析侧栏宽度" onMouseDown={onStartLeftResize} />
      ) : null}
      {!effectiveLeftSidebarFullscreen ? (
        <NotebookCanvas
          activeNotebookPath={headerActivePath ?? 'No notebook selected'}
          notebooks={headerTabs}
          availableNotebooks={notebooks}
          projectCwd={notebookRegistry?.projectCwd ?? null}
          notebookFile={notebookFile}
          initialDocument={notebookFile?.document ?? null}
          isOpening={isOpeningNotebook}
          error={notebookContentError}
          kernelDiagnostics={kernelDiagnostics}
          isLoadingKernels={isLoadingKernels}
          kernelError={kernelError}
          notebookSessionStatus={notebookSessionStatus}
          isStartingNotebookSession={isStartingNotebookSession}
          notebookSessionError={notebookSessionError}
          executingCellId={executingNotebookCellId}
          cellExecutionError={notebookCellExecutionError}
          agentFocus={agentFocus}
          onSaveNotebook={onSaveNotebook}
          onSyncNotebookDraft={onSyncNotebookDraft}
          onStartNotebookSession={onStartNotebookSession}
          onStopNotebookSession={onStopNotebookSession}
          onRunNotebookCell={onRunNotebookCell}
          onStopNotebookCell={onStopNotebookCell}
          onCompleteNotebookCell={onCompleteNotebookCell}
          onFormatNotebookCell={onFormatNotebookCell}
          onGenerateNotebookCode={onGenerateNotebookCode}
          onNotebookCodeGenerationProgress={onNotebookCodeGenerationProgress}
          aiModelOptions={notebookAiModelOptions}
          aiDefaultModel={notebookAiDefaultModel}
          onPickContextFiles={onPickNotebookContextFiles}
          onSelectNotebook={onSelectNotebook}
          onCreateNotebook={onCreateNotebook}
          onCloseNotebook={onCloseNotebookTab}
        />
      ) : null}
    </Box>
  )
}
