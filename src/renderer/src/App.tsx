import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import {
  Box,
  Button,
  CssBaseline,
  IconButton,
  ThemeProvider,
  Tooltip,
  Typography
} from '@mui/material'
import { alpha } from '@mui/material/styles'
import { FiMaximize2, FiMinimize2, FiMinus } from 'react-icons/fi'
import { TbLayoutSidebarRight } from 'react-icons/tb'
import ChatView from './components/ChatView'
import MacWindowControls from './components/MacWindowControls'
import WindowNavigationControls from './components/WindowNavigationControls'
import type { LocalPathKind } from './components/MarkdownContent'
import PluginView from './features/plugin/PluginView'
import { usePluginCatalog } from './features/plugin/hooks/usePluginCatalog'
import WrapperView from './features/wrapper/WrapperView'
import SkillView from './features/skill/SkillView'
import { useSkillCatalog } from './features/skill/hooks/useSkillCatalog'
import McpView from './features/mcp/McpView'
import { useMcpServerCatalog } from './features/mcp/hooks/useMcpServerCatalog'
import { type SettingsCategory } from './components/SettingsDialog'
import AppDialogs, { type SnackbarNotice } from './AppDialogs'
import AppActivityBar from './AppActivityBar'
import AppWorkspaceSidebar from './AppWorkspaceSidebar'
import FilePreviewPanel, {
  type FilePreviewPanelState
} from './features/file-preview/FilePreviewPanel'
import AnalysisView, { type AnalysisWorkspaceFileTab } from './features/analysis/AnalysisView'
import { useAnalysisNotebookRuntime } from './features/analysis/hooks/useAnalysisNotebookRuntime'
import RuntimeView from './features/runtime/RuntimeView'
import { createAppTheme } from './theme'
import { useThemeMode } from './useThemeMode'
import { useProviderAuth } from './useProviderAuth'
import { modelOptionFromSelection, useModelSelection } from './useModelSelection'
import { useProjects } from './useProjects'
import { useWorkspaceFileTabs, type WorkspaceFileTab } from './useWorkspaceFileTabs'
import {
  useSessionStore,
  sessionStateKey,
  sessionStateKeyFromAgentEvent,
  sessionStateKeyFromToolApproval,
  sessionRuntimeStates,
  pendingApprovalsBySession,
  sessionAgentEventStates
} from './stores/sessionStore'
import { getRendererApi } from './lib/rendererApi'
import { absoluteWorkspacePath, fileNameFromPath, filePreviewStatePath } from './lib/workspacePaths'
import { chatItemsFromSessionMessages } from './lib/chatItems'
import { getAppShortcutAction } from './lib/appShortcuts'
import {
  initialNavigationHistory,
  navigationHistoryTargetIndex,
  navigationRestorationSettled,
  recordNavigationEntry,
  type NavigationHistoryEntry
} from './lib/navigationHistory'
import {
  agentEventBelongsToActiveSession,
  agentEventMaterializesActiveFreshSession
} from './lib/agentEventRouting'
import { getPromptReadiness } from './lib/promptReadiness'
import { shouldRefreshProjectGitStatusForAgentEvent } from './lib/projectGitRefresh'
import { readableErrorMessage } from './lib/sessionNotifications'
import { sessionDraftKey, updateSessionDraft } from './lib/sessionDrafts'
import { preserveSessionListOrder } from './lib/sessionOrder'
import { sessionDisplayTitle, titleFromMessages, truncateSessionTitle } from './lib/sessionTitles'
import { isNotebookFilePath } from './features/analysis/lib/notebookPaths'
import { activeCwdBelongsToProject, orderProjectsForSessionSelection } from './lib/projectSidebar'
import { workspaceScopeLabelForCwd } from './lib/workspaceScope'
import { workspaceSidebarModeIsExpanded, type WorkspaceSidebarMode } from './lib/workspaceSidebar'
import { PhiIcons, fileIconForPath, directoryIconForPath } from './icons'
import {
  idleSessionRuntimeState,
  reduceSessionRuntimeState,
  sessionRuntimeStateIsBusy,
  sessionStatusIsBusy
} from './lib/sessionRuntimeState'
import { createAgentEventReducerState, reduceAgentEventState } from './lib/agentEventReducer'
import { navigationPaneWidth } from './layout'
import type {
  AgentEventSummary,
  AnalysisNotebookFileChange,
  ModelOption,
  PermissionMode,
  Project,
  SessionSummary
} from './types'

export type AppView =
  'chat' | 'projects' | 'analysis' | 'runtime' | 'plugins' | 'skills' | 'mcp' | 'wrappers'

const activityBarWidth = 48
const macTitlebarHeight = 44
const minNavigationPaneWidth = 240
const maxNavigationPaneWidth = 520
const isMac = typeof window !== 'undefined' && window.platform === 'darwin'

export function TopRightControls({
  showInspectorFullscreen,
  inspectorFullscreen,
  inspectorCollapsed,
  showInspectorToggle,
  onToggleInspectorFullscreen,
  onToggleInspector,
  onMinimize
}: {
  showInspectorFullscreen: boolean
  inspectorFullscreen: boolean
  inspectorCollapsed: boolean
  showInspectorToggle: boolean
  onToggleInspectorFullscreen: () => void
  onToggleInspector: () => void
  onMinimize: () => void | Promise<void>
}): React.JSX.Element | null {
  if (!showInspectorFullscreen && !showInspectorToggle) return null

  const buttonSx = {
    width: 32,
    height: 32,
    borderRadius: 1.5,
    color: 'text.secondary',
    '&:hover': {
      bgcolor: 'action.hover',
      color: 'text.primary'
    }
  } as const

  return (
    <Box
      data-phi-top-right-controls="analysis"
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        flexShrink: 0,
        gap: 0.5,
        WebkitAppRegion: 'no-drag'
      }}
    >
      {showInspectorFullscreen ? (
        <Tooltip title={inspectorFullscreen ? '退出右侧内容全屏' : '右侧内容全屏'}>
          <IconButton
            data-phi-inspector-fullscreen-button={inspectorFullscreen ? 'expanded' : 'collapsed'}
            size="small"
            aria-label={inspectorFullscreen ? '退出右侧内容全屏' : '右侧内容全屏'}
            onClick={onToggleInspectorFullscreen}
            sx={buttonSx}
          >
            {inspectorFullscreen ? <FiMinimize2 size={18} /> : <FiMaximize2 size={18} />}
          </IconButton>
        </Tooltip>
      ) : null}
      <Tooltip title="最小化">
        <IconButton
          size="small"
          aria-label="最小化"
          onClick={() => {
            void onMinimize()
          }}
          sx={buttonSx}
        >
          <FiMinus size={18} />
        </IconButton>
      </Tooltip>
      {showInspectorToggle ? (
        <Tooltip title={inspectorCollapsed ? '展开右侧栏' : '关闭右侧栏'}>
          <IconButton
            data-phi-inspector-toggle-button={inspectorCollapsed ? 'collapsed' : 'expanded'}
            data-phi-inspector-toggle-position="titlebar-flow"
            data-phi-inspector-toggle-anchor="analysis-chrome"
            size="small"
            color="default"
            aria-label={inspectorCollapsed ? '展开右侧栏' : '关闭右侧栏'}
            onClick={onToggleInspector}
            sx={{
              ...buttonSx,
              bgcolor: inspectorCollapsed ? 'transparent' : 'action.selected',
              color: inspectorCollapsed ? 'text.secondary' : 'text.primary'
            }}
          >
            <TbLayoutSidebarRight size={18} />
          </IconButton>
        </Tooltip>
      ) : null}
    </Box>
  )
}

function WorkspaceFileTabs({
  tabs,
  activePath,
  onSelect,
  onClose
}: {
  tabs: WorkspaceFileTab[]
  activePath: string | null
  onSelect: (tab: WorkspaceFileTab) => void
  onClose: (tab: WorkspaceFileTab) => void
}): React.JSX.Element {
  return (
    <Box
      role="tablist"
      aria-label="Open files"
      data-phi-workspace-file-tabs="true"
      sx={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 0.55,
        overflowX: 'auto',
        alignSelf: 'stretch',
        py: 0.65,
        WebkitAppRegion: 'no-drag',
        scrollbarWidth: 'none',
        '&::-webkit-scrollbar': { display: 'none' }
      }}
    >
      {tabs.map((tab) => {
        const selected = tab.path === activePath
        const fileIcon =
          tab.kind === 'directory'
            ? directoryIconForPath(tab.path, selected)
            : fileIconForPath(tab.path)
        const FileIcon = fileIcon.Icon
        return (
          <Box
            key={tab.id}
            role="tab"
            tabIndex={0}
            aria-selected={selected}
            data-phi-workspace-file-tab={selected ? 'active' : 'inactive'}
            data-phi-workspace-file-kind={tab.kind}
            title={tab.absolutePath ?? tab.path}
            onClick={() => {
              if (!selected) onSelect(tab)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              if (!selected) onSelect(tab)
            }}
            sx={{
              border: 1,
              borderColor: selected
                ? (theme) => alpha(theme.palette.primary.main, 0.5)
                : (theme) => alpha(theme.palette.text.primary, 0.12),
              borderRadius: '999px',
              bgcolor: selected
                ? (theme) =>
                    alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.2 : 0.1)
                : (theme) => alpha(theme.palette.background.paper, 0.56),
              color: selected ? 'text.primary' : 'text.secondary',
              cursor: selected ? 'default' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 0.4,
              flex: '0 0 156px',
              width: 156,
              minWidth: 118,
              maxWidth: 156,
              height: 32,
              px: 0.6,
              pl: 1,
              lineHeight: 1,
              '&:hover': {
                bgcolor: selected
                  ? (theme) =>
                      alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.24 : 0.14)
                  : (theme) => alpha(theme.palette.action.hover, 0.68),
                color: 'text.primary'
              },
              '&:hover .workspace-file-tab-close, &:focus-within .workspace-file-tab-close': {
                opacity: 1
              }
            }}
          >
            <FileIcon sx={{ flexShrink: 0, fontSize: 18, color: fileIcon.color }} />
            <Typography
              component="span"
              noWrap
              sx={{
                flex: 1,
                minWidth: 0,
                fontFamily: 'var(--font-mono)',
                fontSize: '0.78rem',
                fontWeight: selected ? 800 : 650,
                lineHeight: '18px'
              }}
            >
              {tab.name}
            </Typography>
            <Box
              className="workspace-file-tab-close"
              component="span"
              role="button"
              aria-label={`关闭 ${tab.name}`}
              tabIndex={0}
              onClick={(event: MouseEvent<HTMLElement>) => {
                event.stopPropagation()
                onClose(tab)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                event.stopPropagation()
                onClose(tab)
              }}
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                width: 17,
                height: 17,
                ml: 'auto',
                borderRadius: '50%',
                color: 'text.disabled',
                opacity: selected ? 0.72 : 0,
                transition: 'opacity 120ms ease, background-color 120ms ease, color 120ms ease',
                '&:hover': {
                  bgcolor: (theme) => alpha(theme.palette.text.primary, 0.08),
                  color: 'text.primary'
                }
              }}
            >
              <PhiIcons.action.close sx={{ fontSize: 14 }} />
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

function WorkspaceFileHeader({
  tabs,
  activePath,
  onSelect,
  onClose
}: {
  tabs: WorkspaceFileTab[]
  activePath: string | null
  onSelect: (tab: WorkspaceFileTab) => void
  onClose: (tab: WorkspaceFileTab) => void
}): React.JSX.Element {
  return (
    <Box
      data-phi-workspace-file-header="true"
      sx={{
        height: macTitlebarHeight,
        flexShrink: 0,
        borderBottom: 1,
        borderColor: 'divider',
        px: 1.5,
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        WebkitAppRegion: 'drag'
      }}
    >
      <WorkspaceFileTabs
        tabs={tabs}
        activePath={activePath}
        onSelect={onSelect}
        onClose={onClose}
      />
    </Box>
  )
}

function App(): React.JSX.Element {
  const { mode: themeMode, effectiveMode, setMode: setThemeMode } = useThemeMode()
  const theme = useMemo(() => createAppTheme(effectiveMode), [effectiveMode])

  const {
    sessions,
    setSessions,
    activeSessionPath,
    setActiveSessionPath,
    activePhiSessionId,
    setActivePhiSessionId,
    activeCwd,
    activeSessionGeneration,
    projectSessionRefreshKey,
    setProjectSessionRefreshKey,
    currentPermissionMode,
    isSessionChanging,
    setIsSessionChanging,
    agentEventState,
    setAgentEventState,
    pendingApproval,
    setPendingApproval,
    activeSessionRuntimeState,
    setActiveSessionRuntimeState,
    draftInputs,
    setDraftInputs,
    getSessionRuntimeState,
    setVisibleAgentEventState,
    replaceMessages,
    updateMessages,
    storeSessionRuntimeState,
    mergeSessionSummariesRuntimeState,
    applyCurrentSession,
    acknowledgeActiveSession,
    refreshSessions,
    startFreshChat,
    scheduleSessionRefresh,
    cancelScheduledSessionRefresh,
    onRenameSession,
    onRespondToolApproval
  } = useSessionStore()
  const messages = agentEventState.messages
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>('persona')
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(navigationPaneWidth)
  const [activeView, setActiveViewState] = useState<AppView>('chat')

  // Back/forward navigation history: tracks top-level view switches and,
  // within chat, which session was active, so "back" can return to an
  // earlier screen by restoring already-loaded state instead of clicking
  // through and re-rendering it from scratch. navigateToView must exist
  // before useWorkspaceFileTabs below (which takes it as an option), so
  // the recording half lives here; restoreNavigationEntry/goBack/goForward
  // need onSelectSession and are declared further down, right after it.
  // See lib/navigationHistory.ts for the (independently tested) reducer
  // logic this wraps.
  const [navigationHistory, setNavigationHistory] = useState(() =>
    initialNavigationHistory({ view: 'chat', sessionPath: null })
  )
  const restoringNavigationEntryRef = useRef<NavigationHistoryEntry | null>(null)

  const navigateToView = useCallback((view: AppView): void => {
    setActiveViewState(view)
  }, [])

  useEffect(() => {
    const current: NavigationHistoryEntry = { view: activeView, sessionPath: activeSessionPath }
    const restoringTo = restoringNavigationEntryRef.current
    if (restoringTo) {
      // Still catching up to a back/forward target -- e.g. the view
      // changed synchronously but the session switch is an async IPC call
      // that hasn't landed yet. Don't record it as a new navigation either
      // way (it's a restoration, not a fresh one) until it's settled.
      if (navigationRestorationSettled(restoringTo, current)) {
        restoringNavigationEntryRef.current = null
      }
      return
    }
    setNavigationHistory((prev) => recordNavigationEntry(prev, current))
  }, [activeView, activeSessionPath])

  const [workspaceSidebarMode, setWorkspaceSidebarMode] =
    useState<WorkspaceSidebarMode>('conversations')
  const [workspaceSidebarPreview, setWorkspaceSidebarPreview] = useState<{
    mode: WorkspaceSidebarMode
    anchorEl: HTMLElement
  } | null>(null)
  const workspaceSidebarPreviewCloseTimer = useRef<number | null>(null)
  const [isNewProjectDialogOpen, setIsNewProjectDialogOpen] = useState(false)
  const [isBusy, setIsBusy] = useState(false)
  const [isSendingMessage, setIsSendingMessage] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [personaMarkdown, setPersonaMarkdownState] = useState<string | null>(null)
  const [snackbarNotice, setSnackbarNotice] = useState<SnackbarNotice | null>(null)
  const isSendingRef = useRef(false)
  const sessionRequestRef = useRef(0)
  const sendRequestRef = useRef(0)
  const projectSidebarSelectionRequestRef = useRef(0)
  const rendererApi = useMemo(() => getRendererApi(), [])
  const getActiveCwd = useCallback(() => useSessionStore.getState().activeCwd, [])

  const {
    plugins,
    activePluginId,
    isLoadingPlugins,
    busyPluginSource,
    pluginOperationError,
    setActivePluginId,
    refreshPlugins,
    installPlugin: onInstallPlugin,
    removePlugin: onRemovePlugin
  } = usePluginCatalog()
  const {
    skills,
    promptAgents,
    activeSkillId,
    isLoadingSkills,
    setActiveSkillId,
    refreshSkills,
    refreshPromptAgents
  } = useSkillCatalog(getActiveCwd)
  const { mcpServers, activeMcpServerId, setActiveMcpServerId, refreshMcpServers } =
    useMcpServerCatalog(getActiveCwd)

  const showSnackbar = useCallback(
    (message: string, severity: SnackbarNotice['severity'] = 'error'): void => {
      setSnackbarNotice({ id: Date.now(), message, severity })
    },
    []
  )

  const showSnackbarError = useCallback(
    (error: unknown, fallback: string): void => {
      showSnackbar(readableErrorMessage(error, fallback), 'error')
    },
    [showSnackbar]
  )

  const {
    providerStatuses,
    activePrompts,
    providerHints,
    isProviderDialogOpen,
    providerDialogProviderId,
    refreshAuthStatuses,
    openProviderDialog,
    closeProviderDialog,
    setProviderDialogProviderId,
    submitProviderApiKey,
    submitProviderOAuth,
    logoutProvider,
    onSubmitAuthPrompt,
    onUpdatePromptValue,
    handleAuthInteractionEvent
  } = useProviderAuth(setIsBusy)
  const {
    models,
    availableModels,
    isModelStateReady,
    selectedModel,
    setSelectedModel,
    thinkingLevel,
    setThinkingLevel,
    onSelectModel,
    onSelectThinkingLevel
  } = useModelSelection(providerStatuses, showSnackbarError)
  const {
    projects,
    setProjects,
    projectsRef,
    updatingPermissionProjectId,
    updatingRemoteProjectId,
    refreshProjects,
    onUpdateProjectPermissionMode,
    onUpdateProjectDefaults,
    onUpdateProjectRemoteConnection,
    onUpdateProjectRemoteDefaults
  } = useProjects(showSnackbarError)

  const {
    filePreview,
    setFilePreview,
    filePreviewCache,
    clearCachedFilePreview,
    workspaceFileTabs,
    setWorkspaceFileTabs,
    activeWorkspaceFilePath,
    setActiveWorkspaceFilePath,
    filePreviewRequestRef,
    loadFilePreview,
    previewFilePath,
    previewDirectoryPath,
    onRevealPreviewPath,
    onListPreviewDirectory,
    openPathWithSystemDefault
  } = useWorkspaceFileTabs({
    rendererApi,
    getActiveCwd,
    showSnackbarError,
    setIsSidebarOpen,
    setActiveView: navigateToView
  })

  const onNavigateToNotebookView = useCallback((): void => {
    setFilePreview(null)
    navigateToView('analysis')
  }, [setFilePreview, navigateToView])

  const {
    analysisNotebookRegistry,
    analysisInspectorCollapsed,
    setAnalysisInspectorCollapsed,
    activeAnalysisNotebook,
    setActiveAnalysisNotebook,
    isLoadingAnalysisNotebooks,
    isOpeningAnalysisNotebook,
    analysisNotebookError,
    analysisNotebookContentError,
    analysisKernelDiagnostics,
    isLoadingAnalysisKernels,
    analysisKernelError,
    analysisJupyterStatus,
    analysisJupyterRuntimeStatus,
    isLoadingAnalysisJupyterRuntime,
    analysisJupyterRuntimeError,
    isStartingAnalysisJupyter,
    analysisJupyterError,
    analysisNotebookSessionStatus,
    isStartingAnalysisNotebookSession,
    closingRuntimeNotebookPath,
    analysisNotebookSessionError,
    executingAnalysisCellId,
    analysisCellExecutionError,
    analysisAgentFocus,
    refreshAnalysisNotebooks,
    onInitializeProjectAnalysis,
    onOpenAnalysisNotebook,
    activateCachedAnalysisNotebook,
    forgetCachedAnalysisNotebook,
    onSaveAnalysisNotebook,
    onSyncAnalysisNotebookDraft,
    onCreateAnalysisNotebook,
    onDeleteAnalysisNotebook,
    refreshAnalysisKernels,
    refreshAnalysisJupyterStatus,
    onJumpToAnalysisNotebookCell,
    refreshAnalysisJupyterRuntimeStatus,
    onStartAnalysisJupyter,
    onStopAnalysisJupyter,
    onStartAnalysisNotebookSession,
    onStopAnalysisNotebookSession,
    onStopRuntimeNotebookSession,
    onRunAnalysisNotebookCell,
    onStopAnalysisNotebookCell,
    onCompleteAnalysisNotebookCell,
    onFormatAnalysisNotebookCell,
    onGenerateAnalysisNotebookCode,
    closeActiveNotebook,
    resetAnalysisJupyterRuntimeForCwdChange,
    handleNotebookDraftChanged,
    handleNotebookFileChanged
  } = useAnalysisNotebookRuntime({
    rendererApi,
    getActiveCwd,
    projectsRef,
    showSnackbar,
    onNavigateToNotebookView
  })

  const handleNotebookFileChangedEvent = useCallback(
    (change: AnalysisNotebookFileChange): void => {
      handleNotebookFileChanged(change)
      if (change.type === 'changed') {
        setWorkspaceFileTabs((tabs) =>
          tabs.map((tab) =>
            tab.path === change.path || tab.path === change.file.path
              ? {
                  ...tab,
                  id: change.file.path,
                  path: change.file.path,
                  name: change.file.name,
                  status: change.file.relativePath,
                  absolutePath: change.file.path
                }
              : tab
          )
        )
        if (activeWorkspaceFilePath === change.path) {
          setActiveWorkspaceFilePath(change.file.path)
        }
        return
      }

      if (change.type === 'deleted') {
        setWorkspaceFileTabs((tabs) => tabs.filter((tab) => tab.path !== change.path))
        if (activeWorkspaceFilePath === change.path) {
          setActiveWorkspaceFilePath(null)
        }
      }
    },
    [
      activeWorkspaceFilePath,
      handleNotebookFileChanged,
      setActiveWorkspaceFilePath,
      setWorkspaceFileTabs
    ]
  )

  const refreshCurrentModelControls = useCallback(
    async (request = sessionRequestRef.current): Promise<void> => {
      const [selected, level] = await Promise.all([
        rendererApi.getSelectedModel(),
        rendererApi.getThinkingLevel()
      ])
      if (request !== sessionRequestRef.current) return
      setSelectedModel(modelOptionFromSelection(selected, models))
      setThinkingLevel(level)
    },
    [models, rendererApi, setSelectedModel, setThinkingLevel]
  )

  const onResetSending = useCallback((): void => {
    sendRequestRef.current += 1
    isSendingRef.current = false
    setIsSendingMessage(false)
  }, [])

  const onNewChat = useCallback(async (): Promise<void> => {
    projectSidebarSelectionRequestRef.current += 1
    const request = ++sessionRequestRef.current
    setIsSessionChanging(true)
    try {
      const current = await rendererApi.createSession()
      if (request !== sessionRequestRef.current) return
      setWorkspaceSidebarMode('conversations')
      applyCurrentSession(
        current,
        { resetSending: true },
        {
          onCwdChanged: resetAnalysisJupyterRuntimeForCwdChange,
          onResetSending
        }
      )
      void refreshCurrentModelControls(request)
      startFreshChat()
    } finally {
      if (request === sessionRequestRef.current) {
        setIsSessionChanging(false)
      }
    }
  }, [
    applyCurrentSession,
    onResetSending,
    refreshCurrentModelControls,
    rendererApi,
    resetAnalysisJupyterRuntimeForCwdChange,
    setIsSessionChanging,
    startFreshChat
  ])

  const onSelectSession = useCallback(
    async (path: string): Promise<void> => {
      if (path === useSessionStore.getState().activeSessionPath) {
        await acknowledgeActiveSession({ force: true })
        return
      }
      const request = ++sessionRequestRef.current
      setIsSessionChanging(true)
      try {
        const result = await rendererApi.switchSession(path)
        if (!result || request !== sessionRequestRef.current) return
        applyCurrentSession(
          result,
          { resetSending: true },
          { onCwdChanged: resetAnalysisJupyterRuntimeForCwdChange, onResetSending }
        )
        const targetStateKey = sessionStateKey({
          phiSessionId: result.phiSessionId,
          path: result.path,
          cwd: result.cwd,
          sessionGeneration: result.sessionGeneration
        })
        const cachedState = sessionAgentEventStates.get(targetStateKey)
        if (cachedState && cachedState.messages.length > 0) {
          setAgentEventState(cachedState)
        } else {
          replaceMessages(chatItemsFromSessionMessages(result.messages))
        }
        void refreshCurrentModelControls(request)
        void refreshSessions()
      } finally {
        if (request === sessionRequestRef.current) {
          setIsSessionChanging(false)
        }
      }
    },
    [
      acknowledgeActiveSession,
      applyCurrentSession,
      onResetSending,
      refreshCurrentModelControls,
      refreshSessions,
      rendererApi,
      replaceMessages,
      resetAnalysisJupyterRuntimeForCwdChange,
      setAgentEventState,
      setIsSessionChanging
    ]
  )

  const restoreNavigationEntry = useCallback(
    (entry: NavigationHistoryEntry): void => {
      const viewChanges = entry.view !== activeView
      const sessionChanges = Boolean(entry.sessionPath) && entry.sessionPath !== activeSessionPath
      if (!viewChanges && !sessionChanges) return
      restoringNavigationEntryRef.current = entry
      if (viewChanges) setActiveViewState(entry.view)
      if (sessionChanges) void onSelectSession(entry.sessionPath as string)
    },
    [activeView, activeSessionPath, onSelectSession]
  )

  const goInHistory = useCallback(
    (direction: 'back' | 'forward'): void => {
      const targetIndex = navigationHistoryTargetIndex(navigationHistory, direction)
      if (targetIndex === null) return
      const target = navigationHistory.entries[targetIndex]
      setNavigationHistory((prev) => ({ ...prev, index: targetIndex }))
      restoreNavigationEntry(target)
    },
    [navigationHistory, restoreNavigationEntry]
  )
  const goBackInHistory = useCallback(() => goInHistory('back'), [goInHistory])
  const goForwardInHistory = useCallback(() => goInHistory('forward'), [goInHistory])

  const canGoBackInHistory = navigationHistoryTargetIndex(navigationHistory, 'back') !== null
  const canGoForwardInHistory = navigationHistoryTargetIndex(navigationHistory, 'forward') !== null

  const onDeleteSession = async (path: string): Promise<void> => {
    const request = sessionRequestRef.current
    const wasActive = path === useSessionStore.getState().activeSessionPath
    await rendererApi.deleteSession(path)
    if (wasActive && request === sessionRequestRef.current) {
      const current = await rendererApi.getCurrentSession()
      if (request === sessionRequestRef.current) {
        applyCurrentSession(
          current,
          { resetSending: true },
          { onCwdChanged: resetAnalysisJupyterRuntimeForCwdChange, onResetSending }
        )
        void refreshCurrentModelControls(request)
        replaceMessages([])
      }
    }
    await refreshSessions()
    setProjectSessionRefreshKey((key) => key + 1)
  }

  const onOpenNotebookWorkspaceFile = useCallback(
    (path: string): void => {
      const normalizedPath = absoluteWorkspacePath(useSessionStore.getState().activeCwd, path)
      const title = fileNameFromPath(normalizedPath)
      filePreviewRequestRef.current += 1
      setFilePreview(null)
      setWorkspaceFileTabs((tabs) => {
        const nextTab: WorkspaceFileTab = {
          id: normalizedPath,
          path: normalizedPath,
          name: title,
          status: normalizedPath,
          absolutePath: normalizedPath,
          kind: 'notebook',
          pathKind: 'file'
        }
        return tabs.some((tab) => tab.path === normalizedPath)
          ? tabs.map((tab) => (tab.path === normalizedPath ? { ...tab, ...nextTab } : tab))
          : [...tabs, nextTab]
      })
      setActiveWorkspaceFilePath(normalizedPath)
      setIsSidebarOpen(true)
      navigateToView('analysis')
      const cachedFile = activateCachedAnalysisNotebook(normalizedPath)
      if (cachedFile) {
        setWorkspaceFileTabs((tabs) =>
          tabs.map((tab) =>
            tab.path === normalizedPath || tab.path === cachedFile.path
              ? {
                  ...tab,
                  id: cachedFile.path,
                  path: cachedFile.path,
                  name: cachedFile.name,
                  status: cachedFile.relativePath,
                  absolutePath: cachedFile.path
                }
              : tab
          )
        )
        setActiveWorkspaceFilePath(cachedFile.path)
        return
      }
      void refreshAnalysisNotebooks()
      void refreshAnalysisKernels()
      void refreshAnalysisJupyterStatus()
      void onOpenAnalysisNotebook(normalizedPath).then((file) => {
        if (!file) return
        setWorkspaceFileTabs((tabs) =>
          tabs.map((tab) =>
            tab.path === normalizedPath
              ? {
                  ...tab,
                  id: file.path,
                  path: file.path,
                  name: file.name,
                  status: file.relativePath,
                  absolutePath: file.path
                }
              : tab
          )
        )
        setActiveWorkspaceFilePath(file.path)
      })
    },
    [
      activateCachedAnalysisNotebook,
      filePreviewRequestRef,
      onOpenAnalysisNotebook,
      refreshAnalysisJupyterStatus,
      refreshAnalysisKernels,
      refreshAnalysisNotebooks,
      setActiveWorkspaceFilePath,
      setFilePreview,
      setWorkspaceFileTabs,
      navigateToView
    ]
  )

  const onCreateProject = async (
    name: string,
    workingDirectory: string,
    permissionMode: PermissionMode
  ): Promise<void> => {
    const project = await rendererApi.createProject(name, workingDirectory, permissionMode)
    await refreshProjects()
    await onStartProjectChat(project)
  }

  const onStartProjectChat = async (project: Project): Promise<void> => {
    projectSidebarSelectionRequestRef.current += 1
    const request = ++sessionRequestRef.current
    setIsSessionChanging(true)
    try {
      const current = await rendererApi.createProjectSession(
        project.workingDirectory,
        project.permissionMode
      )
      if (request !== sessionRequestRef.current) return
      setWorkspaceSidebarMode('projects')
      applyCurrentSession(
        current,
        { resetSending: true },
        { onCwdChanged: resetAnalysisJupyterRuntimeForCwdChange, onResetSending }
      )
      void refreshCurrentModelControls(request)
      startFreshChat()
      setProjectSessionRefreshKey((key) => key + 1)
    } finally {
      if (request === sessionRequestRef.current) {
        setIsSessionChanging(false)
      }
    }
  }

  const onDeleteProjectEntry = async (project: Project): Promise<void> => {
    await rendererApi.deleteProject(project.id)
    await refreshProjects()
  }

  const onFetchProjectSessions = useCallback(
    async (workingDirectory: string): Promise<SessionSummary[]> =>
      mergeSessionSummariesRuntimeState(
        await rendererApi.listProjectSessions(workingDirectory),
        workingDirectory
      ),
    [mergeSessionSummariesRuntimeState, rendererApi]
  )

  const selectFirstAvailableProjectSession = useCallback(
    async (request: number): Promise<boolean> => {
      const orderedProjects = orderProjectsForSessionSelection(
        projectsRef.current,
        useSessionStore.getState().activeCwd
      )

      for (const project of orderedProjects) {
        const projectSessions = await onFetchProjectSessions(project.workingDirectory)
        if (request !== projectSidebarSelectionRequestRef.current) return false

        const targetSession = projectSessions[0]
        if (!targetSession) continue

        await onSelectSession(targetSession.path)
        if (request !== projectSidebarSelectionRequestRef.current) return false

        setWorkspaceSidebarMode('projects')
        setProjectSessionRefreshKey((key) => key + 1)
        return true
      }

      return false
    },
    [onFetchProjectSessions, onSelectSession, projectsRef, setProjectSessionRefreshKey]
  )

  const onOpenApprovalSession = (path: string): void => {
    navigateToView('chat')
    setIsSettingsOpen(false)
    void onSelectSession(path)
  }

  const openSettings = useCallback((category?: SettingsCategory): void => {
    if (category) {
      setSettingsCategory(category)
    }
    setIsSettingsOpen(true)
  }, [])

  const onGoProviderSettings = useCallback((): void => {
    openSettings('providers')
  }, [openSettings])

  const focusPrimaryInput = useCallback((): void => {
    const selector = activeView === 'chat' ? '[data-phi-focus="chat-input"]' : 'input[type="text"]'
    const target = document.querySelector<HTMLElement>(selector)
    target?.focus({ preventScroll: true })
  }, [activeView])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const action = getAppShortcutAction(event)
      if (!action) return

      if (action === 'new-chat') {
        event.preventDefault()
        navigateToView('chat')
        void onNewChat()
        return
      }

      if (action === 'focus-primary-input') {
        event.preventDefault()
        focusPrimaryInput()
        return
      }

      if (action === 'close-dialogs') {
        if (isSettingsOpen || isProviderDialogOpen || isNewProjectDialogOpen) {
          event.preventDefault()
          setIsSettingsOpen(false)
          closeProviderDialog()
          setIsNewProjectDialogOpen(false)
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    closeProviderDialog,
    focusPrimaryInput,
    isNewProjectDialogOpen,
    isProviderDialogOpen,
    isSettingsOpen,
    onNewChat,
    navigateToView
  ])

  useEffect(() => {
    const unsubscribe = rendererApi.onAgentEvent((event: AgentEventSummary) => {
      if (event.sessionPath) {
        scheduleSessionRefresh()
      }

      const activeSessionIdentity = {
        phiSessionId: useSessionStore.getState().activePhiSessionId,
        path: useSessionStore.getState().activeSessionPath,
        cwd: useSessionStore.getState().activeCwd,
        sessionGeneration: useSessionStore.getState().activeSessionGeneration
      }
      const materializesActiveFreshSession = agentEventMaterializesActiveFreshSession(
        event,
        activeSessionIdentity,
        isSendingRef.current
      )
      const belongsToActiveSession =
        materializesActiveFreshSession ||
        agentEventBelongsToActiveSession(event, activeSessionIdentity)
      const eventStateKey = sessionStateKeyFromAgentEvent(event)
      if (eventStateKey) {
        const nextRuntimeState = reduceSessionRuntimeState(
          sessionRuntimeStates.get(eventStateKey) ?? idleSessionRuntimeState(),
          event
        )
        const runtimeStateChanged = storeSessionRuntimeState(eventStateKey, nextRuntimeState)
        const baseState =
          sessionAgentEventStates.get(eventStateKey) ??
          (belongsToActiveSession
            ? useSessionStore.getState().agentEventState
            : createAgentEventReducerState())
        const nextState = reduceAgentEventState(baseState, event)
        sessionAgentEventStates.set(eventStateKey, nextState)
        if (belongsToActiveSession) {
          useSessionStore.setState({
            activeAgentEventStateKey: eventStateKey,
            ...(materializesActiveFreshSession && typeof event.phiSessionId === 'string'
              ? { activePhiSessionId: event.phiSessionId }
              : {}),
            ...(materializesActiveFreshSession && typeof event.sessionPath === 'string'
              ? { activeSessionPath: event.sessionPath }
              : {})
          })
          setAgentEventState(nextState)
          setActiveSessionRuntimeState(nextRuntimeState)
        }
        if (runtimeStateChanged) {
          setProjectSessionRefreshKey((key) => key + 1)
        }
        if (shouldRefreshProjectGitStatusForAgentEvent(event, projectsRef.current)) {
          void refreshProjects()
        }
        return
      }

      if (!belongsToActiveSession) return
      setVisibleAgentEventState((prev) => reduceAgentEventState(prev, event))
    })

    const unsubscribeAuthInteraction = rendererApi.onAuthInteraction((event) => {
      if (handleAuthInteractionEvent(event)) {
        setIsSettingsOpen(true)
      }
    })

    const unsubscribeToolApproval = rendererApi.onToolApprovalRequest((event) => {
      const approvalStateKey = sessionStateKeyFromToolApproval(
        event,
        useSessionStore.getState().activeSessionGeneration
      )
      if (approvalStateKey) {
        pendingApprovalsBySession.set(approvalStateKey, event)
        const nextRuntimeState = {
          ...(sessionRuntimeStates.get(approvalStateKey) ?? idleSessionRuntimeState()),
          status: 'needs_approval' as const,
          unreadKind: 'approval' as const,
          currentRunId: event.runId
        }
        storeSessionRuntimeState(approvalStateKey, nextRuntimeState)
        if (approvalStateKey === useSessionStore.getState().activeAgentEventStateKey) {
          setPendingApproval(event)
          setActiveSessionRuntimeState(nextRuntimeState)
        }
      } else {
        setPendingApproval(event)
      }
      setProjectSessionRefreshKey((key) => key + 1)
      scheduleSessionRefresh()
    })

    const unsubscribeToolApprovalCancelled = rendererApi.onToolApprovalCancelled(() => {
      pendingApprovalsBySession.clear()
      setPendingApproval(null)
      scheduleSessionRefresh()
    })

    const unsubscribeNotebookDraftChanged = rendererApi.onAnalysisNotebookDraftChanged(
      handleNotebookDraftChanged
    )
    const unsubscribeNotebookFileChanged = rendererApi.onAnalysisNotebookFileChanged(
      handleNotebookFileChangedEvent
    )

    const unsubscribeSessionChanged = rendererApi.onSessionChanged((session) => {
      applyCurrentSession(session, undefined, {
        onCwdChanged: resetAnalysisJupyterRuntimeForCwdChange
      })
      setProjectSessionRefreshKey((key) => key + 1)
      if (activeView === 'projects') {
        void refreshProjects()
      }
    })

    return () => {
      unsubscribe()
      unsubscribeAuthInteraction()
      unsubscribeToolApproval()
      unsubscribeToolApprovalCancelled()
      unsubscribeNotebookDraftChanged()
      unsubscribeNotebookFileChanged()
      unsubscribeSessionChanged()
      cancelScheduledSessionRefresh()
    }
  }, [
    activeView,
    applyCurrentSession,
    cancelScheduledSessionRefresh,
    handleAuthInteractionEvent,
    handleNotebookDraftChanged,
    handleNotebookFileChangedEvent,
    projectsRef,
    refreshProjects,
    rendererApi,
    resetAnalysisJupyterRuntimeForCwdChange,
    scheduleSessionRefresh,
    setActiveSessionRuntimeState,
    setAgentEventState,
    setPendingApproval,
    setProjectSessionRefreshKey,
    setVisibleAgentEventState,
    showSnackbar,
    storeSessionRuntimeState
  ])

  useEffect(() => {
    void (async () => {
      const [name, onboarded, markdown] = await Promise.all([
        rendererApi.getAppName(),
        rendererApi.isOnboarded(),
        rendererApi.getPersonaMarkdown()
      ])
      document.title = name
      setPersonaMarkdownState(markdown)
      setShowOnboarding(!onboarded)
    })()
  }, [rendererApi])

  useEffect(() => {
    void (async () => {
      const [sessionList, current, projectList] = await Promise.all([
        rendererApi.listSessions(),
        rendererApi.getCurrentSession(),
        rendererApi.listProjects()
      ])
      setSessions((previous) =>
        preserveSessionListOrder(
          previous,
          mergeSessionSummariesRuntimeState(sessionList, current.cwd)
        )
      )
      applyCurrentSession(current, undefined, {
        onCwdChanged: resetAnalysisJupyterRuntimeForCwdChange
      })
      if (Array.isArray(current.messages)) {
        replaceMessages(chatItemsFromSessionMessages(current.messages))
      }
      setProjects(projectList)
      projectsRef.current = projectList
    })()
  }, [
    applyCurrentSession,
    mergeSessionSummariesRuntimeState,
    projectsRef,
    rendererApi,
    replaceMessages,
    resetAnalysisJupyterRuntimeForCwdChange,
    setProjects,
    setSessions
  ])

  useEffect(() => {
    void Promise.resolve().then(() => {
      if (activeView === 'projects') {
        void refreshProjects()
      }
      if (activeView === 'skills') {
        void refreshSkills()
      }
      if (activeView === 'mcp') {
        void refreshMcpServers()
      }
      if (activeView === 'analysis') {
        void refreshAnalysisNotebooks()
        void refreshAnalysisKernels()
        void refreshAnalysisJupyterStatus()
      }
    })
  }, [
    activeCwd,
    activeView,
    refreshAnalysisKernels,
    refreshAnalysisJupyterStatus,
    refreshAnalysisNotebooks,
    refreshMcpServers,
    refreshProjects,
    refreshSkills
  ])

  const activeDraftKey = sessionDraftKey({
    phiSessionId: activePhiSessionId,
    path: activeSessionPath,
    cwd: activeCwd,
    sessionGeneration: activeSessionGeneration
  })
  const input = draftInputs[activeDraftKey] ?? ''
  const setActiveInput = useCallback(
    (value: string): void => {
      setDraftInputs((prev) => updateSessionDraft(prev, activeDraftKey, value))
    },
    [activeDraftKey, setDraftInputs]
  )

  const onChatSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const text = input.trim()
    // isSendingRef is checked-and-set synchronously so a second submit fired in the
    // same tick (before the isSendingMessage state update commits) can't slip through.
    if (!text || isSendingRef.current || currentSessionIsBusy) {
      return
    }
    const readiness = getPromptReadiness({
      modelStateReady: isModelStateReady,
      providers: providerStatuses,
      availableModels
    })
    if (!readiness.ready) {
      if (readiness.reason !== 'providers_loading') {
        openSettings('providers')
      }
      return
    }
    isSendingRef.current = true
    const submitGeneration = useSessionStore.getState().activeSessionGeneration
    const sendRequest = ++sendRequestRef.current

    updateMessages((prev) => [...prev, { id: `user-${Date.now()}`, role: 'user', content: text }])
    setActiveInput('')
    setIsSendingMessage(true)

    try {
      const result = await rendererApi.sendPrompt(text, {
        path: useSessionStore.getState().activeSessionPath,
        phiSessionId: useSessionStore.getState().activePhiSessionId ?? undefined,
        cwd: useSessionStore.getState().activeCwd,
        sessionGeneration: submitGeneration
      })
      if (
        !result ||
        sendRequest !== sendRequestRef.current ||
        result.sessionGeneration !== useSessionStore.getState().activeSessionGeneration
      ) {
        return
      }

      if (result.path && result.path !== activeSessionPath) {
        // First prompt of a fresh chat: it just became a stable Phi session — pick it up so
        // the sidebar can highlight it.
        setActiveSessionPath(result.path)
      }
      if (
        result.phiSessionId &&
        result.phiSessionId !== useSessionStore.getState().activePhiSessionId
      ) {
        setActivePhiSessionId(result.phiSessionId)
      }
      void refreshSessions()
      if (!selectedModel) {
        const active = await rendererApi.getSelectedModel()
        if (active) {
          setSelectedModel((prev) => prev ?? modelOptionFromSelection(active, models) ?? prev)
        }
      }
    } catch (error) {
      if (
        sendRequest !== sendRequestRef.current ||
        submitGeneration !== useSessionStore.getState().activeSessionGeneration
      ) {
        return
      }
      showSnackbarError(error, '发送消息失败')
    } finally {
      if (
        sendRequest === sendRequestRef.current &&
        submitGeneration === useSessionStore.getState().activeSessionGeneration
      ) {
        isSendingRef.current = false
        setIsSendingMessage(false)
      }
    }
  }

  const onStopGeneration = async (): Promise<void> => {
    const stoppedRequest = sendRequestRef.current
    await rendererApi.stopGeneration()
    if (stoppedRequest === sendRequestRef.current) {
      isSendingRef.current = false
      setIsSendingMessage(false)
      setPendingApproval(null)
    }
  }

  const onSavePersonaMarkdown = async (markdown: string): Promise<void> => {
    const next = await rendererApi.setPersonaMarkdown(markdown)
    setPersonaMarkdownState(next)
  }

  const onCompleteOnboarding = async (description: string): Promise<void> => {
    const markdown = await rendererApi.completeOnboarding(description)
    setPersonaMarkdownState(markdown)
    setShowOnboarding(false)
  }

  const onSkipOnboarding = async (): Promise<void> => {
    await rendererApi.skipOnboarding()
    setShowOnboarding(false)
  }

  const onSelectPermissionMode = async (permissionMode: PermissionMode): Promise<void> => {
    if (permissionMode === activePermissionMode) return
    const current = await rendererApi.updateCurrentSessionPermissionMode(permissionMode)
    applyCurrentSession(current, undefined, {
      onCwdChanged: resetAnalysisJupyterRuntimeForCwdChange
    })
    setProjectSessionRefreshKey((key) => key + 1)
  }

  const onOpenFilePreview = useCallback(
    (path: string): void => {
      if (isNotebookFilePath(path)) {
        onOpenNotebookWorkspaceFile(path)
        return
      }
      previewFilePath(path)
    },
    [onOpenNotebookWorkspaceFile, previewFilePath]
  )

  const onOpenLocalPath = useCallback(
    (path: string, pathKind: LocalPathKind): void => {
      if (pathKind === 'directory') {
        previewDirectoryPath(path)
        return
      }
      if (isNotebookFilePath(path)) {
        onOpenNotebookWorkspaceFile(path)
        return
      }
      previewFilePath(path)
    },
    [onOpenNotebookWorkspaceFile, previewDirectoryPath, previewFilePath]
  )

  const onOpenDefaultPreviewPath = useCallback(
    (path: string): void => {
      if (isNotebookFilePath(path)) {
        onOpenNotebookWorkspaceFile(path)
        return
      }
      openPathWithSystemDefault(path)
    },
    [onOpenNotebookWorkspaceFile, openPathWithSystemDefault]
  )

  const onOpenInputAddMenu = useCallback((): void => {
    void refreshSkills()
    void refreshPromptAgents()
    if (plugins.length === 0) {
      void refreshPlugins()
    }
  }, [plugins.length, refreshPlugins, refreshPromptAgents, refreshSkills])

  const onPickInputFiles = useCallback(async (): Promise<string[]> => {
    try {
      return await rendererApi.pickInputFiles()
    } catch (error) {
      showSnackbarError(error, '选择文件失败')
      return []
    }
  }, [rendererApi, showSnackbarError])
  const onListInputDirectory = useCallback(
    (path: string) => rendererApi.listDirectory(path),
    [rendererApi]
  )

  const selectedPrompts = activePrompts.filter(
    (item) => item.providerId === providerDialogProviderId
  )
  const isChatWorkspaceView =
    activeView === 'chat' || activeView === 'projects' || activeView === 'analysis'
  const isAnalysisWorkspaceView = activeView === 'analysis'
  const activeSession = activeSessionPath
    ? (sessions.find((session) =>
        activePhiSessionId
          ? session.phiSessionId === activePhiSessionId
          : session.path === activeSessionPath
      ) ?? null)
    : null
  const activeProject = activeCwd
    ? (projects.find((project) => project.workingDirectory === activeCwd) ?? null)
    : null
  const notebookAiDefaultModel = useMemo<ModelOption | null>(() => {
    const projectModelSelection = activeProject?.defaultModel ?? null
    if (projectModelSelection) {
      return (
        modelOptionFromSelection(projectModelSelection, models) ?? {
          providerId: projectModelSelection.providerId,
          modelId: projectModelSelection.modelId,
          name: `${projectModelSelection.providerId}/${projectModelSelection.modelId}`,
          thinkingLevels: []
        }
      )
    }
    return selectedModel
  }, [activeProject, models, selectedModel])
  const activeWorkspaceIsProject = Boolean(activeProject)
  const showProjectSessionPlaceholder = activeView === 'projects' && !activeWorkspaceIsProject
  const activeSessionHasWork =
    sessionStatusIsBusy(activeSession) || sessionRuntimeStateIsBusy(activeSessionRuntimeState)
  const currentSessionIsBusy = isSendingMessage || activeSessionHasWork
  const activeWorkspaceTitle = useMemo(() => {
    if (showProjectSessionPlaceholder) return '项目会话'
    if (!isChatWorkspaceView) return activeView
    if (activeSession) return sessionDisplayTitle(activeSession)
    return titleFromMessages(messages) ?? truncateSessionTitle('新对话')
  }, [activeSession, activeView, isChatWorkspaceView, messages, showProjectSessionPlaceholder])
  const activeWorkspaceScopeLabel = workspaceScopeLabelForCwd(activeCwd, projects)
  const activePermissionMode = currentPermissionMode
  const showWorkspaceTitlebar = !isAnalysisWorkspaceView
  const workspaceSidebarPreviewWidth = Math.min(360, Math.max(320, sidebarWidth))
  const isWorkspaceSidebarModeExpanded = useCallback(
    (mode: WorkspaceSidebarMode): boolean =>
      workspaceSidebarModeIsExpanded({
        activeView,
        isSidebarOpen,
        workspaceSidebarMode,
        mode
      }),
    [activeView, isSidebarOpen, workspaceSidebarMode]
  )
  const shouldUseWorkspaceSidebarPreview = useCallback(
    (mode: WorkspaceSidebarMode): boolean => !isWorkspaceSidebarModeExpanded(mode),
    [isWorkspaceSidebarModeExpanded]
  )
  const visibleWorkspaceSidebarPreview =
    workspaceSidebarPreview && shouldUseWorkspaceSidebarPreview(workspaceSidebarPreview.mode)
      ? workspaceSidebarPreview
      : null
  const workspaceSidebarPreviewMode = visibleWorkspaceSidebarPreview?.mode ?? 'conversations'
  const isWorkspaceSidebarPreviewOpen = visibleWorkspaceSidebarPreview !== null
  const clearWorkspaceSidebarPreviewCloseTimer = useCallback((): void => {
    if (workspaceSidebarPreviewCloseTimer.current === null) return
    window.clearTimeout(workspaceSidebarPreviewCloseTimer.current)
    workspaceSidebarPreviewCloseTimer.current = null
  }, [])
  const closeWorkspaceSidebarPreview = useCallback(
    (delayMs = 0): void => {
      clearWorkspaceSidebarPreviewCloseTimer()
      if (delayMs <= 0) {
        setWorkspaceSidebarPreview(null)
        return
      }
      workspaceSidebarPreviewCloseTimer.current = window.setTimeout(() => {
        workspaceSidebarPreviewCloseTimer.current = null
        setWorkspaceSidebarPreview(null)
      }, delayMs)
    },
    [clearWorkspaceSidebarPreviewCloseTimer]
  )
  const openWorkspaceSidebarPreview = useCallback(
    (mode: WorkspaceSidebarMode, anchorEl: HTMLElement): void => {
      if (!shouldUseWorkspaceSidebarPreview(mode)) {
        closeWorkspaceSidebarPreview()
        return
      }
      clearWorkspaceSidebarPreviewCloseTimer()
      setWorkspaceSidebarPreview({ mode, anchorEl })
    },
    [
      clearWorkspaceSidebarPreviewCloseTimer,
      closeWorkspaceSidebarPreview,
      shouldUseWorkspaceSidebarPreview
    ]
  )
  const scheduleWorkspaceSidebarPreviewClose = useCallback((): void => {
    closeWorkspaceSidebarPreview(160)
  }, [closeWorkspaceSidebarPreview])

  useEffect(
    () => () => {
      clearWorkspaceSidebarPreviewCloseTimer()
    },
    [clearWorkspaceSidebarPreviewCloseTimer]
  )

  const activeWorkspaceFileTab =
    workspaceFileTabs.find((tab) => tab.path === activeWorkspaceFilePath) ?? null
  const cachedActiveFilePreview =
    activeWorkspaceFileTab && activeWorkspaceFileTab.kind !== 'notebook'
      ? (filePreviewCache[activeWorkspaceFileTab.path] ?? null)
      : null
  const activeFilePreviewState =
    activeWorkspaceFileTab && activeWorkspaceFileTab.kind !== 'notebook'
      ? filePreview && filePreviewStatePath(filePreview) === activeWorkspaceFileTab.path
        ? filePreview
        : (cachedActiveFilePreview ??
          (activeWorkspaceFileTab.pathKind === 'directory'
            ? ({
                status: 'loading',
                path: activeWorkspaceFileTab.path,
                pathKind: 'directory'
              } satisfies FilePreviewPanelState)
            : ({
                status: 'loading',
                path: activeWorkspaceFileTab.path
              } satisfies FilePreviewPanelState)))
      : null

  const showCachedOrLoadFilePreview = useCallback(
    (tab: WorkspaceFileTab): void => {
      const cachedPreview = filePreviewCache[tab.path] ?? null
      if (cachedPreview) {
        filePreviewRequestRef.current += 1
        setFilePreview(cachedPreview)
        return
      }
      loadFilePreview(tab.path, tab.pathKind)
    },
    [filePreviewCache, filePreviewRequestRef, loadFilePreview, setFilePreview]
  )

  const onSelectWorkspaceFileTab = useCallback(
    (tabLike: AnalysisWorkspaceFileTab): void => {
      const tab = workspaceFileTabs.find((item) => item.path === tabLike.path)
      if (!tab) return
      setActiveWorkspaceFilePath(tab.path)
      navigateToView('analysis')
      if (tab.kind === 'notebook') {
        if (!activateCachedAnalysisNotebook(tab.path)) {
          onOpenNotebookWorkspaceFile(tab.path)
        }
        return
      }
      showCachedOrLoadFilePreview(tab)
    },
    [
      activateCachedAnalysisNotebook,
      onOpenNotebookWorkspaceFile,
      setActiveWorkspaceFilePath,
      showCachedOrLoadFilePreview,
      workspaceFileTabs,
      navigateToView
    ]
  )

  const onCloseWorkspaceFileTab = useCallback(
    (tabLike: AnalysisWorkspaceFileTab): void => {
      const closingTab = workspaceFileTabs.find((tab) => tab.path === tabLike.path)
      if (!closingTab) return
      const remainingTabs = workspaceFileTabs.filter((tab) => tab.path !== closingTab.path)
      setWorkspaceFileTabs(remainingTabs)
      clearCachedFilePreview(closingTab.path)
      if (closingTab.kind === 'notebook') {
        forgetCachedAnalysisNotebook(closingTab.path)
      }

      if (closingTab.path !== activeWorkspaceFilePath) {
        if (filePreview && filePreviewStatePath(filePreview) === closingTab.path) {
          filePreviewRequestRef.current += 1
          setFilePreview(null)
        }
        return
      }

      const nextTab = remainingTabs.at(-1) ?? null
      if (!nextTab) {
        filePreviewRequestRef.current += 1
        setFilePreview(null)
        setActiveWorkspaceFilePath(null)
        closeActiveNotebook()
        navigateToView(workspaceSidebarMode === 'projects' ? 'projects' : 'chat')
        return
      }

      setActiveWorkspaceFilePath(nextTab.path)
      if (nextTab.kind === 'notebook') {
        if (!activateCachedAnalysisNotebook(nextTab.path)) {
          onOpenNotebookWorkspaceFile(nextTab.path)
        }
      } else {
        setActiveAnalysisNotebook(null)
        showCachedOrLoadFilePreview(nextTab)
      }
    },
    [
      activateCachedAnalysisNotebook,
      activeWorkspaceFilePath,
      clearCachedFilePreview,
      closeActiveNotebook,
      filePreview,
      filePreviewRequestRef,
      forgetCachedAnalysisNotebook,
      onOpenNotebookWorkspaceFile,
      setActiveAnalysisNotebook,
      setActiveWorkspaceFilePath,
      setFilePreview,
      setWorkspaceFileTabs,
      showCachedOrLoadFilePreview,
      workspaceFileTabs,
      workspaceSidebarMode,
      navigateToView
    ]
  )

  const onStartSidebarResize = useCallback((event: MouseEvent<HTMLDivElement>): void => {
    event.preventDefault()

    const onMouseMove = (moveEvent: globalThis.MouseEvent): void => {
      const nextWidth = Math.min(
        maxNavigationPaneWidth,
        Math.max(minNavigationPaneWidth, moveEvent.clientX - activityBarWidth)
      )
      setSidebarWidth(nextWidth)
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
  }, [])

  const onSelectWorkspaceView = useCallback(
    (view: 'chat' | 'projects'): void => {
      closeWorkspaceSidebarPreview()
      const nextSidebarMode = view === 'projects' ? 'projects' : 'conversations'
      const projectSelectionRequest =
        view === 'projects' ? ++projectSidebarSelectionRequestRef.current : 0
      if (view === 'chat') {
        projectSidebarSelectionRequestRef.current += 1
      }
      if (activeView === 'analysis') {
        setWorkspaceSidebarMode(nextSidebarMode)
        if (workspaceSidebarMode === nextSidebarMode) {
          setIsSidebarOpen((value) => !value)
        } else {
          setIsSidebarOpen(true)
        }
        return
      }

      setWorkspaceSidebarMode(nextSidebarMode)
      if (activeView === view) {
        setIsSidebarOpen((value) => !value)
        return
      }
      navigateToView(view)
      setIsSidebarOpen(true)
      if (
        view === 'projects' &&
        !activeCwdBelongsToProject(projectsRef.current, useSessionStore.getState().activeCwd)
      ) {
        void selectFirstAvailableProjectSession(projectSelectionRequest)
      }
    },
    [
      activeView,
      closeWorkspaceSidebarPreview,
      projectsRef,
      selectFirstAvailableProjectSession,
      workspaceSidebarMode,
      navigateToView
    ]
  )

  const startPlaceholderProjectSession = (): void => {
    const [project] = orderProjectsForSessionSelection(
      projectsRef.current,
      useSessionStore.getState().activeCwd
    )
    if (project) {
      void onStartProjectChat(project)
      return
    }
    setIsNewProjectDialogOpen(true)
  }

  const acknowledgeActiveSessionInteraction = useCallback((): void => {
    void acknowledgeActiveSession()
  }, [acknowledgeActiveSession])

  const activeChatView = (
    <ChatView
      messages={messages}
      input={input}
      scrollResetKey={activeDraftKey}
      canSend={!isSessionChanging && !currentSessionIsBusy && !isBusy}
      isGenerating={currentSessionIsBusy}
      currentRunStartedAt={activeSessionRuntimeState.currentRunStartedAt}
      models={availableModels}
      selectedModel={selectedModel}
      skills={skills}
      promptAgents={promptAgents}
      plugins={plugins}
      onSelectModel={(model) => {
        void onSelectModel(model)
      }}
      thinkingLevel={thinkingLevel}
      onSelectThinkingLevel={(level) => {
        void onSelectThinkingLevel(level)
      }}
      onInputChange={setActiveInput}
      onOpenInputAddMenu={onOpenInputAddMenu}
      onPickInputFiles={onPickInputFiles}
      onGetPathForInputFile={rendererApi.getPathForFile}
      onInputFilesDropped={rendererApi.onInputFilesDropped}
      onListInputDirectory={onListInputDirectory}
      onChatSubmit={onChatSubmit}
      onStopGeneration={onStopGeneration}
      onAcknowledgeActiveSession={acknowledgeActiveSessionInteraction}
      onGoSettings={onGoProviderSettings}
      permissionMode={activePermissionMode}
      onSelectPermissionMode={(mode) => {
        void onSelectPermissionMode(mode)
      }}
      disablePermissionModeSelect={isSessionChanging}
      disableModelControls={isSessionChanging}
      pendingApproval={pendingApproval}
      onRespondApproval={onRespondToolApproval}
      onOpenApprovalSession={onOpenApprovalSession}
      onOpenLocalPath={onOpenLocalPath}
      onJumpToNotebookCell={onJumpToAnalysisNotebookCell}
      compactComposerControls={activeView === 'analysis' || filePreview !== null}
      cwd={activeCwd}
    />
  )

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box
        sx={{
          display: 'flex',
          width: '100vw',
          height: '100vh',
          backgroundColor: (muiTheme) =>
            muiTheme.palette.mode === 'dark' ? muiTheme.palette.background.default : '#FFFFFF',
          overflow: 'hidden',
          position: 'relative'
        }}
      >
        <Box
          aria-hidden
          className="app-left-background-fill"
          sx={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width:
              isChatWorkspaceView && isSidebarOpen
                ? activityBarWidth + sidebarWidth
                : activityBarWidth,
            backgroundColor: (muiTheme) =>
              muiTheme.palette.mode === 'dark' ? muiTheme.palette.background.default : '#FFFFFF',
            pointerEvents: 'none',
            zIndex: 0
          }}
        />
        {isMac && (
          // One shared no-drag boundary for the whole button cluster --
          // see MacWindowControls' doc comment for why two separate
          // sibling no-drag rectangles here was the likely cause of the
          // buttons going unclickable after the first use (a known
          // Electron frameless-window region quirk).
          <Box
            sx={{
              position: 'absolute',
              top: '10px',
              left: '14px',
              display: 'flex',
              alignItems: 'center',
              gap: '18px',
              zIndex: 20,
              WebkitAppRegion: 'no-drag'
            }}
          >
            <MacWindowControls
              onClose={() => void rendererApi.closeWindow()}
              onMinimize={() => void rendererApi.minimizeWindow()}
              onToggleFullscreen={() => void rendererApi.toggleWindowFullscreen()}
            />
            <WindowNavigationControls
              isSidebarOpen={isSidebarOpen}
              onToggleSidebar={() => setIsSidebarOpen((value) => !value)}
              canGoBack={canGoBackInHistory}
              canGoForward={canGoForwardInHistory}
              onGoBack={goBackInHistory}
              onGoForward={goForwardInHistory}
            />
          </Box>
        )}

        <AppActivityBar
          activeView={activeView}
          setActiveView={navigateToView}
          isWorkspaceSidebarModeExpanded={isWorkspaceSidebarModeExpanded}
          shouldUseWorkspaceSidebarPreview={shouldUseWorkspaceSidebarPreview}
          openWorkspaceSidebarPreview={openWorkspaceSidebarPreview}
          scheduleWorkspaceSidebarPreviewClose={scheduleWorkspaceSidebarPreviewClose}
          onSelectWorkspaceView={onSelectWorkspaceView}
          refreshAnalysisJupyterRuntimeStatus={refreshAnalysisJupyterRuntimeStatus}
          refreshPlugins={refreshPlugins}
          refreshSkills={refreshSkills}
          refreshMcpServers={refreshMcpServers}
          setIsSettingsOpen={setIsSettingsOpen}
          isWorkspaceSidebarPreviewOpen={isWorkspaceSidebarPreviewOpen}
          visibleWorkspaceSidebarPreview={visibleWorkspaceSidebarPreview}
          workspaceSidebarPreviewMode={workspaceSidebarPreviewMode}
          workspaceSidebarPreviewWidth={workspaceSidebarPreviewWidth}
          clearWorkspaceSidebarPreviewCloseTimer={clearWorkspaceSidebarPreviewCloseTimer}
          closeWorkspaceSidebarPreview={closeWorkspaceSidebarPreview}
          sessions={sessions}
          activeSessionPath={activeSessionPath}
          activeCwd={activeCwd}
          projects={projects}
          projectSessionRefreshKey={projectSessionRefreshKey}
          onNewChat={onNewChat}
          setIsNewProjectDialogOpen={setIsNewProjectDialogOpen}
          onSelectSession={onSelectSession}
          onRenameSession={onRenameSession}
          onDeleteSession={onDeleteSession}
          onStartProjectChat={onStartProjectChat}
          onDeleteProjectEntry={onDeleteProjectEntry}
          onFetchProjectSessions={onFetchProjectSessions}
          getSessionRuntimeState={getSessionRuntimeState}
        />

        <AppWorkspaceSidebar
          isChatWorkspaceView={isChatWorkspaceView}
          isSidebarOpen={isSidebarOpen}
          sidebarWidth={sidebarWidth}
          activeView={activeView}
          activeChatView={activeChatView}
          onStartSidebarResize={onStartSidebarResize}
          activeWorkspaceIsProject={activeWorkspaceIsProject}
          activeWorkspaceTitle={activeWorkspaceTitle}
          activeWorkspaceScopeLabel={activeWorkspaceScopeLabel}
          workspaceSidebarMode={workspaceSidebarMode}
          sessions={sessions}
          activeSessionPath={activeSessionPath}
          activeCwd={activeCwd}
          projects={projects}
          projectSessionRefreshKey={projectSessionRefreshKey}
          onNewChat={onNewChat}
          setIsNewProjectDialogOpen={setIsNewProjectDialogOpen}
          onSelectSession={onSelectSession}
          onRenameSession={onRenameSession}
          onDeleteSession={onDeleteSession}
          onStartProjectChat={onStartProjectChat}
          onDeleteProjectEntry={onDeleteProjectEntry}
          onFetchProjectSessions={onFetchProjectSessions}
          getSessionRuntimeState={getSessionRuntimeState}
        />

        {isChatWorkspaceView ? (
          <Box
            component="main"
            sx={{
              flex: 1,
              minWidth: 0,
              height: '100vh',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            {showWorkspaceTitlebar ? (
              <Box
                sx={{
                  height: macTitlebarHeight,
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  backgroundColor: (muiTheme) =>
                    muiTheme.palette.mode === 'dark'
                      ? muiTheme.palette.background.default
                      : '#FFFFFF',
                  WebkitAppRegion: 'drag',
                  zIndex: 7
                }}
              >
                <Box
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    borderBottom: 1,
                    borderColor: 'divider'
                  }}
                >
                  <Box
                    sx={{
                      width: '100%',
                      maxWidth: 860,
                      mx: 'auto',
                      px: 3,
                      minWidth: 0
                    }}
                  >
                    <Typography
                      variant="subtitle2"
                      title={activeWorkspaceTitle}
                      sx={{
                        maxWidth: { xs: 220, sm: 360, md: 520 },
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontWeight: 600
                      }}
                    >
                      {activeWorkspaceTitle}
                    </Typography>
                  </Box>
                </Box>
              </Box>
            ) : null}
            <Box sx={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', overflow: 'hidden' }}>
              {isAnalysisWorkspaceView &&
              activeWorkspaceFileTab &&
              activeWorkspaceFileTab.kind !== 'notebook' ? (
                <Box
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    minHeight: 0,
                    display: 'flex',
                    flexDirection: 'column'
                  }}
                >
                  <WorkspaceFileHeader
                    tabs={workspaceFileTabs}
                    activePath={activeWorkspaceFilePath}
                    onSelect={onSelectWorkspaceFileTab}
                    onClose={onCloseWorkspaceFileTab}
                  />
                  <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
                    {activeFilePreviewState ? (
                      <FilePreviewPanel
                        layout="workspace"
                        state={activeFilePreviewState}
                        onOpenFile={onOpenFilePreview}
                        onOpenDefaultPath={onOpenDefaultPreviewPath}
                        onRevealPath={onRevealPreviewPath}
                        onListDirectory={onListPreviewDirectory}
                      />
                    ) : null}
                  </Box>
                </Box>
              ) : isAnalysisWorkspaceView ? (
                <AnalysisView
                  hideLeftRail
                  notebookRegistry={analysisNotebookRegistry}
                  notebookFile={activeAnalysisNotebook}
                  workspaceFileTabs={workspaceFileTabs}
                  activeWorkspaceFilePath={activeWorkspaceFilePath}
                  onSelectWorkspaceFileTab={onSelectWorkspaceFileTab}
                  onCloseWorkspaceFileTab={onCloseWorkspaceFileTab}
                  inspectorCollapsed={analysisInspectorCollapsed}
                  topRightControls={(chromeState) => (
                    <TopRightControls
                      showInspectorFullscreen={chromeState.inspectorVisible}
                      inspectorFullscreen={chromeState.inspectorFullscreen}
                      showInspectorToggle
                      inspectorCollapsed={analysisInspectorCollapsed}
                      onToggleInspectorFullscreen={chromeState.onToggleInspectorFullscreen}
                      onToggleInspector={() => {
                        if (!analysisInspectorCollapsed && chromeState.inspectorFullscreen) {
                          chromeState.onToggleInspectorFullscreen()
                        }
                        setAnalysisInspectorCollapsed((value) => !value)
                      }}
                      onMinimize={() => rendererApi.minimizeWindow()}
                    />
                  )}
                  isLoadingNotebooks={isLoadingAnalysisNotebooks}
                  isOpeningNotebook={isOpeningAnalysisNotebook}
                  notebookError={analysisNotebookError}
                  notebookContentError={analysisNotebookContentError}
                  kernelDiagnostics={analysisKernelDiagnostics}
                  isLoadingKernels={isLoadingAnalysisKernels}
                  kernelError={analysisKernelError}
                  jupyterServerStatus={analysisJupyterStatus}
                  isStartingJupyterServer={isStartingAnalysisJupyter}
                  jupyterServerError={analysisJupyterError}
                  notebookSessionStatus={analysisNotebookSessionStatus}
                  isStartingNotebookSession={isStartingAnalysisNotebookSession}
                  notebookSessionError={analysisNotebookSessionError}
                  executingNotebookCellId={executingAnalysisCellId}
                  notebookCellExecutionError={analysisCellExecutionError}
                  agentFocus={analysisAgentFocus}
                  onRefreshNotebooks={() => {
                    void refreshAnalysisNotebooks()
                  }}
                  onRefreshKernels={() => {
                    void refreshAnalysisKernels()
                  }}
                  onRefreshJupyterServer={() => {
                    void refreshAnalysisJupyterStatus()
                  }}
                  onStartJupyterServer={(cwd) => {
                    void onStartAnalysisJupyter(cwd)
                  }}
                  onStopJupyterServer={(cwd) => {
                    void onStopAnalysisJupyter(cwd)
                  }}
                  onStartNotebookSession={(file, document) => {
                    return onStartAnalysisNotebookSession(file, document)
                  }}
                  onSyncNotebookDraft={(file, document) => {
                    void onSyncAnalysisNotebookDraft(file, document)
                  }}
                  onStopNotebookSession={(file) => {
                    return onStopAnalysisNotebookSession(file)
                  }}
                  onRunNotebookCell={(file, document, cellId) => {
                    void onRunAnalysisNotebookCell(file, document, cellId)
                  }}
                  onStopNotebookCell={(file, cellId) => {
                    void onStopAnalysisNotebookCell(file, cellId)
                  }}
                  onCompleteNotebookCell={onCompleteAnalysisNotebookCell}
                  onFormatNotebookCell={onFormatAnalysisNotebookCell}
                  onGenerateNotebookCode={onGenerateAnalysisNotebookCode}
                  onNotebookCodeGenerationProgress={
                    rendererApi.onAnalysisNotebookCodeGenerationProgress
                  }
                  notebookAiModelOptions={availableModels}
                  notebookAiDefaultModel={notebookAiDefaultModel}
                  onPickNotebookContextFiles={onPickInputFiles}
                  onInitializeProjectAnalysis={(cwd) => {
                    void onInitializeProjectAnalysis(cwd)
                  }}
                  onOpenNotebook={(path) => {
                    void onOpenAnalysisNotebook(path)
                  }}
                  onCloseNotebook={() => {
                    closeActiveNotebook()
                    navigateToView(workspaceSidebarMode === 'projects' ? 'projects' : 'chat')
                  }}
                  onSaveNotebook={(file, document) => {
                    void onSaveAnalysisNotebook(file, document)
                  }}
                  onCreateNotebook={(cwd) => {
                    void onCreateAnalysisNotebook(cwd)
                  }}
                  onDeleteNotebook={(file) => {
                    void onDeleteAnalysisNotebook(file)
                  }}
                />
              ) : (
                <>
                  {showProjectSessionPlaceholder ? (
                    <Box
                      sx={{
                        flex: 1,
                        minWidth: 0,
                        minHeight: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        px: 3
                      }}
                    >
                      <Box
                        sx={{
                          width: 'min(420px, 100%)',
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          gap: 2,
                          textAlign: 'center'
                        }}
                      >
                        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                          选择项目会话
                        </Typography>
                        <Button variant="outlined" onClick={startPlaceholderProjectSession}>
                          {projects.length > 0 ? '新建项目对话' : '新建项目'}
                        </Button>
                      </Box>
                    </Box>
                  ) : (
                    activeChatView
                  )}
                  {!showProjectSessionPlaceholder && filePreview ? (
                    <FilePreviewPanel
                      state={filePreview}
                      onOpenFile={onOpenFilePreview}
                      onOpenDefaultPath={onOpenDefaultPreviewPath}
                      onRevealPath={onRevealPreviewPath}
                      onListDirectory={onListPreviewDirectory}
                    />
                  ) : null}
                </>
              )}
            </Box>
          </Box>
        ) : activeView === 'runtime' ? (
          <RuntimeView
            projectCwd={activeProject?.workingDirectory ?? ''}
            projectName={activeProject?.name}
            runtimeStatus={analysisJupyterRuntimeStatus}
            isLoading={isLoadingAnalysisJupyterRuntime || isStartingAnalysisJupyter}
            closingNotebookPath={closingRuntimeNotebookPath}
            error={analysisJupyterRuntimeError ?? analysisJupyterError}
            onRefresh={() => {
              void refreshAnalysisJupyterRuntimeStatus()
            }}
            onStartJupyter={(cwd) => {
              void onStartAnalysisJupyter(cwd).then(() => refreshAnalysisJupyterRuntimeStatus())
            }}
            onStopJupyter={(cwd) => {
              void onStopAnalysisJupyter(cwd).then(() => refreshAnalysisJupyterRuntimeStatus())
            }}
            onOpenNotebook={onOpenNotebookWorkspaceFile}
            onStopNotebookKernel={(notebookPath) => {
              void onStopRuntimeNotebookSession(notebookPath)
            }}
          />
        ) : activeView === 'plugins' ? (
          <PluginView
            plugins={plugins}
            isLoading={isLoadingPlugins}
            activePluginId={activePluginId}
            busySource={busyPluginSource}
            operationError={pluginOperationError}
            sidebarWidth={sidebarWidth}
            onSelectPlugin={setActivePluginId}
            onInstall={(source) => {
              void onInstallPlugin(source)
            }}
            onRemove={(source) => {
              void onRemovePlugin(source)
            }}
            onRefresh={() => {
              void refreshPlugins()
            }}
            onStartSidebarResize={onStartSidebarResize}
          />
        ) : activeView === 'skills' ? (
          <SkillView
            skills={skills}
            isLoading={isLoadingSkills}
            activeSkillId={activeSkillId}
            sidebarWidth={sidebarWidth}
            onSelectSkill={setActiveSkillId}
            onStartSidebarResize={onStartSidebarResize}
          />
        ) : activeView === 'mcp' ? (
          <McpView
            servers={mcpServers}
            activeServerId={activeMcpServerId}
            sidebarWidth={sidebarWidth}
            onSelectServer={setActiveMcpServerId}
            onStartSidebarResize={onStartSidebarResize}
          />
        ) : activeView === 'wrappers' ? (
          <WrapperView
            sidebarWidth={sidebarWidth}
            onOpenLocalPath={onOpenLocalPath}
            onStartSidebarResize={onStartSidebarResize}
          />
        ) : (
          <Box component="main" sx={{ flex: 1, minWidth: 0, height: '100vh' }} />
        )}

        <AppDialogs
          rendererApi={rendererApi}
          isSettingsOpen={isSettingsOpen}
          setIsSettingsOpen={setIsSettingsOpen}
          settingsCategory={settingsCategory}
          setSettingsCategory={setSettingsCategory}
          providerStatuses={providerStatuses}
          providerHints={providerHints}
          personaMarkdown={personaMarkdown}
          onSavePersonaMarkdown={onSavePersonaMarkdown}
          refreshAuthStatuses={refreshAuthStatuses}
          openProviderDialog={openProviderDialog}
          logoutProvider={logoutProvider}
          projects={projects}
          availableModels={availableModels}
          pendingApproval={pendingApproval}
          updatingPermissionProjectId={updatingPermissionProjectId}
          onUpdateProjectPermissionMode={onUpdateProjectPermissionMode}
          onUpdateProjectDefaults={onUpdateProjectDefaults}
          updatingRemoteProjectId={updatingRemoteProjectId}
          onUpdateProjectRemoteConnection={onUpdateProjectRemoteConnection}
          onUpdateProjectRemoteDefaults={onUpdateProjectRemoteDefaults}
          onOpenApprovalSession={onOpenApprovalSession}
          onRespondToolApproval={onRespondToolApproval}
          themeMode={themeMode}
          setThemeMode={setThemeMode}
          showOnboarding={showOnboarding}
          onCompleteOnboarding={onCompleteOnboarding}
          onSkipOnboarding={onSkipOnboarding}
          isProviderDialogOpen={isProviderDialogOpen}
          providerDialogProviderId={providerDialogProviderId}
          selectedPrompts={selectedPrompts}
          isBusy={isBusy}
          closeProviderDialog={closeProviderDialog}
          setProviderDialogProviderId={setProviderDialogProviderId}
          submitProviderApiKey={submitProviderApiKey}
          submitProviderOAuth={submitProviderOAuth}
          onSubmitAuthPrompt={onSubmitAuthPrompt}
          onUpdatePromptValue={onUpdatePromptValue}
          isNewProjectDialogOpen={isNewProjectDialogOpen}
          setIsNewProjectDialogOpen={setIsNewProjectDialogOpen}
          onCreateProject={onCreateProject}
          snackbarNotice={snackbarNotice}
          setSnackbarNotice={setSnackbarNotice}
          isChatWorkspaceView={isChatWorkspaceView}
          isSidebarOpen={isSidebarOpen}
          activityBarWidth={activityBarWidth}
          sidebarWidth={sidebarWidth}
          macTitlebarHeight={macTitlebarHeight}
        />
      </Box>
    </ThemeProvider>
  )
}

export default App
