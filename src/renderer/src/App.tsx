import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent
} from 'react'
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
import { alpha, type SxProps, type Theme } from '@mui/material/styles'
import { GoGlobe, GoStack, GoSync, GoTerminal } from 'react-icons/go'
import {
  DEFAULT_NEXT_ACTION_SUGGESTIONS_ENABLED,
  DEFAULT_PREVENT_SLEEP_DURING_RUNS
} from '../../shared/appSettingsTypes'
import type { WrapperCompositionManifest } from '../../shared/wrapperCompositionManifestTypes'
import type { WrapperRun } from '../../shared/wrapperTypes'
import type { RemoteProjectCreateInput } from '../../shared/projectLocation'
import { MAX_PROMPT_IMAGES, type PromptImageInput } from '../../shared/promptImageTypes'
import type { ManualCompactionTarget } from '../../shared/contextUsageTypes'
import type { PackageRegistryEntryView } from '../../shared/packageManagerTypes'
import ChatView from './features/chat/ChatView'
import { ChatArtifactSplit } from './features/chat/components/ChatArtifactSplit'
import {
  shouldEnableOfficeChatSplit,
  sidebarHostsCurrentConversation
} from './features/chat/lib/chatArtifactSplit'
import { OfficeCreateButton } from './features/office/components/OfficeCreateButton'
import { isOfficeDocumentPath } from './lib/officeDocumentPath'
import { useOfficePromptTarget } from './features/office/hooks/useOfficePromptTarget'
import { officeDocumentRegistry } from './features/office/lib/officeDocumentRegistry'
import {
  retargetCapturedOfficePrompt,
  visibleOfficeComposerTarget,
  withCapturedOfficeTarget
} from './features/office/lib/officePromptTarget'
import {
  isOfficePromptTargetFailure,
  officePromptFailureRecovery
} from './features/office/lib/officePromptFailure'
import { HomeView } from './features/home/HomeView'
import { SessionExportDialog } from './features/chat/components/SessionExportDialog'
import MacWindowControls from './components/MacWindowControls'
import WindowNavigationControls from './components/WindowNavigationControls'
import { SessionSearchPanel } from './features/session-search/SessionSearchPanel'
import { BackgroundJobsPanel } from './features/jobs/BackgroundJobsPanel'
import BrowserPanel from './features/browser/BrowserPanel'
import TerminalPanel from './features/terminal/TerminalPanel'
import { useTerminalWorkspaceRestoration } from './features/terminal/hooks/useTerminalWorkspaceRestoration'
import { useBrowserTrustedOverlayGate } from './features/browser/hooks/useBrowserTrustedOverlayGate'
import { useBrowserPanelRequests } from './features/browser/hooks/useBrowserPanelRequests'
import { createBrowserLinkOpeningCoordinator } from './features/browser/lib/browserLinkOpening'
import { createBrowserRequestIdFactory } from './features/browser/lib/browserPanelState'
import type { BrowserTrustedOverlayRequest } from './features/browser/lib/browserTrustedOverlayGate'
import { useEnvironmentBuildNotices } from './features/jobs/hooks/useEnvironmentBuildNotices'
import type { LocalPathKind } from './components/MarkdownContent'
import { useDeveloperExtensionCatalog } from './features/developer-extensions/hooks/useDeveloperExtensionCatalog'
import PhiPluginsView, { PhiPluginCatalogDialog } from './features/phi-plugin/PhiPluginsView'
import { usePhiPlugins, type PhiPluginDisplayItem } from './features/phi-plugin/hooks/usePhiPlugins'
import { WrapperDetail } from './features/wrapper/WrapperView'
import { useWrapperCatalog } from './features/wrapper/hooks/useWrapperCatalog'
import {
  wrapperResultBelongsToProject,
  wrapperResultScopeForPath
} from './features/wrapper/lib/resultFiles'
import { SkillCatalogDialog, SkillDetail } from './features/skill/SkillView'
import { useSkillCatalog } from './features/skill/hooks/useSkillCatalog'
import { McpDetail } from './features/mcp/McpView'
import { ConnectorIcon } from './features/mcp/components/ConnectorIcon'
import { useMcpServerCatalog } from './features/mcp/hooks/useMcpServerCatalog'
import { type SettingsCategory } from './components/SettingsDialog'
import AppDialogs, { type SnackbarNotice } from './AppDialogs'
import AppActivityBar from './AppActivityBar'
import AppWorkspaceSidebar, { type WorkspaceSidebarDataProps } from './AppWorkspaceSidebar'
import FilePreviewPanel, {
  FilePreviewTitleTab,
  type FilePreviewPanelState
} from './features/file-preview/FilePreviewPanel'
import AnalysisView, { type AnalysisWorkspaceFileTab } from './features/analysis/AnalysisView'
import { WorkspaceSidePanel } from './components/WorkspaceSidePanel'
import { PackageUpdateNotice } from './components/PackageUpdateNotice'
import { useAnalysisNotebookRuntime } from './features/analysis/hooks/useAnalysisNotebookRuntime'
import { WorkspaceResourceTabs } from './components/WorkspaceResourceTabs'
import { createAppTheme } from './theme'
import { createMinimalTheme } from './minimalTheme'
import { useThemeMode } from './useThemeMode'
import { useProviderAuth } from './useProviderAuth'
import { modelOptionFromSelection, useModelSelection } from './useModelSelection'
import { useProjects } from './useProjects'
import {
  upsertReusableWorkspaceFileTab,
  useWorkspaceFileTabs,
  type WorkspaceFileTab
} from './useWorkspaceFileTabs'
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
import { useWindowFullscreen } from './lib/useWindowFullscreen'
import { WINDOW_TITLEBAR_HEIGHT, windowChromeLayout } from './lib/windowChromeLayout'
import {
  absoluteWorkspacePath,
  fileNameFromPath,
  filePreviewStatePath,
  shouldClearWorkspaceFilesForRemoteSwitch
} from './lib/workspacePaths'
import {
  remotePathInsideRoot,
  remotePathWithinProjectUri,
  remoteWorkspaceUri
} from '../../shared/remoteWorkspacePath'
import { RemoteProjectFileContext } from './lib/remoteProjectFileContext'
import { RemoteConnectionNotice } from './features/project/components/RemoteConnectionNotice'
import { shouldRetryRemoteReads } from './features/project/lib/remoteConnectionUi'
import type { RemoteProjectReachability } from '../../shared/projectLocation'
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
import { orderSessionsForDisplay } from './lib/sessionOrder'
import {
  isPointerWithinWorkspaceSidebarPreview,
  isWorkspaceSidebarPreviewDialogActive
} from './lib/workspaceSidebarPreviewPointer'
import { sessionDisplayTitle, titleFromMessages, truncateSessionTitle } from './lib/sessionTitles'
import { isNotebookFilePath } from './features/analysis/lib/notebookPaths'
import { orderProjectsForSessionSelection } from './lib/projectSidebar'
import { workspaceScopeLabelForCwd } from './lib/workspaceScope'
import {
  isWorkspaceFileTabKind,
  isWorkspaceResourceKind,
  upsertWorkspaceResourceTab,
  workspaceFileTabKey,
  workspaceResourceKindLabel,
  workspaceResourceKindToSidebarMode,
  workspaceResourceTabKey,
  activeTabKeyAfterPrompt,
  workspaceSessionTabKey,
  visibleWorkspaceTabsForState,
  type WorkspaceFileWorkspaceTab,
  type WorkspaceResourceKind,
  type WorkspaceResourceTab,
  type WorkspaceSessionTab,
  type WorkspaceTab
} from './lib/workspaceResourceTabs'
import { workspaceSidebarModeIsExpanded, type WorkspaceSidebarMode } from './lib/workspaceSidebar'
import {
  closeWorkspaceSidePanelMode,
  emptyWorkspaceSidePanelState,
  openWorkspaceSidePanelMode,
  toggleWorkspaceSidePanelMaximized,
  toggleWorkspaceSidePanelModeForLayout,
  workspaceSidePanelWidthForViewport,
  type WorkspaceSidePanelMode
} from './lib/workspaceSidePanelMode'
import { PhiIcons, fileIconForPath, directoryIconForPath } from './icons'
import {
  idleSessionRuntimeState,
  reduceSessionRuntimeState,
  sessionRuntimeStateIsBusy,
  sessionRuntimeStatePausesQueue,
  sessionStatusIsBusy
} from './lib/sessionRuntimeState'
import { createAgentEventReducerState, reduceAgentEventState } from './lib/agentEventReducer'
import { navigationPaneWidth } from './layout'
import type { UserMessageRetryTarget } from './components/chat/ChatUserMessage'
import type {
  AgentEventSummary,
  AnalysisNotebookFileChange,
  EnvironmentSnapshot,
  EnvironmentToolId,
  McpServerSummary,
  ModelOption,
  PhiAppSettings,
  PhiAppSettingsPatch,
  PermissionMode,
  PromptTarget,
  Project,
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
  images?: PromptImageInput[]
  planMode?: boolean
}

const activityBarWidth = 48
const minNavigationPaneWidth = 240
const maxNavigationPaneWidth = 520
const workspaceSidePanelWidthDefault = 340
const minWorkspaceSidePanelWidth = 240
const maxWorkspaceSidePanelWidth = 520
const titlebarChromeHorizontalInset = '14px'
const titlebarChromeIconButtonSize = 28
const titlebarChromeTopOffset = `${(WINDOW_TITLEBAR_HEIGHT - titlebarChromeIconButtonSize) / 2}px`
const titlebarTrailingToggleChromeReserve = '120px'

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
  activePanels,
  showSidePanelButtons,
  onRefreshSidePanel,
  onTogglePanel
}: {
  showSidePanelRefresh: boolean
  sidePanelRefreshDisabled: boolean
  activePanels: readonly WorkspaceSidePanelMode[]
  showSidePanelButtons: boolean
  onRefreshSidePanel: () => void
  onTogglePanel: (mode: WorkspaceSidePanelMode) => void
}): React.JSX.Element | null {
  if (!showSidePanelRefresh && !showSidePanelButtons) return null

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
  const panelButtonSx = (active: boolean): SxProps<Theme> => ({
    ...buttonSx,
    color: active ? 'primary.main' : 'text.secondary',
    '&:hover': {
      bgcolor: 'action.hover',
      color: active ? 'primary.main' : 'text.primary'
    },
    '& svg': { color: 'inherit', display: 'block' }
  })

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
      {showSidePanelButtons ? (
        <Tooltip title="后台任务">
          <IconButton
            data-phi-background-jobs-toggle-button="true"
            data-phi-workspace-panel-toggle="jobs"
            size="small"
            aria-label="后台任务"
            aria-pressed={activePanels.includes('jobs')}
            onClick={() => onTogglePanel('jobs')}
            sx={panelButtonSx(activePanels.includes('jobs'))}
          >
            <GoStack aria-hidden focusable="false" size={20} />
          </IconButton>
        </Tooltip>
      ) : null}
      {showSidePanelButtons ? (
        <Tooltip title="终端">
          <IconButton
            data-phi-terminal-toggle-button="true"
            data-phi-workspace-panel-toggle="terminal"
            size="small"
            aria-label="终端"
            aria-pressed={activePanels.includes('terminal')}
            onClick={() => onTogglePanel('terminal')}
            sx={panelButtonSx(activePanels.includes('terminal'))}
          >
            <GoTerminal aria-hidden focusable="false" size={20} />
          </IconButton>
        </Tooltip>
      ) : null}
      {showSidePanelButtons ? (
        <Tooltip title="浏览器">
          <IconButton
            data-phi-browser-toggle-button="true"
            data-phi-workspace-panel-toggle="browser"
            size="small"
            aria-label="浏览器"
            aria-pressed={activePanels.includes('browser')}
            onClick={() => onTogglePanel('browser')}
            sx={panelButtonSx(activePanels.includes('browser'))}
          >
            <GoGlobe aria-hidden focusable="false" size={20} />
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
            {tab.dirty && (
              <Box
                component="span"
                role="img"
                aria-label="未保存修改"
                sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: 'warning.main' }}
              />
            )}
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
  leadingChromeInset = 0,
  reserveTrailingChromeSpace = false
}: {
  tabs: WorkspaceFileTab[]
  activePath: string | null
  onSelect: (tab: WorkspaceFileTab) => void
  onClose: (tab: WorkspaceFileTab) => void
  leadingChromeInset?: number
  reserveTrailingChromeSpace?: boolean
}): React.JSX.Element {
  return (
    <Box
      data-phi-workspace-file-header="true"
      sx={{
        height: WINDOW_TITLEBAR_HEIGHT,
        flexShrink: 0,
        pl: leadingChromeInset > 0 ? `${leadingChromeInset}px` : 1.5,
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
  actions,
  leadingChromeInset = 0,
  reserveTrailingChromeSpace = false
}: {
  tabs: WorkspaceTab[]
  activeKey: string | null
  onSelect: (tab: WorkspaceTab) => void
  onClose: (tab: WorkspaceTab) => void
  actions?: React.ReactNode
  leadingChromeInset?: number
  reserveTrailingChromeSpace?: boolean
}): React.JSX.Element {
  return (
    <Box
      data-phi-workspace-resource-header="true"
      sx={{
        height: WINDOW_TITLEBAR_HEIGHT,
        flexShrink: 0,
        pl: leadingChromeInset > 0 ? `${leadingChromeInset}px` : 1.5,
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
        connectorIcon={renderConnectorTabIcon}
        fileIcon={renderFileWorkspaceTabIcon}
      />
      {actions}
    </Box>
  )
}

function renderConnectorTabIcon(connectorId?: string): React.JSX.Element {
  return <ConnectorIcon connectorId={connectorId} size={20} />
}

function renderFileWorkspaceTabIcon(tab: WorkspaceFileWorkspaceTab): React.JSX.Element {
  const icon =
    tab.kind === 'directory' ? directoryIconForPath(tab.path, false) : fileIconForPath(tab.path)
  const Icon = icon.Icon
  return <Icon sx={{ flexShrink: 0, fontSize: 18, color: icon.color }} />
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
  const {
    mode: themeMode,
    effectiveMode,
    setMode: setThemeMode,
    family: themeFamily,
    setFamily: setThemeFamily
  } = useThemeMode()
  const theme = useMemo(
    () =>
      themeFamily === 'minimal' ? createMinimalTheme(effectiveMode) : createAppTheme(effectiveMode),
    [themeFamily, effectiveMode]
  )

  const {
    sessions,
    setSessions,
    activeSessionPath,
    setActiveSessionPath,
    activePhiSessionId,
    setActivePhiSessionId,
    activeCwd,
    activeDisplayCwd,
    activeProjectId,
    activeProjectLocation,
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
  const [chatScrollPositionStore] = useState(() => new Map<string, number>())
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const compactingSessionKeysRef = useRef(new Set<string>())
  const [compactingSessions, setCompactingSessions] = useState<Set<string>>(() => new Set())
  const [contextUsageRefreshKey, setContextUsageRefreshKey] = useState(0)
  const [isSessionSearchOpen, setIsSessionSearchOpen] = useState(false)
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>('general')
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
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
  const [sessionTabWasOpened, setSessionTabWasOpened] = useState(false)
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
  const [isSkillCatalogOpen, setIsSkillCatalogOpen] = useState(false)
  const [isPhiPluginCatalogOpen, setIsPhiPluginCatalogOpen] = useState(false)
  const [isBusy, setIsBusy] = useState(false)
  const [isSendingMessage, setIsSendingMessage] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [personaMarkdown, setPersonaMarkdownState] = useState<string | null>(null)
  const [noProjectTaskFolder, setNoProjectTaskFolder] = useState('')
  const [preventSleepDuringRuns, setPreventSleepDuringRuns] = useState(
    DEFAULT_PREVENT_SLEEP_DURING_RUNS
  )
  const [nextActionSuggestionsEnabled, setNextActionSuggestionsEnabled] = useState(
    DEFAULT_NEXT_ACTION_SUGGESTIONS_ENABLED
  )
  const [environmentSnapshot, setEnvironmentSnapshot] = useState<EnvironmentSnapshot | null>(null)
  const [isLoadingEnvironment, setIsLoadingEnvironment] = useState(true)
  const [isRedetectingEnvironment, setIsRedetectingEnvironment] = useState(false)
  const [showEnvironmentSummary, setShowEnvironmentSummary] = useState(false)
  const [isSavingAppSettings, setIsSavingAppSettings] = useState(false)
  const [snackbarNotice, setSnackbarNotice] = useState<SnackbarNotice | null>(null)
  const [exportTarget, setExportTarget] = useState<SessionSummary | null>(null)
  const [isExportingSession, setIsExportingSession] = useState(false)
  const isSendingRef = useRef(false)
  const currentSessionIsBusyRef = useRef(false)
  const sessionRequestRef = useRef(0)
  const sendRequestRef = useRef(0)
  const projectSidebarSelectionRequestRef = useRef(0)
  const rendererApi = useMemo(() => getRendererApi(), [])
  const isWindowFullscreen = useWindowFullscreen(rendererApi, isMac)
  const chromeLayout = windowChromeLayout({
    isMac,
    sidebarOpen: isSidebarOpen,
    fullscreen: isWindowFullscreen
  })
  const getActiveCwd = useCallback(() => useSessionStore.getState().activeCwd, [])
  const getActiveProjectId = useCallback(() => useSessionStore.getState().activeProjectId, [])

  const { extensions: plugins, refreshExtensions: refreshPlugins } = useDeveloperExtensionCatalog()
  const phiPluginsState = usePhiPlugins()
  const refreshPhiPluginsForNavigation = phiPluginsState.refreshForNavigation
  const {
    skills,
    promptAgents,
    activeSkillId,
    isLoadingSkills,
    busySkillId,
    setActiveSkillId,
    refreshSkills,
    refreshSkillsForNavigation,
    refreshPromptAgents,
    setGlobalEnabled,
    setProjectOverride,
    setSkillDisabled,
    deleteSkill
  } = useSkillCatalog(getActiveCwd)
  const {
    mcpServers,
    activeMcpServerId,
    setActiveMcpServerId,
    refreshMcpServers,
    refreshMcpServersForNavigation
  } = useMcpServerCatalog(getActiveCwd)
  const {
    catalog: wrapperCatalog,
    runs: wrapperRuns,
    selectedWrapperId,
    isLoadingWrappers,
    wrapperError,
    packageEnablementBusy,
    busyPackageId: busyWrapperPackageId,
    setSelectedWrapperId,
    refreshWrappers,
    refreshRuns: refreshWrapperRuns,
    cancelWrapperRun,
    exportWrapperReproducibility,
    setPackageEnabled
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
  useEnvironmentBuildNotices(showSnackbar)

  const showSnackbarError = useCallback(
    (error: unknown, fallback: string): void => {
      showSnackbar(readableErrorMessage(error, fallback), 'error')
    },
    [showSnackbar]
  )

  const blockRemoteLocalFileAction = useCallback((): boolean => {
    if (useSessionStore.getState().activeProjectLocation?.kind !== 'ssh') return false
    showSnackbarError(new Error('远程项目的文件操作暂不可用'), '远程项目的文件操作暂不可用')
    return true
  }, [showSnackbarError])

  const applyAppSettings = useCallback((settings: PhiAppSettings): void => {
    setNoProjectTaskFolder(settings.noProjectTaskFolder)
    setPreventSleepDuringRuns(settings.preventSleepDuringRuns)
    setNextActionSuggestionsEnabled(settings.nextActionSuggestionsEnabled)
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

  useEffect(() => {
    let cancelled = false
    void rendererApi
      .getEnvironment()
      .then((result) => {
        if (cancelled) return
        setEnvironmentSnapshot(result.snapshot)
        setShowEnvironmentSummary(result.showSummary)
      })
      .catch((error) => {
        if (!cancelled) {
          showSnackbarError(error, '读取工作台环境失败')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingEnvironment(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [rendererApi, showSnackbarError])

  const onRedetectEnvironment = useCallback(async (): Promise<void> => {
    setIsRedetectingEnvironment(true)
    try {
      setEnvironmentSnapshot(await rendererApi.redetectEnvironment())
    } catch (error) {
      showSnackbarError(error, '重新检测环境失败')
    } finally {
      setIsRedetectingEnvironment(false)
    }
  }, [rendererApi, showSnackbarError])

  const onSetEnvironmentToolPath = useCallback(
    async (toolId: EnvironmentToolId, path: string | null): Promise<void> => {
      setEnvironmentSnapshot(await rendererApi.setEnvironmentToolPath(toolId, path))
    },
    [rendererApi]
  )

  const onDismissEnvironmentSummary = useCallback(async (): Promise<void> => {
    setShowEnvironmentSummary(false)
    try {
      setEnvironmentSnapshot(await rendererApi.dismissEnvironmentSummary())
    } catch (error) {
      showSnackbarError(error, '关闭环境摘要失败')
    }
  }, [rendererApi, showSnackbarError])

  const onUpdateAppSettings = useCallback(
    async (patch: PhiAppSettingsPatch): Promise<void> => {
      const previousNoProjectTaskFolder = noProjectTaskFolder
      const previousPreventSleepDuringRuns = preventSleepDuringRuns
      const previousNextActionSuggestionsEnabled = nextActionSuggestionsEnabled

      if (patch.noProjectTaskFolder !== undefined) {
        setNoProjectTaskFolder(patch.noProjectTaskFolder)
      }
      if (patch.preventSleepDuringRuns !== undefined) {
        setPreventSleepDuringRuns(patch.preventSleepDuringRuns)
      }
      if (patch.nextActionSuggestionsEnabled !== undefined) {
        setNextActionSuggestionsEnabled(patch.nextActionSuggestionsEnabled)
      }

      setIsSavingAppSettings(true)
      try {
        const settings = await rendererApi.updateAppSettings(patch)
        applyAppSettings(settings)
      } catch (error) {
        setNoProjectTaskFolder(previousNoProjectTaskFolder)
        setPreventSleepDuringRuns(previousPreventSleepDuringRuns)
        setNextActionSuggestionsEnabled(previousNextActionSuggestionsEnabled)
        showSnackbarError(error, '保存通用设置失败')
      } finally {
        setIsSavingAppSettings(false)
      }
    },
    [
      applyAppSettings,
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
  } = useProviderAuth(setIsBusy, showSnackbar)
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
  useTerminalWorkspaceRestoration(rendererApi.terminal, projects, activeProjectId)

  const getActiveRemoteProject = useCallback(() => {
    const state = useSessionStore.getState()
    if (state.activeProjectLocation?.kind !== 'ssh') return null
    const project = projectsRef.current.find((item) => item.id === state.activeProjectId)
    if (!state.activePhiSessionId || !state.activeProjectId || !project?.remoteHostAlias) {
      return null
    }
    return {
      sessionId: state.activePhiSessionId,
      projectId: state.activeProjectId,
      hostAlias: project.remoteHostAlias,
      canonicalRoot: state.activeProjectLocation.canonicalRoot
    }
  }, [projectsRef])

  const {
    filePreview,
    setFilePreview,
    filePreviewCache,
    clearCachedFilePreview,
    clearFileWorkspace,
    workspaceFileTabs,
    setWorkspaceFileTabs,
    activeWorkspaceFilePath,
    setActiveWorkspaceFilePath,
    filePreviewRequestRef,
    activeWrapperResultScope,
    isActiveWrapperResultUri,
    openWrapperResultPath,
    cancelActiveWrapperResultRead,
    fileDownload,
    downloadWrapperResultFile,
    cancelActiveWrapperResultDownload,
    loadFilePreview,
    previewFilePath,
    previewDirectoryPath,
    onRevealPreviewPath,
    onListPreviewDirectory,
    openPathWithSystemDefault
  } = useWorkspaceFileTabs({
    rendererApi,
    getActiveCwd,
    getActiveProjectId,
    getActiveRemoteProject,
    showSnackbarError,
    setIsSidebarOpen,
    setActiveView: navigateToView
  })
  const officeDevelopmentEnabled =
    typeof window !== 'undefined' && window.api?.office?.enabled === true
  const activeOfficeFileTab = workspaceFileTabs.find(
    (tab) =>
      tab.path === activeWorkspaceFilePath &&
      activeWorkspaceTabKey === workspaceFileTabKey(tab.path) &&
      isOfficeDocumentPath(tab.path)
  )
  const readyOfficeTarget = useOfficePromptTarget(
    officeDevelopmentEnabled ? (activeOfficeFileTab?.path ?? null) : null,
    activeOfficeFileTab?.name ?? ''
  )
  const [dismissedOfficeArtifactId, setDismissedOfficeArtifactId] = useState<string | null>(null)
  const officeComposerTarget = visibleOfficeComposerTarget(
    readyOfficeTarget,
    dismissedOfficeArtifactId
  )
  const onClearOfficeSelection = useCallback(
    (artifactId: string): void => {
      officeDocumentRegistry.publishSelection(artifactId, null)
      void rendererApi.office.clearSelection({ artifactId }).catch(() => undefined)
    },
    [rendererApi]
  )

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
  const [appViewportSize, setAppViewportSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }))
  useEffect(() => {
    const onResize = (): void =>
      setAppViewportSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const appViewportWidth = appViewportSize.width
  const workspaceSidePanelCanSplit = appViewportWidth >= 1200 && appViewportSize.height >= 640
  const [workspaceSidePanelState, setWorkspaceSidePanelState] = useState(
    emptyWorkspaceSidePanelState
  )
  const workspaceSidePanelSlots = workspaceSidePanelState.slots
  const browserSlotVisible =
    workspaceSidePanelSlots.includes('browser') &&
    (workspaceSidePanelState.maximized === null ||
      workspaceSidePanelState.maximized === 'browser') &&
    (workspaceSidePanelSlots.length === 1 ||
      workspaceSidePanelCanSplit ||
      workspaceSidePanelState.active === 'browser')
  const openWorkspaceSidePanel = useCallback((mode: WorkspaceSidePanelMode): void => {
    setWorkspaceSidePanelState((current) => openWorkspaceSidePanelMode(current, mode))
  }, [])
  const openBrowserPanelFromRequest = useCallback((): void => {
    openWorkspaceSidePanel('browser')
  }, [openWorkspaceSidePanel])
  const showBrowserAppShellFailure = useCallback(
    (message: string): void => showSnackbar(message),
    [showSnackbar]
  )
  useBrowserPanelRequests({
    bridge: rendererApi.browser,
    activeSessionId: activePhiSessionId ?? null,
    onRequest: openBrowserPanelFromRequest,
    onFailure: showBrowserAppShellFailure
  })
  const showBrowserLinkFailure = useCallback((): void => {
    showSnackbar('无法在内置浏览器打开该链接。为安全起见，Phi 未跳转到外部浏览器。')
  }, [showSnackbar])
  const browserLinkOpeningCoordinator = useMemo(() => {
    const nextRequestId = createBrowserRequestIdFactory()
    return createBrowserLinkOpeningCoordinator({
      execute: (command) => rendererApi.browser.execute(command),
      nextRequestId,
      getActiveSessionId: () => useSessionStore.getState().activePhiSessionId,
      openBrowserPanel: () => openWorkspaceSidePanel('browser'),
      showFailure: showBrowserLinkFailure
    })
  }, [openWorkspaceSidePanel, rendererApi, showBrowserLinkFailure])
  const onOpenWebUrl = useCallback(
    (url: string): void => {
      void browserLinkOpeningCoordinator.open(url)
    },
    [browserLinkOpeningCoordinator]
  )
  useEffect(() => {
    browserLinkOpeningCoordinator.invalidate()
  }, [activePhiSessionId, activeSessionGeneration, browserLinkOpeningCoordinator])
  const closeBrowserPanelForTrustedOverlay = useCallback((): void => {
    browserLinkOpeningCoordinator.invalidate()
    setWorkspaceSidePanelState((current) => closeWorkspaceSidePanelMode(current, 'browser'))
  }, [browserLinkOpeningCoordinator])
  const handleBrowserTrustedOverlayFailure = useCallback((): void => {
    showSnackbar('无法安全显示应用对话框，请重试。')
  }, [showSnackbar])
  const {
    suspended: browserOverlaySuspended,
    enqueue: enqueueBrowserTrustedOverlayGate,
    cancel: cancelBrowserTrustedOverlay
  } = useBrowserTrustedOverlayGate({
    bridge: rendererApi.browser,
    activePhiSessionId: activePhiSessionId ?? null,
    activeSessionGeneration,
    browserOpen: browserSlotVisible,
    closeBrowserPanel: closeBrowserPanelForTrustedOverlay,
    onFailure: handleBrowserTrustedOverlayFailure
  })
  const enqueueBrowserTrustedOverlay = useCallback(
    (request: BrowserTrustedOverlayRequest): void => {
      browserLinkOpeningCoordinator.invalidate()
      enqueueBrowserTrustedOverlayGate(request)
    },
    [browserLinkOpeningCoordinator, enqueueBrowserTrustedOverlayGate]
  )
  const openLocalTrustedOverlay = useCallback(
    (key: string, publish: () => void, onCancel?: () => void): void => {
      cancelBrowserTrustedOverlay('local', key)
      enqueueBrowserTrustedOverlay({
        kind: 'local',
        key,
        publish,
        ...(onCancel ? { onCancel } : {})
      })
    },
    [cancelBrowserTrustedOverlay, enqueueBrowserTrustedOverlay]
  )
  const cancelLocalTrustedOverlay = useCallback(
    (key: string): void => cancelBrowserTrustedOverlay('local', key),
    [cancelBrowserTrustedOverlay]
  )
  const setSettingsOpenWithBrowserGate = useCallback(
    (open: boolean): void => {
      if (!open) {
        cancelBrowserTrustedOverlay('local', 'settings')
        setIsSettingsOpen(false)
        return
      }
      openLocalTrustedOverlay('settings', () => setIsSettingsOpen(true))
    },
    [cancelBrowserTrustedOverlay, openLocalTrustedOverlay]
  )
  const setNewProjectDialogOpenWithBrowserGate = useCallback(
    (open: boolean): void => {
      if (!open) {
        cancelBrowserTrustedOverlay('local', 'new-project')
        setIsNewProjectDialogOpen(false)
        return
      }
      openLocalTrustedOverlay('new-project', () => setIsNewProjectDialogOpen(true))
    },
    [cancelBrowserTrustedOverlay, openLocalTrustedOverlay]
  )
  const setSessionSearchOpenWithBrowserGate = useCallback(
    (open: boolean): void => {
      if (!open) {
        cancelBrowserTrustedOverlay('local', 'session-search')
        setIsSessionSearchOpen(false)
        return
      }
      openLocalTrustedOverlay('session-search', () => setIsSessionSearchOpen(true))
    },
    [cancelBrowserTrustedOverlay, openLocalTrustedOverlay]
  )
  const workspaceSidePanelCollapsed = workspaceSidePanelSlots.length === 0
  const [workspaceSidePanelWidth, setWorkspaceSidePanelWidth] = useState(
    workspaceSidePanelWidthDefault
  )
  const workspaceSidePanelEffectiveWidth = workspaceSidePanelWidthForViewport({
    preferredWidth: workspaceSidePanelWidth,
    viewportWidth: appViewportWidth,
    navigationWidth: activityBarWidth + (isSidebarOpen ? sidebarWidth : 0),
    compactMinimum: minWorkspaceSidePanelWidth,
    maximum: maxWorkspaceSidePanelWidth
  })
  const responsiveSingleVisibleMode =
    !workspaceSidePanelCanSplit && workspaceSidePanelSlots.length > 1
      ? (workspaceSidePanelState.active ?? workspaceSidePanelSlots.at(-1) ?? null)
      : null
  const workspaceSidePanelOverlay =
    appViewportWidth < 1100 || workspaceSidePanelEffectiveWidth < minWorkspaceSidePanelWidth
  const activeWorkspaceSidePanelWidth = workspaceSidePanelOverlay
    ? Math.min(workspaceSidePanelWidth, Math.max(0, appViewportWidth - 16))
    : workspaceSidePanelEffectiveWidth
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
      setSessionTabWasOpened(true)
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
        const tabKey = workspaceSessionTabKey(
          path,
          useSessionStore.getState().activeSessionGeneration
        )
        setSessionTabWasOpened(true)
        setClosedWorkspaceSessionTabKeys((keys) => {
          if (!keys.has(tabKey)) return keys
          const nextKeys = new Set(keys)
          nextKeys.delete(tabKey)
          return nextKeys
        })
        setActiveWorkspaceTabKey(tabKey)
        navigateToView('chat')
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
        setSessionTabWasOpened(true)
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

  const onDeleteSession = useCallback(
    async (path: string): Promise<void> => {
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
          setSessionTabWasOpened(false)
          setActiveWorkspaceTabKey((currentKey) =>
            currentKey?.startsWith('session:') ? null : currentKey
          )
        }
      }
      await refreshSessions()
      setProjectSessionRefreshKey((key) => key + 1)
    },
    [
      rendererApi,
      applyCurrentSession,
      resetAnalysisJupyterRuntimeForCwdChange,
      onResetSending,
      refreshCurrentModelControls,
      replaceMessages,
      refreshSessions,
      setProjectSessionRefreshKey
    ]
  )

  const onExportSession = useCallback(
    (session: SessionSummary): void => {
      if (session.phiSessionId) {
        openLocalTrustedOverlay('session-export', () => setExportTarget(session))
      }
    },
    [openLocalTrustedOverlay]
  )

  const confirmExportSession = async (): Promise<void> => {
    if (!exportTarget?.phiSessionId || isExportingSession) return
    setIsExportingSession(true)
    try {
      const result = await rendererApi.exportSession(exportTarget.phiSessionId)
      setExportTarget(null)
      if (result) showSnackbar(`会话已导出到 ${result.path}`, 'success')
    } catch (error) {
      showSnackbarError(error, '导出会话失败')
    } finally {
      setIsExportingSession(false)
    }
  }

  const showActiveConversationInSidebar = useCallback((): void => {
    projectSidebarSelectionRequestRef.current += 1
    setWorkspaceSidebarMode('conversations')
    setIsSidebarOpen(true)
  }, [])

  const onNotebookDirtyChange = useCallback(
    (file: { path: string }, dirty: boolean): void => {
      setWorkspaceFileTabs((tabs) => {
        const current = tabs.find((tab) => tab.kind === 'notebook' && tab.path === file.path)
        if (!current || Boolean(current.dirty) === dirty) return tabs
        const updated = { ...current, dirty }
        return dirty
          ? tabs.map((tab) => (tab.path === file.path ? updated : tab))
          : upsertReusableWorkspaceFileTab(tabs, updated)
      })
    },
    [setWorkspaceFileTabs]
  )

  const onOpenNotebookWorkspaceFile = useCallback(
    (path: string): void => {
      if (blockRemoteLocalFileAction()) return
      const normalizedPath = absoluteWorkspacePath(useSessionStore.getState().activeCwd, path)
      const title = fileNameFromPath(normalizedPath)
      filePreviewRequestRef.current += 1
      setFilePreview(null)
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
        return upsertReusableWorkspaceFileTab(tabs, nextTab)
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
      blockRemoteLocalFileAction,
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

  const onStartProjectChat = useCallback(
    async (project: Project): Promise<void> => {
      projectSidebarSelectionRequestRef.current += 1
      const request = ++sessionRequestRef.current
      setIsSessionChanging(true)
      try {
        const current =
          project.location?.kind === 'ssh'
            ? await rendererApi.createRemoteProjectSession(project.id)
            : await rendererApi.createProjectSession(
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
        setSessionTabWasOpened(true)
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

  const onCreateRemoteProject = async (input: RemoteProjectCreateInput): Promise<void> => {
    await rendererApi.createRemoteProject(input)
    await refreshProjects()
    setWorkspaceSidebarMode('projects')
  }

  const onDeleteProjectEntry = useCallback(
    async (project: Project): Promise<void> => {
      await rendererApi.deleteProject(project.id)
      await refreshProjects()
    },
    [rendererApi, refreshProjects]
  )

  const onFetchProjectSessions = useCallback(
    async (workingDirectory: string, projectId?: string): Promise<SessionSummary[]> => {
      const project = projectId
        ? projectsRef.current.find((item) => item.id === projectId)
        : undefined
      if (projectId && !project) return []
      const sessions =
        project?.location.kind === 'ssh'
          ? await rendererApi.listProjectSessionsById(project.id)
          : await rendererApi.listProjectSessions(workingDirectory)
      return mergeSessionSummariesRuntimeState(sessions, workingDirectory)
    },
    [mergeSessionSummariesRuntimeState, rendererApi, projectsRef]
  )

  const onOpenApprovalSession = (path: string): void => {
    navigateToView('chat')
    setIsSettingsOpen(false)
    void onSelectSession(path)
  }

  const openSettings = useCallback(
    (category?: SettingsCategory): void => {
      if (category) {
        setSettingsCategory(category)
      }
      setSettingsOpenWithBrowserGate(true)
    },
    [setSettingsOpenWithBrowserGate]
  )

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
      enqueueBrowserTrustedOverlay({
        kind: 'auth',
        key: event.type === 'prompt' ? event.requestId : `${event.providerId}:${event.event.type}`,
        onCancel:
          event.type === 'prompt'
            ? () => rendererApi.submitAuthInteraction(event.requestId, '')
            : undefined,
        publish: () => {
          if (handleAuthInteractionEvent(event)) {
            setIsSettingsOpen(true)
          }
        }
      })
    })

    const unsubscribeToolApproval = rendererApi.onToolApprovalRequest((event) => {
      enqueueBrowserTrustedOverlay({
        kind: 'approval',
        key: event.requestId,
        onCancel: () => rendererApi.respondToolApproval(event.requestId, false),
        publish: () => {
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
        }
      })
    })

    const unsubscribeToolApprovalCancelled = rendererApi.onToolApprovalCancelled((requestId) => {
      cancelBrowserTrustedOverlay('approval', requestId)
      if (requestId) {
        for (const [key, request] of pendingApprovalsBySession) {
          if (request.requestId === requestId) pendingApprovalsBySession.delete(key)
        }
        if (useSessionStore.getState().pendingApproval?.requestId === requestId) {
          setPendingApproval(null)
        }
      } else {
        pendingApprovalsBySession.clear()
        setPendingApproval(null)
      }
      scheduleSessionRefresh()
    })

    const unsubscribeAgentUserInteraction = rendererApi.onAgentUserInteractionRequest((event) => {
      enqueueBrowserTrustedOverlay({
        kind: 'interaction',
        key: event.requestId,
        onCancel: () =>
          rendererApi.respondAgentUserInteraction(
            event.requestId,
            { requestId: event.requestId, answers: [], cancelled: true },
            true
          ),
        publish: () => {
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
        }
      })
    })

    const unsubscribeAgentUserInteractionCancelled = rendererApi.onAgentUserInteractionCancelled(
      () => {
        cancelBrowserTrustedOverlay('interaction')
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
    cancelBrowserTrustedOverlay,
    cancelScheduledSessionRefresh,
    enqueueBrowserTrustedOverlay,
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
      setSessions(
        orderSessionsForDisplay(mergeSessionSummariesRuntimeState(sessionList, current.cwd))
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
        void refreshPhiPluginsForNavigation()
      }
      if (workspaceSidebarMode === 'skills') {
        void refreshSkillsForNavigation()
      }
      if (workspaceSidebarMode === 'mcp') {
        void refreshMcpServersForNavigation()
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
    refreshMcpServersForNavigation,
    refreshPhiPluginsForNavigation,
    refreshProjects,
    refreshSkillsForNavigation,
    workspaceSidebarMode
  ])

  const activeDraftKey = sessionDraftKey({
    phiSessionId: activePhiSessionId,
    path: activeSessionPath,
    cwd: activeCwd,
    sessionGeneration: activeSessionGeneration
  })
  const input = draftInputs[activeDraftKey] ?? ''
  const [planReviewByDraft, setPlanReviewByDraft] = useState<Record<string, boolean>>({})
  const planReviewEnabled = planReviewByDraft[activeDraftKey] === true
  const togglePlanReview = useCallback((): void => {
    setPlanReviewByDraft((previous) => ({
      ...previous,
      [activeDraftKey]: previous[activeDraftKey] !== true
    }))
  }, [activeDraftKey])
  const [draftImagesBySession, setDraftImagesBySession] = useState<
    Record<string, PromptImageInput[]>
  >({})
  const inputImages = draftImagesBySession[activeDraftKey] ?? []
  const addInputImages = useCallback(
    (images: PromptImageInput[]): void => {
      setDraftImagesBySession((prev) => ({
        ...prev,
        [activeDraftKey]: [...(prev[activeDraftKey] ?? []), ...images].slice(0, MAX_PROMPT_IMAGES)
      }))
    },
    [activeDraftKey]
  )
  const removeInputImage = useCallback(
    (index: number): void => {
      setDraftImagesBySession((prev) => {
        const next = (prev[activeDraftKey] ?? []).filter((_, imageIndex) => imageIndex !== index)
        const updated = { ...prev }
        if (next.length) updated[activeDraftKey] = next
        else delete updated[activeDraftKey]
        return updated
      })
    },
    [activeDraftKey]
  )
  const clearInputImages = useCallback((): void => {
    setDraftImagesBySession((prev) => {
      if (!prev[activeDraftKey]) return prev
      const updated = { ...prev }
      delete updated[activeDraftKey]
      return updated
    })
  }, [activeDraftKey])
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
      const images = options.images ?? []
      if ((!text.trim() && images.length === 0) || isSendingRef.current) {
        return false
      }
      if (images.length && selectedModel?.supportsImages === false) {
        showSnackbarError(new Error('当前模型不支持图片，请切换到支持图片的模型'), '无法发送图片')
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
      let optimisticUserMessageId: string | undefined

      if (options.retryUserMessageId) {
        updateMessages((prev) => messagesForUserRetry(prev, options.retryUserMessageId as string))
      } else if (options.appendUserMessage !== false) {
        optimisticUserMessageId = `user-${Date.now()}`
        updateMessages((prev) => [
          ...prev,
          {
            id: optimisticUserMessageId as string,
            role: 'user',
            content: text,
            ...(images.length ? { images } : {})
          }
        ])
      }
      setIsSendingMessage(true)

      try {
        const result = await rendererApi.sendPrompt(
          text,
          options.suppressUserMessageEvent
            ? {
                ...target,
                ...(images.length ? { images } : {}),
                ...(options.planMode ? { planMode: true } : {}),
                suppressUserMessageEvent: true,
                ...(options.retryUserMessageId
                  ? { retryUserMessageId: options.retryUserMessageId }
                  : {})
              }
            : {
                ...target,
                ...(images.length ? { images } : {}),
                ...(options.planMode ? { planMode: true } : {})
              }
        )
        if (isOfficePromptTargetFailure(result)) {
          const officeRecovery = officePromptFailureRecovery(result, text)
          if (!officeRecovery) return false
          setDraftInputs((prev) =>
            prev[activeDraftKey]
              ? prev
              : updateSessionDraft(prev, activeDraftKey, officeRecovery.draft)
          )
          if (images.length) {
            setDraftImagesBySession((prev) =>
              prev[activeDraftKey]?.length ? prev : { ...prev, [activeDraftKey]: images }
            )
          }
          if (
            sendRequest === sendRequestRef.current &&
            submitGeneration === useSessionStore.getState().activeSessionGeneration
          ) {
            if (optimisticUserMessageId) {
              updateMessages((prev) =>
                prev.filter((message) => message.id !== optimisticUserMessageId)
              )
            }
            showSnackbarError(
              Object.assign(new Error(officeRecovery.error.message), {
                code: officeRecovery.error.code
              }),
              '发送消息失败'
            )
          }
          return false
        }
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
                ...queued.map((item) => ({
                  ...item,
                  target: retargetCapturedOfficePrompt(item.target, materializedTarget)
                }))
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
          setActiveWorkspaceTabKey((currentKey) => activeTabKeyAfterPrompt(currentKey, tabKey))
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
        if (images.length && options.appendUserMessage !== false) {
          setDraftImagesBySession((prev) =>
            prev[activeDraftKey]?.length ? prev : { ...prev, [activeDraftKey]: images }
          )
          setDraftInputs((prev) => updateSessionDraft(prev, activeDraftKey, text))
        }
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
      setDraftInputs,
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
    const current = useSessionStore.getState()
    if (
      compactingSessionKeysRef.current.has(
        JSON.stringify([
          current.activePhiSessionId ?? null,
          current.activeSessionPath,
          current.activeSessionGeneration
        ])
      )
    ) {
      return
    }
    const text = input.trim()
    const images = inputImages
    if (!text && images.length === 0) return
    if (images.length && selectedModel?.supportsImages === false) {
      showSnackbarError(new Error('当前模型不支持图片，请切换到支持图片的模型'), '无法发送图片')
      return
    }
    const target = withCapturedOfficeTarget<PromptTarget>(
      {
        path: useSessionStore.getState().activeSessionPath,
        phiSessionId: useSessionStore.getState().activePhiSessionId ?? undefined,
        cwd: useSessionStore.getState().activeCwd,
        sessionGeneration: useSessionStore.getState().activeSessionGeneration
      },
      officeComposerTarget,
      officeDevelopmentEnabled
    )
    if (currentSessionIsBusy || isSendingRef.current) {
      queuePromptText(text, target, { images, planMode: planReviewEnabled })
      clearInputImages()
      setPlanReviewByDraft((previous) => ({ ...previous, [activeDraftKey]: false }))
      return
    }
    setActiveInput('')
    clearInputImages()
    setPlanReviewByDraft((previous) => ({ ...previous, [activeDraftKey]: false }))
    await sendPromptText(text, target, { images, planMode: planReviewEnabled })
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

  const openRemoteWorkspacePath = useCallback(
    (path: string, kind: LocalPathKind): void => {
      const scope = getActiveRemoteProject()
      if (!scope) {
        showSnackbarError(new Error('远程服务器档案或会话不可用'), '无法打开远程文件')
        return
      }
      const uri = path.startsWith('ssh://')
        ? path
        : remotePathInsideRoot(path, scope.canonicalRoot)
          ? remoteWorkspaceUri(scope.hostAlias, path)
          : null
      if (!uri || !remotePathWithinProjectUri(uri, scope.hostAlias, scope.canonicalRoot)) {
        showSnackbarError(new Error('远程路径不属于当前项目'), '无法打开远程文件')
        return
      }
      setWorkspaceSidebarMode('files')
      setIsSidebarOpen(true)
      setActiveWorkspaceTabKey(workspaceFileTabKey(uri))
      if (kind === 'directory') previewDirectoryPath(uri)
      else previewFilePath(uri)
    },
    [getActiveRemoteProject, previewDirectoryPath, previewFilePath, showSnackbarError]
  )

  const openActiveWrapperResultPath = useCallback(
    (path: string, kind: LocalPathKind): boolean => {
      if (
        !wrapperResultBelongsToProject(
          activeWrapperResultScope,
          useSessionStore.getState().activeProjectId
        ) ||
        !isActiveWrapperResultUri(path)
      ) {
        return false
      }
      setWorkspaceSidebarMode('files')
      setIsSidebarOpen(true)
      setActiveWorkspaceTabKey(workspaceFileTabKey(path))
      if (kind === 'directory') previewDirectoryPath(path)
      else previewFilePath(path)
      return true
    },
    [activeWrapperResultScope, isActiveWrapperResultUri, previewDirectoryPath, previewFilePath]
  )

  const onOpenWrapperResult = useCallback(
    (run: WrapperRun, path: string, kind: LocalPathKind): void => {
      if (
        !run.remote?.projectId ||
        run.remote.projectId !== useSessionStore.getState().activeProjectId
      ) {
        showSnackbarError(new Error('请先进入这次运行所属的项目'), '无法打开远程结果')
        return
      }
      const scope = wrapperResultScopeForPath(run, path)
      if (!scope) {
        showSnackbarError(new Error('运行记录缺少该结果路径的授权范围'), '无法打开远程结果')
        return
      }
      try {
        const uri = openWrapperResultPath(scope, path, kind)
        setWorkspaceSidebarMode('files')
        setIsSidebarOpen(true)
        setActiveWorkspaceTabKey(workspaceFileTabKey(uri))
      } catch (error) {
        showSnackbarError(error, '无法打开远程结果')
      }
    },
    [openWrapperResultPath, showSnackbarError]
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
      if (useSessionStore.getState().activeProjectLocation?.kind === 'ssh') {
        openRemoteWorkspacePath(path, 'file')
        return
      }
      if (blockRemoteLocalFileAction()) return
      const normalizedPath = absoluteWorkspacePath(getActiveCwd(), path)
      setWorkspaceSidebarMode('files')
      setIsSidebarOpen(true)
      setActiveWorkspaceTabKey(workspaceFileTabKey(normalizedPath))
      if (isNotebookFilePath(path)) {
        onOpenNotebookWorkspaceFile(path)
        return
      }
      previewFilePath(path)
    },
    [
      blockRemoteLocalFileAction,
      getActiveCwd,
      onOpenNotebookWorkspaceFile,
      openRemoteWorkspacePath,
      previewFilePath
    ]
  )

  const onOpenFilePreview = useCallback(
    (path: string): void => {
      if (openActiveWrapperResultPath(path, 'file')) return
      if (useSessionStore.getState().activeProjectLocation?.kind === 'ssh') {
        openRemoteWorkspacePath(path, 'file')
        return
      }
      if (blockRemoteLocalFileAction()) return
      if (isNotebookFilePath(path)) {
        onOpenNotebookWorkspaceFile(path)
        return
      }
      previewFilePathInWorkspaceTab(path)
    },
    [
      blockRemoteLocalFileAction,
      onOpenNotebookWorkspaceFile,
      openActiveWrapperResultPath,
      openRemoteWorkspacePath,
      previewFilePathInWorkspaceTab
    ]
  )

  const onOpenLocalPath = useCallback(
    (path: string, pathKind: LocalPathKind): void => {
      if (openActiveWrapperResultPath(path, pathKind)) return
      if (useSessionStore.getState().activeProjectLocation?.kind === 'ssh') {
        openRemoteWorkspacePath(path, pathKind)
        return
      }
      if (blockRemoteLocalFileAction()) return
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
    [
      blockRemoteLocalFileAction,
      onOpenNotebookWorkspaceFile,
      openActiveWrapperResultPath,
      openRemoteWorkspacePath,
      previewDirectoryPathInWorkspaceTab,
      previewFilePathInWorkspaceTab
    ]
  )

  const onOpenDefaultPreviewPath = useCallback(
    (path: string, kind: LocalPathKind = 'file'): void => {
      if (openActiveWrapperResultPath(path, kind)) return
      if (useSessionStore.getState().activeProjectLocation?.kind === 'ssh') {
        openRemoteWorkspacePath(path, kind)
        return
      }
      if (blockRemoteLocalFileAction()) return
      if (isNotebookFilePath(path)) {
        onOpenNotebookWorkspaceFile(path)
        return
      }
      openPathWithSystemDefault(path)
    },
    [
      blockRemoteLocalFileAction,
      onOpenNotebookWorkspaceFile,
      openActiveWrapperResultPath,
      openPathWithSystemDefault,
      openRemoteWorkspacePath
    ]
  )

  const onRetryRemoteConnection = useCallback((): void => {
    const state = useSessionStore.getState()
    if (!state.activePhiSessionId || !state.activeProjectId) {
      showSnackbarError(new Error('远程项目会话不可用'), '无法重新连接')
      return
    }
    void rendererApi
      .retryRemoteProjectConnection({
        sessionId: state.activePhiSessionId,
        projectId: state.activeProjectId
      })
      .catch((error) => showSnackbarError(error, '无法重新连接'))
  }, [rendererApi, showSnackbarError])

  const onRevealPreviewPathInWorkspace = useCallback(
    (path: string, kind: LocalPathKind = 'file'): void => {
      if (path.startsWith('ssh://')) setWorkspaceSidebarMode('files')
      onRevealPreviewPath(path, kind)
    },
    [onRevealPreviewPath]
  )

  const onOpenInputAddMenu = useCallback((): void => {
    void refreshSkills()
    void refreshPromptAgents()
    void refreshPlugins()
  }, [refreshPlugins, refreshPromptAgents, refreshSkills])

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
  const onToggleWorkspaceSidePanel = useCallback(
    (mode: WorkspaceSidePanelMode): void => {
      browserLinkOpeningCoordinator.invalidate()
      setWorkspaceSidePanelState((current) =>
        toggleWorkspaceSidePanelModeForLayout(current, mode, workspaceSidePanelCanSplit)
      )
    },
    [browserLinkOpeningCoordinator, workspaceSidePanelCanSplit]
  )
  const onOpenBackgroundJobs = useCallback((): void => {
    browserLinkOpeningCoordinator.invalidate()
    openWorkspaceSidePanel('jobs')
  }, [browserLinkOpeningCoordinator, openWorkspaceSidePanel])
  const onCloseWorkspaceSidePanelSlot = useCallback((mode: WorkspaceSidePanelMode): void => {
    setWorkspaceSidePanelState((current) => closeWorkspaceSidePanelMode(current, mode))
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>(`[data-phi-workspace-panel-toggle="${mode}"]`)
        ?.focus()
    })
  }, [])
  const onToggleWorkspaceSidePanelMaximized = useCallback((mode: WorkspaceSidePanelMode): void => {
    setWorkspaceSidePanelState((current) => toggleWorkspaceSidePanelMaximized(current, mode))
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
        const nextWidth = Math.min(
          maxWorkspaceSidePanelWidth,
          Math.max(minWorkspaceSidePanelWidth, startWidth - delta)
        )
        setWorkspaceSidePanelWidth(nextWidth)
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
    ? (projects.find((project) => project.id === activeProjectId) ??
      projects.find(
        (project) => project.location?.kind !== 'ssh' && project.workingDirectory === activeCwd
      ) ??
      null)
    : null
  const activeRemoteConnection =
    activeProjectLocation?.kind === 'ssh' ? activeProject?.remoteConnection : undefined
  const previousRemoteConnectionPhaseRef = useRef<RemoteProjectReachability | null>(null)
  useEffect(() => {
    const phase =
      activeProjectLocation?.kind === 'ssh' ? (activeRemoteConnection?.phase ?? 'unchecked') : null
    const previous = previousRemoteConnectionPhaseRef.current
    previousRemoteConnectionPhaseRef.current = phase
    if (!phase || !shouldRetryRemoteReads(previous, phase)) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setWorkspaceSidePanelTreeRevision((value) => value + 1)
      const currentScope = getActiveRemoteProject()
      if (
        filePreview?.status === 'error' &&
        currentScope &&
        remotePathWithinProjectUri(
          filePreview.path,
          currentScope.hostAlias,
          currentScope.canonicalRoot
        )
      ) {
        loadFilePreview(filePreview.path, filePreview.pathKind ?? 'file')
      }
    })
    return () => {
      cancelled = true
    }
  }, [
    activeProjectLocation?.kind,
    activeRemoteConnection?.phase,
    filePreview,
    getActiveRemoteProject,
    loadFilePreview
  ])
  const activeRemoteFileScope =
    activeProjectLocation?.kind === 'ssh' && activeProject?.remoteHostAlias
      ? {
          hostAlias: activeProject.remoteHostAlias,
          canonicalRoot: activeProjectLocation.canonicalRoot
        }
      : null
  const workspaceFilesRootPath =
    activeProjectLocation?.kind === 'ssh'
      ? activeRemoteFileScope
        ? remoteWorkspaceUri(activeRemoteFileScope.hostAlias, activeRemoteFileScope.canonicalRoot)
        : ''
      : activeCwd
  const remoteFileIdentity =
    activeProjectLocation?.kind === 'ssh'
      ? `${activeProjectId ?? ''}:${activeRemoteFileScope?.hostAlias ?? ''}:${activeProjectLocation.canonicalRoot}`
      : null
  const previousRemoteFileIdentityRef = useRef<string | null>(null)
  const currentSessionTab = useMemo<WorkspaceSessionTab>(
    () => ({
      key: workspaceSessionTabKey(activeSessionPath, activeSessionGeneration),
      kind: 'session',
      itemId: activeSessionPath ?? `fresh:${activeSessionGeneration}`,
      title: activeSession
        ? sessionDisplayTitle(activeSession)
        : (titleFromMessages(messages) ?? truncateSessionTitle('新对话')),
      subtitle: activeProject?.name ?? workspaceScopeLabelForCwd(activeCwd, projects),
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
  useLayoutEffect(() => {
    const previous = previousRemoteFileIdentityRef.current
    if (!shouldClearWorkspaceFilesForRemoteSwitch(previous, remoteFileIdentity)) {
      previousRemoteFileIdentityRef.current = remoteFileIdentity
      return
    }
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      clearFileWorkspace()
      setActiveWorkspaceTabKey(currentSessionTab.key)
      if (activeView === 'analysis') navigateToView('chat')
      previousRemoteFileIdentityRef.current = remoteFileIdentity
    })
    return () => {
      cancelled = true
    }
  }, [activeView, clearFileWorkspace, currentSessionTab.key, navigateToView, remoteFileIdentity])
  useLayoutEffect(() => {
    if (
      !activeWrapperResultScope ||
      wrapperResultBelongsToProject(activeWrapperResultScope, activeProjectId)
    )
      return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      clearFileWorkspace()
      setActiveWorkspaceTabKey(currentSessionTab.key)
      if (activeView === 'analysis') navigateToView('chat')
    })
    return () => {
      cancelled = true
    }
  }, [
    activeProjectId,
    activeView,
    activeWrapperResultScope,
    clearFileWorkspace,
    currentSessionTab.key,
    navigateToView
  ])
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
        absolutePath: tab.absolutePath ?? tab.path,
        dirty: tab.dirty
      })),
    [workspaceFileTabs]
  )
  const shouldShowSessionWorkspaceTab = !(
    activeView === 'analysis' && workspaceSidebarMode === 'conversations'
  )
  const visibleWorkspaceTabs = useMemo(() => {
    return visibleWorkspaceTabsForState({
      currentSessionTab,
      workspaceTabs,
      workspaceFileTabs: workspaceFileWorkspaceTabs,
      closedSessionTabKeys: closedWorkspaceSessionTabKeys,
      shouldShowSessionTab: shouldShowSessionWorkspaceTab,
      sessionTabWasOpened
    })
  }, [
    closedWorkspaceSessionTabKeys,
    currentSessionTab,
    sessionTabWasOpened,
    shouldShowSessionWorkspaceTab,
    workspaceFileWorkspaceTabs,
    workspaceTabs
  ])
  const sidebarSelectedSessionPath =
    !sessionTabWasOpened || closedWorkspaceSessionTabKeys.has(currentSessionTab.key)
      ? null
      : activeSessionPath
  const effectiveActiveWorkspaceTabKey =
    activeWorkspaceTabKey ??
    (activeView === 'analysis' && activeWorkspaceFilePath
      ? workspaceFileTabKey(activeWorkspaceFilePath)
      : activeView === 'chat' && sessionTabWasOpened
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
  const queuedPromptsPaused = sessionRuntimeStatePausesQueue(activeSessionRuntimeState)
  const activeContextCompactionKey = JSON.stringify([
    activePhiSessionId ?? null,
    activeSessionPath,
    activeSessionGeneration
  ])
  const currentSessionIsCompacting = compactingSessions.has(activeContextCompactionKey)
  const onCompactContext = useCallback(
    async (target: ManualCompactionTarget): Promise<void> => {
      const key = JSON.stringify([
        target.phiSessionId,
        target.sessionPath,
        target.sessionGeneration
      ])
      if (compactingSessionKeysRef.current.has(key)) return
      compactingSessionKeysRef.current.add(key)
      setCompactingSessions((previous) => new Set(previous).add(key))
      try {
        await rendererApi.compactCurrentSession(target)
        showSnackbar('上下文已压缩', 'success')
        setContextUsageRefreshKey((value) => value + 1)
      } catch (error) {
        showSnackbarError(error, '上下文压缩失败')
      } finally {
        compactingSessionKeysRef.current.delete(key)
        setCompactingSessions((previous) => {
          const next = new Set(previous)
          next.delete(key)
          return next
        })
      }
    },
    [rendererApi, showSnackbar, showSnackbarError]
  )
  useEffect(() => {
    currentSessionIsBusyRef.current = currentSessionIsBusy || currentSessionIsCompacting
  }, [currentSessionIsBusy, currentSessionIsCompacting])
  const onRetryUserMessage = useCallback(
    async (message: UserMessageRetryTarget): Promise<void> => {
      const text = message.content.trim()
      let images: PromptImageInput[]
      try {
        images = await Promise.all(
          (message.images ?? []).map((image) =>
            'data' in image ? Promise.resolve(image) : rendererApi.readPromptImage(image)
          )
        )
      } catch (error) {
        showSnackbarError(error, '无法重试图片消息')
        return
      }
      if (!text && images.length === 0) return
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
        suppressUserMessageEvent: true,
        images
      }
      if (currentSessionIsBusyRef.current || isSendingRef.current) {
        queuePromptText(text, target, sendOptions)
        return
      }
      await sendPromptText(text, target, sendOptions)
    },
    [queuePromptText, rendererApi, sendPromptText, showSnackbarError]
  )
  const forkInProgressRef = useRef(false)
  const onForkUserMessage = useCallback(
    async (eventId: string): Promise<void> => {
      if (forkInProgressRef.current) return
      const sourceId = useSessionStore.getState().activePhiSessionId
      if (!sourceId) return
      forkInProgressRef.current = true
      try {
        const fork = await rendererApi.forkSession(sourceId, eventId)
        if (useSessionStore.getState().activePhiSessionId !== sourceId) {
          void refreshSessions()
          return
        }
        await onSelectSession(fork.path)
      } catch (error) {
        showSnackbarError(error, '无法分叉会话')
      } finally {
        forkInProgressRef.current = false
      }
    },
    [onSelectSession, refreshSessions, rendererApi, showSnackbarError]
  )
  useEffect(() => {
    if (
      currentSessionIsBusy ||
      queuedPromptsPaused ||
      currentSessionIsCompacting ||
      isSessionChanging ||
      isBusy ||
      isSendingRef.current
    ) {
      return
    }
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
    queuedPromptsPaused,
    currentSessionIsCompacting,
    isModelStateReady,
    isBusy,
    isSessionChanging,
    providerStatuses,
    sendPromptText
  ])
  const activeWorkspaceTitle = useMemo(() => {
    if (showProjectSessionPlaceholder) return '项目会话'
    if (isChatWorkspaceView && visibleWorkspaceTabs.length === 0) return '首页'
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
    showProjectSessionPlaceholder,
    visibleWorkspaceTabs.length
  ])
  const activeWorkspaceScopeLabel =
    activeProject?.name ?? workspaceScopeLabelForCwd(activeCwd, projects)
  const activePermissionMode = currentPermissionMode
  const showWorkspaceTabs =
    visibleWorkspaceTabs.length > 0 &&
    (activeView === 'chat' || activeView === 'analysis' || isResourceWorkspaceView)
  const showWorkspaceTitlebar =
    !isAnalysisWorkspaceView && !isResourceWorkspaceView && !showWorkspaceTabs
  const workspaceSidebarPreviewWidth = Math.min(360, Math.max(navigationPaneWidth, sidebarWidth))
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
  const isWorkspaceSidebarPreviewBlocked = Boolean(
    isSettingsOpen ||
    pendingApproval ||
    pendingUserInteraction ||
    isSessionSearchOpen ||
    isProviderDialogOpen ||
    isNewProjectDialogOpen ||
    isSkillCatalogOpen ||
    isPhiPluginCatalogOpen ||
    showEnvironmentSummary ||
    showOnboarding ||
    exportTarget
  )
  if (isWorkspaceSidebarPreviewBlocked && workspaceSidebarPreview !== null) {
    setWorkspaceSidebarPreview(null)
  }
  const shouldUseWorkspaceSidebarPreview = useCallback(
    (mode: WorkspaceSidebarMode): boolean =>
      !isWorkspaceSidebarPreviewBlocked && !isWorkspaceSidebarModeExpanded(mode),
    [isWorkspaceSidebarModeExpanded, isWorkspaceSidebarPreviewBlocked]
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
    (delayMs = 0, expectedPreview?: typeof workspaceSidebarPreview): void => {
      // A completed navigation must not cancel a newer preview's leave timer.
      // Opening any new preview already clears timers from its predecessor.
      if (!expectedPreview || delayMs > 0) clearWorkspaceSidebarPreviewCloseTimer()
      if (delayMs <= 0) {
        setWorkspaceSidebarPreview((current) =>
          expectedPreview && current !== expectedPreview ? current : null
        )
        return
      }
      workspaceSidebarPreviewCloseTimer.current = window.setTimeout(() => {
        workspaceSidebarPreviewCloseTimer.current = null
        if (isWorkspaceSidebarPreviewDialogActive() || isPointerWithinWorkspaceSidebarPreview())
          return
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
    closeWorkspaceSidebarPreview(350)
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
    activeWrapperResultScope &&
    !wrapperResultBelongsToProject(activeWrapperResultScope, activeProjectId)
      ? null
      : activeWorkspaceFileTab && activeWorkspaceFileTab.kind !== 'notebook'
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
    activeWrapperResultScope &&
    !wrapperResultBelongsToProject(activeWrapperResultScope, activeProjectId)
      ? null
      : (activeWorkspaceFilePath ?? (filePreview ? filePreviewStatePath(filePreview) : null))
  const activeResultPreview = activeFilePreviewState
    ? isActiveWrapperResultUri(filePreviewStatePath(activeFilePreviewState))
    : false

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
          cancelActiveWrapperResultRead()
          filePreviewRequestRef.current += 1
          setFilePreview(null)
        }
        return
      }

      const nextTab = remainingTabs.at(-1) ?? null
      cancelActiveWrapperResultRead()
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
      cancelActiveWrapperResultRead,
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
    setWorkspaceTabs((tabs) => upsertWorkspaceResourceTab(tabs, tab))
  }, [])

  const selectWorkspaceTab = useCallback(
    (tab: WorkspaceTab): void => {
      setActiveWorkspaceTabKey(tab.key)
      if (tab.kind === 'session') {
        setSessionTabWasOpened(true)
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
      if (tab.kind === 'skills') {
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
      setActiveSkillId,
      setSelectedWrapperId
    ]
  )

  const openWorkspaceResourceTab = useCallback(
    (tab: Omit<WorkspaceResourceTab, 'key'>): void => {
      const nextTab: WorkspaceResourceTab = {
        ...tab,
        key: workspaceResourceTabKey(tab.kind)
      }
      upsertWorkspaceTab(nextTab)
      selectWorkspaceTab(nextTab)
    },
    [selectWorkspaceTab, upsertWorkspaceTab]
  )

  const onOpenPhiPlugins = useCallback((): void => {
    openWorkspaceResourceTab({
      kind: 'plugins',
      itemId: 'installed',
      title: '插件'
    })
  }, [openWorkspaceResourceTab])

  const onOpenPhiPluginTab = useCallback(
    (plugin: PhiPluginDisplayItem): void => {
      openWorkspaceResourceTab({
        kind: 'plugins',
        itemId: plugin.id,
        title: plugin.title,
        subtitle: plugin.directory
      })
    },
    [openWorkspaceResourceTab]
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

  const onSetSkillGlobalEnabled = useCallback(
    async (skill: SkillSummary, enabled: boolean): Promise<void> => {
      try {
        await setGlobalEnabled(skill, enabled)
        showSnackbar(enabled ? '已全局启用技能' : '已全局关闭技能', 'success')
      } catch (error) {
        showSnackbarError(error, enabled ? '启用技能失败' : '关闭技能失败')
        throw error
      }
    },
    [setGlobalEnabled, showSnackbar, showSnackbarError]
  )

  const onSetSkillProjectOverride = useCallback(
    async (skill: SkillSummary, value: boolean | null): Promise<void> => {
      const projectCwd =
        activeProject?.location.kind === 'ssh' ? null : activeProject?.workingDirectory
      if (!projectCwd) throw new Error('当前没有可用的本地项目')
      try {
        await setProjectOverride(skill, value, projectCwd)
        showSnackbar(
          value === null ? '已跟随全局技能设置' : value ? '项目已启用技能' : '项目已关闭技能',
          'success'
        )
      } catch (error) {
        showSnackbarError(error, '更新项目技能设置失败')
        throw error
      }
    },
    [activeProject, setProjectOverride, showSnackbar, showSnackbarError]
  )

  const onSetSidebarSkillEnabled = useCallback(
    (skill: SkillSummary, enabled: boolean): Promise<void> =>
      skill.projectOverride != null &&
      activeProject?.location.kind !== 'ssh' &&
      activeProject?.workingDirectory
        ? onSetSkillProjectOverride(skill, enabled)
        : onSetSkillGlobalEnabled(skill, enabled),
    [activeProject, onSetSkillProjectOverride, onSetSkillGlobalEnabled]
  )

  const onInstallSkillPackage = useCallback(
    async (registryDir: string, entry: PackageRegistryEntryView): Promise<void> => {
      await rendererApi.installPackage(registryDir, 'skill', entry.id, entry.version)
      await refreshSkills()
      showSnackbar(`已安装并启用「${entry.title}」`, 'success')
    },
    [refreshSkills, rendererApi, showSnackbar]
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
        title: server.title ?? server.name,
        subtitle: server.sourcePath ?? server.command,
        connectorUrl: server.url
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
      // Reload just the runs: a full refresh flips the sidebar to its loading spinner and
      // swaps the catalog, which repaints the whole view instead of only the detail page.
      void refreshWrapperRuns()
    },
    [openWorkspaceResourceTab, refreshWrapperRuns, setSelectedWrapperId]
  )

  const onOpenWrapperRunFromJobs = useCallback(
    (canonicalId: string): void => {
      const entry = wrapperCatalog.find((item) => item.id === canonicalId)
      if (entry) {
        onOpenWrapperTab(entry)
        return
      }
      setWorkspaceSidebarMode('wrappers')
      setIsSidebarOpen(true)
    },
    [onOpenWrapperTab, wrapperCatalog]
  )

  const onCloseWorkspaceTab = useCallback(
    (tab: WorkspaceTab): void => {
      const closingIndex = visibleWorkspaceTabs.findIndex((item) => item.key === tab.key)
      if (closingIndex === -1) return
      const remainingTabs = visibleWorkspaceTabs.filter((item) => item.key !== tab.key)
      if (tab.kind === 'session') {
        setSessionTabWasOpened(false)
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
      if (tab.kind === 'skills' && activeSkillId === tab.itemId) {
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
      activeSkillId,
      effectiveActiveWorkspaceTabKey,
      navigateToView,
      onCloseWorkspaceFileTab,
      selectWorkspaceTab,
      selectedWrapperId,
      setActiveMcpServerId,
      setActiveSkillId,
      setSelectedWrapperId,
      visibleWorkspaceTabs
    ]
  )

  const onRemoveMcpServer = useCallback(
    async (server: McpServerSummary): Promise<void> => {
      if (!server.managed || !server.url) throw new Error('此连接器不能从 Phi 中移除')
      await window.api.removeRemoteMcpConnector(server.name, server.url)
      await refreshMcpServers()
      showSnackbar('已移除连接器', 'success')
      if (
        activeWorkspaceResourceTab?.kind === 'mcp' &&
        activeWorkspaceResourceTab.itemId === server.id
      ) {
        onCloseWorkspaceTab(activeWorkspaceResourceTab)
      }
    },
    [activeWorkspaceResourceTab, onCloseWorkspaceTab, refreshMcpServers, showSnackbar]
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
    setNewProjectDialogOpenWithBrowserGate(true)
  }

  const acknowledgeActiveSessionInteraction = useCallback((): void => {
    void acknowledgeActiveSession()
  }, [acknowledgeActiveSession])

  const activeResourceSkill =
    activeWorkspaceResourceTab?.kind === 'skills'
      ? (skills.find((skill) => skill.id === activeWorkspaceResourceTab.itemId) ?? null)
      : null
  const activeResourcePhiPlugin =
    activeWorkspaceResourceTab?.kind === 'plugins'
      ? (phiPluginsState.plugins.find(
          (plugin) => plugin.id === activeWorkspaceResourceTab.itemId
        ) ?? null)
      : null
  const activePhiPluginId = activeResourcePhiPlugin?.id ?? null
  const activeResourceMcpServer =
    activeWorkspaceResourceTab?.kind === 'mcp'
      ? (mcpServers.find((server) => server.id === activeWorkspaceResourceTab.itemId) ?? null)
      : null

  const activeWorkspaceResourceContent = activeWorkspaceResourceTab ? (
    activeWorkspaceResourceTab.kind === 'plugins' ? (
      <PhiPluginsView
        plugin={activeResourcePhiPlugin}
        busyPluginId={phiPluginsState.busyPluginId}
        error={phiPluginsState.error}
        notice={phiPluginsState.notice}
        onClearError={phiPluginsState.clearError}
        onClearNotice={phiPluginsState.clearNotice}
        onRefresh={phiPluginsState.refresh}
        onSetEnabled={phiPluginsState.setEnabled}
        onUninstall={phiPluginsState.uninstall}
      />
    ) : activeWorkspaceResourceTab.kind === 'skills' ? (
      <SkillDetail
        selectedSkill={activeResourceSkill}
        busySkillId={busySkillId}
        projectCwd={activeProject?.location.kind === 'ssh' ? null : activeProject?.workingDirectory}
        onSetGlobalEnabled={onSetSkillGlobalEnabled}
        onSetProjectOverride={onSetSkillProjectOverride}
        onNavigateToPlugin={(pluginId) => {
          const plugin = phiPluginsState.plugins.find((item) => item.id === pluginId)
          if (plugin) onOpenPhiPluginTab(plugin)
          else onOpenPhiPlugins()
        }}
        onSetSkillDisabled={onSetSkillDisabled}
        onDeleteSkill={onDeleteSkill}
      />
    ) : activeWorkspaceResourceTab.kind === 'mcp' ? (
      <McpDetail
        selectedServer={activeResourceMcpServer}
        onRemoveServer={onRemoveMcpServer}
        onRefreshServers={refreshMcpServers}
      />
    ) : activeWorkspaceResourceTab.kind === 'wrappers' ? (
      <WrapperDetail
        catalog={wrapperCatalog}
        runs={wrapperRuns}
        selectedId={activeWorkspaceResourceTab.itemId}
        error={wrapperError}
        onOpenLocalPath={onOpenLocalPath}
        onOpenRemoteResult={onOpenWrapperResult}
        onExportReproducibility={(runId) => void exportWrapperReproducibility(runId)}
        onCancelRun={(runId) => void cancelWrapperRun(runId)}
        packageEnablementBusy={packageEnablementBusy}
        onSetPackageEnabled={(packageId, enabled) => void setPackageEnabled(packageId, enabled)}
        project={activeProject ?? undefined}
        updatingRemoteProjectId={updatingRemoteProjectId}
        onUpdateProjectRemoteConnection={onUpdateProjectRemoteConnection}
        onUpdateProjectRemoteDefaults={onUpdateProjectRemoteDefaults}
        onOpenRemoteSettings={() => openSettings('remote')}
      />
    ) : null
  ) : (
    <Stack spacing={1} sx={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Typography color="text.secondary">从左侧选择一个项目打开 tab。</Typography>
    </Stack>
  )

  const activeChatView = (
    <RemoteProjectFileContext.Provider
      value={
        activeProjectLocation?.kind === 'ssh'
          ? {
              hostAlias: activeRemoteFileScope?.hostAlias ?? '',
              canonicalRoot: activeProjectLocation.canonicalRoot,
              openPath: openRemoteWorkspacePath
            }
          : null
      }
    >
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {activeProjectLocation?.kind === 'ssh' ? (
          <RemoteConnectionNotice
            hostAlias={activeProject?.remoteHostAlias}
            connection={activeRemoteConnection}
            onRetry={onRetryRemoteConnection}
          />
        ) : null}
        <ChatView
          messages={messages}
          input={input}
          images={inputImages}
          onImagesAdded={addInputImages}
          onRemoveImage={removeInputImage}
          scrollResetKey={activeChatScrollResetKey}
          scrollPositionStore={chatScrollPositionStore}
          canSend={
            !isSessionChanging && !currentSessionIsBusy && !currentSessionIsCompacting && !isBusy
          }
          canQueue={
            !isSessionChanging && currentSessionIsBusy && !currentSessionIsCompacting && !isBusy
          }
          isGenerating={currentSessionIsBusy}
          currentRunStartedAt={activeSessionRuntimeState.currentRunStartedAt}
          models={availableModels}
          selectedModel={selectedModel}
          contextUsageTarget={{
            sessionPath: activeSessionPath,
            phiSessionId: activePhiSessionId ?? null,
            sessionGeneration: activeSessionGeneration
          }}
          contextUsageRefreshKey={contextUsageRefreshKey}
          contextCompacting={currentSessionIsCompacting}
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
          onForkUserMessage={
            currentSessionIsBusy || currentSessionIsCompacting || !activePhiSessionId
              ? undefined
              : onForkUserMessage
          }
          onOpenInputAddMenu={onOpenInputAddMenu}
          onPickInputFiles={onPickInputFiles}
          onGetPathForInputFile={rendererApi.getPathForFile}
          onInputFilesDropped={rendererApi.onInputFilesDropped}
          onListInputDirectory={onListInputDirectory}
          onChatSubmit={onChatSubmit}
          officeTarget={officeDevelopmentEnabled ? (officeComposerTarget ?? undefined) : undefined}
          onRemoveOfficeTarget={
            officeComposerTarget
              ? () => setDismissedOfficeArtifactId(officeComposerTarget.artifactId)
              : undefined
          }
          onClearOfficeSelection={
            officeComposerTarget?.selection
              ? () => onClearOfficeSelection(officeComposerTarget.artifactId)
              : undefined
          }
          planReviewEnabled={planReviewEnabled}
          onTogglePlanReview={togglePlanReview}
          disablePlanReview={activeProjectLocation?.kind === 'ssh'}
          onStopGeneration={onStopGeneration}
          onAcknowledgeActiveSession={acknowledgeActiveSessionInteraction}
          onGoSettings={onGoProviderSettings}
          onOpenBackgroundJobs={onOpenBackgroundJobs}
          permissionMode={activePermissionMode}
          onSelectPermissionMode={(mode) => {
            void onSelectPermissionMode(mode)
          }}
          disablePermissionModeSelect={isSessionChanging || currentSessionIsCompacting}
          disableModelControls={isSessionChanging || currentSessionIsCompacting}
          pendingApproval={pendingApproval}
          pendingUserInteraction={pendingUserInteraction}
          queuedPrompts={activeQueuedPrompts.map((item) => ({
            id: item.id,
            text: item.text || `图片 ${item.sendOptions?.images?.length ?? 0} 张`
          }))}
          queuedPromptsPaused={queuedPromptsPaused}
          onRespondApproval={onRespondToolApproval}
          onRespondUserInteraction={onRespondAgentUserInteraction}
          onRemoveQueuedPrompt={removeQueuedPrompt}
          onOpenApprovalSession={onOpenApprovalSession}
          onOpenLocalPath={onOpenLocalPath}
          onOpenWebUrl={onOpenWebUrl}
          onJumpToNotebookCell={onJumpToAnalysisNotebookCell}
          compactComposerControls={activeView === 'analysis'}
          cwd={activeDisplayCwd}
        />
      </Box>
    </RemoteProjectFileContext.Provider>
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

  const emptyWorkspaceContent = (
    <HomeView
      sessions={sessions}
      lastClosedSessionPath={activeSessionPath}
      onNewChat={() => void onNewChatFromSidebar()}
      onShowProjects={() => {
        setWorkspaceSidebarMode('projects')
        setIsSidebarOpen(true)
      }}
      onOpenSession={(path) => void onOpenSessionFromSidebar(path)}
    />
  )

  const activeAnalysisView =
    activeProjectLocation?.kind === 'ssh' ? (
      <Box sx={{ p: 3 }}>
        <Typography variant="body2" color="text.secondary">
          远程项目的 Notebook/Jupyter 暂不可用；不会打开本机会话目录。
        </Typography>
      </Box>
    ) : (
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
        onNotebookDirtyChange={onNotebookDirtyChange}
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
        key={
          activeWrapperResultScope
            ? `${activeWrapperResultScope.projectId}:${activeWrapperResultScope.runId}:${activeWrapperResultScope.scope}`
            : 'project-file'
        }
        layout="workspace"
        state={activeFilePreviewState}
        onOpenFile={onOpenFilePreview}
        onOpenDefaultPath={onOpenDefaultPreviewPath}
        onRevealPath={onRevealPreviewPathInWorkspace}
        onListDirectory={onListPreviewDirectory}
        onDownloadFile={
          activeResultPreview ? (path) => void downloadWrapperResultFile(path) : undefined
        }
        downloadState={activeResultPreview ? fileDownload : null}
        onCancelDownload={activeResultPreview ? cancelActiveWrapperResultDownload : undefined}
      />
    ) : null
  ) : null

  const officeChatSplitEnabled = shouldEnableOfficeChatSplit({
    officeEnabled: typeof window !== 'undefined' && window.api?.office?.enabled === true,
    activeTabKind: activeWorkspaceTab?.kind,
    activeTabPath: isWorkspaceFileWorkspaceTab(activeWorkspaceTab) ? activeWorkspaceTab.path : null,
    previewPath: activeFilePreviewState ? filePreviewStatePath(activeFilePreviewState) : null,
    currentConversationInSidebar: sidebarHostsCurrentConversation({
      activeView,
      isSidebarOpen,
      workspaceSidebarMode
    })
  })

  const standardWorkspaceTabContent =
    activeWorkspaceTab?.kind === 'session'
      ? chatWorkspaceContent
      : isWorkspaceFileWorkspaceTab(activeWorkspaceTab)
        ? activeWorkspaceFileTabContent
        : activeWorkspaceResourceContent

  const activeWorkspaceTabContent = officeChatSplitEnabled ? (
    <ChatArtifactSplit enabled artifact={activeWorkspaceFileTabContent}>
      {chatWorkspaceContent}
    </ChatArtifactSplit>
  ) : (
    standardWorkspaceTabContent
  )

  const onWorkspaceSidebarPreviewNavigate = useCallback((): void => {
    const dismiss =
      workspaceSidebarPreviewMode === 'conversations' || workspaceSidebarPreviewMode === 'projects'
    if (dismiss) closeWorkspaceSidebarPreview(0, visibleWorkspaceSidebarPreview)
    else clearWorkspaceSidebarPreviewCloseTimer()
    if (!isSidebarOpen) setIsSidebarOpen(false)
    else if (!dismiss) setWorkspaceSidebarMode(workspaceSidebarMode)
  }, [
    clearWorkspaceSidebarPreviewCloseTimer,
    closeWorkspaceSidebarPreview,
    isSidebarOpen,
    workspaceSidebarMode,
    workspaceSidebarPreviewMode,
    visibleWorkspaceSidebarPreview
  ])

  const workspaceSidebarProps = useMemo<WorkspaceSidebarDataProps>(
    () => ({
      activeWorkspaceIsProject: activeWorkspaceIsProject,
      activeWorkspaceTitle: activeWorkspaceTitle,
      activeWorkspaceScopeLabel: activeWorkspaceScopeLabel,
      workspaceRootPath: workspaceFilesRootPath,
      isRemoteProject: activeProjectLocation?.kind === 'ssh',
      remoteHostAlias: activeProject?.remoteHostAlias,
      remoteConnection: activeRemoteConnection,
      onRetryRemoteConnection: onRetryRemoteConnection,
      activeWorkspacePath: activeWorkspaceSidePanelPath,
      workspaceFileTreeRevision: workspaceSidePanelTreeRevision,
      onOpenWorkspaceFile: onOpenWorkspaceFileFromSidebar,
      onListWorkspaceDirectory: onListPreviewDirectory,
      runtimeProjectCwd: activeProject?.workingDirectory ?? '',
      runtimeStatus: analysisJupyterRuntimeStatus,
      isRuntimeLoading: isLoadingAnalysisJupyterRuntime || isStartingAnalysisJupyter,
      runtimeClosingNotebookPath: closingRuntimeNotebookPath,
      onOpenRuntimeNotebook: onOpenNotebookWorkspaceFile,
      onRefreshRuntime: () => {
        void refreshAnalysisJupyterRuntimeStatus()
      },
      onStartRuntime: (cwd) => {
        void onStartAnalysisJupyter(cwd).then(() => refreshAnalysisJupyterRuntimeStatus())
      },
      onStopRuntime: (cwd) => {
        void onStopAnalysisJupyter(cwd).then(() => refreshAnalysisJupyterRuntimeStatus())
      },
      onStopRuntimeNotebookKernel: (notebookPath) => {
        void onStopRuntimeNotebookSession(notebookPath)
      },
      phiPlugins: phiPluginsState.plugins,
      activePhiPluginId: activePhiPluginId,
      isLoadingPhiPlugins: phiPluginsState.loading,
      busyPhiPluginId: phiPluginsState.busyPluginId,
      onSetPhiPluginEnabled: phiPluginsState.setEnabled,
      onOpenPhiPlugin: onOpenPhiPluginTab,
      onOpenPhiPluginCatalog: () =>
        openLocalTrustedOverlay('phi-plugin-catalog', () => setIsPhiPluginCatalogOpen(true)),
      isPhiPluginCatalogOpen: isPhiPluginCatalogOpen,
      skills: skills,
      activeSkillId: activeSkillId,
      isLoadingSkills: isLoadingSkills,
      busySkillId: busySkillId,
      onSetSkillEnabled: onSetSidebarSkillEnabled,
      onOpenSkill: onOpenSkillTab,
      onOpenSkillCatalog: () =>
        openLocalTrustedOverlay('skill-catalog', () => setIsSkillCatalogOpen(true)),
      mcpServers: mcpServers,
      activeMcpServerId: activeMcpServerId,
      onOpenMcpServer: onOpenMcpServerTab,
      onRefreshMcpServers: refreshMcpServers,
      wrapperCatalog: wrapperCatalog,
      selectedWrapperId: selectedWrapperId,
      isLoadingWrappers: isLoadingWrappers,
      onOpenWrapper: onOpenWrapperTab,
      onRefreshWrappers: refreshWrappers,
      busyWrapperPackageId: busyWrapperPackageId,
      onSetWrapperPackageEnabled: setPackageEnabled,
      sessions: sessions,
      activeSessionPath: sidebarSelectedSessionPath,
      activeCwd: activeCwd,
      activeProjectId: activeProjectId,
      projects: projects,
      projectSessionRefreshKey: projectSessionRefreshKey,
      onNewChat: onNewChatFromSidebar,
      setIsNewProjectDialogOpen: setNewProjectDialogOpenWithBrowserGate,
      requestTrustedOverlay: openLocalTrustedOverlay,
      cancelTrustedOverlay: cancelLocalTrustedOverlay,
      onSelectSession: onOpenSessionFromSidebar,
      onRenameSession: onRenameSession,
      onDeleteSession: onDeleteSession,
      onExportSession: onExportSession,
      onStartProjectChat: onStartProjectChatFromSidebar,
      onDeleteProjectEntry: onDeleteProjectEntry,
      onFetchProjectSessions: onFetchProjectSessions,
      getSessionRuntimeState: getSessionRuntimeState
    }),
    [
      activeWorkspaceIsProject,
      activeWorkspaceTitle,
      activeWorkspaceScopeLabel,
      workspaceFilesRootPath,
      activeProjectLocation?.kind,
      activeProject?.remoteHostAlias,
      activeRemoteConnection,
      onRetryRemoteConnection,
      activeWorkspaceSidePanelPath,
      workspaceSidePanelTreeRevision,
      onOpenWorkspaceFileFromSidebar,
      onListPreviewDirectory,
      activeProject?.workingDirectory,
      analysisJupyterRuntimeStatus,
      isLoadingAnalysisJupyterRuntime,
      isStartingAnalysisJupyter,
      closingRuntimeNotebookPath,
      onOpenNotebookWorkspaceFile,
      refreshAnalysisJupyterRuntimeStatus,
      onStartAnalysisJupyter,
      onStopAnalysisJupyter,
      onStopRuntimeNotebookSession,
      phiPluginsState.plugins,
      activePhiPluginId,
      phiPluginsState.loading,
      phiPluginsState.busyPluginId,
      phiPluginsState.setEnabled,
      onOpenPhiPluginTab,
      setIsPhiPluginCatalogOpen,
      isPhiPluginCatalogOpen,
      skills,
      activeSkillId,
      isLoadingSkills,
      busySkillId,
      onSetSidebarSkillEnabled,
      onOpenSkillTab,
      setIsSkillCatalogOpen,
      mcpServers,
      activeMcpServerId,
      onOpenMcpServerTab,
      refreshMcpServers,
      wrapperCatalog,
      selectedWrapperId,
      isLoadingWrappers,
      busyWrapperPackageId,
      setPackageEnabled,
      onOpenWrapperTab,
      refreshWrappers,
      sessions,
      sidebarSelectedSessionPath,
      activeCwd,
      activeProjectId,
      projects,
      projectSessionRefreshKey,
      onNewChatFromSidebar,
      setNewProjectDialogOpenWithBrowserGate,
      openLocalTrustedOverlay,
      cancelLocalTrustedOverlay,
      onOpenSessionFromSidebar,
      onRenameSession,
      onDeleteSession,
      onExportSession,
      onStartProjectChatFromSidebar,
      onDeleteProjectEntry,
      onFetchProjectSessions,
      getSessionRuntimeState
    ]
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
            width: isSidebarOpen ? activityBarWidth + sidebarWidth : activityBarWidth,
            backgroundColor: (muiTheme) =>
              muiTheme.palette.mode === 'dark' ? muiTheme.palette.background.default : '#FFFFFF',
            pointerEvents: 'none',
            zIndex: 0
          }}
        />
        <AppActivityBar
          isWorkspaceSidebarModeExpanded={isWorkspaceSidebarModeExpanded}
          shouldUseWorkspaceSidebarPreview={shouldUseWorkspaceSidebarPreview}
          openWorkspaceSidebarPreview={openWorkspaceSidebarPreview}
          scheduleWorkspaceSidebarPreviewClose={scheduleWorkspaceSidebarPreviewClose}
          onSelectWorkspaceView={onSelectWorkspaceView}
          onSelectWorkspaceSidebarMode={onSelectWorkspaceSidebarMode}
          refreshAnalysisJupyterRuntimeStatus={refreshAnalysisJupyterRuntimeStatus}
          refreshPhiPlugins={refreshPhiPluginsForNavigation}
          refreshSkills={refreshSkillsForNavigation}
          refreshMcpServers={refreshMcpServersForNavigation}
          setIsSettingsOpen={setSettingsOpenWithBrowserGate}
          isWorkspaceSidebarPreviewOpen={isWorkspaceSidebarPreviewOpen}
          isWorkspaceSidebarPreviewBlocked={isWorkspaceSidebarPreviewBlocked}
          visibleWorkspaceSidebarPreview={visibleWorkspaceSidebarPreview}
          workspaceSidebarPreviewMode={workspaceSidebarPreviewMode}
          workspaceSidebarPreviewWidth={workspaceSidebarPreviewWidth}
          clearWorkspaceSidebarPreviewCloseTimer={clearWorkspaceSidebarPreviewCloseTimer}
          closeWorkspaceSidebarPreview={closeWorkspaceSidebarPreview}
          sidebarProps={workspaceSidebarProps}
          onPreviewNavigate={onWorkspaceSidebarPreviewNavigate}
        />

        <AppWorkspaceSidebar
          {...workspaceSidebarProps}
          isSidebarOpen={isSidebarOpen}
          sidebarWidth={sidebarWidth}
          activeView={activeView}
          activeChatView={activeChatView}
          onStartSidebarResize={onStartSidebarResize}
          workspaceSidebarMode={workspaceSidebarMode}
        />

        <SkillCatalogDialog
          open={isSkillCatalogOpen}
          skills={skills}
          isSkillsLoading={isLoadingSkills}
          onClose={() => setIsSkillCatalogOpen(false)}
          onEnableBundled={(skill) => onSetSkillGlobalEnabled(skill, true)}
          onPickRegistryDirectory={() => rendererApi.pickPackageRegistryDirectory()}
          onReadRegistry={(dir) => rendererApi.readPackageRegistry(dir)}
          onInstallPackage={onInstallSkillPackage}
          onApplyUpdate={async (entry) => {
            await rendererApi.applyPackageUpdate('skill', entry.id)
            await refreshSkills()
            showSnackbar(`已更新「${entry.title}」`, 'success')
          }}
        />

        <PhiPluginCatalogDialog
          open={isPhiPluginCatalogOpen}
          plugins={phiPluginsState.plugins}
          installWorking={phiPluginsState.busyPluginId === '__install__'}
          feedbackError={phiPluginsState.error}
          feedbackNotice={phiPluginsState.notice}
          onClose={() => setIsPhiPluginCatalogOpen(false)}
          onChanged={phiPluginsState.refresh}
          onClearFeedback={() => {
            phiPluginsState.clearError()
            phiPluginsState.clearNotice()
          }}
          onShowError={phiPluginsState.showError}
          onInstallFromDirectory={phiPluginsState.installFromDirectory}
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
                data-phi-workspace-titlebar="true"
                sx={{
                  height: WINDOW_TITLEBAR_HEIGHT,
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  backgroundColor: (muiTheme) =>
                    muiTheme.palette.mode === 'dark'
                      ? muiTheme.palette.background.default
                      : '#FFFFFF',
                  WebkitAppRegion: 'drag',
                  zIndex: 7,
                  pl: `${chromeLayout.mainColumnTitlebarInset}px`
                }}
              >
                <Box
                  sx={{
                    flex: filePreview && !showProjectSessionPlaceholder ? '1 1 320px' : 1,
                    minWidth: 0,
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center'
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
                    actions={
                      <OfficeCreateButton
                        bridge={rendererApi.office}
                        disabled={!activePhiSessionId}
                        onCreated={previewFilePathInWorkspaceTab}
                      />
                    }
                    leadingChromeInset={chromeLayout.mainColumnTitlebarInset}
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
                    leadingChromeInset={chromeLayout.mainColumnTitlebarInset}
                    reserveTrailingChromeSpace={workspaceSidePanelCollapsed}
                  />
                  <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
                    {activeFilePreviewState ? (
                      <FilePreviewPanel
                        key={
                          activeWrapperResultScope
                            ? `${activeWrapperResultScope.projectId}:${activeWrapperResultScope.runId}:${activeWrapperResultScope.scope}`
                            : 'project-file'
                        }
                        layout="workspace"
                        state={activeFilePreviewState}
                        onOpenFile={onOpenFilePreview}
                        onOpenDefaultPath={onOpenDefaultPreviewPath}
                        onRevealPath={onRevealPreviewPathInWorkspace}
                        onListDirectory={onListPreviewDirectory}
                        onDownloadFile={
                          activeResultPreview
                            ? (path) => void downloadWrapperResultFile(path)
                            : undefined
                        }
                        downloadState={activeResultPreview ? fileDownload : null}
                        onCancelDownload={
                          activeResultPreview ? cancelActiveWrapperResultDownload : undefined
                        }
                      />
                    ) : null}
                  </Box>
                </Box>
              ) : isAnalysisWorkspaceView ? (
                activeAnalysisView
              ) : activeView === 'chat' && visibleWorkspaceTabs.length === 0 ? (
                emptyWorkspaceContent
              ) : (
                chatWorkspaceContent
              )}
            </Box>
          </Box>
        ) : (
          <Box component="main" sx={{ flex: 1, minWidth: 0, height: '100vh' }} />
        )}

        {workspaceSidePanelSlots.length > 0 ? (
          <>
            {!workspaceSidePanelOverlay ? (
              <AppResizeSeparator
                label="调整工作区面板宽度"
                onMouseDown={onStartWorkspaceSidePanelResize}
              />
            ) : null}
            <Box
              data-phi-workspace-side-panel-shell="true"
              data-phi-workspace-side-panel-presentation={
                workspaceSidePanelOverlay ? 'overlay' : 'dock'
              }
              sx={{
                position: workspaceSidePanelOverlay ? 'absolute' : 'relative',
                top: workspaceSidePanelOverlay ? 0 : 'auto',
                right: workspaceSidePanelOverlay ? 0 : 'auto',
                zIndex: workspaceSidePanelOverlay ? 20 : 'auto',
                height: '100vh',
                flexShrink: 0,
                display: 'flex',
                minWidth: 0,
                minHeight: 0
              }}
            >
              <WorkspaceSidePanel
                width={activeWorkspaceSidePanelWidth}
                slots={workspaceSidePanelSlots}
                maximized={workspaceSidePanelState.maximized}
                singleVisibleMode={responsiveSingleVisibleMode}
                onCloseSlot={onCloseWorkspaceSidePanelSlot}
                onToggleMaximized={onToggleWorkspaceSidePanelMaximized}
                renderSlot={(mode, slotContext) => {
                  if (mode === 'jobs') {
                    return (
                      <BackgroundJobsPanel
                        onOpenSession={(path) => void onOpenSessionFromSidebar(path)}
                        onOpenWrapper={onOpenWrapperRunFromJobs}
                      />
                    )
                  }
                  if (mode === 'browser') {
                    return (
                      <BrowserPanel
                        bridge={rendererApi.browser}
                        activePhiSessionId={activePhiSessionId ?? null}
                        activeSessionGeneration={activeSessionGeneration}
                        headerActions={slotContext.headerActions}
                        visible={
                          browserSlotVisible &&
                          !pendingApproval &&
                          !pendingUserInteraction &&
                          !browserOverlaySuspended &&
                          !isSettingsOpen &&
                          !isSessionSearchOpen &&
                          !isProviderDialogOpen &&
                          !exportTarget &&
                          !showEnvironmentSummary &&
                          !showOnboarding &&
                          !isNewProjectDialogOpen
                        }
                      />
                    )
                  }
                  return (
                    <TerminalPanel
                      bridge={rendererApi.terminal}
                      projects={projects}
                      headerActions={slotContext.headerActions}
                    />
                  )
                }}
              />
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
              left: `${chromeLayout.topLeftChromeInset}px`,
              display: 'flex',
              alignItems: 'center',
              gap: `${chromeLayout.topLeftChromeGap}px`,
              pointerEvents: 'auto',
              zIndex: 30,
              WebkitAppRegion: 'no-drag'
            }}
          >
            {chromeLayout.showMacWindowControls ? (
              <MacWindowControls
                onClose={() => void rendererApi.closeWindow()}
                onMinimize={() => void rendererApi.minimizeWindow()}
                onToggleFullscreen={() => void rendererApi.toggleWindowFullscreen()}
              />
            ) : null}
            <WindowNavigationControls
              isSidebarOpen={isSidebarOpen}
              onToggleSidebar={() => setIsSidebarOpen((value) => !value)}
              onOpenSessionSearch={() => setSessionSearchOpenWithBrowserGate(true)}
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
            right:
              workspaceSidePanelSlots.length === 0
                ? titlebarChromeHorizontalInset
                : `calc(${activeWorkspaceSidePanelWidth}px + ${workspaceSidePanelOverlay ? 0 : 1}px + ${titlebarChromeHorizontalInset})`,
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
            showSidePanelButtons
            activePanels={workspaceSidePanelSlots}
            onRefreshSidePanel={onRefreshWorkspaceSidePanel}
            onTogglePanel={onToggleWorkspaceSidePanel}
          />
        </Box>

        {isSessionSearchOpen && (
          <SessionSearchPanel
            key={JSON.stringify([
              projectSessionRefreshKey,
              projects.map((project) => [project.id, project.name, project.workingDirectory])
            ])}
            onClose={() => setSessionSearchOpenWithBrowserGate(false)}
            sessions={sessions}
            projects={projects}
            onFetchProjectSessions={onFetchProjectSessions}
            onSelectSession={onOpenSessionFromSidebar}
          />
        )}

        <AppDialogs
          rendererApi={rendererApi}
          isSettingsOpen={isSettingsOpen}
          setIsSettingsOpen={setSettingsOpenWithBrowserGate}
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
          onOpenApprovalSession={onOpenApprovalSession}
          onRespondToolApproval={onRespondToolApproval}
          themeMode={themeMode}
          setThemeMode={setThemeMode}
          themeFamily={themeFamily}
          setThemeFamily={setThemeFamily}
          noProjectTaskFolder={noProjectTaskFolder}
          preventSleepDuringRuns={preventSleepDuringRuns}
          nextActionSuggestionsEnabled={nextActionSuggestionsEnabled}
          isSavingAppSettings={isSavingAppSettings}
          onUpdateAppSettings={onUpdateAppSettings}
          onPickNoProjectTaskFolder={onPickNoProjectTaskFolder}
          autoCompactionTarget={{
            sessionPath: activeSessionPath,
            phiSessionId: activePhiSessionId ?? null,
            sessionGeneration: activeSessionGeneration
          }}
          autoCompactionDisabled={
            currentSessionIsBusy || currentSessionIsCompacting || isSessionChanging
          }
          contextCompacting={currentSessionIsCompacting}
          compactDisabled={
            currentSessionIsBusy ||
            isSessionChanging ||
            isBusy ||
            !selectedModel ||
            messages.length === 0
          }
          onCompactContext={() => {
            void onCompactContext({
              sessionPath: activeSessionPath,
              phiSessionId: activePhiSessionId ?? null,
              sessionGeneration: activeSessionGeneration
            })
          }}
          environmentSnapshot={environmentSnapshot}
          isLoadingEnvironment={isLoadingEnvironment}
          isRedetectingEnvironment={isRedetectingEnvironment}
          onRedetectEnvironment={onRedetectEnvironment}
          onSetEnvironmentToolPath={onSetEnvironmentToolPath}
          showEnvironmentSummary={showEnvironmentSummary}
          onDismissEnvironmentSummary={onDismissEnvironmentSummary}
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
          setIsNewProjectDialogOpen={setNewProjectDialogOpenWithBrowserGate}
          onCreateProject={onCreateProject}
          onCreateRemoteProject={onCreateRemoteProject}
          snackbarNotice={snackbarNotice}
          setSnackbarNotice={setSnackbarNotice}
          isChatWorkspaceView={isChatWorkspaceView}
          isSidebarOpen={isSidebarOpen}
          activityBarWidth={activityBarWidth}
          sidebarWidth={sidebarWidth}
          macTitlebarHeight={WINDOW_TITLEBAR_HEIGHT}
        />
        <SessionExportDialog
          session={exportTarget}
          busy={isExportingSession}
          onClose={() => setExportTarget(null)}
          onExport={() => void confirmExportSession()}
        />
        <PackageUpdateNotice />
      </Box>
    </ThemeProvider>
  )
}

export default App
