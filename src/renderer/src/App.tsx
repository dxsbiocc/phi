import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import {
  Alert,
  Box,
  Button,
  CssBaseline,
  IconButton,
  Paper,
  Popover,
  Popper,
  Snackbar,
  ThemeProvider,
  Tooltip,
  Typography
} from '@mui/material'
import { alpha } from '@mui/material/styles'
import { FiMaximize2, FiMinimize2, FiMinus } from 'react-icons/fi'
import { TbLayoutSidebarRight } from 'react-icons/tb'
import ChatView from './components/ChatView'
import type { LocalPathKind } from './components/MarkdownContent'
import SessionSidebar from './components/SessionSidebar'
import PluginView from './features/plugin/PluginView'
import { usePluginCatalog } from './features/plugin/hooks/usePluginCatalog'
import WrapperView from './features/wrapper/WrapperView'
import SkillView from './features/skill/SkillView'
import { useSkillCatalog } from './features/skill/hooks/useSkillCatalog'
import McpView from './features/mcp/McpView'
import { useMcpServerCatalog } from './features/mcp/hooks/useMcpServerCatalog'
import SettingsDialog, { type SettingsCategory } from './components/SettingsDialog'
import AddProviderDialog from './components/AddProviderDialog'
import OnboardingDialog from './components/OnboardingDialog'
import NewProjectDialog from './components/NewProjectDialog'
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
import { agentEventBelongsToActiveSession } from './lib/agentEventRouting'
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
  sessionRuntimeStateFrom,
  sessionRuntimeStateIsBusy,
  sessionStatusIsBusy
} from './lib/sessionRuntimeState'
import { createAgentEventReducerState, reduceAgentEventState } from './lib/agentEventReducer'
import { navigationPaneWidth } from './layout'
import type { AgentEventSummary, PermissionMode, Project, SessionSummary } from './types'

export type AppView =
  'chat' | 'projects' | 'analysis' | 'runtime' | 'plugins' | 'skills' | 'mcp' | 'wrappers'
type SnackbarNotice = {
  id: number
  severity: 'error' | 'info' | 'success' | 'warning'
  message: string
}

const activityBarWidth = 48
const macTitlebarHeight = 44
const macContentTopGap = 8
const minNavigationPaneWidth = 240
const maxNavigationPaneWidth = 520
const isMac = typeof window !== 'undefined' && window.platform === 'darwin'
const NavChatIcon = PhiIcons.nav.chat
const NavProjectsIcon = PhiIcons.nav.projects
const NavRuntimeIcon = PhiIcons.nav.runtime
const NavPluginsIcon = PhiIcons.nav.plugins
const NavSkillsIcon = PhiIcons.nav.skills
const NavMcpIcon = PhiIcons.nav.mcp
const NavWrappersIcon = PhiIcons.nav.wrappers
const NavSettingsIcon = PhiIcons.nav.settings

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

function WorkspaceSidebarNavButton({
  mode,
  label,
  icon: Icon,
  active,
  useContentPreview,
  onPreviewOpen,
  onPreviewClose,
  onClick
}: {
  mode: WorkspaceSidebarMode
  label: string
  icon: typeof NavChatIcon
  active: boolean
  useContentPreview: boolean
  onPreviewOpen: (mode: WorkspaceSidebarMode, anchorEl: HTMLElement) => void
  onPreviewClose: () => void
  onClick: () => void
}): React.JSX.Element {
  const button = (
    <IconButton
      size="small"
      aria-label={label}
      color={active ? 'primary' : 'default'}
      onMouseEnter={(event) => {
        if (useContentPreview) onPreviewOpen(mode, event.currentTarget)
      }}
      onMouseLeave={useContentPreview ? onPreviewClose : undefined}
      onFocus={(event) => {
        if (useContentPreview) onPreviewOpen(mode, event.currentTarget)
      }}
      onBlur={useContentPreview ? onPreviewClose : undefined}
      onClick={onClick}
    >
      <Icon fontSize="small" />
    </IconButton>
  )

  return useContentPreview ? (
    button
  ) : (
    <Tooltip title={label} placement="right">
      {button}
    </Tooltip>
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
  const [activeView, setActiveView] = useState<AppView>('chat')
  const [workspaceSidebarMode, setWorkspaceSidebarMode] =
    useState<WorkspaceSidebarMode>('conversations')
  const [workspaceSidebarPreview, setWorkspaceSidebarPreview] = useState<{
    mode: WorkspaceSidebarMode
    anchorEl: HTMLElement
  } | null>(null)
  const workspaceSidebarPreviewCloseTimer = useRef<number | null>(null)
  const [analysisSessionSelectorAnchor, setAnalysisSessionSelectorAnchor] =
    useState<HTMLElement | null>(null)
  const [isNewProjectDialogOpen, setIsNewProjectDialogOpen] = useState(false)
  const [isBusy, setIsBusy] = useState(false)
  const [isSendingMessage, setIsSendingMessage] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [personaMarkdown, setPersonaMarkdownState] = useState<string | null>(null)
  const [snackbarNotice, setSnackbarNotice] = useState<SnackbarNotice | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
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
    setActiveView
  })

  const onNavigateToNotebookView = useCallback((): void => {
    setFilePreview(null)
    setActiveView('analysis')
  }, [setFilePreview])

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
    onGenerateAnalysisNotebookCode,
    closeActiveNotebook,
    resetAnalysisJupyterRuntimeForCwdChange,
    handleNotebookDraftChanged
  } = useAnalysisNotebookRuntime({
    rendererApi,
    getActiveCwd,
    projectsRef,
    showSnackbar,
    onNavigateToNotebookView
  })

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
        const acknowledged = await rendererApi.acknowledgeSession(path)
        if (!acknowledged) return
        const nextRuntimeState = sessionRuntimeStateFrom(acknowledged)
        const stateKey = sessionStateKey({
          phiSessionId: acknowledged.phiSessionId,
          path: acknowledged.path,
          cwd: useSessionStore.getState().activeCwd,
          sessionGeneration: useSessionStore.getState().activeSessionGeneration
        })
        storeSessionRuntimeState(stateKey, nextRuntimeState)
        if (stateKey === useSessionStore.getState().activeAgentEventStateKey) {
          setActiveSessionRuntimeState(nextRuntimeState)
        }
        setSessions((prev) =>
          prev.map((session) =>
            session.path === acknowledged.path ? { ...session, ...nextRuntimeState } : session
          )
        )
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
      applyCurrentSession,
      onResetSending,
      refreshCurrentModelControls,
      refreshSessions,
      rendererApi,
      replaceMessages,
      resetAnalysisJupyterRuntimeForCwdChange,
      setActiveSessionRuntimeState,
      setAgentEventState,
      setIsSessionChanging,
      setSessions,
      storeSessionRuntimeState
    ]
  )

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
      setActiveView('analysis')
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
      filePreviewRequestRef,
      onOpenAnalysisNotebook,
      refreshAnalysisJupyterStatus,
      refreshAnalysisKernels,
      refreshAnalysisNotebooks,
      setActiveWorkspaceFilePath,
      setFilePreview,
      setWorkspaceFileTabs
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
    setActiveView('chat')
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

  const setMessagesContainerNode = useCallback((node: HTMLDivElement | null): void => {
    listRef.current = node
  }, [])

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
        setActiveView('chat')
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
    onNewChat
  ])

  useEffect(() => {
    const unsubscribe = rendererApi.onAgentEvent((event: AgentEventSummary) => {
      if (event.sessionPath) {
        scheduleSessionRefresh()
      }

      const belongsToActiveSession = agentEventBelongsToActiveSession(event, {
        phiSessionId: useSessionStore.getState().activePhiSessionId,
        path: useSessionStore.getState().activeSessionPath,
        cwd: useSessionStore.getState().activeCwd,
        sessionGeneration: useSessionStore.getState().activeSessionGeneration
      })
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
          useSessionStore.setState({ activeAgentEventStateKey: eventStateKey })
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
      unsubscribeSessionChanged()
      cancelScheduledSessionRefresh()
    }
  }, [
    activeView,
    applyCurrentSession,
    cancelScheduledSessionRefresh,
    handleAuthInteractionEvent,
    handleNotebookDraftChanged,
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

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [messages])

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
  const activeFilePreviewState =
    activeWorkspaceFileTab && activeWorkspaceFileTab.kind !== 'notebook'
      ? filePreview && filePreviewStatePath(filePreview) === activeWorkspaceFileTab.path
        ? filePreview
        : activeWorkspaceFileTab.pathKind === 'directory'
          ? ({
              status: 'loading',
              path: activeWorkspaceFileTab.path,
              pathKind: 'directory'
            } satisfies FilePreviewPanelState)
          : ({
              status: 'loading',
              path: activeWorkspaceFileTab.path
            } satisfies FilePreviewPanelState)
      : null

  const onSelectWorkspaceFileTab = useCallback(
    (tabLike: AnalysisWorkspaceFileTab): void => {
      const tab = workspaceFileTabs.find((item) => item.path === tabLike.path)
      if (!tab) return
      setActiveWorkspaceFilePath(tab.path)
      setActiveView('analysis')
      if (tab.kind === 'notebook') {
        onOpenNotebookWorkspaceFile(tab.path)
        return
      }
      loadFilePreview(tab.path, tab.pathKind)
    },
    [loadFilePreview, onOpenNotebookWorkspaceFile, setActiveWorkspaceFilePath, workspaceFileTabs]
  )

  const onCloseWorkspaceFileTab = useCallback(
    (tabLike: AnalysisWorkspaceFileTab): void => {
      const closingTab = workspaceFileTabs.find((tab) => tab.path === tabLike.path)
      if (!closingTab) return
      const remainingTabs = workspaceFileTabs.filter((tab) => tab.path !== closingTab.path)
      setWorkspaceFileTabs(remainingTabs)

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
        setActiveView(workspaceSidebarMode === 'projects' ? 'projects' : 'chat')
        return
      }

      setActiveWorkspaceFilePath(nextTab.path)
      if (nextTab.kind === 'notebook') {
        onOpenNotebookWorkspaceFile(nextTab.path)
      } else {
        setActiveAnalysisNotebook(null)
        loadFilePreview(nextTab.path, nextTab.pathKind)
      }
    },
    [
      activeWorkspaceFilePath,
      closeActiveNotebook,
      filePreview,
      filePreviewRequestRef,
      loadFilePreview,
      onOpenNotebookWorkspaceFile,
      setActiveAnalysisNotebook,
      setActiveWorkspaceFilePath,
      setFilePreview,
      setWorkspaceFileTabs,
      workspaceFileTabs,
      workspaceSidebarMode
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
      setActiveView(view)
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
      workspaceSidebarMode
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

  const activeChatView = (
    <ChatView
      messages={messages}
      input={input}
      messagesContainerRef={setMessagesContainerNode}
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
      onChatSubmit={onChatSubmit}
      onStopGeneration={onStopGeneration}
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
          <Box
            sx={{
              position: 'absolute',
              top: '14px',
              left: '14px',
              display: 'flex',
              gap: '8px',
              zIndex: 20,
              WebkitAppRegion: 'no-drag',
              '&:hover .window-control-symbol': {
                opacity: 1
              }
            }}
          >
            {[
              {
                label: '关闭',
                color: '#FF5F57',
                borderColor: '#E24640',
                symbol: '×',
                action: () => rendererApi.closeWindow()
              },
              {
                label: '最小化',
                color: '#FFBD2E',
                borderColor: '#DFA123',
                symbol: '−',
                action: () => rendererApi.minimizeWindow()
              },
              {
                label: '全屏',
                color: '#28C840',
                borderColor: '#20A935',
                symbol: '+',
                action: () => rendererApi.toggleWindowFullscreen()
              }
            ].map((control) => (
              <Box
                key={control.label}
                component="button"
                type="button"
                aria-label={control.label}
                onClick={() => {
                  void control.action()
                }}
                sx={{
                  width: 12,
                  height: 12,
                  p: 0,
                  border: '1px solid',
                  borderColor: control.borderColor,
                  borderRadius: '50%',
                  backgroundColor: control.color,
                  cursor: 'default',
                  WebkitAppRegion: 'no-drag',
                  position: 'relative',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'rgba(45, 45, 45, 0.72)',
                  fontSize: 10,
                  lineHeight: 1,
                  fontWeight: 700,
                  '&:hover': {
                    filter: 'brightness(0.96)'
                  }
                }}
              >
                <Box
                  component="span"
                  className="window-control-symbol"
                  aria-hidden
                  sx={{
                    opacity: 0,
                    transform: 'translateY(-0.5px)',
                    transition: 'opacity 120ms ease',
                    pointerEvents: 'none'
                  }}
                >
                  {control.symbol}
                </Box>
              </Box>
            ))}
          </Box>
        )}
        <Box
          className="app-activity-bar"
          sx={{
            width: activityBarWidth,
            height: '100vh',
            flexShrink: 0,
            position: 'relative',
            zIndex: 1,
            pt: isMac ? `${macTitlebarHeight + macContentTopGap}px` : 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 0.5,
            backgroundColor: (muiTheme) =>
              muiTheme.palette.mode === 'dark' ? muiTheme.palette.background.default : '#FFFFFF',
            '& > *': {
              position: 'relative',
              zIndex: 8
            }
          }}
        >
          <WorkspaceSidebarNavButton
            mode="conversations"
            label="对话"
            icon={NavChatIcon}
            active={isWorkspaceSidebarModeExpanded('conversations')}
            useContentPreview={shouldUseWorkspaceSidebarPreview('conversations')}
            onPreviewOpen={openWorkspaceSidebarPreview}
            onPreviewClose={scheduleWorkspaceSidebarPreviewClose}
            onClick={() => onSelectWorkspaceView('chat')}
          />
          <WorkspaceSidebarNavButton
            mode="projects"
            label="项目"
            icon={NavProjectsIcon}
            active={isWorkspaceSidebarModeExpanded('projects')}
            useContentPreview={shouldUseWorkspaceSidebarPreview('projects')}
            onPreviewOpen={openWorkspaceSidebarPreview}
            onPreviewClose={scheduleWorkspaceSidebarPreviewClose}
            onClick={() => onSelectWorkspaceView('projects')}
          />
          <Tooltip title="运行时" placement="right">
            <IconButton
              size="small"
              color={activeView === 'runtime' ? 'primary' : 'default'}
              onClick={() => {
                setActiveView('runtime')
                void refreshAnalysisJupyterRuntimeStatus()
              }}
            >
              <NavRuntimeIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="插件" placement="right">
            <IconButton
              size="small"
              color={activeView === 'plugins' ? 'primary' : 'default'}
              onClick={() => {
                setActiveView('plugins')
                void refreshPlugins()
              }}
            >
              <NavPluginsIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="技能" placement="right">
            <IconButton
              size="small"
              color={activeView === 'skills' ? 'primary' : 'default'}
              onClick={() => {
                setActiveView('skills')
                void refreshSkills()
              }}
            >
              <NavSkillsIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="MCP" placement="right">
            <IconButton
              size="small"
              color={activeView === 'mcp' ? 'primary' : 'default'}
              onClick={() => {
                setActiveView('mcp')
                void refreshMcpServers()
              }}
            >
              <NavMcpIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Wrappers" placement="right">
            <IconButton
              size="small"
              color={activeView === 'wrappers' ? 'primary' : 'default'}
              onClick={() => setActiveView('wrappers')}
            >
              <NavWrappersIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Box sx={{ flex: 1 }} />
          <Tooltip title="设置" placement="right">
            <IconButton size="small" onClick={() => setIsSettingsOpen(true)} sx={{ mb: 1 }}>
              <NavSettingsIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>

        <Popper
          open={isWorkspaceSidebarPreviewOpen}
          anchorEl={visibleWorkspaceSidebarPreview?.anchorEl ?? null}
          placement="right-start"
          modifiers={[
            {
              name: 'offset',
              options: { offset: [0, 6] }
            },
            {
              name: 'preventOverflow',
              options: { padding: 8 }
            }
          ]}
          sx={{ zIndex: (muiTheme) => muiTheme.zIndex.tooltip }}
        >
          <Paper
            data-phi-workspace-sidebar-hover-preview={workspaceSidebarPreviewMode}
            elevation={8}
            onMouseEnter={clearWorkspaceSidebarPreviewCloseTimer}
            onMouseLeave={scheduleWorkspaceSidebarPreviewClose}
            onFocus={clearWorkspaceSidebarPreviewCloseTimer}
            onBlur={scheduleWorkspaceSidebarPreviewClose}
            sx={{
              width: workspaceSidebarPreviewWidth,
              maxHeight: 'min(420px, calc(100vh - 96px))',
              mt: isMac ? -0.5 : 0.5,
              overflow: 'hidden',
              borderRadius: 2,
              border: 1,
              borderColor: 'divider',
              bgcolor: 'background.default',
              boxShadow: (muiTheme) =>
                muiTheme.palette.mode === 'dark'
                  ? '0 18px 46px rgba(0, 0, 0, 0.48)'
                  : '0 18px 46px rgba(12, 26, 32, 0.18)'
            }}
          >
            <SessionSidebar
              hideWindowDragSpacer
              compactHoverPreview
              mode={workspaceSidebarPreviewMode}
              sessions={sessions}
              activeSessionPath={activeSessionPath}
              activeCwd={activeCwd}
              projects={projects}
              projectSessionRefreshKey={projectSessionRefreshKey}
              onNewChat={() => {
                closeWorkspaceSidebarPreview()
                void onNewChat()
              }}
              onNewProject={() => {
                closeWorkspaceSidebarPreview()
                setIsNewProjectDialogOpen(true)
              }}
              onSelectSession={(path) => {
                closeWorkspaceSidebarPreview()
                void onSelectSession(path)
              }}
              onRenameSession={(path, name) => {
                void onRenameSession(path, name)
              }}
              onDeleteSession={(path) => {
                void onDeleteSession(path)
              }}
              onStartProjectChat={(project) => {
                closeWorkspaceSidebarPreview()
                void onStartProjectChat(project)
              }}
              onDeleteProject={(project) => {
                void onDeleteProjectEntry(project)
              }}
              onFetchProjectSessions={onFetchProjectSessions}
              getSessionRuntimeState={getSessionRuntimeState}
            />
          </Paper>
        </Popper>

        {isChatWorkspaceView && isSidebarOpen && (
          <Box
            className="app-sidebar-shell"
            sx={{
              width: sidebarWidth,
              flexShrink: 0,
              position: 'relative',
              zIndex: 1,
              backgroundColor: (muiTheme) =>
                muiTheme.palette.mode === 'dark' ? muiTheme.palette.background.default : '#FFFFFF',
              '& > *': {
                position: 'relative',
                zIndex: 8
              }
            }}
          >
            {activeView === 'analysis' ? (
              <Box
                data-phi-analysis-sidebar="true"
                sx={{
                  height: '100%',
                  minHeight: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden'
                }}
              >
                <Box
                  sx={{
                    flexShrink: 0,
                    minHeight: isMac ? macTitlebarHeight : 0,
                    WebkitAppRegion: 'drag'
                  }}
                />
                <Box
                  data-phi-analysis-session-selector="true"
                  sx={{
                    px: 1.5,
                    pb: 1,
                    flexShrink: 0
                  }}
                >
                  <Button
                    fullWidth
                    variant="outlined"
                    aria-haspopup="menu"
                    aria-expanded={analysisSessionSelectorAnchor ? 'true' : undefined}
                    data-phi-analysis-session-select-button="true"
                    onClick={(event) => setAnalysisSessionSelectorAnchor(event.currentTarget)}
                    sx={{
                      minHeight: 48,
                      justifyContent: 'space-between',
                      gap: 1,
                      borderRadius: 2,
                      px: 1.25,
                      py: 0.75,
                      fontWeight: 700,
                      textTransform: 'none',
                      color: 'text.primary',
                      borderColor: activeWorkspaceIsProject ? 'primary.light' : 'divider',
                      bgcolor: (theme) =>
                        theme.palette.mode === 'dark'
                          ? 'rgba(255, 255, 255, 0.035)'
                          : 'rgba(255, 255, 255, 0.92)',
                      boxShadow: (theme) =>
                        theme.palette.mode === 'dark'
                          ? '0 10px 28px rgba(0, 0, 0, 0.22)'
                          : '0 12px 34px rgba(24, 74, 86, 0.10)',
                      '&:hover': {
                        borderColor: 'primary.main',
                        bgcolor: (theme) =>
                          theme.palette.mode === 'dark'
                            ? 'rgba(255, 255, 255, 0.055)'
                            : 'rgba(248, 253, 255, 0.98)',
                        boxShadow: (theme) =>
                          theme.palette.mode === 'dark'
                            ? '0 12px 30px rgba(0, 0, 0, 0.28)'
                            : '0 14px 36px rgba(24, 74, 86, 0.14)'
                      }
                    }}
                  >
                    <Box
                      component="span"
                      sx={{
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        textAlign: 'left',
                        fontSize: '0.92rem'
                      }}
                    >
                      {activeWorkspaceTitle}
                    </Box>
                    <Box
                      component="span"
                      data-phi-analysis-session-scope-label={
                        activeWorkspaceIsProject ? 'project' : 'ordinary'
                      }
                      title={activeWorkspaceScopeLabel}
                      sx={{
                        flexShrink: 0,
                        maxWidth: 132,
                        minWidth: 52,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        borderRadius: 999,
                        px: 1,
                        py: 0.35,
                        textAlign: 'center',
                        color: activeWorkspaceIsProject ? 'primary.dark' : 'text.secondary',
                        bgcolor: activeWorkspaceIsProject
                          ? 'rgba(46, 159, 179, 0.12)'
                          : 'action.selected',
                        border: 1,
                        borderColor: activeWorkspaceIsProject ? 'primary.light' : 'divider',
                        fontSize: '0.76rem',
                        fontWeight: 800,
                        lineHeight: 1.35
                      }}
                    >
                      {activeWorkspaceScopeLabel}
                    </Box>
                  </Button>
                  <Popover
                    open={Boolean(analysisSessionSelectorAnchor)}
                    anchorEl={analysisSessionSelectorAnchor}
                    onClose={() => setAnalysisSessionSelectorAnchor(null)}
                    anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
                    transformOrigin={{ vertical: 'top', horizontal: 'left' }}
                    slotProps={{
                      paper: {
                        sx: {
                          mt: 0.75,
                          width: Math.max(280, sidebarWidth - 24),
                          height: 'min(360px, calc(100vh - 132px))',
                          overflow: 'hidden',
                          borderRadius: 2,
                          border: 1,
                          borderColor: 'divider',
                          boxShadow: '0 18px 45px rgba(12, 26, 32, 0.18)'
                        }
                      }
                    }}
                  >
                    <Box
                      data-phi-analysis-session-select-menu="true"
                      sx={{ width: '100%', height: '100%', display: 'flex', minHeight: 0 }}
                    >
                      <SessionSidebar
                        hideWindowDragSpacer
                        mode={workspaceSidebarMode}
                        sessions={sessions}
                        activeSessionPath={activeSessionPath}
                        activeCwd={activeCwd}
                        projects={projects}
                        projectSessionRefreshKey={projectSessionRefreshKey}
                        onNewChat={() => {
                          setAnalysisSessionSelectorAnchor(null)
                          void onNewChat()
                        }}
                        onNewProject={() => setIsNewProjectDialogOpen(true)}
                        onSelectSession={(path) => {
                          setAnalysisSessionSelectorAnchor(null)
                          void onSelectSession(path)
                        }}
                        onRenameSession={(path, name) => {
                          void onRenameSession(path, name)
                        }}
                        onDeleteSession={(path) => {
                          void onDeleteSession(path)
                        }}
                        onStartProjectChat={(project) => {
                          setAnalysisSessionSelectorAnchor(null)
                          void onStartProjectChat(project)
                        }}
                        onDeleteProject={(project) => {
                          void onDeleteProjectEntry(project)
                        }}
                        onFetchProjectSessions={onFetchProjectSessions}
                        getSessionRuntimeState={getSessionRuntimeState}
                      />
                    </Box>
                  </Popover>
                </Box>
                <Box sx={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
                  <Box
                    data-phi-analysis-chat-panel="true"
                    sx={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}
                  >
                    {activeChatView}
                  </Box>
                </Box>
              </Box>
            ) : (
              <SessionSidebar
                mode={workspaceSidebarMode}
                sessions={sessions}
                activeSessionPath={activeSessionPath}
                activeCwd={activeCwd}
                projects={projects}
                projectSessionRefreshKey={projectSessionRefreshKey}
                onNewChat={() => {
                  void onNewChat()
                }}
                onNewProject={() => setIsNewProjectDialogOpen(true)}
                onSelectSession={(path) => {
                  void onSelectSession(path)
                }}
                onRenameSession={(path, name) => {
                  void onRenameSession(path, name)
                }}
                onDeleteSession={(path) => {
                  void onDeleteSession(path)
                }}
                onStartProjectChat={(project) => {
                  void onStartProjectChat(project)
                }}
                onDeleteProject={(project) => {
                  void onDeleteProjectEntry(project)
                }}
                onFetchProjectSessions={onFetchProjectSessions}
                getSessionRuntimeState={getSessionRuntimeState}
              />
            )}
          </Box>
        )}

        {isChatWorkspaceView && isSidebarOpen && (
          <Box
            role="separator"
            aria-orientation="vertical"
            aria-label="调整侧边栏宽度"
            onMouseDown={onStartSidebarResize}
            sx={{
              width: '1px',
              flexShrink: 0,
              position: 'relative',
              cursor: 'col-resize',
              bgcolor: (muiTheme) =>
                muiTheme.palette.mode === 'dark'
                  ? 'rgba(241, 246, 246, 0.18)'
                  : 'rgba(15, 42, 48, 0.18)',
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
        )}

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
                  onGenerateNotebookCode={onGenerateAnalysisNotebookCode}
                  onPickNotebookContextFiles={onPickInputFiles}
                  onInitializeProjectAnalysis={(cwd) => {
                    void onInitializeProjectAnalysis(cwd)
                  }}
                  onOpenNotebook={(path) => {
                    void onOpenAnalysisNotebook(path)
                  }}
                  onCloseNotebook={() => {
                    closeActiveNotebook()
                    setActiveView(workspaceSidebarMode === 'projects' ? 'projects' : 'chat')
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

        <SettingsDialog
          open={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          category={settingsCategory}
          onCategoryChange={setSettingsCategory}
          providers={providerStatuses}
          providerHints={providerHints}
          personaMarkdown={personaMarkdown}
          onSavePersonaMarkdown={onSavePersonaMarkdown}
          onRefresh={refreshAuthStatuses}
          onOpenAddProvider={() => {
            openProviderDialog(null)
          }}
          onLogout={logoutProvider}
          projects={projects}
          models={availableModels}
          pendingApproval={pendingApproval}
          updatingProjectId={updatingPermissionProjectId}
          onUpdateProjectPermissionMode={(projectId, permissionMode) => {
            void onUpdateProjectPermissionMode(projectId, permissionMode)
          }}
          onUpdateProjectDefaults={(projectId, defaults) => {
            void onUpdateProjectDefaults(projectId, defaults)
          }}
          updatingRemoteProjectId={updatingRemoteProjectId}
          onUpdateProjectRemoteConnection={onUpdateProjectRemoteConnection}
          onUpdateProjectRemoteDefaults={onUpdateProjectRemoteDefaults}
          onOpenApprovalSession={onOpenApprovalSession}
          onRespondApproval={onRespondToolApproval}
          onCopyDiagnostics={() => rendererApi.copyDiagnostics()}
          themeMode={themeMode}
          onSelectThemeMode={setThemeMode}
        />

        <OnboardingDialog
          open={showOnboarding}
          onComplete={onCompleteOnboarding}
          onSkip={onSkipOnboarding}
        />

        <AddProviderDialog
          open={isProviderDialogOpen}
          providers={providerStatuses}
          initialProviderId={providerDialogProviderId}
          activePrompts={selectedPrompts}
          providerHint={providerDialogProviderId ? providerHints[providerDialogProviderId] : ''}
          isProcessing={isBusy}
          onClose={closeProviderDialog}
          onSelectProvider={(provider) => {
            setProviderDialogProviderId(provider.providerId)
          }}
          onBackToList={() => {
            setProviderDialogProviderId(null)
          }}
          onSubmitApiKey={submitProviderApiKey}
          onStartOAuth={submitProviderOAuth}
          onSubmitPrompt={onSubmitAuthPrompt}
          onUpdatePromptValue={onUpdatePromptValue}
        />

        <NewProjectDialog
          open={isNewProjectDialogOpen}
          onClose={() => setIsNewProjectDialogOpen(false)}
          onPickDirectory={() => rendererApi.pickProjectDirectory()}
          onCreate={onCreateProject}
        />

        <Snackbar
          key={snackbarNotice?.id}
          open={Boolean(snackbarNotice)}
          autoHideDuration={6000}
          onClose={(_, reason) => {
            if (reason === 'clickaway') return
            setSnackbarNotice(null)
          }}
          anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
          sx={{
            top: isChatWorkspaceView ? `${macTitlebarHeight + 12}px` : 16,
            left: isChatWorkspaceView
              ? `${activityBarWidth + (isSidebarOpen ? sidebarWidth + 1 : 0)}px`
              : 0,
            right: 0,
            transform: 'none',
            justifyContent: 'center',
            pointerEvents: 'none',
            '& .MuiAlert-root': {
              pointerEvents: 'auto'
            }
          }}
        >
          <Alert
            severity={snackbarNotice?.severity ?? 'error'}
            variant="filled"
            onClose={() => setSnackbarNotice(null)}
            sx={{ maxWidth: 720, alignItems: 'center' }}
          >
            {snackbarNotice?.message}
          </Alert>
        </Snackbar>
      </Box>
    </ThemeProvider>
  )
}

export default App
