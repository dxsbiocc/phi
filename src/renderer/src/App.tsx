import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import {
  Box,
  Button,
  CssBaseline,
  IconButton,
  Stack,
  ThemeProvider,
  Tooltip,
  Typography
} from '@mui/material'
import { alpha } from '@mui/material/styles'
import { GoSidebarCollapse, GoSidebarExpand, GoSync } from 'react-icons/go'
import {
  DEFAULT_DB_CONNECTOR_TOOLS_ENABLED,
  DEFAULT_NEXT_ACTION_SUGGESTIONS_ENABLED,
  DEFAULT_PREVENT_SLEEP_DURING_RUNS,
  DEFAULT_PROXY_TRANSPORT_STATUS
} from '../../shared/appSettingsTypes'
import type { WrapperCompositionManifest } from '../../shared/wrapperCompositionManifestTypes'
import ChatView from './components/ChatView'
import MacWindowControls from './components/MacWindowControls'
import WindowNavigationControls from './components/WindowNavigationControls'
import type { LocalPathKind } from './components/MarkdownContent'
import { PluginDetail } from './features/plugin/PluginView'
import { usePluginCatalog } from './features/plugin/hooks/usePluginCatalog'
import { WrapperDetail } from './features/wrapper/WrapperView'
import { useWrapperCatalog } from './features/wrapper/hooks/useWrapperCatalog'
import { SkillDetail } from './features/skill/SkillView'
import { useSkillCatalog } from './features/skill/hooks/useSkillCatalog'
import { McpDetail } from './features/mcp/McpView'
import { useMcpServerCatalog } from './features/mcp/hooks/useMcpServerCatalog'
import { type SettingsCategory } from './components/SettingsDialog'
import AppDialogs, { type SnackbarNotice } from './AppDialogs'
import AppActivityBar from './AppActivityBar'
import AppWorkspaceSidebar from './AppWorkspaceSidebar'
import FilePreviewPanel, {
  FilePreviewTitleTab,
  type FilePreviewPanelState
} from './features/file-preview/FilePreviewPanel'
import AnalysisView, { type AnalysisWorkspaceFileTab } from './features/analysis/AnalysisView'
import { WorkspaceSidePanel } from './components/WorkspaceSidePanel'
import { useAnalysisNotebookRuntime } from './features/analysis/hooks/useAnalysisNotebookRuntime'
import { WorkspaceResourceTabs } from './components/WorkspaceResourceTabs'
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
  sessionStateKeyFromAgentUserInteraction,
  sessionStateKeyFromToolApproval,
  sessionRuntimeStates,
  pendingApprovalsBySession,
  pendingUserInteractionsBySession,
  sessionAgentEventStates
} from './stores/sessionStore'
import { getRendererApi } from './lib/rendererApi'
import { absoluteWorkspacePath, fileNameFromPath, filePreviewStatePath } from './lib/workspacePaths'
import { chatItemsFromSessionMessages } from './lib/chatItems'
import { messagesForUserRetry } from './lib/chatRetry'
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
import { orderProjectsForSessionSelection } from './lib/projectSidebar'
import { workspaceScopeLabelForCwd } from './lib/workspaceScope'
import {
  isWorkspaceFileTabKind,
  isWorkspaceResourceKind,
  workspaceFileTabKey,
  workspaceResourceKindLabel,
  workspaceResourceKindToSidebarMode,
  workspaceResourceTabKey,
  workspaceSessionTabKey,
  type WorkspaceFileWorkspaceTab,
  type WorkspaceResourceKind,
  type WorkspaceResourceTab,
  type WorkspaceSessionTab,
  type WorkspaceTab
} from './lib/workspaceResourceTabs'
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
import type { UserMessageRetryTarget } from './components/chat/ChatUserMessage'
import type {
  AgentEventSummary,
  AnalysisNotebookFileChange,
  DefaultProxyMode,
  McpServerSummary,
  ModelOption,
  PhiAppSettings,
  PhiAppSettingsPatch,
  PermissionMode,
  PluginCatalogItem,
  PromptTarget,
  Project,
  ProxyTransportStatus,
  SessionSummary,
  SkillSummary
} from './types'

export type AppView =
  'chat' | 'projects' | 'analysis' | 'runtime' | 'plugins' | 'skills' | 'mcp' | 'wrappers'

type QueuedPrompt = {
  id: string
  text: string
  target: PromptTarget
  sendOptions?: SendPromptOptions
}

type SendPromptOptions = {
  appendUserMessage?: boolean
  retryUserMessageId?: string
  suppressUserMessageEvent?: boolean
}

const activityBarWidth = 48
const macTitlebarHeight = 44
const minNavigationPaneWidth = 240
const maxNavigationPaneWidth = 520
const workspaceSidePanelWidthDefault = 340
const minWorkspaceSidePanelWidth = 240
const maxWorkspaceSidePanelWidth = 520
const titlebarChromeTopOffset = '10px'
const titlebarChromeHorizontalInset = '14px'
const titlebarChromeIconButtonSize = 28
const titlebarLeadingChromeReserveWidth = 220
const titlebarTrailingToggleChromeReserve = '56px'
const workspaceFileHeaderLeadingChromeInsetWidth =
  titlebarLeadingChromeReserveWidth - activityBarWidth
const workspaceFileHeaderLeadingChromeInset = `${workspaceFileHeaderLeadingChromeInsetWidth}px`

function isWorkspaceFileWorkspaceTab(
  tab: WorkspaceTab | null | undefined
): tab is WorkspaceFileWorkspaceTab {
  return Boolean(tab && isWorkspaceFileTabKind(tab.kind))
}
const isMac = typeof window !== 'undefined' && window.platform === 'darwin'
const RefreshIcon = GoSync

export function TopRightControls({
  showSidePanelRefresh,
  sidePanelRefreshDisabled,
  sidePanelCollapsed,
  showSidePanelToggle,
  onRefreshSidePanel,
  onToggleSidePanel
}: {
  showSidePanelRefresh: boolean
  sidePanelRefreshDisabled: boolean
  sidePanelCollapsed: boolean
  showSidePanelToggle: boolean
  onRefreshSidePanel: () => void
  onToggleSidePanel: () => void
}): React.JSX.Element | null {
  if (!showSidePanelRefresh && !showSidePanelToggle) return null
  const SidePanelToggleIcon = sidePanelCollapsed ? GoSidebarExpand : GoSidebarCollapse

  const buttonSx = {
    width: titlebarChromeIconButtonSize,
    height: titlebarChromeIconButtonSize,
    borderRadius: 1.5,
    color: 'text.secondary',
    pointerEvents: 'auto',
    WebkitAppRegion: 'no-drag',
    '&:hover': {
      bgcolor: 'action.hover',
      color: 'text.primary'
    },
    '&.Mui-disabled': {
      color: 'text.disabled'
    }
  } as const

  return (
    <Box
      data-phi-top-right-controls="workspace"
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        flexShrink: 0,
        gap: 0.5,
        WebkitAppRegion: 'no-drag'
      }}
    >
      {showSidePanelRefresh ? (
        <Tooltip title="刷新文件树">
          <span>
            <IconButton
              data-phi-workspace-side-panel-refresh-button="true"
              size="small"
              aria-label="刷新文件树"
              disabled={sidePanelRefreshDisabled}
              onClick={onRefreshSidePanel}
              sx={buttonSx}
            >
              <RefreshIcon size={19} />
            </IconButton>
          </span>
        </Tooltip>
      ) : null}
      {showSidePanelToggle ? (
        <Tooltip title={sidePanelCollapsed ? '展开右侧栏' : '关闭右侧栏'}>
          <IconButton
            data-phi-side-panel-toggle-button={sidePanelCollapsed ? 'collapsed' : 'expanded'}
            data-phi-side-panel-toggle-icon={sidePanelCollapsed ? 'expand' : 'collapse'}
            data-phi-side-panel-toggle-position="titlebar-flow"
            data-phi-side-panel-toggle-anchor="workspace-chrome"
            size="small"
            color="default"
            aria-label={sidePanelCollapsed ? '展开右侧栏' : '关闭右侧栏'}
            onClick={onToggleSidePanel}
            sx={{
              ...buttonSx,
              bgcolor: sidePanelCollapsed ? 'transparent' : 'action.selected',
              color: sidePanelCollapsed ? 'text.secondary' : 'text.primary'
            }}
          >
            <SidePanelToggleIcon size={19} />
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
        WebkitAppRegion: 'drag',
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
              WebkitAppRegion: 'no-drag',
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
                WebkitAppRegion: 'no-drag',
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
  onClose,
  reserveLeadingChromeSpace = false,
  reserveTrailingChromeSpace = false
}: {
  tabs: WorkspaceFileTab[]
  activePath: string | null
  onSelect: (tab: WorkspaceFileTab) => void
  onClose: (tab: WorkspaceFileTab) => void
  reserveLeadingChromeSpace?: boolean
  reserveTrailingChromeSpace?: boolean
}): React.JSX.Element {
  return (
    <Box
      data-phi-workspace-file-header="true"
      sx={{
        height: macTitlebarHeight,
        flexShrink: 0,
        borderBottom: 1,
        borderColor: 'divider',
        pl: reserveLeadingChromeSpace ? workspaceFileHeaderLeadingChromeInset : 1.5,
        pr: reserveTrailingChromeSpace ? titlebarTrailingToggleChromeReserve : 1.5,
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

function WorkspaceResourceHeader({
  tabs,
  activeKey,
  onSelect,
  onClose,
  reserveLeadingChromeSpace = false,
  reserveTrailingChromeSpace = false
}: {
  tabs: WorkspaceTab[]
  activeKey: string | null
  onSelect: (tab: WorkspaceTab) => void
  onClose: (tab: WorkspaceTab) => void
  reserveLeadingChromeSpace?: boolean
  reserveTrailingChromeSpace?: boolean
}): React.JSX.Element {
  return (
    <Box
      data-phi-workspace-resource-header="true"
      sx={{
        height: macTitlebarHeight,
        flexShrink: 0,
        borderBottom: 1,
        borderColor: 'divider',
        pl: reserveLeadingChromeSpace ? workspaceFileHeaderLeadingChromeInset : 1.5,
        pr: reserveTrailingChromeSpace ? titlebarTrailingToggleChromeReserve : 1.5,
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        WebkitAppRegion: 'drag'
      }}
    >
      <WorkspaceResourceTabs
        tabs={tabs}
        activeKey={activeKey}
        onSelect={onSelect}
        onClose={onClose}
      />
    </Box>
  )
}

function AppResizeSeparator({
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
    activeChatScrollResetKey,
    projectSessionRefreshKey,
    setProjectSessionRefreshKey,
    currentPermissionMode,
    isSessionChanging,
    setIsSessionChanging,
    agentEventState,
    setAgentEventState,
    pendingApproval,
    setPendingApproval,
    pendingUserInteraction,
    setPendingUserInteraction,
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
    onRespondToolApproval,
    onRespondAgentUserInteraction
  } = useSessionStore()
  const messages = agentEventState.messages
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>('general')
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
  const [workspaceTabs, setWorkspaceTabs] = useState<WorkspaceTab[]>([])
  const [closedWorkspaceSessionTabKeys, setClosedWorkspaceSessionTabKeys] = useState<Set<string>>(
    () => new Set()
  )
  const [activeWorkspaceTabKey, setActiveWorkspaceTabKey] = useState<string | null>(null)
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
  const [defaultProxyMode, setDefaultProxyMode] = useState<DefaultProxyMode>('auto')
  const [noProjectTaskFolder, setNoProjectTaskFolder] = useState('')
  const [preventSleepDuringRuns, setPreventSleepDuringRuns] = useState(
    DEFAULT_PREVENT_SLEEP_DURING_RUNS
  )
  const [nextActionSuggestionsEnabled, setNextActionSuggestionsEnabled] = useState(
    DEFAULT_NEXT_ACTION_SUGGESTIONS_ENABLED
  )
  const [enableDbConnectorTools, setEnableDbConnectorTools] = useState(
    DEFAULT_DB_CONNECTOR_TOOLS_ENABLED
  )
  const [proxyTransportStatus, setProxyTransportStatus] = useState<ProxyTransportStatus>(
    DEFAULT_PROXY_TRANSPORT_STATUS
  )
  const [isSavingDefaultProxyMode, setIsSavingDefaultProxyMode] = useState(false)
  const [isSavingAppSettings, setIsSavingAppSettings] = useState(false)
  const [snackbarNotice, setSnackbarNotice] = useState<SnackbarNotice | null>(null)
  const isSendingRef = useRef(false)
  const currentSessionIsBusyRef = useRef(false)
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
    busySkillId,
    setActiveSkillId,
    refreshSkills,
    refreshPromptAgents,
    setSkillDisabled,
    deleteSkill
  } = useSkillCatalog(getActiveCwd)
  const { mcpServers, activeMcpServerId, setActiveMcpServerId, refreshMcpServers } =
    useMcpServerCatalog(getActiveCwd)
  const {
    catalog: wrapperCatalog,
    runs: wrapperRuns,
    selectedWrapperId,
    isLoadingWrappers,
    wrapperError,
    setSelectedWrapperId,
    refreshWrappers,
    cancelWrapperRun,
    exportWrapperReproducibility
  } = useWrapperCatalog()

  const showSnackbar = useCallback(
    (
      message: string,
      severity: SnackbarNotice['severity'] = 'error',
      options?: { persistent?: boolean }
    ): void => {
      setSnackbarNotice({ id: Date.now(), message, severity, persistent: options?.persistent })
    },
    []
  )

  const showSnackbarError = useCallback(
    (error: unknown, fallback: string): void => {
      showSnackbar(readableErrorMessage(error, fallback), 'error')
    },
    [showSnackbar]
  )

  const applyAppSettings = useCallback((settings: PhiAppSettings): void => {
    setDefaultProxyMode(settings.defaultProxyMode)
    setNoProjectTaskFolder(settings.noProjectTaskFolder)
    setPreventSleepDuringRuns(settings.preventSleepDuringRuns)
    setNextActionSuggestionsEnabled(settings.nextActionSuggestionsEnabled)
    setEnableDbConnectorTools(settings.enableDbConnectorTools)
    setProxyTransportStatus(settings.proxyTransportStatus)
  }, [])

  useEffect(() => {
    let cancelled = false
    void rendererApi
      .getAppSettings()
      .then((settings) => {
        if (!cancelled) {
          applyAppSettings(settings)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          showSnackbarError(error, '读取通用设置失败')
        }
      })

    return () => {
      cancelled = true
    }
  }, [applyAppSettings, rendererApi, showSnackbarError])

  const onSelectDefaultProxyMode = useCallback(
    async (mode: DefaultProxyMode): Promise<void> => {
      if (mode === defaultProxyMode) return
      if (mode === 'enabled' && !proxyTransportStatus.enabledModeAvailable) {
        setDefaultProxyMode('auto')
        setIsSavingDefaultProxyMode(true)
        showSnackbar('DB_PROXY_UNAVAILABLE：受控代理通道不可用，已切换到自动选择。', 'warning', {
          persistent: true
        })
        try {
          const settings = await rendererApi.updateDefaultProxyMode('auto')
          applyAppSettings(settings)
        } catch (error) {
          showSnackbarError(error, '切换默认代理模式到自动选择失败')
        } finally {
          setIsSavingDefaultProxyMode(false)
        }
        return
      }
      const previousMode = defaultProxyMode
      setDefaultProxyMode(mode)
      setIsSavingDefaultProxyMode(true)
      try {
        const settings = await rendererApi.updateDefaultProxyMode(mode)
        applyAppSettings(settings)
      } catch (error) {
        setDefaultProxyMode(previousMode)
        showSnackbarError(error, '保存默认代理模式失败')
      } finally {
        setIsSavingDefaultProxyMode(false)
      }
    },
    [
      applyAppSettings,
      defaultProxyMode,
      proxyTransportStatus.enabledModeAvailable,
      rendererApi,
      showSnackbar,
      showSnackbarError
    ]
  )

  const onUpdateAppSettings = useCallback(
    async (patch: PhiAppSettingsPatch): Promise<void> => {
      const previousNoProjectTaskFolder = noProjectTaskFolder
      const previousPreventSleepDuringRuns = preventSleepDuringRuns
      const previousNextActionSuggestionsEnabled = nextActionSuggestionsEnabled
      const previousEnableDbConnectorTools = enableDbConnectorTools

      if (patch.noProjectTaskFolder !== undefined) {
        setNoProjectTaskFolder(patch.noProjectTaskFolder)
      }
      if (patch.preventSleepDuringRuns !== undefined) {
        setPreventSleepDuringRuns(patch.preventSleepDuringRuns)
      }
      if (patch.nextActionSuggestionsEnabled !== undefined) {
        setNextActionSuggestionsEnabled(patch.nextActionSuggestionsEnabled)
      }
      if (patch.enableDbConnectorTools !== undefined) {
        setEnableDbConnectorTools(patch.enableDbConnectorTools)
      }

      setIsSavingAppSettings(true)
      try {
        const settings = await rendererApi.updateAppSettings(patch)
        applyAppSettings(settings)
      } catch (error) {
        setNoProjectTaskFolder(previousNoProjectTaskFolder)
        setPreventSleepDuringRuns(previousPreventSleepDuringRuns)
        setNextActionSuggestionsEnabled(previousNextActionSuggestionsEnabled)
        setEnableDbConnectorTools(previousEnableDbConnectorTools)
        showSnackbarError(error, '保存通用设置失败')
      } finally {
        setIsSavingAppSettings(false)
      }
    },
    [
      applyAppSettings,
      enableDbConnectorTools,
      nextActionSuggestionsEnabled,
      noProjectTaskFolder,
      preventSleepDuringRuns,
      rendererApi,
      showSnackbarError
    ]
  )

  const onPickNoProjectTaskFolder = useCallback(async (): Promise<void> => {
    try {
      const path = await rendererApi.pickProjectDirectory()
      if (!path) return
      await onUpdateAppSettings({ noProjectTaskFolder: path })
    } catch (error) {
      showSnackbarError(error, '选择无项目任务文件夹失败')
    }
  }, [onUpdateAppSettings, rendererApi, showSnackbarError])

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
    activeAnalysisNotebook,
    setActiveAnalysisNotebook,
    isLoadingAnalysisNotebooks,
    isOpeningAnalysisNotebook,
    analysisNotebookError,
    analysisNotebookContentError,
    analysisKernelDiagnostics,
    isLoadingAnalysisKernels,
    analysisKernelError,
    analysisJupyterRuntimeStatus,
    isLoadingAnalysisJupyterRuntime,
    isStartingAnalysisJupyter,
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
  const [workspaceSidePanelCollapsed, setWorkspaceSidePanelCollapsed] = useState(true)
  const [workspaceSidePanelWidth, setWorkspaceSidePanelWidth] = useState(
    workspaceSidePanelWidthDefault
  )
  const [workspaceSidePanelTreeRevision, setWorkspaceSidePanelTreeRevision] = useState(0)

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
      const tabKey = workspaceSessionTabKey(current.path, current.sessionGeneration)
      setClosedWorkspaceSessionTabKeys((keys) => {
        if (!keys.has(tabKey)) return keys
        const nextKeys = new Set(keys)
        nextKeys.delete(tabKey)
        return nextKeys
      })
      setActiveWorkspaceTabKey(tabKey)
      navigateToView('chat')
    } finally {
      if (request === sessionRequestRef.current) {
        setIsSessionChanging(false)
      }
    }
  }, [
    applyCurrentSession,
    navigateToView,
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
        const tabKey = workspaceSessionTabKey(result.path, result.sessionGeneration)
        setClosedWorkspaceSessionTabKeys((keys) => {
          if (!keys.has(tabKey)) return keys
          const nextKeys = new Set(keys)
          nextKeys.delete(tabKey)
          return nextKeys
        })
        setActiveWorkspaceTabKey(tabKey)
        navigateToView('chat')
      } finally {
        if (request === sessionRequestRef.current) {
          setIsSessionChanging(false)
        }
      }
    },
    [
      acknowledgeActiveSession,
      applyCurrentSession,
      navigateToView,
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

  const showActiveConversationInSidebar = useCallback((): void => {
    projectSidebarSelectionRequestRef.current += 1
    setWorkspaceSidebarMode('conversations')
    setIsSidebarOpen(true)
  }, [])

  const onOpenNotebookWorkspaceFile = useCallback(
    (path: string, options: { revealConversationSidebar?: boolean } = {}): void => {
      const normalizedPath = absoluteWorkspacePath(useSessionStore.getState().activeCwd, path)
      const title = fileNameFromPath(normalizedPath)
      filePreviewRequestRef.current += 1
      setFilePreview(null)
      if (options.revealConversationSidebar ?? true) {
        showActiveConversationInSidebar()
      } else {
        setIsSidebarOpen(true)
      }
      setActiveWorkspaceTabKey(workspaceFileTabKey(normalizedPath))
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
      navigateToView,
      showActiveConversationInSidebar
    ]
  )

  const onStartProjectChat = useCallback(
    async (project: Project): Promise<void> => {
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
        const tabKey = workspaceSessionTabKey(current.path, current.sessionGeneration)
        setClosedWorkspaceSessionTabKeys((keys) => {
          if (!keys.has(tabKey)) return keys
          const nextKeys = new Set(keys)
          nextKeys.delete(tabKey)
          return nextKeys
        })
        setActiveWorkspaceTabKey(tabKey)
        navigateToView('chat')
        setProjectSessionRefreshKey((key) => key + 1)
      } finally {
        if (request === sessionRequestRef.current) {
          setIsSessionChanging(false)
        }
      }
    },
    [
      applyCurrentSession,
      navigateToView,
      onResetSending,
      refreshCurrentModelControls,
      rendererApi,
      resetAnalysisJupyterRuntimeForCwdChange,
      setIsSessionChanging,
      setProjectSessionRefreshKey,
      startFreshChat
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

    const unsubscribeAgentUserInteraction = rendererApi.onAgentUserInteractionRequest((event) => {
      const interactionStateKey = sessionStateKeyFromAgentUserInteraction(
        event,
        useSessionStore.getState().activeSessionGeneration
      )
      if (interactionStateKey) {
        pendingUserInteractionsBySession.set(interactionStateKey, event)
        const nextRuntimeState = {
          ...(sessionRuntimeStates.get(interactionStateKey) ?? idleSessionRuntimeState()),
          status: 'needs_input' as const,
          unreadKind: 'input' as const,
          currentRunId: event.runId
        }
        storeSessionRuntimeState(interactionStateKey, nextRuntimeState)
        if (interactionStateKey === useSessionStore.getState().activeAgentEventStateKey) {
          setPendingUserInteraction(event)
          setActiveSessionRuntimeState(nextRuntimeState)
        }
      } else {
        setPendingUserInteraction(event)
      }
      setProjectSessionRefreshKey((key) => key + 1)
      scheduleSessionRefresh()
    })

    const unsubscribeAgentUserInteractionCancelled = rendererApi.onAgentUserInteractionCancelled(
      () => {
        pendingUserInteractionsBySession.clear()
        setPendingUserInteraction(null)
        scheduleSessionRefresh()
      }
    )

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
      if (workspaceSidebarMode === 'projects') {
        void refreshProjects()
      }
    })

    return () => {
      unsubscribe()
      unsubscribeAuthInteraction()
      unsubscribeToolApproval()
      unsubscribeToolApprovalCancelled()
      unsubscribeAgentUserInteraction()
      unsubscribeAgentUserInteractionCancelled()
      unsubscribeNotebookDraftChanged()
      unsubscribeNotebookFileChanged()
      unsubscribeSessionChanged()
      cancelScheduledSessionRefresh()
    }
  }, [
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
    setPendingUserInteraction,
    setProjectSessionRefreshKey,
    setVisibleAgentEventState,
    showSnackbar,
    storeSessionRuntimeState,
    workspaceSidebarMode
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
      if (workspaceSidebarMode === 'projects') {
        void refreshProjects()
      }
      if (workspaceSidebarMode === 'runtime') {
        void refreshAnalysisJupyterRuntimeStatus()
      }
      if (workspaceSidebarMode === 'plugins') {
        void refreshPlugins()
      }
      if (workspaceSidebarMode === 'skills') {
        void refreshSkills()
      }
      if (workspaceSidebarMode === 'mcp') {
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
    refreshAnalysisJupyterRuntimeStatus,
    refreshAnalysisJupyterStatus,
    refreshAnalysisNotebooks,
    refreshMcpServers,
    refreshPlugins,
    refreshProjects,
    refreshSkills,
    workspaceSidebarMode
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
  const [queuedPromptsBySession, setQueuedPromptsBySession] = useState<
    Record<string, QueuedPrompt[]>
  >({})
  const activeQueuedPrompts = useMemo(
    () => queuedPromptsBySession[activeDraftKey] ?? [],
    [activeDraftKey, queuedPromptsBySession]
  )
  const removeQueuedPrompt = useCallback(
    (id: string): void => {
      setQueuedPromptsBySession((prev) => {
        const current = prev[activeDraftKey] ?? []
        const next = current.filter((item) => item.id !== id)
        if (next.length === current.length) return prev
        const updated = { ...prev }
        if (next.length > 0) {
          updated[activeDraftKey] = next
        } else {
          delete updated[activeDraftKey]
        }
        return updated
      })
    },
    [activeDraftKey]
  )
  const queuePromptText = useCallback(
    (text: string, target: PromptTarget, sendOptions?: SendPromptOptions): void => {
      setQueuedPromptsBySession((prev) => {
        const current = prev[activeDraftKey] ?? []
        return {
          ...prev,
          [activeDraftKey]: [
            ...current,
            {
              id: `queued-${Date.now()}-${current.length}`,
              text,
              target,
              sendOptions
            }
          ]
        }
      })
      setActiveInput('')
    },
    [activeDraftKey, setActiveInput]
  )

  const sendPromptText = useCallback(
    async (
      text: string,
      target: PromptTarget,
      options: SendPromptOptions = {}
    ): Promise<boolean> => {
      if (!text.trim() || isSendingRef.current) {
        return false
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
        return false
      }

      isSendingRef.current = true
      const submitGeneration = target.sessionGeneration
      const sendRequest = ++sendRequestRef.current

      if (options.retryUserMessageId) {
        updateMessages((prev) => messagesForUserRetry(prev, options.retryUserMessageId as string))
      } else if (options.appendUserMessage !== false) {
        updateMessages((prev) => [
          ...prev,
          { id: `user-${Date.now()}`, role: 'user', content: text }
        ])
      }
      setIsSendingMessage(true)

      try {
        const result = await rendererApi.sendPrompt(
          text,
          options.suppressUserMessageEvent
            ? {
                ...target,
                suppressUserMessageEvent: true,
                ...(options.retryUserMessageId
                  ? { retryUserMessageId: options.retryUserMessageId }
                  : {})
              }
            : target
        )
        if (
          !result ||
          sendRequest !== sendRequestRef.current ||
          result.sessionGeneration !== useSessionStore.getState().activeSessionGeneration
        ) {
          return true
        }

        if (result.path) {
          const materializedQueueKey = sessionDraftKey({
            phiSessionId: result.phiSessionId ?? null,
            path: result.path,
            cwd: target.cwd,
            sessionGeneration: result.sessionGeneration
          })
          if (materializedQueueKey !== activeDraftKey) {
            const materializedTarget: PromptTarget = {
              path: result.path,
              phiSessionId: result.phiSessionId,
              cwd: target.cwd,
              sessionGeneration: result.sessionGeneration
            }
            setQueuedPromptsBySession((prev) => {
              const queued = prev[activeDraftKey] ?? []
              if (queued.length === 0) return prev
              const updated = { ...prev }
              delete updated[activeDraftKey]
              updated[materializedQueueKey] = [
                ...(updated[materializedQueueKey] ?? []),
                ...queued.map((item) => ({ ...item, target: materializedTarget }))
              ]
              return updated
            })
          }
        }

        if (result.path && result.path !== activeSessionPath) {
          // First prompt of a fresh chat: it just became a stable Phi session — pick it up so
          // the sidebar can highlight it.
          setActiveSessionPath(result.path)
        }
        if (result.path) {
          const tabKey = workspaceSessionTabKey(result.path, result.sessionGeneration)
          setClosedWorkspaceSessionTabKeys((keys) => {
            if (!keys.has(tabKey)) return keys
            const nextKeys = new Set(keys)
            nextKeys.delete(tabKey)
            return nextKeys
          })
          setActiveWorkspaceTabKey(tabKey)
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
        return true
      } catch (error) {
        if (
          sendRequest !== sendRequestRef.current ||
          submitGeneration !== useSessionStore.getState().activeSessionGeneration
        ) {
          return true
        }
        showSnackbarError(error, '发送消息失败')
        return true
      } finally {
        if (
          sendRequest === sendRequestRef.current &&
          submitGeneration === useSessionStore.getState().activeSessionGeneration
        ) {
          isSendingRef.current = false
          setIsSendingMessage(false)
        }
      }
    },
    [
      activeDraftKey,
      activeSessionPath,
      availableModels,
      isModelStateReady,
      models,
      openSettings,
      providerStatuses,
      refreshSessions,
      rendererApi,
      selectedModel,
      setActivePhiSessionId,
      setActiveSessionPath,
      setActiveWorkspaceTabKey,
      setClosedWorkspaceSessionTabKeys,
      setSelectedModel,
      showSnackbarError,
      updateMessages
    ]
  )

  const onChatSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const text = input.trim()
    if (!text) return
    const target: PromptTarget = {
      path: useSessionStore.getState().activeSessionPath,
      phiSessionId: useSessionStore.getState().activePhiSessionId ?? undefined,
      cwd: useSessionStore.getState().activeCwd,
      sessionGeneration: useSessionStore.getState().activeSessionGeneration
    }
    if (currentSessionIsBusy || isSendingRef.current) {
      queuePromptText(text, target)
      return
    }
    setActiveInput('')
    await sendPromptText(text, target)
  }

  const onStopGeneration = async (): Promise<void> => {
    const stoppedRequest = sendRequestRef.current
    await rendererApi.stopGeneration()
    if (stoppedRequest === sendRequestRef.current) {
      isSendingRef.current = false
      setIsSendingMessage(false)
      setPendingApproval(null)
      setPendingUserInteraction(null)
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

  const previewFilePathInWorkspaceTab = useCallback(
    (path: string): void => {
      const normalizedPath = absoluteWorkspacePath(getActiveCwd(), path)
      showActiveConversationInSidebar()
      setActiveWorkspaceTabKey(workspaceFileTabKey(normalizedPath))
      previewFilePath(path)
    },
    [getActiveCwd, previewFilePath, showActiveConversationInSidebar]
  )

  const previewDirectoryPathInWorkspaceTab = useCallback(
    (path: string): void => {
      const normalizedPath = absoluteWorkspacePath(getActiveCwd(), path)
      showActiveConversationInSidebar()
      setActiveWorkspaceTabKey(workspaceFileTabKey(normalizedPath))
      previewDirectoryPath(path)
    },
    [getActiveCwd, previewDirectoryPath, showActiveConversationInSidebar]
  )

  const onOpenWorkspaceFileFromSidebar = useCallback(
    (path: string): void => {
      const normalizedPath = absoluteWorkspacePath(getActiveCwd(), path)
      setWorkspaceSidebarMode('files')
      setIsSidebarOpen(true)
      setActiveWorkspaceTabKey(workspaceFileTabKey(normalizedPath))
      if (isNotebookFilePath(path)) {
        onOpenNotebookWorkspaceFile(path, { revealConversationSidebar: false })
        return
      }
      previewFilePath(path)
    },
    [getActiveCwd, onOpenNotebookWorkspaceFile, previewFilePath]
  )

  const onOpenFilePreview = useCallback(
    (path: string): void => {
      if (isNotebookFilePath(path)) {
        onOpenNotebookWorkspaceFile(path)
        return
      }
      previewFilePathInWorkspaceTab(path)
    },
    [onOpenNotebookWorkspaceFile, previewFilePathInWorkspaceTab]
  )

  const onOpenLocalPath = useCallback(
    (path: string, pathKind: LocalPathKind): void => {
      if (pathKind === 'directory') {
        previewDirectoryPathInWorkspaceTab(path)
        return
      }
      if (isNotebookFilePath(path)) {
        onOpenNotebookWorkspaceFile(path)
        return
      }
      previewFilePathInWorkspaceTab(path)
    },
    [onOpenNotebookWorkspaceFile, previewDirectoryPathInWorkspaceTab, previewFilePathInWorkspaceTab]
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
  const isResourceWorkspaceView = isWorkspaceResourceKind(activeView)
  const isChatWorkspaceView =
    activeView === 'chat' || activeView === 'projects' || activeView === 'analysis'
  const isWorkspaceView = isChatWorkspaceView || isResourceWorkspaceView
  const isAnalysisWorkspaceView = activeView === 'analysis'
  const onToggleWorkspaceSidePanel = useCallback((): void => {
    setWorkspaceSidePanelCollapsed((value) => !value)
  }, [])
  const onRefreshWorkspaceSidePanel = useCallback((): void => {
    setWorkspaceSidePanelTreeRevision((value) => value + 1)
  }, [])
  const onStartWorkspaceSidePanelResize = useCallback(
    (event: MouseEvent<HTMLDivElement>): void => {
      event.preventDefault()

      const startX = event.clientX
      const startWidth = workspaceSidePanelWidth
      const onMouseMove = (moveEvent: globalThis.MouseEvent): void => {
        const delta = moveEvent.clientX - startX
        setWorkspaceSidePanelWidth(
          Math.min(
            maxWorkspaceSidePanelWidth,
            Math.max(minWorkspaceSidePanelWidth, startWidth - delta)
          )
        )
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
    [workspaceSidePanelWidth]
  )
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
  const currentSessionTab = useMemo<WorkspaceSessionTab>(
    () => ({
      key: workspaceSessionTabKey(activeSessionPath, activeSessionGeneration),
      kind: 'session',
      itemId: activeSessionPath ?? `fresh:${activeSessionGeneration}`,
      title: activeSession
        ? sessionDisplayTitle(activeSession)
        : (titleFromMessages(messages) ?? truncateSessionTitle('新对话')),
      subtitle: workspaceScopeLabelForCwd(activeCwd, projects),
      sessionPath: activeSessionPath,
      sessionGeneration: activeSessionGeneration,
      sidebarMode: activeProject ? 'projects' : 'conversations'
    }),
    [
      activeCwd,
      activeProject,
      activeSession,
      activeSessionGeneration,
      activeSessionPath,
      messages,
      projects
    ]
  )
  const workspaceFileWorkspaceTabs = useMemo<WorkspaceFileWorkspaceTab[]>(
    () =>
      workspaceFileTabs.map((tab) => ({
        key: workspaceFileTabKey(tab.path),
        kind: tab.kind,
        id: tab.id,
        itemId: tab.path,
        name: tab.name,
        status: tab.status,
        title: tab.name,
        subtitle: tab.status,
        path: tab.path,
        pathKind: tab.pathKind,
        absolutePath: tab.absolutePath ?? tab.path
      })),
    [workspaceFileTabs]
  )
  const shouldShowSessionWorkspaceTab = !(
    activeView === 'analysis' && workspaceSidebarMode === 'conversations'
  )
  const visibleWorkspaceTabs = useMemo(() => {
    const staleFreshSessionKey =
      currentSessionTab.sessionPath === null
        ? null
        : workspaceSessionTabKey(null, currentSessionTab.sessionGeneration)
    const normalizedTabs = workspaceTabs.filter(
      (tab) =>
        tab.key !== staleFreshSessionKey &&
        (shouldShowSessionWorkspaceTab || tab.kind !== 'session')
    )
    const normalizedTabsWithFiles = [...normalizedTabs, ...workspaceFileWorkspaceTabs]
    if (!shouldShowSessionWorkspaceTab) return normalizedTabsWithFiles
    if (closedWorkspaceSessionTabKeys.has(currentSessionTab.key)) return normalizedTabsWithFiles

    const existingIndex = normalizedTabsWithFiles.findIndex(
      (tab) => tab.key === currentSessionTab.key
    )
    if (existingIndex === -1) return [currentSessionTab, ...normalizedTabsWithFiles]
    return normalizedTabsWithFiles.map((tab, index) =>
      index === existingIndex ? { ...tab, ...currentSessionTab } : tab
    )
  }, [
    closedWorkspaceSessionTabKeys,
    currentSessionTab,
    shouldShowSessionWorkspaceTab,
    workspaceFileWorkspaceTabs,
    workspaceTabs
  ])
  const effectiveActiveWorkspaceTabKey =
    activeWorkspaceTabKey ??
    (activeView === 'analysis' && activeWorkspaceFilePath
      ? workspaceFileTabKey(activeWorkspaceFilePath)
      : activeView === 'chat'
        ? currentSessionTab.key
        : null)
  const activeWorkspaceTab =
    visibleWorkspaceTabs.find((tab) => tab.key === effectiveActiveWorkspaceTabKey) ?? null
  const activeWorkspaceResourceTab =
    activeWorkspaceTab && isWorkspaceResourceKind(activeWorkspaceTab.kind)
      ? activeWorkspaceTab
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
  useEffect(() => {
    currentSessionIsBusyRef.current = currentSessionIsBusy
  }, [currentSessionIsBusy])
  const onRetryUserMessage = useCallback(
    async (message: UserMessageRetryTarget): Promise<void> => {
      const text = message.content.trim()
      if (!text) return
      const state = useSessionStore.getState()
      const target: PromptTarget = {
        path: state.activeSessionPath,
        phiSessionId: state.activePhiSessionId ?? undefined,
        cwd: state.activeCwd,
        sessionGeneration: state.activeSessionGeneration
      }
      const sendOptions: SendPromptOptions = {
        appendUserMessage: false,
        retryUserMessageId: message.id,
        suppressUserMessageEvent: true
      }
      if (currentSessionIsBusyRef.current || isSendingRef.current) {
        queuePromptText(text, target, sendOptions)
        return
      }
      await sendPromptText(text, target, sendOptions)
    },
    [queuePromptText, sendPromptText]
  )
  useEffect(() => {
    if (currentSessionIsBusy || isSessionChanging || isBusy || isSendingRef.current) return
    const nextPrompt = activeQueuedPrompts[0]
    if (!nextPrompt) return
    const readiness = getPromptReadiness({
      modelStateReady: isModelStateReady,
      providers: providerStatuses,
      availableModels
    })
    if (!readiness.ready) return

    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setQueuedPromptsBySession((prev) => {
        const current = prev[activeDraftKey] ?? []
        if (current[0]?.id !== nextPrompt.id) return prev
        const remaining = current.slice(1)
        const updated = { ...prev }
        if (remaining.length > 0) {
          updated[activeDraftKey] = remaining
        } else {
          delete updated[activeDraftKey]
        }
        return updated
      })
      void sendPromptText(nextPrompt.text, nextPrompt.target, nextPrompt.sendOptions)
    })
    return () => {
      cancelled = true
    }
  }, [
    activeDraftKey,
    activeQueuedPrompts,
    availableModels,
    currentSessionIsBusy,
    isModelStateReady,
    isBusy,
    isSessionChanging,
    providerStatuses,
    sendPromptText
  ])
  const activeWorkspaceTitle = useMemo(() => {
    if (showProjectSessionPlaceholder) return '项目会话'
    if (isResourceWorkspaceView) {
      return (
        activeWorkspaceResourceTab?.title ??
        workspaceResourceKindLabel(activeView as WorkspaceResourceKind)
      )
    }
    if (!isChatWorkspaceView) return activeView
    if (activeSession) return sessionDisplayTitle(activeSession)
    return titleFromMessages(messages) ?? truncateSessionTitle('新对话')
  }, [
    activeSession,
    activeView,
    activeWorkspaceResourceTab,
    isChatWorkspaceView,
    isResourceWorkspaceView,
    messages,
    showProjectSessionPlaceholder
  ])
  const activeWorkspaceScopeLabel = workspaceScopeLabelForCwd(activeCwd, projects)
  const activePermissionMode = currentPermissionMode
  const showWorkspaceTabs =
    visibleWorkspaceTabs.length > 0 &&
    (activeView === 'chat' || activeView === 'analysis' || isResourceWorkspaceView)
  const showWorkspaceTitlebar =
    !isAnalysisWorkspaceView && !isResourceWorkspaceView && !showWorkspaceTabs
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
  const activeWorkspaceSidePanelPath =
    activeWorkspaceFilePath ?? (filePreview ? filePreviewStatePath(filePreview) : null)

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
      setActiveWorkspaceTabKey(workspaceFileTabKey(tab.path))
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

  const onCloseCurrentFilePreview = useCallback((): void => {
    if (!filePreview) return
    const previewPath = filePreviewStatePath(filePreview)
    const previewTab = workspaceFileTabs.find((tab) => tab.path === previewPath)
    if (previewTab) {
      onCloseWorkspaceFileTab(previewTab)
      return
    }

    filePreviewRequestRef.current += 1
    clearCachedFilePreview(previewPath)
    setFilePreview(null)
    if (activeWorkspaceFilePath === previewPath) {
      setActiveWorkspaceFilePath(null)
    }
  }, [
    activeWorkspaceFilePath,
    clearCachedFilePreview,
    filePreview,
    filePreviewRequestRef,
    onCloseWorkspaceFileTab,
    setActiveWorkspaceFilePath,
    setFilePreview,
    workspaceFileTabs
  ])

  const upsertWorkspaceTab = useCallback((tab: WorkspaceTab): void => {
    setWorkspaceTabs((tabs) => {
      const existingIndex = tabs.findIndex((item) => item.key === tab.key)
      if (existingIndex === -1) return [...tabs, tab]
      return tabs.map((item, index) => (index === existingIndex ? { ...item, ...tab } : item))
    })
  }, [])

  const selectWorkspaceTab = useCallback(
    (tab: WorkspaceTab): void => {
      setActiveWorkspaceTabKey(tab.key)
      if (tab.kind === 'session') {
        setClosedWorkspaceSessionTabKeys((keys) => {
          if (!keys.has(tab.key)) return keys
          const nextKeys = new Set(keys)
          nextKeys.delete(tab.key)
          return nextKeys
        })
        setWorkspaceSidebarMode(tab.sidebarMode)
        setIsSidebarOpen(true)
        navigateToView('chat')
        if (tab.sessionPath && tab.sessionPath !== useSessionStore.getState().activeSessionPath) {
          void onSelectSession(tab.sessionPath)
        } else {
          void acknowledgeActiveSession({ force: true })
        }
        return
      }

      if (isWorkspaceFileWorkspaceTab(tab)) {
        onSelectWorkspaceFileTab(tab)
        return
      }

      setWorkspaceSidebarMode(workspaceResourceKindToSidebarMode(tab.kind))
      setIsSidebarOpen(true)
      if (tab.kind === 'plugins') {
        setActivePluginId(tab.itemId)
      } else if (tab.kind === 'skills') {
        setActiveSkillId(tab.itemId)
      } else if (tab.kind === 'mcp') {
        setActiveMcpServerId(tab.itemId)
      } else if (tab.kind === 'wrappers') {
        setSelectedWrapperId(tab.itemId)
      }
      navigateToView(tab.kind)
    },
    [
      acknowledgeActiveSession,
      navigateToView,
      onSelectSession,
      onSelectWorkspaceFileTab,
      setActiveMcpServerId,
      setActivePluginId,
      setActiveSkillId,
      setSelectedWrapperId
    ]
  )

  const openWorkspaceResourceTab = useCallback(
    (tab: Omit<WorkspaceResourceTab, 'key'>): void => {
      const nextTab: WorkspaceResourceTab = {
        ...tab,
        key: workspaceResourceTabKey(tab.kind, tab.itemId)
      }
      upsertWorkspaceTab(nextTab)
      selectWorkspaceTab(nextTab)
    },
    [selectWorkspaceTab, upsertWorkspaceTab]
  )

  const onOpenPluginTab = useCallback(
    (plugin: PluginCatalogItem): void => {
      setActivePluginId(plugin.id)
      openWorkspaceResourceTab({
        kind: 'plugins',
        itemId: plugin.id,
        title: plugin.name,
        subtitle: plugin.source
      })
    },
    [openWorkspaceResourceTab, setActivePluginId]
  )

  const onOpenSkillTab = useCallback(
    (skill: SkillSummary): void => {
      setActiveSkillId(skill.id)
      openWorkspaceResourceTab({
        kind: 'skills',
        itemId: skill.id,
        title: skill.name,
        subtitle: skill.filePath
      })
    },
    [openWorkspaceResourceTab, setActiveSkillId]
  )

  const onSetSkillDisabled = useCallback(
    async (skill: SkillSummary, disabled: boolean): Promise<void> => {
      try {
        await setSkillDisabled(skill, disabled)
        showSnackbar(disabled ? '已关闭技能' : '已启用技能', 'success')
      } catch (error) {
        showSnackbarError(error, disabled ? '关闭技能失败' : '启用技能失败')
        throw error
      }
    },
    [setSkillDisabled, showSnackbar, showSnackbarError]
  )

  const onDeleteSkill = useCallback(
    async (skill: SkillSummary): Promise<void> => {
      try {
        const nextSkills = await deleteSkill(skill)
        showSnackbar('已卸载技能', 'success')
        if (
          activeWorkspaceResourceTab?.kind === 'skills' &&
          activeWorkspaceResourceTab.itemId === skill.id
        ) {
          const nextSkill = nextSkills[0] ?? null
          if (nextSkill) {
            onOpenSkillTab(nextSkill)
          } else {
            setActiveSkillId(null)
          }
        }
      } catch (error) {
        showSnackbarError(error, '卸载技能失败')
        throw error
      }
    },
    [
      activeWorkspaceResourceTab,
      deleteSkill,
      onOpenSkillTab,
      setActiveSkillId,
      showSnackbar,
      showSnackbarError
    ]
  )

  const onOpenMcpServerTab = useCallback(
    (server: McpServerSummary): void => {
      setActiveMcpServerId(server.id)
      openWorkspaceResourceTab({
        kind: 'mcp',
        itemId: server.id,
        title: server.name,
        subtitle: server.sourcePath ?? server.command
      })
    },
    [openWorkspaceResourceTab, setActiveMcpServerId]
  )

  const onOpenWrapperTab = useCallback(
    (entry: WrapperCompositionManifest): void => {
      setSelectedWrapperId(entry.id)
      openWorkspaceResourceTab({
        kind: 'wrappers',
        itemId: entry.id,
        title: entry.name,
        subtitle: entry.id
      })
      // Runs the agent started while this view was closed (wrapper_run) only exist on disk.
      void refreshWrappers()
    },
    [openWorkspaceResourceTab, refreshWrappers, setSelectedWrapperId]
  )

  const onCloseWorkspaceTab = useCallback(
    (tab: WorkspaceTab): void => {
      const closingIndex = visibleWorkspaceTabs.findIndex((item) => item.key === tab.key)
      if (closingIndex === -1) return
      const remainingTabs = visibleWorkspaceTabs.filter((item) => item.key !== tab.key)
      if (tab.kind === 'session') {
        setClosedWorkspaceSessionTabKeys((keys) => {
          if (keys.has(tab.key)) return keys
          const nextKeys = new Set(keys)
          nextKeys.add(tab.key)
          return nextKeys
        })
      } else if (isWorkspaceFileWorkspaceTab(tab)) {
        onCloseWorkspaceFileTab(tab)
      } else {
        setWorkspaceTabs((tabs) => tabs.filter((item) => item.key !== tab.key))
      }

      // The sidebar's "selected" resource id is independent of which tab is
      // active — clicking a resource icon in the activity bar switches
      // `workspaceSidebarMode` without touching `activeWorkspaceTabKey` (see
      // selectWorkspaceTab), so closing that resource's tab from the *tab
      // bar* wouldn't otherwise clear its sidebar highlight even when the
      // tab wasn't the active one. Without this, the sidebar keeps showing
      // an item selected indefinitely after its last tab closes.
      if (tab.kind === 'plugins' && activePluginId === tab.itemId) {
        setActivePluginId(null)
      } else if (tab.kind === 'skills' && activeSkillId === tab.itemId) {
        setActiveSkillId(null)
      } else if (tab.kind === 'mcp' && activeMcpServerId === tab.itemId) {
        setActiveMcpServerId(null)
      } else if (tab.kind === 'wrappers' && selectedWrapperId === tab.itemId) {
        setSelectedWrapperId(null)
      }

      if (tab.key !== effectiveActiveWorkspaceTabKey) return

      const nextTab = remainingTabs[Math.min(closingIndex, remainingTabs.length - 1)] ?? null
      if (nextTab) {
        selectWorkspaceTab(nextTab)
        return
      }
      setActiveWorkspaceTabKey(null)
      navigateToView('chat')
    },
    [
      activeMcpServerId,
      activePluginId,
      activeSkillId,
      effectiveActiveWorkspaceTabKey,
      navigateToView,
      onCloseWorkspaceFileTab,
      selectWorkspaceTab,
      selectedWrapperId,
      setActiveMcpServerId,
      setActivePluginId,
      setActiveSkillId,
      setSelectedWrapperId,
      visibleWorkspaceTabs
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

  const onSelectWorkspaceSidebarMode = useCallback(
    (mode: WorkspaceSidebarMode): void => {
      closeWorkspaceSidebarPreview()
      if (mode === 'projects' || mode === 'conversations') {
        projectSidebarSelectionRequestRef.current += 1
      }
      setWorkspaceSidebarMode(mode)
      if (workspaceSidebarMode === mode) {
        setIsSidebarOpen((value) => !value)
        return
      }
      setIsSidebarOpen(true)
    },
    [closeWorkspaceSidebarPreview, workspaceSidebarMode]
  )

  const onSelectWorkspaceView = useCallback(
    (view: 'chat' | 'projects'): void => {
      onSelectWorkspaceSidebarMode(view === 'projects' ? 'projects' : 'conversations')
    },
    [onSelectWorkspaceSidebarMode]
  )

  const onNewChatFromSidebar = useCallback(async (): Promise<void> => {
    await onNewChat()
    navigateToView('chat')
  }, [navigateToView, onNewChat])

  const onOpenSessionFromSidebar = useCallback(
    async (path: string): Promise<void> => {
      await onSelectSession(path)
      navigateToView('chat')
    },
    [navigateToView, onSelectSession]
  )

  const onStartProjectChatFromSidebar = useCallback(
    async (project: Project): Promise<void> => {
      await onStartProjectChat(project)
      navigateToView('chat')
    },
    [navigateToView, onStartProjectChat]
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

  const activeResourcePlugin =
    activeWorkspaceResourceTab?.kind === 'plugins'
      ? (plugins.find((plugin) => plugin.id === activeWorkspaceResourceTab.itemId) ?? null)
      : null
  const activeResourceSkill =
    activeWorkspaceResourceTab?.kind === 'skills'
      ? (skills.find((skill) => skill.id === activeWorkspaceResourceTab.itemId) ?? null)
      : null
  const activeResourceMcpServer =
    activeWorkspaceResourceTab?.kind === 'mcp'
      ? (mcpServers.find((server) => server.id === activeWorkspaceResourceTab.itemId) ?? null)
      : null

  const activeWorkspaceResourceContent = activeWorkspaceResourceTab ? (
    activeWorkspaceResourceTab.kind === 'plugins' ? (
      <PluginDetail
        selectedPlugin={activeResourcePlugin}
        busySource={busyPluginSource}
        operationError={pluginOperationError}
        onInstall={(source) => {
          void onInstallPlugin(source)
        }}
        onRemove={(source) => {
          void onRemovePlugin(source)
        }}
      />
    ) : activeWorkspaceResourceTab.kind === 'skills' ? (
      <SkillDetail
        selectedSkill={activeResourceSkill}
        busySkillId={busySkillId}
        onSetSkillDisabled={onSetSkillDisabled}
        onDeleteSkill={onDeleteSkill}
      />
    ) : activeWorkspaceResourceTab.kind === 'mcp' ? (
      <McpDetail selectedServer={activeResourceMcpServer} />
    ) : activeWorkspaceResourceTab.kind === 'wrappers' ? (
      <WrapperDetail
        catalog={wrapperCatalog}
        runs={wrapperRuns}
        selectedId={activeWorkspaceResourceTab.itemId}
        error={wrapperError}
        onOpenLocalPath={onOpenLocalPath}
        onExportReproducibility={(runId) => void exportWrapperReproducibility(runId)}
        onCancelRun={(runId) => void cancelWrapperRun(runId)}
      />
    ) : null
  ) : (
    <Stack spacing={1} sx={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Typography color="text.secondary">从左侧选择一个项目打开 tab。</Typography>
    </Stack>
  )

  const activeChatView = (
    <ChatView
      messages={messages}
      input={input}
      scrollResetKey={activeChatScrollResetKey}
      canSend={!isSessionChanging && !currentSessionIsBusy && !isBusy}
      canQueue={!isSessionChanging && currentSessionIsBusy && !isBusy}
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
      onRetryUserMessage={onRetryUserMessage}
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
      pendingUserInteraction={pendingUserInteraction}
      queuedPrompts={activeQueuedPrompts.map((item) => ({ id: item.id, text: item.text }))}
      onRespondApproval={onRespondToolApproval}
      onRespondUserInteraction={onRespondAgentUserInteraction}
      onRemoveQueuedPrompt={removeQueuedPrompt}
      onOpenApprovalSession={onOpenApprovalSession}
      onOpenLocalPath={onOpenLocalPath}
      onJumpToNotebookCell={onJumpToAnalysisNotebookCell}
      compactComposerControls={activeView === 'analysis'}
      cwd={activeCwd}
    />
  )

  const chatWorkspaceContent = (
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
    </>
  )

  const activeAnalysisView = (
    <AnalysisView
      hideLeftRail
      notebookRegistry={analysisNotebookRegistry}
      notebookFile={activeAnalysisNotebook}
      workspaceFileTabs={workspaceFileTabs}
      activeWorkspaceFilePath={activeWorkspaceFilePath}
      onSelectWorkspaceFileTab={onSelectWorkspaceFileTab}
      onCloseWorkspaceFileTab={onCloseWorkspaceFileTab}
      isLoadingNotebooks={isLoadingAnalysisNotebooks}
      isOpeningNotebook={isOpeningAnalysisNotebook}
      notebookError={analysisNotebookError}
      notebookContentError={analysisNotebookContentError}
      kernelDiagnostics={analysisKernelDiagnostics}
      isLoadingKernels={isLoadingAnalysisKernels}
      kernelError={analysisKernelError}
      notebookSessionStatus={analysisNotebookSessionStatus}
      isStartingNotebookSession={isStartingAnalysisNotebookSession}
      notebookSessionError={analysisNotebookSessionError}
      executingNotebookCellId={executingAnalysisCellId}
      notebookCellExecutionError={analysisCellExecutionError}
      agentFocus={analysisAgentFocus}
      onRefreshNotebooks={() => {
        void refreshAnalysisNotebooks()
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
      onNotebookCodeGenerationProgress={rendererApi.onAnalysisNotebookCodeGenerationProgress}
      notebookAiModelOptions={availableModels}
      notebookAiDefaultModel={notebookAiDefaultModel}
      onPickNotebookContextFiles={onPickInputFiles}
      onInitializeProjectAnalysis={(cwd) => {
        void onInitializeProjectAnalysis(cwd)
      }}
      onOpenNotebook={(path) => {
        onOpenNotebookWorkspaceFile(path)
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
    />
  )

  const activeWorkspaceFileTabContent = isWorkspaceFileWorkspaceTab(activeWorkspaceTab) ? (
    activeWorkspaceTab.kind === 'notebook' ? (
      activeAnalysisView
    ) : activeFilePreviewState ? (
      <FilePreviewPanel
        layout="workspace"
        state={activeFilePreviewState}
        onOpenFile={onOpenFilePreview}
        onOpenDefaultPath={onOpenDefaultPreviewPath}
        onRevealPath={onRevealPreviewPath}
        onListDirectory={onListPreviewDirectory}
      />
    ) : null
  ) : null

  const activeWorkspaceTabContent =
    activeWorkspaceTab?.kind === 'session'
      ? chatWorkspaceContent
      : isWorkspaceFileWorkspaceTab(activeWorkspaceTab)
        ? activeWorkspaceFileTabContent
        : activeWorkspaceResourceContent

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
            width: isSidebarOpen ? activityBarWidth + sidebarWidth : activityBarWidth,
            backgroundColor: (muiTheme) =>
              muiTheme.palette.mode === 'dark' ? muiTheme.palette.background.default : '#FFFFFF',
            pointerEvents: 'none',
            zIndex: 0
          }}
        />
        <AppActivityBar
          activeView={activeView}
          isWorkspaceSidebarModeExpanded={isWorkspaceSidebarModeExpanded}
          shouldUseWorkspaceSidebarPreview={shouldUseWorkspaceSidebarPreview}
          openWorkspaceSidebarPreview={openWorkspaceSidebarPreview}
          scheduleWorkspaceSidebarPreviewClose={scheduleWorkspaceSidebarPreviewClose}
          onSelectWorkspaceView={onSelectWorkspaceView}
          onSelectWorkspaceSidebarMode={onSelectWorkspaceSidebarMode}
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
          onNewChat={onNewChatFromSidebar}
          setIsNewProjectDialogOpen={setIsNewProjectDialogOpen}
          onSelectSession={onOpenSessionFromSidebar}
          onRenameSession={onRenameSession}
          onDeleteSession={onDeleteSession}
          onStartProjectChat={onStartProjectChatFromSidebar}
          onDeleteProjectEntry={onDeleteProjectEntry}
          onFetchProjectSessions={onFetchProjectSessions}
          getSessionRuntimeState={getSessionRuntimeState}
        />

        <AppWorkspaceSidebar
          isSidebarOpen={isSidebarOpen}
          sidebarWidth={sidebarWidth}
          activeView={activeView}
          activeChatView={activeChatView}
          onStartSidebarResize={onStartSidebarResize}
          activeWorkspaceIsProject={activeWorkspaceIsProject}
          activeWorkspaceTitle={activeWorkspaceTitle}
          activeWorkspaceScopeLabel={activeWorkspaceScopeLabel}
          workspaceSidebarMode={workspaceSidebarMode}
          workspaceRootPath={activeCwd}
          activeWorkspacePath={activeWorkspaceSidePanelPath}
          workspaceFileTreeRevision={workspaceSidePanelTreeRevision}
          onOpenWorkspaceFile={onOpenWorkspaceFileFromSidebar}
          onListWorkspaceDirectory={onListPreviewDirectory}
          runtimeProjectCwd={activeProject?.workingDirectory ?? ''}
          runtimeStatus={analysisJupyterRuntimeStatus}
          isRuntimeLoading={isLoadingAnalysisJupyterRuntime || isStartingAnalysisJupyter}
          runtimeClosingNotebookPath={closingRuntimeNotebookPath}
          onOpenRuntimeNotebook={onOpenNotebookWorkspaceFile}
          onRefreshRuntime={() => {
            void refreshAnalysisJupyterRuntimeStatus()
          }}
          onStartRuntime={(cwd) => {
            void onStartAnalysisJupyter(cwd).then(() => refreshAnalysisJupyterRuntimeStatus())
          }}
          onStopRuntime={(cwd) => {
            void onStopAnalysisJupyter(cwd).then(() => refreshAnalysisJupyterRuntimeStatus())
          }}
          onStopRuntimeNotebookKernel={(notebookPath) => {
            void onStopRuntimeNotebookSession(notebookPath)
          }}
          plugins={plugins}
          activePluginId={activePluginId}
          isLoadingPlugins={isLoadingPlugins}
          onOpenPlugin={onOpenPluginTab}
          onRefreshPlugins={() => {
            void refreshPlugins()
          }}
          skills={skills}
          activeSkillId={activeSkillId}
          isLoadingSkills={isLoadingSkills}
          onOpenSkill={onOpenSkillTab}
          mcpServers={mcpServers}
          activeMcpServerId={activeMcpServerId}
          onOpenMcpServer={onOpenMcpServerTab}
          wrapperCatalog={wrapperCatalog}
          selectedWrapperId={selectedWrapperId}
          isLoadingWrappers={isLoadingWrappers}
          onOpenWrapper={onOpenWrapperTab}
          onRefreshWrappers={() => {
            void refreshWrappers()
          }}
          sessions={sessions}
          activeSessionPath={activeSessionPath}
          activeCwd={activeCwd}
          projects={projects}
          projectSessionRefreshKey={projectSessionRefreshKey}
          onNewChat={onNewChatFromSidebar}
          setIsNewProjectDialogOpen={setIsNewProjectDialogOpen}
          onSelectSession={onOpenSessionFromSidebar}
          onRenameSession={onRenameSession}
          onDeleteSession={onDeleteSession}
          onStartProjectChat={onStartProjectChatFromSidebar}
          onDeleteProjectEntry={onDeleteProjectEntry}
          onFetchProjectSessions={onFetchProjectSessions}
          getSessionRuntimeState={getSessionRuntimeState}
        />

        {isWorkspaceView ? (
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
                    flex: filePreview && !showProjectSessionPlaceholder ? '1 1 320px' : 1,
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
                {filePreview && !showProjectSessionPlaceholder ? (
                  <FilePreviewTitleTab
                    state={filePreview}
                    titlebarInsetEnd={
                      workspaceSidePanelCollapsed ? titlebarTrailingToggleChromeReserve : 1.25
                    }
                    onClose={onCloseCurrentFilePreview}
                  />
                ) : null}
              </Box>
            ) : null}
            <Box sx={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', overflow: 'hidden' }}>
              {showWorkspaceTabs ? (
                <Box
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    minHeight: 0,
                    display: 'flex',
                    flexDirection: 'column'
                  }}
                >
                  <WorkspaceResourceHeader
                    tabs={visibleWorkspaceTabs}
                    activeKey={effectiveActiveWorkspaceTabKey}
                    onSelect={selectWorkspaceTab}
                    onClose={onCloseWorkspaceTab}
                    reserveLeadingChromeSpace={isMac && !isSidebarOpen}
                    reserveTrailingChromeSpace={workspaceSidePanelCollapsed}
                  />
                  <Box
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      minHeight: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      overflow: 'hidden'
                    }}
                  >
                    {activeWorkspaceTabContent}
                  </Box>
                </Box>
              ) : isAnalysisWorkspaceView &&
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
                    reserveLeadingChromeSpace={isMac && !isSidebarOpen}
                    reserveTrailingChromeSpace={workspaceSidePanelCollapsed}
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
                activeAnalysisView
              ) : (
                chatWorkspaceContent
              )}
            </Box>
          </Box>
        ) : (
          <Box component="main" sx={{ flex: 1, minWidth: 0, height: '100vh' }} />
        )}

        {!workspaceSidePanelCollapsed ? (
          <>
            <AppResizeSeparator
              label="调整工作区面板宽度"
              onMouseDown={onStartWorkspaceSidePanelResize}
            />
            <Box
              data-phi-workspace-side-panel-shell="true"
              sx={{
                height: '100vh',
                flexShrink: 0,
                display: 'flex',
                minWidth: 0,
                minHeight: 0
              }}
            >
              <WorkspaceSidePanel width={workspaceSidePanelWidth} />
            </Box>
          </>
        ) : null}

        {/* App chrome renders after view titlebars so Electron drag regions cannot swallow clicks. */}
        {isMac && (
          <Box
            data-phi-window-top-left-chrome="true"
            sx={{
              position: 'absolute',
              top: titlebarChromeTopOffset,
              left: titlebarChromeHorizontalInset,
              display: 'flex',
              alignItems: 'center',
              gap: '18px',
              pointerEvents: 'auto',
              zIndex: 30,
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
        <Box
          data-phi-workspace-top-right-chrome="true"
          sx={{
            position: 'absolute',
            top: titlebarChromeTopOffset,
            right: titlebarChromeHorizontalInset,
            display: 'flex',
            alignItems: 'center',
            pointerEvents: 'auto',
            zIndex: 30,
            WebkitAppRegion: 'no-drag'
          }}
        >
          <TopRightControls
            showSidePanelRefresh={false}
            sidePanelRefreshDisabled={false}
            showSidePanelToggle
            sidePanelCollapsed={workspaceSidePanelCollapsed}
            onRefreshSidePanel={onRefreshWorkspaceSidePanel}
            onToggleSidePanel={onToggleWorkspaceSidePanel}
          />
        </Box>

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
          defaultProxyMode={defaultProxyMode}
          noProjectTaskFolder={noProjectTaskFolder}
          preventSleepDuringRuns={preventSleepDuringRuns}
          nextActionSuggestionsEnabled={nextActionSuggestionsEnabled}
          enableDbConnectorTools={enableDbConnectorTools}
          proxyTransportStatus={proxyTransportStatus}
          isSavingDefaultProxyMode={isSavingDefaultProxyMode}
          isSavingAppSettings={isSavingAppSettings}
          onSelectDefaultProxyMode={onSelectDefaultProxyMode}
          onUpdateAppSettings={onUpdateAppSettings}
          onPickNoProjectTaskFolder={onPickNoProjectTaskFolder}
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
