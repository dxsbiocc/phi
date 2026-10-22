import { appCopy } from './lib/appCopy'
import {
  browserPresentationSessionId,
  HUMAN_BROWSER_SESSION_GENERATION
} from '../../shared/browserSessionScope'
import { useWorkspaceFileActions } from './features/file-preview/hooks/useWorkspaceFileActions'
import { useFilePathOpeners } from './features/file-preview/hooks/useFilePathOpeners'
import { resourceActionMessages, resourceUi } from './lib/resourceUi'
import { getUiLanguage, normalizeUiLanguage, setUiLanguage, useUiLanguage } from './lib/i18n'
import { enUS, zhCN } from '@mui/material/locale'
import {
  textFileHasUnsavedChanges,
  useTextFileDrafts
} from './features/file-preview/lib/textFileDrafts'
import type { NotebookViewStateStore } from './features/analysis/lib/notebookViewState'
import {
  lazy,
  Suspense,
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
  createTheme,
  Stack,
  ThemeProvider,
  Typography
} from '@mui/material'
import {
  DEFAULT_ALLOW_EXTERNAL_FILE_READ,
  DEFAULT_FILE_OPEN_CONVERSATION_LAYOUT,
  DEFAULT_NEXT_ACTION_SUGGESTIONS_ENABLED,
  DEFAULT_PREVENT_SLEEP_DURING_RUNS
} from '../../shared/appSettingsTypes'
import type { WrapperCompositionCatalogItem } from '../../shared/wrapperCompositionManifestTypes'
import type { RemoteProjectCreateInput } from '../../shared/projectLocation'
import { MAX_PROMPT_IMAGES, type PromptImageInput } from '../../shared/promptImageTypes'
import type { ManualCompactionTarget } from '../../shared/contextUsageTypes'
import type {
  RuntimeRecoveryState,
  RuntimeRecoveryTarget,
  RuntimeSummaryContinuation
} from '../../shared/runtimeRecoveryTypes'
import type { PackageRegistryEntryView } from '../../shared/packageManagerTypes'
import { sidebarStateForFileOpenConversationLayout } from './features/chat/lib/fileOpenConversationLayout'
import { titlebarTrailingToggleChromeReserve } from './components/app-shell/WorkspaceTitlebar'
import { AppResizeSeparator } from './components/app-shell/AppResizeSeparator'
import { AppWindowChrome } from './components/app-shell/AppWindowChrome'
import { WorkspaceView } from './features/workspace/WorkspaceView'
import { workspaceViewModeFor } from './features/workspace/lib/workspaceViewMode'
import { useWorkspaceTabNavigation } from './features/workspace/hooks/useWorkspaceTabNavigation'
import { useAppDialogs } from './lib/app-shell/useAppDialogs'
import { usePanelRequests } from './lib/app-shell/usePanelRequests'
import { useAppCommands } from './lib/app-shell/useAppCommands'
import { useAppBootstrap } from './lib/app-shell/useAppBootstrap'
import { useWorkspaceSidebar } from './lib/app-shell/useWorkspaceSidebar'
import { useChatRunControl } from './features/chat/hooks/useChatRunControl'
import { useSessionEventBridge } from './features/chat/hooks/useSessionEventBridge'
import { usePromptSend } from './features/chat/hooks/usePromptSend'
import { useQueuedPromptDrain } from './features/chat/hooks/useQueuedPromptDrain'
import type { SendPromptOptions } from './features/chat/lib/promptQueue'
import { HomeView } from './features/home/HomeView'
import { runtimeStatusesSnapshot } from './features/runtime/lib/runtimeGroups'
import { homeResourceIcons } from './features/home/lib/homeOverview'
import { SessionExportDialog } from './features/chat/components/SessionExportDialog'
import { RuntimeRecoveryBanner } from './features/chat/components/RuntimeRecoveryBanner'
import {
  remoteModelControlsBlocked,
  remoteRecoveryTargetForSession,
  sameRuntimeRecoveryTarget,
  shouldAutoConnectRemoteSession
} from './features/chat/lib/runtimeRecoveryState'
import { SessionSearchPanel } from './features/session-search/SessionSearchPanel'
import { BackgroundJobsPanel, LATEST_JUPYTER_JOB_KEY } from './features/jobs/BackgroundJobsPanel'
import { jupyterProjectJobRequestKey } from './features/jobs/lib/requestedBackgroundJob'
import {
  useBackgroundJobRetention,
  useJupyterStartupOverview,
  refreshBackgroundJobs
} from './features/jobs/hooks/useBackgroundJobsData'
import BrowserPanel from './features/browser/BrowserPanel'
import TerminalPanel from './features/terminal/TerminalPanel'
import { useTerminalWorkspaceRestoration } from './features/terminal/hooks/useTerminalWorkspaceRestoration'
import { useBrowserTrustedOverlayGate } from './features/browser/hooks/useBrowserTrustedOverlayGate'
import { useBrowserPanelRequests } from './features/browser/hooks/useBrowserPanelRequests'
import {
  browserLinkFailureMessage,
  createBrowserLinkOpeningCoordinator,
  type BrowserLinkOpenFailure
} from './features/browser/lib/browserLinkOpening'
import { createBrowserRequestIdFactory } from './features/browser/lib/browserPanelState'
import type { BrowserTrustedOverlayRequest } from './features/browser/lib/browserTrustedOverlayGate'
import { useEnvironmentBuildNotices } from './features/jobs/hooks/useEnvironmentBuildNotices'
import type { LocalPathKind } from './components/MarkdownContent'
import PhiPluginsView, { PhiPluginCatalogDialog } from './features/phi-plugin/PhiPluginsView'
import { usePhiPlugins } from './features/phi-plugin/hooks/usePhiPlugins'
import { WrapperDetail } from './features/wrapper/WrapperView'
import { useWrapperCatalog } from './features/wrapper/hooks/useWrapperCatalog'
import { wrapperResultBelongsToProject } from './features/wrapper/lib/resultFiles'
import { SkillCatalogDialog, SkillDetail } from './features/skill/SkillView'
import { useSkillCatalog } from './features/skill/hooks/useSkillCatalog'
import { McpDetail } from './features/mcp/McpView'
import { useMcpServerCatalog } from './features/mcp/hooks/useMcpServerCatalog'
import { useLocalConnectorNotices } from './features/mcp/hooks/useLocalConnectorNotices'
import { type SettingsCategory } from './components/SettingsDialog'
import AppDialogs, { type SnackbarNotice } from './AppDialogs'
import AppActivityBar from './AppActivityBar'
import AppWorkspaceSidebar, { type WorkspaceSidebarDataProps } from './AppWorkspaceSidebar'
import FilePreviewPanel, {
  FilePreviewTitleTab,
  type FilePreviewPanelState
} from './features/file-preview/FilePreviewPanel'
import type { AnalysisWorkspaceFileTab } from './features/analysis/AnalysisView'
import { WorkspaceSidePanel } from './components/WorkspaceSidePanel'
import { PackageUpdateNotice } from './components/PackageUpdateNotice'
import { useAnalysisNotebookRuntime } from './features/analysis/hooks/useAnalysisNotebookRuntime'
import { createPaletteTheme } from './theme'
import { useThemeMode } from './useThemeMode'
import { syncWindowBackground } from './lib/windowStartup'
import { useProviderAuth } from './useProviderAuth'
import { isThinkingLevel, modelOptionFromSelection, useModelSelection } from './useModelSelection'
import { useProjects } from './useProjects'
import {
  notebookWorkspaceTabId,
  upsertReusableWorkspaceFileTab,
  useWorkspaceFileTabs,
  type WorkspaceFileTab
} from './useWorkspaceFileTabs'
import { useSessionStore, sessionStateKey, sessionAgentEventStates } from './stores/sessionStore'
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
import { useRemoteConnectionRetry } from './features/project/hooks/useRemoteConnectionRetry'
import { shouldRetryRemoteReads } from './features/project/lib/remoteConnectionUi'
import {
  rememberRemoteUploadDestination,
  remoteUploadDestinationDirectory
} from './lib/remoteUploadDestination'
import type { RemoteProjectReachability } from '../../shared/projectLocation'
import { chatItemsFromSessionMessages } from './lib/chatItems'
import { readableErrorMessage } from './lib/sessionNotifications'
import { sessionDraftKey, updateSessionDraft } from './lib/sessionDrafts'
import {
  isPointerWithinWorkspaceSidebarPreview,
  isWorkspaceSidebarPreviewDialogActive
} from './lib/workspaceSidebarPreviewPointer'
import { sessionDisplayTitle, titleFromMessages, truncateSessionTitle } from './lib/sessionTitles'
import { orderProjectsForSessionSelection } from './lib/projectSidebar'
import { workspaceScopeLabelForCwd } from './lib/workspaceScope'
import {
  isWorkspaceFileTabKind,
  isWorkspaceResourceKind,
  resolveWorkspaceResourceTabIcons,
  workspaceFileTabKey,
  workspaceResourceKindLabel,
  workspaceSessionTabKey,
  visibleWorkspaceTabsForState,
  type WorkspaceFileWorkspaceTab,
  type WorkspaceResourceKind,
  type WorkspaceSessionTab,
  type WorkspaceTab
} from './lib/workspaceResourceTabs'
import { workspaceSidebarModeIsExpanded, type WorkspaceSidebarMode } from './lib/workspaceSidebar'
import type { ChatResourceMention } from './lib/chatResourceMentions'
import type { WorkspaceSidePanelMode } from './lib/workspaceSidePanelMode'
import { useWorkspaceSidePanel } from './lib/app-shell/useWorkspaceSidePanel'
import {
  sessionRuntimeStateIsBusy,
  sessionRuntimeStatePausesQueue,
  sessionStatusIsBusy
} from './lib/sessionRuntimeState'
import { navigationPaneWidth } from './layout'
import type { UserMessageRetryTarget } from './components/chat/ChatUserMessage'
import type {
  AnalysisJupyterRuntimeStatus,
  AnalysisNotebookFileChange,
  EnvironmentSnapshot,
  EnvironmentToolId,
  CurrentSession,
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

function isWorkspaceFileWorkspaceTab(
  tab: WorkspaceTab | null | undefined
): tab is WorkspaceFileWorkspaceTab {
  return Boolean(tab && isWorkspaceFileTabKind(tab.kind))
}
const isMac = typeof window !== 'undefined' && window.platform === 'darwin'

export type AppView =
  'chat' | 'projects' | 'analysis' | 'runtime' | 'plugins' | 'skills' | 'mcp' | 'wrappers'

const activityBarWidth = 48
const ChatView = lazy(() => import('./features/chat/ChatView'))
const AnalysisView = lazy(() => import('./features/analysis/AnalysisView'))
const minNavigationPaneWidth = 240
const maxNavigationPaneWidth = 520

function App(): React.JSX.Element {
  const uiLanguage = useUiLanguage()
  useBackgroundJobRetention()
  const jupyterStartupOverview = useJupyterStartupOverview()
  const {
    mode: themeMode,
    effectiveMode,
    setMode: setThemeMode,
    palette: themePalette,
    setPalette: setThemePalette
  } = useThemeMode()
  const theme = useMemo(
    () =>
      createTheme(
        createPaletteTheme(effectiveMode, themePalette),
        uiLanguage === 'zh-CN' ? zhCN : enUS
      ),
    [themePalette, effectiveMode, uiLanguage]
  )
  useEffect(() => {
    syncWindowBackground(theme.palette.background.default)
  }, [theme])

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
    draftInputs,
    setDraftInputs,
    getSessionRuntimeState,
    replaceMessages,
    updateMessages,
    mergeSessionSummariesRuntimeState,
    applyCurrentSession,
    acknowledgeActiveSession,
    refreshSessions,
    startFreshChat,
    onRenameSession,
    onRespondToolApproval,
    onRespondAgentUserInteraction
  } = useSessionStore()
  const messages = agentEventState.messages
  // Stopping a run clears both interaction channels at once; the setters are stable.
  const clearPendingInteractions = useCallback((): void => {
    setPendingApproval(null)
    setPendingUserInteraction(null)
  }, [setPendingApproval, setPendingUserInteraction])
  // Dialog ownership lives in its own hook; names and setter signatures are unchanged
  // so call sites stay as they were while the shell gets smaller.
  const {
    isSettingsOpen,
    setIsSettingsOpen,
    settingsCategory,
    setSettingsCategory,
    isSessionSearchOpen,
    setIsSessionSearchOpen,
    isNewProjectDialogOpen,
    setIsNewProjectDialogOpen,
    isSkillCatalogOpen,
    setIsSkillCatalogOpen,
    isPhiPluginCatalogOpen,
    setIsPhiPluginCatalogOpen,
    showOnboarding,
    setShowOnboarding,
    showEnvironmentSummary,
    setShowEnvironmentSummary,
    exportTarget,
    setExportTarget,
    isExportingSession,
    setIsExportingSession
  } = useAppDialogs()
  const homeCreateSelectRef = useRef(false)
  const [homeCreatedProjectId, setHomeCreatedProjectId] = useState<string | null>(null)
  useEffect(() => {
    if (!isNewProjectDialogOpen) homeCreateSelectRef.current = false
  }, [isNewProjectDialogOpen])
  const {
    isSidebarOpen,
    setIsSidebarOpen,
    sidebarWidth,
    setSidebarWidth,
    workspaceSidebarMode,
    setWorkspaceSidebarMode,
    workspaceSidebarPreview,
    setWorkspaceSidebarPreview,
    sessionTabWasOpened,
    setSessionTabWasOpened,
    closedWorkspaceSessionTabKeys,
    setClosedWorkspaceSessionTabKeys
  } = useWorkspaceSidebar()
  const workspaceSidebarPreviewCloseTimer = useRef<number | null>(null)
  const [chatScrollPositionStore] = useState(() => new Map<string, number>())
  const [notebookViewStateStore] = useState<NotebookViewStateStore>(() => new Map())
  const [activeView, setActiveViewState] = useState<AppView>('chat')

  const navigateToView = useCallback((view: AppView): void => {
    setActiveViewState(view)
  }, [])

  const [workspaceTabs, setWorkspaceTabs] = useState<WorkspaceTab[]>([])
  const [activeWorkspaceTabKey, setActiveWorkspaceTabKey] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const [isSendingMessage, setIsSendingMessage] = useState(false)
  const [personaMarkdown, setPersonaMarkdownState] = useState<string | null>(null)
  const [noProjectTaskFolder, setNoProjectTaskFolder] = useState('')
  const [allowExternalFileRead, setAllowExternalFileRead] = useState(
    DEFAULT_ALLOW_EXTERNAL_FILE_READ
  )
  const [preventSleepDuringRuns, setPreventSleepDuringRuns] = useState(
    DEFAULT_PREVENT_SLEEP_DURING_RUNS
  )
  const [nextActionSuggestionsEnabled, setNextActionSuggestionsEnabled] = useState(
    DEFAULT_NEXT_ACTION_SUGGESTIONS_ENABLED
  )
  const [fileOpenConversationLayout, setFileOpenConversationLayout] = useState(
    DEFAULT_FILE_OPEN_CONVERSATION_LAYOUT
  )
  const [environmentSnapshot, setEnvironmentSnapshot] = useState<EnvironmentSnapshot | null>(null)
  const [isLoadingEnvironment, setIsLoadingEnvironment] = useState(true)
  const [isLoadingHomeSessions, setIsLoadingHomeSessions] = useState(true)
  const [isRedetectingEnvironment, setIsRedetectingEnvironment] = useState(false)
  const [isSavingAppSettings, setIsSavingAppSettings] = useState(false)
  const appSettingsRevisionRef = useRef(0)
  const [isUpdatingPermissionMode, setIsUpdatingPermissionMode] = useState(false)
  const permissionModeUpdateRef = useRef(false)
  const [snackbarNotice, setSnackbarNotice] = useState<SnackbarNotice | null>(null)
  const isSendingRef = useRef(false)
  const currentSessionIsBusyRef = useRef(false)
  const sessionRequestRef = useRef(0)
  const getModelSelectionSessionKey = useCallback(() => {
    const state = useSessionStore.getState()
    return sessionStateKey({
      phiSessionId: state.activePhiSessionId,
      path: state.activeSessionPath,
      cwd: state.activeCwd,
      sessionGeneration: state.activeSessionGeneration
    })
  }, [])
  const sendRequestRef = useRef(0)
  const projectSidebarSelectionRequestRef = useRef(0)
  const rendererApi = useMemo(() => getRendererApi(), [])
  const [runningJupyterRuntimes, setRunningJupyterRuntimes] = useState<
    AnalysisJupyterRuntimeStatus[]
  >([])
  const runningJupyterRequestRef = useRef(0)
  const runningJupyterAppliedRequestRef = useRef(0)
  const runningJupyterSnapshotRef = useRef('[]')
  const refreshRunningJupyterRuntimes = useCallback(async (): Promise<void> => {
    const request = ++runningJupyterRequestRef.current
    try {
      const statuses = await rendererApi.listAnalysisJupyterRuntimeStatuses()
      if (request < runningJupyterAppliedRequestRef.current) return
      runningJupyterAppliedRequestRef.current = request
      const snapshot = runtimeStatusesSnapshot(statuses)
      if (snapshot === runningJupyterSnapshotRef.current) return
      runningJupyterSnapshotRef.current = snapshot
      setRunningJupyterRuntimes(statuses)
    } catch {
      // Keep the last known entries during a temporary IPC failure.
    }
  }, [rendererApi])
  useEffect(() => {
    if (workspaceSidebarMode !== 'runtime' || !isSidebarOpen) return
    void Promise.resolve().then(refreshRunningJupyterRuntimes)
    const interval = window.setInterval(() => void refreshRunningJupyterRuntimes(), 2500)
    return () => window.clearInterval(interval)
  }, [isSidebarOpen, refreshRunningJupyterRuntimes, workspaceSidebarMode])
  const isWindowFullscreen = useWindowFullscreen(rendererApi, isMac)
  const chromeLayout = windowChromeLayout({
    isMac,
    sidebarOpen: isSidebarOpen,
    fullscreen: isWindowFullscreen
  })
  const getActiveCwd = useCallback(() => useSessionStore.getState().activeCwd, [])
  const getActiveProjectId = useCallback(() => useSessionStore.getState().activeProjectId, [])

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
      options?: Pick<SnackbarNotice, 'persistent' | 'action'>
    ): void => {
      setSnackbarNotice({
        id: Date.now(),
        message,
        severity,
        persistent: options?.persistent,
        action: options?.action
      })
    },
    []
  )
  useEnvironmentBuildNotices(showSnackbar)
  const mcpConnectorDialogCloserRef = useRef<(() => void) | null>(null)
  const registerMcpConnectorDialogCloser = useCallback((close: () => void): (() => void) => {
    mcpConnectorDialogCloserRef.current = close
    return () => {
      if (mcpConnectorDialogCloserRef.current === close) {
        mcpConnectorDialogCloserRef.current = null
      }
    }
  }, [])

  const showSnackbarError = useCallback(
    (error: unknown, fallback: string): void => {
      showSnackbar(readableErrorMessage(error, fallback), 'error')
    },
    [showSnackbar]
  )

  const blockRemoteLocalFileAction = useCallback((): boolean => {
    if (useSessionStore.getState().activeProjectLocation?.kind !== 'ssh') return false
    showSnackbarError(new Error(appCopy.remoteFilesUnavailable), appCopy.remoteFilesUnavailable)
    return true
  }, [showSnackbarError])

  const applyAppSettings = useCallback((settings: PhiAppSettings): void => {
    setUiLanguage(normalizeUiLanguage(settings.uiLanguage))
    setNoProjectTaskFolder(settings.noProjectTaskFolder)
    setAllowExternalFileRead(settings.allowExternalFileRead)
    setPreventSleepDuringRuns(settings.preventSleepDuringRuns)
    setNextActionSuggestionsEnabled(settings.nextActionSuggestionsEnabled)
    setFileOpenConversationLayout(settings.fileOpenConversationLayout)
  }, [])

  useEffect(() => {
    let cancelled = false
    const revision = appSettingsRevisionRef.current
    void rendererApi
      .getAppSettings()
      .then((settings) => {
        if (!cancelled && appSettingsRevisionRef.current === revision) {
          applyAppSettings(settings)
        }
      })
      .catch((error) => {
        if (!cancelled && appSettingsRevisionRef.current === revision) {
          showSnackbarError(error, appCopy.loadSettingsFailed)
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
          showSnackbarError(error, appCopy.loadEnvironmentFailed)
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
  }, [rendererApi, showSnackbarError, setShowEnvironmentSummary])

  const onRedetectEnvironment = useCallback(async (): Promise<void> => {
    setIsRedetectingEnvironment(true)
    try {
      setEnvironmentSnapshot(await rendererApi.redetectEnvironment())
    } catch (error) {
      showSnackbarError(error, appCopy.detectEnvironmentFailed)
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
      showSnackbarError(error, appCopy.dismissEnvironmentFailed)
    }
  }, [rendererApi, showSnackbarError, setShowEnvironmentSummary])

  const onUpdateAppSettings = useCallback(
    async (patch: PhiAppSettingsPatch): Promise<void> => {
      const revision = ++appSettingsRevisionRef.current
      const previousUiLanguage = getUiLanguage()
      const previousNoProjectTaskFolder = noProjectTaskFolder
      const previousAllowExternalFileRead = allowExternalFileRead
      const previousPreventSleepDuringRuns = preventSleepDuringRuns
      const previousNextActionSuggestionsEnabled = nextActionSuggestionsEnabled
      const previousFileOpenConversationLayout = fileOpenConversationLayout

      if (patch.uiLanguage !== undefined) setUiLanguage(patch.uiLanguage)

      if (patch.noProjectTaskFolder !== undefined) {
        setNoProjectTaskFolder(patch.noProjectTaskFolder)
      }
      if (patch.allowExternalFileRead !== undefined) {
        setAllowExternalFileRead(patch.allowExternalFileRead)
      }
      if (patch.preventSleepDuringRuns !== undefined) {
        setPreventSleepDuringRuns(patch.preventSleepDuringRuns)
      }
      if (patch.nextActionSuggestionsEnabled !== undefined) {
        setNextActionSuggestionsEnabled(patch.nextActionSuggestionsEnabled)
      }
      if (patch.fileOpenConversationLayout !== undefined) {
        setFileOpenConversationLayout(patch.fileOpenConversationLayout)
      }

      setIsSavingAppSettings(true)
      try {
        const settings = await rendererApi.updateAppSettings(patch)
        if (appSettingsRevisionRef.current === revision) applyAppSettings(settings)
      } catch (error) {
        if (appSettingsRevisionRef.current !== revision) return
        setUiLanguage(previousUiLanguage)
        setNoProjectTaskFolder(previousNoProjectTaskFolder)
        setAllowExternalFileRead(previousAllowExternalFileRead)
        setPreventSleepDuringRuns(previousPreventSleepDuringRuns)
        setNextActionSuggestionsEnabled(previousNextActionSuggestionsEnabled)
        setFileOpenConversationLayout(previousFileOpenConversationLayout)
        showSnackbarError(error, appCopy.saveSettingsFailed)
      } finally {
        if (appSettingsRevisionRef.current === revision) setIsSavingAppSettings(false)
      }
    },
    [
      allowExternalFileRead,
      applyAppSettings,
      fileOpenConversationLayout,
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
      showSnackbarError(error, appCopy.chooseTaskFolderFailed)
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
  } = useModelSelection(providerStatuses, showSnackbarError, getModelSelectionSessionKey)
  const {
    projects,
    setProjects,
    projectsRef,
    updatingPermissionProjectId,
    updatingRemoteProjectId,
    refreshProjects,
    onUpdateProjectPermissionMode,
    onUpdateProjectDefaults,
    onProjectUpdated,
    onUpdateProjectRemoteConnection,
    onUpdateProjectRemoteDefaults
  } = useProjects(showSnackbarError)
  const runtimeStartLogCwds = useMemo(
    () =>
      projects.flatMap((project) =>
        project.location?.kind === 'ssh' && jupyterStartupOverview.projectIds.includes(project.id)
          ? [project.workingDirectory, project.location.canonicalRoot]
          : []
      ),
    [jupyterStartupOverview.projectIds, projects]
  )
  useTerminalWorkspaceRestoration(
    rendererApi.terminal,
    projects,
    activeProjectId,
    activePhiSessionId
  )

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
    analysisJupyterError,
    pendingJupyterCellStart,
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
    onStartJupyterForPendingCell,
    onDismissJupyterCellStart,
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
  useEffect(() => {
    if (
      !isSidebarOpen ||
      workspaceSidebarMode !== 'runtime' ||
      jupyterStartupOverview.signature === '[]'
    ) {
      return
    }
    let active = true
    void Promise.resolve().then(() => {
      if (!active) return
      if (activeProjectId && jupyterStartupOverview.projectIds.includes(activeProjectId)) {
        void refreshAnalysisJupyterRuntimeStatus()
      }
      void refreshRunningJupyterRuntimes()
    })
    return () => {
      active = false
    }
  }, [
    activeProjectId,
    isSidebarOpen,
    workspaceSidebarMode,
    jupyterStartupOverview.signature,
    jupyterStartupOverview.projectIds,
    refreshAnalysisJupyterRuntimeStatus,
    refreshRunningJupyterRuntimes
  ])
  const {
    slots: workspaceSidePanelSlots,
    state: workspaceSidePanelState,
    collapsed: workspaceSidePanelCollapsed,
    canSplit: workspaceSidePanelCanSplit,
    overlay: workspaceSidePanelOverlay,
    activeWidth: activeWorkspaceSidePanelWidth,
    singleVisibleMode: responsiveSingleVisibleMode,
    treeRevision: workspaceSidePanelTreeRevision,
    open: openWorkspaceSidePanel,
    close: closeWorkspaceSidePanel,
    toggleForLayout: toggleWorkspaceSidePanelForLayout,
    toggleMaximized: toggleWorkspaceSidePanelMaximized,
    refreshTree: refreshWorkspaceSidePanelTree,
    startResize: onStartWorkspaceSidePanelResize
  } = useWorkspaceSidePanel({
    navigationWidth: activityBarWidth + (isSidebarOpen ? sidebarWidth : 0)
  })
  // One-shot requests into the jobs/terminal side panels.
  const {
    connectorJobId: requestedConnectorJobId,
    backgroundJobKey: requestedBackgroundJobKey,
    terminalInput: requestedTerminalInput,
    requestConnectorJob,
    consumeConnectorJob,
    requestBackgroundJob,
    consumeBackgroundJob,
    requestTerminalInput,
    consumeTerminalInput
  } = usePanelRequests()
  const browserSlotVisible =
    workspaceSidePanelSlots.includes('browser') &&
    (workspaceSidePanelState.maximized === null ||
      workspaceSidePanelState.maximized === 'browser') &&
    (workspaceSidePanelSlots.length === 1 ||
      workspaceSidePanelCanSplit ||
      workspaceSidePanelState.active === 'browser')
  const activeBrowserSessionId = browserPresentationSessionId(activePhiSessionId)
  const activeBrowserSessionGeneration = activePhiSessionId
    ? activeSessionGeneration
    : HUMAN_BROWSER_SESSION_GENERATION
  const openBrowserPanelFromRequest = useCallback((): void => {
    openWorkspaceSidePanel('browser')
  }, [openWorkspaceSidePanel])
  const showBrowserAppShellFailure = useCallback(
    (message: string): void => showSnackbar(message),
    [showSnackbar]
  )
  useBrowserPanelRequests({
    bridge: rendererApi.browser,
    activeSessionId: activeBrowserSessionId,
    onRequest: openBrowserPanelFromRequest,
    onFailure: showBrowserAppShellFailure
  })
  const showBrowserLinkFailure = useCallback(
    (_url: string, failure: BrowserLinkOpenFailure): void => {
      showSnackbar(browserLinkFailureMessage(failure), 'error')
    },
    [showSnackbar]
  )
  const browserLinkOpeningCoordinator = useMemo(() => {
    const nextRequestId = createBrowserRequestIdFactory()
    return createBrowserLinkOpeningCoordinator({
      execute: (command) => rendererApi.browser.execute(command),
      nextRequestId,
      getActiveSessionId: () =>
        browserPresentationSessionId(useSessionStore.getState().activePhiSessionId),
      openBrowserPanel: () => openWorkspaceSidePanel('browser'),
      showFailure: showBrowserLinkFailure
    })
  }, [openWorkspaceSidePanel, rendererApi, showBrowserLinkFailure])
  const onOpenBackgroundJobs = useCallback((): void => {
    browserLinkOpeningCoordinator.invalidate()
    openWorkspaceSidePanel('jobs')
  }, [browserLinkOpeningCoordinator, openWorkspaceSidePanel])
  const onOpenLocalConnectorJobs = useCallback(
    (jobId?: string): void => {
      mcpConnectorDialogCloserRef.current?.()
      requestConnectorJob(jobId)
      onOpenBackgroundJobs()
    },
    [onOpenBackgroundJobs, requestConnectorJob]
  )
  useLocalConnectorNotices(showSnackbar, onOpenLocalConnectorJobs, refreshMcpServers)
  // Remote Jupyter startup is a background job; its steps and errors live in the jobs panel.
  const onOpenJupyterStartLog = useCallback(
    (projectCwd?: string): void => {
      const project = projects.find(
        (item) =>
          item.location?.kind === 'ssh' &&
          (item.location.canonicalRoot === projectCwd || item.workingDirectory === projectCwd)
      )
      if (project) requestBackgroundJob(jupyterProjectJobRequestKey(project.id))
      else if (!projectCwd) requestBackgroundJob(LATEST_JUPYTER_JOB_KEY)
      onOpenBackgroundJobs()
    },
    [onOpenBackgroundJobs, projects, requestBackgroundJob]
  )
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
    closeWorkspaceSidePanel('browser')
  }, [browserLinkOpeningCoordinator, closeWorkspaceSidePanel])
  const handleBrowserTrustedOverlayFailure = useCallback((): void => {
    showSnackbar(appCopy.dialogOpenFailed)
  }, [showSnackbar])
  const {
    suspended: browserOverlaySuspended,
    enqueue: enqueueBrowserTrustedOverlayGate,
    cancel: cancelBrowserTrustedOverlay
  } = useBrowserTrustedOverlayGate({
    bridge: rendererApi.browser,
    activePhiSessionId: activeBrowserSessionId,
    activeSessionGeneration: activeBrowserSessionGeneration,
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
    [cancelBrowserTrustedOverlay, openLocalTrustedOverlay, setIsSettingsOpen]
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
    [cancelBrowserTrustedOverlay, openLocalTrustedOverlay, setIsNewProjectDialogOpen]
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
    [cancelBrowserTrustedOverlay, openLocalTrustedOverlay, setIsSessionSearchOpen]
  )

  const handleNotebookFileChangedEvent = useCallback(
    (change: AnalysisNotebookFileChange): void => {
      if (
        change.projectCwd !== activeCwd &&
        change.projectCwd !== analysisNotebookRegistry?.projectCwd
      )
        return
      handleNotebookFileChanged(change)
      if (change.type === 'changed') {
        setWorkspaceFileTabs((tabs) =>
          tabs.map((tab) =>
            (tab.ownerCwd === activeCwd || !tab.ownerCwd) &&
            (tab.path === change.path || tab.path === change.file.path)
              ? {
                  ...tab,
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
        setWorkspaceFileTabs((tabs) =>
          tabs.filter(
            (tab) => tab.path !== change.path || (tab.ownerCwd && tab.ownerCwd !== activeCwd)
          )
        )
        if (activeWorkspaceFilePath === change.path) {
          setActiveWorkspaceFilePath(null)
        }
      }
    },
    [
      activeCwd,
      activeWorkspaceFilePath,
      analysisNotebookRegistry?.projectCwd,
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
      if (isThinkingLevel(level)) setThinkingLevel(level)
    },
    [models, rendererApi, setSelectedModel, setThinkingLevel]
  )

  const onResetSending = useCallback((): void => {
    sendRequestRef.current += 1
    isSendingRef.current = false
    setIsSendingMessage(false)
  }, [])

  const openNewChat = useCallback(
    async (initialInput?: string): Promise<CurrentSession | null> => {
      projectSidebarSelectionRequestRef.current += 1
      const request = ++sessionRequestRef.current
      setIsSessionChanging(true)
      try {
        const current = await rendererApi.createSession()
        if (request !== sessionRequestRef.current) return null
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
        if (initialInput) {
          const createdDraftKey = sessionDraftKey({
            phiSessionId: current.phiSessionId,
            path: current.path,
            cwd: current.cwd,
            sessionGeneration: current.sessionGeneration
          })
          setDraftInputs((previous) => updateSessionDraft(previous, createdDraftKey, initialInput))
        }
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
        return current
      } finally {
        if (request === sessionRequestRef.current) {
          setIsSessionChanging(false)
        }
      }
      return null
    },
    [
      applyCurrentSession,
      navigateToView,
      onResetSending,
      refreshCurrentModelControls,
      rendererApi,
      resetAnalysisJupyterRuntimeForCwdChange,
      setIsSessionChanging,
      setDraftInputs,
      startFreshChat,
      setClosedWorkspaceSessionTabKeys,
      setSessionTabWasOpened,
      setWorkspaceSidebarMode
    ]
  )

  const onNewChat = useCallback(async (): Promise<void> => {
    await openNewChat()
  }, [openNewChat])
  const onOpenConnectorSetupAgent = useCallback(
    (prompt: string): void => {
      void openNewChat(prompt)
    },
    [openNewChat]
  )
  const onOpenConnectorSetupTerminal = useCallback(
    (command: string): void => {
      if (!command || command.length > 200 || /[\0\r\n]/u.test(command)) {
        showSnackbar(appCopy.invalidSetupCommand, 'error')
        return
      }
      requestTerminalInput(command)
      openWorkspaceSidePanel('terminal')
    },
    [openWorkspaceSidePanel, requestTerminalInput, showSnackbar]
  )

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
      setIsSessionChanging,
      setClosedWorkspaceSessionTabKeys,
      setSessionTabWasOpened
    ]
  )

  const onDeleteSession = useCallback(
    async (path: string, confirmed?: true): Promise<void> => {
      if (confirmed !== true) {
        showSnackbar(appCopy.confirmConversationDeletionFirst, 'warning')
        return
      }
      const request = sessionRequestRef.current
      const wasActive = path === useSessionStore.getState().activeSessionPath
      try {
        const result = await rendererApi.deleteSession(path, confirmed)
        if (result.status === 'connection-required') {
          showSnackbar(appCopy.remoteDeleteRequiresConnection, 'warning')
          return
        }
        if (result.status === 'confirmation-required') {
          showSnackbar(appCopy.confirmConversationDeletionFirst, 'warning')
          return
        }
      } catch (error) {
        showSnackbarError(error, appCopy.deleteConversationFailed)
        return
      }
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
      showSnackbar,
      showSnackbarError,
      setProjectSessionRefreshKey,
      setSessionTabWasOpened
    ]
  )

  const onExportSession = useCallback(
    (session: SessionSummary): void => {
      if (session.phiSessionId) {
        openLocalTrustedOverlay('session-export', () => setExportTarget(session))
      }
    },
    [openLocalTrustedOverlay, setExportTarget]
  )

  const confirmExportSession = async (): Promise<void> => {
    if (!exportTarget?.phiSessionId || isExportingSession) return
    setIsExportingSession(true)
    try {
      const result = await rendererApi.exportSession(exportTarget.phiSessionId)
      setExportTarget(null)
      if (result) showSnackbar(appCopy.sessionExported(result.path), 'success')
    } catch (error) {
      showSnackbarError(error, appCopy.exportFailed)
    } finally {
      setIsExportingSession(false)
    }
  }

  const showActiveConversationInSidebar = useCallback((): void => {
    projectSidebarSelectionRequestRef.current += 1
    setWorkspaceSidebarMode('conversations')
    setIsSidebarOpen(true)
  }, [setIsSidebarOpen, setWorkspaceSidebarMode])

  const applyFileOpenConversationLayout = useCallback((): void => {
    const next = sidebarStateForFileOpenConversationLayout(fileOpenConversationLayout)
    if (!next) return
    projectSidebarSelectionRequestRef.current += 1
    setWorkspaceSidebarMode(next.workspaceSidebarMode)
    setIsSidebarOpen(next.isSidebarOpen)
  }, [fileOpenConversationLayout, setIsSidebarOpen, setWorkspaceSidebarMode])

  const onNotebookDirtyChange = useCallback(
    (file: { path: string }, dirty: boolean): void => {
      setWorkspaceFileTabs((tabs) => {
        const current = tabs.find(
          (tab) =>
            tab.kind === 'notebook' &&
            tab.path === file.path &&
            (!tab.ownerProjectId || tab.ownerProjectId === activeProjectId) &&
            (!tab.ownerCwd || tab.ownerCwd === activeCwd)
        )
        if (!current || Boolean(current.dirty) === dirty) return tabs
        const updated = { ...current, dirty }
        return dirty
          ? tabs.map((tab) => (tab.id === current.id ? updated : tab))
          : upsertReusableWorkspaceFileTab(tabs, updated)
      })
    },
    [activeCwd, activeProjectId, setWorkspaceFileTabs]
  )

  const blockNotebookWorkspaceOpen = useCallback(
    (path: string): boolean => {
      if (useSessionStore.getState().activeProjectLocation?.kind !== 'ssh') {
        return blockRemoteLocalFileAction()
      }
      const scope = getActiveRemoteProject()
      if (scope && remotePathInsideRoot(path, scope.canonicalRoot)) return false
      showSnackbarError(new Error(appCopy.wrongRemoteNotebook), appCopy.openNotebookFailed)
      return true
    },
    [blockRemoteLocalFileAction, getActiveRemoteProject, showSnackbarError]
  )

  const onOpenNotebookWorkspaceFile = useCallback(
    (path: string): void => {
      if (blockNotebookWorkspaceOpen(path)) return
      applyFileOpenConversationLayout()
      const session = useSessionStore.getState()
      const normalizedPath = absoluteWorkspacePath(session.activeCwd, path)
      const tabId = notebookWorkspaceTabId(session.activeProjectId, normalizedPath)
      const title = fileNameFromPath(normalizedPath)
      filePreviewRequestRef.current += 1
      setFilePreview(null)
      setActiveWorkspaceTabKey(workspaceFileTabKey(tabId))
      setWorkspaceFileTabs((tabs) => {
        const nextTab: WorkspaceFileTab = {
          id: tabId,
          path: normalizedPath,
          name: title,
          status: normalizedPath,
          absolutePath: normalizedPath,
          kind: 'notebook',
          pathKind: 'file',
          ownerProjectId: session.activeProjectId,
          ownerSessionPath: session.activeSessionPath,
          ownerCwd: session.activeCwd
        }
        return upsertReusableWorkspaceFileTab(tabs, nextTab)
      })
      setActiveWorkspaceFilePath(normalizedPath)
      navigateToView('analysis')
      const cachedFile = activateCachedAnalysisNotebook(normalizedPath)
      if (cachedFile) {
        setWorkspaceFileTabs((tabs) =>
          tabs.map((tab) =>
            tab.id === tabId
              ? {
                  ...tab,
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
            tab.id === tabId
              ? {
                  ...tab,
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
      applyFileOpenConversationLayout,
      blockNotebookWorkspaceOpen,
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
    async (project: Project): Promise<CurrentSession | null> => {
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
        if (request !== sessionRequestRef.current) return null
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
        return current
      } finally {
        if (request === sessionRequestRef.current) {
          setIsSessionChanging(false)
        }
      }
      return null
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
      startFreshChat,
      setClosedWorkspaceSessionTabKeys,
      setSessionTabWasOpened,
      setWorkspaceSidebarMode
    ]
  )

  const onCreateProject = async (
    name: string,
    workingDirectory: string,
    permissionMode: PermissionMode
  ): Promise<void> => {
    const project = await rendererApi.createProject(name, workingDirectory, permissionMode)
    await refreshProjects()
    if (homeCreateSelectRef.current) {
      homeCreateSelectRef.current = false
      setHomeCreatedProjectId(project.id)
      return
    }
    await onStartProjectChat(project)
  }

  const onCreateRemoteProject = async (input: RemoteProjectCreateInput): Promise<void> => {
    const knownIds = new Set(projectsRef.current.map((project) => project.id))
    await rendererApi.createRemoteProject(input)
    await refreshProjects()
    if (homeCreateSelectRef.current) {
      homeCreateSelectRef.current = false
      const created = projectsRef.current.find((project) => !knownIds.has(project.id))
      if (created) setHomeCreatedProjectId(created.id)
      return
    }
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
    [setSettingsOpenWithBrowserGate, setSettingsCategory]
  )

  const onGoProviderSettings = useCallback((): void => {
    openSettings('providers')
  }, [openSettings])
  // A published auth overlay has already hidden the browser viewport; reopening
  // settings through the browser gate here would queue behind that same overlay.
  const showSettingsWithoutGate = useCallback((): void => {
    setIsSettingsOpen(true)
  }, [setIsSettingsOpen])

  useAppCommands({
    rendererApi,
    activeView,
    isSettingsOpen,
    isProviderDialogOpen,
    isNewProjectDialogOpen,
    closeProviderDialog,
    setIsSettingsOpen,
    setIsNewProjectDialogOpen,
    navigateToView,
    onNewChat,
    openSettings
  })

  useSessionEventBridge({
    rendererApi,
    isSendingRef,
    projectsRef,
    refreshProjects,
    enqueueTrustedOverlay: enqueueBrowserTrustedOverlay,
    cancelTrustedOverlay: cancelBrowserTrustedOverlay,
    handleAuthInteractionEvent,
    showSettings: showSettingsWithoutGate,
    handleNotebookDraftChanged,
    handleNotebookFileChangedEvent,
    resetJupyterRuntimeForCwdChange: resetAnalysisJupyterRuntimeForCwdChange,
    workspaceSidebarMode
  })

  useAppBootstrap({
    rendererApi,
    mergeSessionSummariesRuntimeState,
    applyCurrentSession,
    replaceMessages,
    setProjects,
    projectsRef,
    setSessions,
    showSnackbarError,
    resetJupyterRuntimeForCwdChange: resetAnalysisJupyterRuntimeForCwdChange,
    setPersonaMarkdownState,
    setShowOnboarding,
    setIsLoadingHomeSessions
  })

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
  // Run control (queue, stop, compaction) has one owner. The shell keeps the wiring:
  // the send pipeline, readiness inputs, and the effect that drains the queue.
  const {
    compactingSessions,
    isCompactingKey,
    contextUsageRefreshKey,
    refreshContextUsage,
    activeQueuedPrompts,
    queuePromptText,
    removeQueuedPrompt,
    dequeueQueuedPrompt,
    moveQueuedPromptsToSession,
    onStopGeneration,
    onCompactContext
  } = useChatRunControl({
    activeDraftKey,
    rendererApi,
    sendRequestRef,
    isSendingRef,
    setIsSendingMessage,
    setActiveInput,
    clearPendingInteractions,
    showSnackbar,
    showSnackbarError
  })

  const sendPromptText = usePromptSend({
    rendererApi,
    readiness: {
      modelStateReady: isModelStateReady,
      providers: providerStatuses,
      availableModels,
      models,
      selectedModel,
      openSettings
    },
    actions: {
      updateMessages,
      setIsSendingMessage,
      setDraftImagesBySession,
      setDraftInputs,
      setActiveSessionPath,
      setActivePhiSessionId,
      setClosedWorkspaceSessionTabKeys,
      setActiveWorkspaceTabKey,
      setSelectedModel,
      moveQueuedPromptsToSession,
      refreshSessions,
      showSnackbarError
    },
    activeDraftKey,
    activeSessionPath,
    isSendingRef,
    sendRequestRef
  })

  const onChatSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const current = useSessionStore.getState()
    if (
      isCompactingKey(
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
      showSnackbarError(new Error(appCopy.imagesUnsupported), appCopy.sendImagesFailed)
      return
    }
    const target: PromptTarget = {
      path: useSessionStore.getState().activeSessionPath,
      phiSessionId: useSessionStore.getState().activePhiSessionId ?? undefined,
      cwd: useSessionStore.getState().activeCwd,
      sessionGeneration: useSessionStore.getState().activeSessionGeneration
    }
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
    const state = useSessionStore.getState()
    if (permissionMode === state.currentPermissionMode || permissionModeUpdateRef.current) return
    const target: ManualCompactionTarget = {
      sessionPath: state.activeSessionPath,
      phiSessionId: state.activePhiSessionId,
      sessionGeneration: state.activeSessionGeneration
    }
    permissionModeUpdateRef.current = true
    setIsUpdatingPermissionMode(true)
    try {
      const current = await rendererApi.updateCurrentSessionPermissionMode(permissionMode, target)
      const active = useSessionStore.getState()
      if (
        active.activeSessionPath !== target.sessionPath ||
        active.activePhiSessionId !== target.phiSessionId ||
        active.activeSessionGeneration !== target.sessionGeneration
      )
        return
      applyCurrentSession(current, undefined, {
        onCwdChanged: resetAnalysisJupyterRuntimeForCwdChange
      })
      setProjectSessionRefreshKey((key) => key + 1)
    } catch (error) {
      showSnackbarError(error, appCopy.permissionsFailed)
    } finally {
      permissionModeUpdateRef.current = false
      setIsUpdatingPermissionMode(false)
    }
  }

  const onStartHomePrompt = async (request: {
    text: string
    projectId: string | null
    permissionMode: PermissionMode
    planMode: boolean
  }): Promise<void> => {
    const text = request.text.trim()
    if (!text) return
    const project = request.projectId
      ? (projectsRef.current.find((item) => item.id === request.projectId) ?? null)
      : null
    if (project && project.permissionMode !== request.permissionMode) {
      await onUpdateProjectPermissionMode(project.id, request.permissionMode)
    }
    const created = project
      ? await onStartProjectChat({ ...project, permissionMode: request.permissionMode })
      : await openNewChat()
    if (!created) return
    if (!project && created.permissionMode !== request.permissionMode) {
      await onSelectPermissionMode(request.permissionMode)
    }
    await sendPromptText(
      text,
      {
        path: created.path,
        phiSessionId: created.phiSessionId,
        cwd: created.cwd,
        sessionGeneration: created.sessionGeneration
      },
      { planMode: request.planMode }
    )
  }

  // Path routing: which surface opens a file, a directory, a notebook, or a
  // wrapper result. The precedence lives in the hook so the shell only wires it.
  const {
    previewDirectoryPathInWorkspaceTab,
    openRemoteWorkspacePath,
    onOpenWorkspaceFileFromSidebar,
    onOpenFilePreview,
    onOpenLocalPath,
    onOpenDefaultPreviewPath,
    onOpenWrapperResult
  } = useFilePathOpeners({
    applyFileOpenConversationLayout,
    getActiveCwd,
    setActiveWorkspaceTabKey,
    previewFilePath,
    previewDirectoryPath,
    openPathWithSystemDefault,
    getActiveRemoteProject,
    blockRemoteLocalFileAction,
    showSnackbarError,
    onOpenNotebookWorkspaceFile,
    activeWrapperResultScope,
    isActiveWrapperResultUri,
    openWrapperResultPath
  })

  const onRetryRemoteConnection = useRemoteConnectionRetry(rendererApi, showSnackbarError)

  const onRevealPreviewPathInWorkspace = useCallback(
    (path: string, kind: LocalPathKind = 'file'): void => {
      if (path.startsWith('ssh://')) {
        setWorkspaceSidebarMode('files')
        setIsSidebarOpen(true)
      }
      onRevealPreviewPath(path, kind)
    },
    [onRevealPreviewPath, setIsSidebarOpen, setWorkspaceSidebarMode]
  )

  const onOpenInputAddMenu = useCallback((): void => {
    void refreshSkills()
    void refreshPromptAgents()
  }, [refreshPromptAgents, refreshSkills])

  const onPickInputFiles = useCallback(async (): Promise<string[]> => {
    try {
      return await rendererApi.pickInputFiles()
    } catch (error) {
      showSnackbarError(error, appCopy.selectFilesFailed)
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
  // Toggling a slot also cancels a pending browser link open, so the link does
  // not steal the panel the user just asked for.
  const onToggleWorkspaceSidePanel = useCallback(
    (mode: WorkspaceSidePanelMode): void => {
      browserLinkOpeningCoordinator.invalidate()
      toggleWorkspaceSidePanelForLayout(mode)
    },
    [browserLinkOpeningCoordinator, toggleWorkspaceSidePanelForLayout]
  )
  const onCloseWorkspaceSidePanelSlot = useCallback(
    (mode: WorkspaceSidePanelMode): void => {
      closeWorkspaceSidePanel(mode)
      window.requestAnimationFrame(() => {
        document
          .querySelector<HTMLButtonElement>(`[data-phi-workspace-panel-toggle="${mode}"]`)
          ?.focus()
      })
    },
    [closeWorkspaceSidePanel]
  )
  const onRefreshWorkspaceSidePanel = refreshWorkspaceSidePanelTree
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
      refreshWorkspaceSidePanelTree()
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
    loadFilePreview,
    refreshWorkspaceSidePanelTree
  ])
  const activeRemoteFileScope = useMemo(
    () =>
      activeProjectLocation?.kind === 'ssh' && activeProject?.remoteHostAlias
        ? {
            hostAlias: activeProject.remoteHostAlias,
            canonicalRoot: activeProjectLocation.canonicalRoot
          }
        : null,
    [activeProject, activeProjectLocation]
  )
  const workspaceFilesRootPath =
    activeProjectLocation?.kind === 'ssh'
      ? activeRemoteFileScope
        ? remoteWorkspaceUri(activeRemoteFileScope.hostAlias, activeRemoteFileScope.canonicalRoot)
        : ''
      : activeCwd
  const onSelectRemoteUploadDirectory = useCallback(
    (path: string): void => {
      if (activeProjectId && activeRemoteFileScope) {
        rememberRemoteUploadDestination(activeProjectId, path)
      }
    },
    [activeProjectId, activeRemoteFileScope]
  )
  const onDropRemoteProjectFiles = useCallback(
    async (paths: string[], destinationPath: string): Promise<void> => {
      if (!activeProjectId || !activeRemoteFileScope) {
        showSnackbarError(new Error(appCopy.uploadRequiresSsh), appCopy.uploadFailed)
        return
      }
      const destinationDirectory = remoteUploadDestinationDirectory(
        destinationPath,
        activeRemoteFileScope.hostAlias,
        activeRemoteFileScope.canonicalRoot
      )
      if (destinationDirectory === null) {
        showSnackbarError(new Error(appCopy.uploadDestinationOutsideProject), appCopy.uploadFailed)
        return
      }
      try {
        const job = await rendererApi.prepareRemoteProjectUpload(activeProjectId, {
          sourcePaths: paths,
          destinationDirectory
        })
        let confirmed = !job.requiresConfirmation
        if (job.requiresConfirmation) {
          confirmed = window.confirm(
            appCopy.confirmUpload(job.totalFiles, (job.totalBytes / 1024 ** 3).toFixed(2))
          )
        }
        if (!confirmed) {
          await rendererApi.cancelRemoteProjectUpload(job.id)
          return
        }
        await rendererApi.startRemoteProjectUpload(activeProjectId, job.id, { confirmed })
        showSnackbar(appCopy.uploadQueued, 'info')
      } catch (error) {
        showSnackbarError(error, appCopy.uploadFailed)
      }
    },
    [activeProjectId, activeRemoteFileScope, rendererApi, showSnackbar, showSnackbarError]
  )

  const workspaceFileActions = useWorkspaceFileActions({
    rootPath: workspaceFilesRootPath,
    rendererApi,
    getActiveCwd,
    getActiveRemoteProject,
    workspace: {
      filePreview,
      filePreviewCache,
      workspaceFileTabs,
      activeWorkspaceFilePath,
      setFilePreview,
      clearCachedFilePreview,
      setWorkspaceFileTabs,
      setActiveWorkspaceFilePath,
      filePreviewRequestRef
    },
    onChanged: onRefreshWorkspaceSidePanel,
    onOpenFile: onOpenWorkspaceFileFromSidebar,
    onReloadFile: loadFilePreview,
    onOpenDirectory: previewDirectoryPathInWorkspaceTab,
    onDownloadFile: downloadWrapperResultFile,
    onRevealFile: onRevealPreviewPath,
    onNotice: (message) => showSnackbar(message, 'warning')
  })

  useEffect(() => {
    if (typeof rendererApi.onRemoteProjectUploadsChanged !== 'function') return undefined
    return rendererApi.onRemoteProjectUploadsChanged((job) => {
      if (job.status !== 'completed') return
      refreshWorkspaceSidePanelTree()
      const renamed = job.files.filter((file) => file.resolution === 'renamed')
      if (renamed.length > 0) {
        const names = renamed
          .slice(0, 3)
          .map((file) => file.destinationPath?.split('/').pop())
          .filter(Boolean)
          .join(getUiLanguage() === 'zh-CN' ? '、' : ', ')
        showSnackbar(appCopy.uploadRenamed(renamed.length, names), 'info')
      }
    })
  }, [refreshWorkspaceSidePanelTree, rendererApi, showSnackbar])
  const remoteFileIdentity =
    activeProjectLocation?.kind === 'ssh'
      ? `${activeProjectId ?? ''}:${activeRemoteFileScope?.hostAlias ?? ''}:${activeProjectLocation.canonicalRoot}`
      : null
  const previousRemoteFileIdentityRef = useRef<string | null>(null)
  const currentSessionTab = useMemo<WorkspaceSessionTab>(() => {
    void uiLanguage // Default titles and scope labels follow the selected interface language.
    return {
      key: workspaceSessionTabKey(activeSessionPath, activeSessionGeneration),
      kind: 'session',
      itemId: activeSessionPath ?? `fresh:${activeSessionGeneration}`,
      title: activeSession
        ? sessionDisplayTitle(activeSession)
        : (titleFromMessages(messages) ?? truncateSessionTitle(appCopy.newChat)),
      subtitle: activeProject?.name ?? workspaceScopeLabelForCwd(activeCwd, projects),
      sessionPath: activeSessionPath,
      sessionGeneration: activeSessionGeneration,
      sidebarMode: activeProject ? 'projects' : 'conversations'
    }
  }, [
    activeCwd,
    activeProject,
    activeSession,
    activeSessionGeneration,
    activeSessionPath,
    messages,
    projects,
    uiLanguage
  ])
  useLayoutEffect(() => {
    const previous = previousRemoteFileIdentityRef.current
    if (!shouldClearWorkspaceFilesForRemoteSwitch(previous, remoteFileIdentity)) {
      previousRemoteFileIdentityRef.current = remoteFileIdentity
      return
    }
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      clearFileWorkspace({ preserveNotebookTabs: true })
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
      clearFileWorkspace({ preserveNotebookTabs: true })
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
        key: workspaceFileTabKey(tab.id),
        kind: tab.kind,
        id: tab.id,
        itemId: tab.id,
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
    activeView === 'analysis' &&
    isSidebarOpen &&
    workspaceSidebarMode === 'conversations'
  )
  const visibleWorkspaceTabs = useMemo(() => {
    return resolveWorkspaceResourceTabIcons(
      visibleWorkspaceTabsForState({
        currentSessionTab,
        workspaceTabs,
        workspaceFileTabs: workspaceFileWorkspaceTabs,
        closedSessionTabKeys: closedWorkspaceSessionTabKeys,
        shouldShowSessionTab: shouldShowSessionWorkspaceTab,
        sessionTabWasOpened
      }),
      { plugins: phiPluginsState.plugins, skills, mcp: mcpServers, wrappers: wrapperCatalog }
    )
  }, [
    closedWorkspaceSessionTabKeys,
    currentSessionTab,
    sessionTabWasOpened,
    shouldShowSessionWorkspaceTab,
    phiPluginsState.plugins,
    skills,
    mcpServers,
    wrapperCatalog,
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
      ? workspaceFileTabKey(
          workspaceFileTabs.find(
            (tab) =>
              tab.path === activeWorkspaceFilePath &&
              (!tab.ownerProjectId || tab.ownerProjectId === activeProjectId)
          )?.id ?? activeWorkspaceFilePath
        )
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
        showSnackbarError(error, appCopy.retryImageFailed)
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
      if (useSessionStore.getState().activeProjectLocation?.kind === 'ssh') {
        showSnackbar(appCopy.remoteForkUnavailable, 'info')
        return
      }
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
        showSnackbarError(error, appCopy.forkFailed)
      } finally {
        forkInProgressRef.current = false
      }
    },
    [onSelectSession, refreshSessions, rendererApi, showSnackbar, showSnackbarError]
  )
  const onRuntimeRecovered = useCallback(
    async (state: RuntimeRecoveryState): Promise<void> => {
      if (state.phase !== 'connected') return
      const target = state.target
      const current = useSessionStore.getState()
      if (
        current.activePhiSessionId !== target.sessionId ||
        current.activeProjectId !== target.projectId ||
        current.activeSessionPath !== target.sessionPath ||
        current.activeSessionGeneration !== target.sessionGeneration
      )
        return
      const request = ++sessionRequestRef.current
      setIsSessionChanging(true)
      try {
        // Recovery already keeps this conversation selected. Read its updated local payload
        // instead of switching it a second time and replaying sidebar/browser navigation.
        const result = await rendererApi.getCurrentSession()
        const latest = useSessionStore.getState()
        if (
          !result ||
          request !== sessionRequestRef.current ||
          result.path !== target.sessionPath ||
          result.phiSessionId !== target.sessionId ||
          result.projectId !== target.projectId ||
          result.sessionGeneration !== target.sessionGeneration ||
          latest.activePhiSessionId !== target.sessionId ||
          latest.activeProjectId !== target.projectId ||
          latest.activeSessionPath !== target.sessionPath ||
          latest.activeSessionGeneration !== target.sessionGeneration
        )
          return
        applyCurrentSession(result, undefined, {
          onCwdChanged: resetAnalysisJupyterRuntimeForCwdChange
        })
        // A resume keeps the live timeline in memory. The persisted events for the interrupted
        // turn stop at run_failed, so replacing the list would silently drop the assistant text
        // and tool cards the user just watched. Only load from disk when nothing is loaded yet.
        if (useSessionStore.getState().agentEventState.messages.length === 0) {
          replaceMessages(chatItemsFromSessionMessages(result.messages ?? []))
        }
        refreshContextUsage()
        void refreshCurrentModelControls(request)
        void refreshSessions()
      } finally {
        if (request === sessionRequestRef.current) setIsSessionChanging(false)
      }
    },
    [
      applyCurrentSession,
      refreshContextUsage,
      refreshCurrentModelControls,
      refreshSessions,
      rendererApi,
      replaceMessages,
      resetAnalysisJupyterRuntimeForCwdChange,
      setIsSessionChanging
    ]
  )
  const onRuntimeSummaryCreated = useCallback(
    async (result: RuntimeSummaryContinuation): Promise<void> => {
      const current = useSessionStore.getState()
      if (
        current.activePhiSessionId !== result.sourceSessionId &&
        current.activePhiSessionId !== result.phiSessionId
      ) {
        void refreshSessions()
        return
      }
      await onSelectSession(result.path)
      await refreshSessions()
      showSnackbar(appCopy.summaryChatCreated, 'info')
    },
    [onSelectSession, refreshSessions, showSnackbar]
  )
  useQueuedPromptDrain({
    queue: { activeQueuedPrompts, dequeueQueuedPrompt },
    session: {
      currentSessionIsBusy,
      currentSessionIsCompacting,
      queuedPromptsPaused,
      isSessionChanging,
      isBusy
    },
    readiness: { modelStateReady: isModelStateReady, providers: providerStatuses, availableModels },
    isSendingRef,
    sendPromptText
  })
  const activeWorkspaceTitle = useMemo(() => {
    void uiLanguage // Localized fallback titles are read through the shared copy proxy.
    if (showProjectSessionPlaceholder) return appCopy.projectChat
    if (isChatWorkspaceView && visibleWorkspaceTabs.length === 0) return appCopy.home
    if (isResourceWorkspaceView) {
      if (
        activeWorkspaceResourceTab?.kind === 'plugins' &&
        activeWorkspaceResourceTab.itemId === 'installed'
      )
        return resourceUi.plugins
      return (
        activeWorkspaceResourceTab?.title ??
        workspaceResourceKindLabel(activeView as WorkspaceResourceKind)
      )
    }
    if (!isChatWorkspaceView) return activeView
    if (activeSession) return sessionDisplayTitle(activeSession)
    return titleFromMessages(messages) ?? truncateSessionTitle(appCopy.newChat)
  }, [
    activeSession,
    activeView,
    activeWorkspaceResourceTab,
    isChatWorkspaceView,
    isResourceWorkspaceView,
    messages,
    showProjectSessionPlaceholder,
    visibleWorkspaceTabs.length,
    uiLanguage
  ])
  const activeWorkspaceScopeLabel =
    activeProject?.name ?? workspaceScopeLabelForCwd(activeCwd, projects)
  const activePermissionMode = currentPermissionMode
  const showWorkspaceTabs =
    visibleWorkspaceTabs.length > 0 &&
    (activeView === 'chat' || activeView === 'analysis' || isResourceWorkspaceView)
  const showWorkspaceTitlebar =
    !isAnalysisWorkspaceView && !isResourceWorkspaceView && !showWorkspaceTabs
  const showHomeWorkspace =
    isChatWorkspaceView && visibleWorkspaceTabs.length === 0 && !showProjectSessionPlaceholder
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
    [clearWorkspaceSidebarPreviewCloseTimer, setWorkspaceSidebarPreview]
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
      shouldUseWorkspaceSidebarPreview,
      setWorkspaceSidebarPreview
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
    workspaceFileTabs.find(
      (tab) => workspaceFileTabKey(tab.id) === effectiveActiveWorkspaceTabKey
    ) ?? null
  const cachedActiveFilePreview =
    activeWorkspaceFileTab && activeWorkspaceFileTab.kind !== 'notebook'
      ? (filePreviewCache[activeWorkspaceFileTab.path] ?? null)
      : null
  const workspaceViewMode = workspaceViewModeFor({
    showWorkspaceTabs,
    isAnalysisWorkspaceView,
    analysisFilePreviewAvailable: Boolean(
      activeWorkspaceFileTab && activeWorkspaceFileTab.kind !== 'notebook'
    ),
    chatSelected: activeView === 'chat',
    visibleTabCount: visibleWorkspaceTabs.length
  })
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

  const autoConnectingSessionIdsRef = useRef<Set<string>>(new Set())
  const [autoConnectingSessionId, setAutoConnectingSessionId] = useState<string | null>(null)
  const onOpenSessionFromSidebar = useCallback(
    async (path: string): Promise<void> => {
      await onSelectSession(path)
      navigateToView('chat')
      const target = remoteRecoveryTargetForSession(useSessionStore.getState())
      if (!target || target.sessionPath !== path) return
      if (autoConnectingSessionIdsRef.current.has(target.sessionId)) return
      autoConnectingSessionIdsRef.current.add(target.sessionId)
      let startedConnection = false
      try {
        const state = await rendererApi.getRuntimeRecoveryState(target)
        if (
          !state ||
          !sameRuntimeRecoveryTarget(
            remoteRecoveryTargetForSession(useSessionStore.getState()),
            target
          ) ||
          !shouldAutoConnectRemoteSession(state)
        )
          return
        startedConnection = true
        setAutoConnectingSessionId(target.sessionId)
        const recovered = await rendererApi.resumeRuntimeSession(target)
        if (recovered) await onRuntimeRecovered(recovered)
      } catch (error) {
        if (
          sameRuntimeRecoveryTarget(
            remoteRecoveryTargetForSession(useSessionStore.getState()),
            target
          )
        )
          showSnackbarError(error, appCopy.reconnectFailed)
      } finally {
        autoConnectingSessionIdsRef.current.delete(target.sessionId)
        if (startedConnection)
          setAutoConnectingSessionId((current) => (current === target.sessionId ? null : current))
      }
    },
    [navigateToView, onRuntimeRecovered, onSelectSession, rendererApi, showSnackbarError]
  )

  const [pendingNotebookTab, setPendingNotebookTab] = useState<{
    id: string
    path: string
    ownerSessionPath: string
    ownerCwd: string
  } | null>(null)

  const onSelectWorkspaceFileTab = useCallback(
    (tabLike: AnalysisWorkspaceFileTab): void => {
      const tab = workspaceFileTabs.find((item) => item.id === tabLike.id)
      if (!tab) return
      if (
        tab.kind === 'notebook' &&
        (tab.ownerProjectId
          ? tab.ownerProjectId !== activeProjectId
          : tab.ownerCwd && tab.ownerCwd !== activeCwd)
      ) {
        if (!tab.ownerSessionPath) {
          showSnackbar(appCopy.selectNotebookProject, 'warning')
          return
        }
        setPendingNotebookTab({
          id: tab.id,
          path: tab.path,
          ownerSessionPath: tab.ownerSessionPath,
          ownerCwd: tab.ownerCwd ?? activeCwd
        })
        void onOpenSessionFromSidebar(tab.ownerSessionPath).catch((error) => {
          setPendingNotebookTab(null)
          showSnackbarError(error, appCopy.openNotebookFailed)
        })
        return
      }
      if (
        tab.kind === 'notebook' &&
        tab.ownerProjectId === activeProjectId &&
        (tab.ownerCwd !== activeCwd || tab.ownerSessionPath !== activeSessionPath)
      ) {
        setWorkspaceFileTabs((tabs) =>
          tabs.map((item) =>
            item.id === tab.id
              ? { ...item, ownerCwd: activeCwd, ownerSessionPath: activeSessionPath }
              : item
          )
        )
      }
      setActiveWorkspaceTabKey(workspaceFileTabKey(tab.id))
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
      activeCwd,
      activeProjectId,
      activeSessionPath,
      activateCachedAnalysisNotebook,
      onOpenSessionFromSidebar,
      onOpenNotebookWorkspaceFile,
      setActiveWorkspaceFilePath,
      setWorkspaceFileTabs,
      showSnackbar,
      showSnackbarError,
      showCachedOrLoadFilePreview,
      workspaceFileTabs,
      navigateToView
    ]
  )

  useEffect(() => {
    if (
      !pendingNotebookTab ||
      activeCwd !== pendingNotebookTab.ownerCwd ||
      activeSessionPath !== pendingNotebookTab.ownerSessionPath
    )
      return
    let cancelled = false
    // Let the scope-switch layout effect clear old previews before restoring this tab.
    void Promise.resolve().then(() => {
      const session = useSessionStore.getState()
      if (
        cancelled ||
        session.activeCwd !== pendingNotebookTab.ownerCwd ||
        session.activeSessionPath !== pendingNotebookTab.ownerSessionPath
      )
        return
      if (!workspaceFileTabs.some((tab) => tab.id === pendingNotebookTab.id)) {
        setPendingNotebookTab(null)
        return
      }
      setPendingNotebookTab(null)
      onOpenNotebookWorkspaceFile(pendingNotebookTab.path)
    })
    return () => {
      cancelled = true
    }
  }, [
    activeCwd,
    activeSessionPath,
    onOpenNotebookWorkspaceFile,
    pendingNotebookTab,
    workspaceFileTabs
  ])

  const onCloseWorkspaceFileTab = useCallback(
    (tabLike: AnalysisWorkspaceFileTab): void => {
      const closingTab = workspaceFileTabs.find((tab) => tab.id === tabLike.id)
      if (!closingTab) return
      if (
        closingTab.dirty ||
        (closingTab.kind !== 'notebook' && textFileHasUnsavedChanges(closingTab.path))
      ) {
        showSnackbar(appCopy.saveFileFirst, 'warning')
        return
      }
      if (closingTab.kind !== 'notebook') useTextFileDrafts.getState().release(closingTab.path)
      const remainingTabs = workspaceFileTabs.filter((tab) => tab.id !== closingTab.id)
      setWorkspaceFileTabs(remainingTabs)
      if (closingTab.kind !== 'notebook') clearCachedFilePreview(closingTab.path)
      if (
        closingTab.kind === 'notebook' &&
        closingTab.ownerCwd === activeCwd &&
        (!closingTab.ownerProjectId || closingTab.ownerProjectId === activeProjectId)
      ) {
        forgetCachedAnalysisNotebook(closingTab.path)
      }

      if (workspaceFileTabKey(closingTab.id) !== effectiveActiveWorkspaceTabKey) {
        if (
          closingTab.kind !== 'notebook' &&
          filePreview &&
          filePreviewStatePath(filePreview) === closingTab.path
        ) {
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

      if (nextTab.kind === 'notebook') {
        onSelectWorkspaceFileTab(nextTab)
      } else {
        setActiveWorkspaceFilePath(nextTab.path)
        setActiveAnalysisNotebook(null)
        showCachedOrLoadFilePreview(nextTab)
      }
    },
    [
      activeCwd,
      activeProjectId,
      cancelActiveWrapperResultRead,
      clearCachedFilePreview,
      closeActiveNotebook,
      filePreview,
      filePreviewRequestRef,
      forgetCachedAnalysisNotebook,
      effectiveActiveWorkspaceTabKey,
      onSelectWorkspaceFileTab,
      setActiveAnalysisNotebook,
      setActiveWorkspaceFilePath,
      setFilePreview,
      setWorkspaceFileTabs,
      showCachedOrLoadFilePreview,
      showSnackbar,
      workspaceFileTabs,
      workspaceSidebarMode,
      navigateToView
    ]
  )

  const onCloseCurrentFilePreview = useCallback((): void => {
    if (!filePreview) return
    const previewPath = filePreviewStatePath(filePreview)
    const previewTab = workspaceFileTabs.find(
      (tab) => tab.kind !== 'notebook' && tab.path === previewPath
    )
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

  const {
    selectTab: selectWorkspaceTab,
    selectTabFromChrome: onSelectWorkspaceTab,
    closeTab: onCloseWorkspaceTab,
    openResourceTab: openWorkspaceResourceTab,
    openPluginsTab: onOpenPhiPlugins,
    openPluginTab: onOpenPhiPluginTab,
    openSkillTab: onOpenSkillTab
  } = useWorkspaceTabNavigation({
    workspaceTabs,
    setWorkspaceTabs,
    activeWorkspaceTabKey,
    setActiveWorkspaceTabKey,
    visibleWorkspaceTabs,
    effectiveActiveWorkspaceTabKey,
    activeSkillId,
    activeMcpServerId,
    selectedWrapperId,
    setWorkspaceSidebarMode,
    setActiveSkillId,
    setActiveMcpServerId,
    setSelectedWrapperId,
    setSessionTabWasOpened,
    setClosedWorkspaceSessionTabKeys,
    navigateToView,
    onSelectSession,
    acknowledgeActiveSession,
    onSelectWorkspaceFileTab,
    onCloseWorkspaceFileTab,
    closeWorkspaceSidebarPreview,
    activeSessionPath: activeSessionPath ?? null
  })

  const onSetSkillDisabled = useCallback(
    async (skill: SkillSummary, disabled: boolean): Promise<void> => {
      try {
        await setSkillDisabled(skill, disabled)
        showSnackbar(
          disabled ? resourceActionMessages.skillDisabled : resourceActionMessages.skillEnabled,
          'success'
        )
      } catch (error) {
        showSnackbarError(
          error,
          disabled
            ? resourceActionMessages.skillDisableFailed
            : resourceActionMessages.skillEnableFailed
        )
        throw error
      }
    },
    [setSkillDisabled, showSnackbar, showSnackbarError]
  )

  const onSetSkillGlobalEnabled = useCallback(
    async (skill: SkillSummary, enabled: boolean): Promise<void> => {
      try {
        await setGlobalEnabled(skill, enabled)
        showSnackbar(
          enabled
            ? resourceActionMessages.skillGlobalEnabled
            : resourceActionMessages.skillGlobalDisabled,
          'success'
        )
      } catch (error) {
        showSnackbarError(
          error,
          enabled
            ? resourceActionMessages.skillEnableFailed
            : resourceActionMessages.skillDisableFailed
        )
        throw error
      }
    },
    [setGlobalEnabled, showSnackbar, showSnackbarError]
  )

  const onSetSkillProjectOverride = useCallback(
    async (skill: SkillSummary, value: boolean | null): Promise<void> => {
      const projectCwd =
        activeProject?.location.kind === 'ssh' ? null : activeProject?.workingDirectory
      if (!projectCwd) throw new Error(resourceActionMessages.noLocalProject)
      try {
        await setProjectOverride(skill, value, projectCwd)
        showSnackbar(
          value === null
            ? resourceActionMessages.skillFollowGlobal
            : value
              ? resourceActionMessages.skillProjectEnabled
              : resourceActionMessages.skillProjectDisabled,
          'success'
        )
      } catch (error) {
        showSnackbarError(error, resourceActionMessages.skillProjectUpdateFailed)
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
      showSnackbar(resourceActionMessages.installedAndEnabled(entry.title), 'success')
    },
    [refreshSkills, rendererApi, showSnackbar]
  )

  const onDeleteSkill = useCallback(
    async (skill: SkillSummary): Promise<void> => {
      try {
        const nextSkills = await deleteSkill(skill)
        showSnackbar(resourceActionMessages.skillUninstalled, 'success')
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
        showSnackbarError(error, resourceActionMessages.skillUninstallFailed)
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
        connectorId: server.connectorId ?? server.packageId,
        icon: server.icon,
        connectorUrl: server.url
      })
    },
    [openWorkspaceResourceTab, setActiveMcpServerId]
  )

  const onOpenWrapperTab = useCallback(
    (entry: WrapperCompositionCatalogItem): void => {
      setSelectedWrapperId(entry.id)
      openWorkspaceResourceTab({
        kind: 'wrappers',
        itemId: entry.id,
        title: entry.name,
        icon: entry.icon,
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
    [onOpenWrapperTab, wrapperCatalog, setIsSidebarOpen, setWorkspaceSidebarMode]
  )

  // Selecting a tab closes any sidebar hover preview first, so the clicked tab

  const onRemoveMcpServer = useCallback(
    async (server: McpServerSummary): Promise<void> => {
      if (server.userStdio) {
        await window.api.removeLocalMcpConnector(server.name)
      } else {
        if (!server.managed || !server.url)
          throw new Error(resourceActionMessages.connectorCannotRemove)
        await window.api.removeRemoteMcpConnector(server.name, server.url)
      }
      await refreshMcpServers()
      showSnackbar(resourceActionMessages.connectorRemoved, 'success')
      if (
        activeWorkspaceResourceTab?.kind === 'mcp' &&
        activeWorkspaceResourceTab.itemId === server.id
      ) {
        onCloseWorkspaceTab(activeWorkspaceResourceTab)
      }
    },
    [activeWorkspaceResourceTab, onCloseWorkspaceTab, refreshMcpServers, showSnackbar]
  )

  const onStartSidebarResize = useCallback(
    (event: MouseEvent<HTMLDivElement>): void => {
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
    },
    [setSidebarWidth]
  )

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
    [closeWorkspaceSidebarPreview, workspaceSidebarMode, setIsSidebarOpen, setWorkspaceSidebarMode]
  )

  const onDockConversationToSidebar = useCallback(
    (tab: WorkspaceSessionTab): void => {
      if (tab.key !== currentSessionTab.key) return
      const target = activeWorkspaceFileTab ?? workspaceFileTabs.at(-1) ?? null
      if (!target) return
      closeWorkspaceSidebarPreview()
      onSelectWorkspaceFileTab(target)
      showActiveConversationInSidebar()
    },
    [
      activeWorkspaceFileTab,
      currentSessionTab.key,
      closeWorkspaceSidebarPreview,
      onSelectWorkspaceFileTab,
      showActiveConversationInSidebar,
      workspaceFileTabs
    ]
  )

  const onRestoreConversationToMain = useCallback((): void => {
    closeWorkspaceSidebarPreview()
    selectWorkspaceTab(currentSessionTab)
    setWorkspaceSidebarMode('files')
    setIsSidebarOpen(true)
  }, [
    closeWorkspaceSidebarPreview,
    currentSessionTab,
    selectWorkspaceTab,
    setIsSidebarOpen,
    setWorkspaceSidebarMode
  ])

  const onSelectWorkspaceView = useCallback(
    (view: 'chat' | 'projects', anchorEl: HTMLElement): void => {
      if (
        view === 'chat' &&
        activeView === 'analysis' &&
        workspaceSidebarMode === 'conversations'
      ) {
        openWorkspaceSidebarPreview('conversations', anchorEl)
        return
      }
      onSelectWorkspaceSidebarMode(view === 'projects' ? 'projects' : 'conversations')
    },
    [activeView, onSelectWorkspaceSidebarMode, openWorkspaceSidebarPreview, workspaceSidebarMode]
  )

  const onNewChatFromSidebar = useCallback(async (): Promise<void> => {
    await onNewChat()
    navigateToView('chat')
  }, [navigateToView, onNewChat])

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
        projectCwd={activeProject?.workingDirectory}
        onSetGlobalEnabled={onSetSkillGlobalEnabled}
        onSetProjectOverride={onSetSkillProjectOverride}
        onNavigateToPlugin={(pluginId) => {
          const plugin = phiPluginsState.plugins.find((item) => item.id === pluginId)
          if (plugin) onOpenPhiPluginTab(plugin)
          else onOpenPhiPlugins()
        }}
        onSetSkillDisabled={onSetSkillDisabled}
        onDeleteSkill={onDeleteSkill}
        onRefresh={refreshSkills}
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
        onSelectWrapper={onOpenWrapperTab}
      />
    ) : null
  ) : (
    <Stack spacing={1} sx={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Typography color="text.secondary">{appCopy.selectProjectForTab}</Typography>
    </Stack>
  )

  const chatResourceMentions = useMemo<ChatResourceMention[]>(
    () => [
      ...skills.map((skill) => ({
        kind: 'skill' as const,
        id: skill.id,
        name: skill.name,
        icon: skill.icon,
        onOpen: () => onOpenSkillTab(skill)
      })),
      ...wrapperCatalog.map((wrapper) => ({
        kind: 'wrapper' as const,
        id: wrapper.id,
        name: wrapper.name,
        icon: wrapper.icon,
        aliases: wrapper.enablementId ? [wrapper.enablementId] : undefined,
        onOpen: () => onOpenWrapperTab(wrapper)
      })),
      ...phiPluginsState.plugins.map((plugin) => ({
        kind: 'plugin' as const,
        id: plugin.id,
        name: plugin.title,
        icon: plugin.icon,
        onOpen: () => onOpenPhiPluginTab(plugin)
      })),
      ...mcpServers.map((server) => ({
        kind: 'mcp' as const,
        id: server.id,
        name: server.title ?? server.name,
        icon: server.icon,
        aliases: [server.name],
        onOpen: () => onOpenMcpServerTab(server)
      }))
    ],
    [
      skills,
      wrapperCatalog,
      phiPluginsState.plugins,
      mcpServers,
      onOpenSkillTab,
      onOpenWrapperTab,
      onOpenPhiPluginTab,
      onOpenMcpServerTab
    ]
  )

  const runtimeRecoveryTarget = useMemo<RuntimeRecoveryTarget | null>(
    () =>
      remoteRecoveryTargetForSession({
        activeProjectLocation,
        activePhiSessionId,
        activeProjectId,
        activeSessionPath,
        activeSessionGeneration
      }),
    [
      activeProjectLocation,
      activePhiSessionId,
      activeProjectId,
      activeSessionPath,
      activeSessionGeneration
    ]
  )
  const [remoteRecoverySelectionState, setRemoteRecoverySelectionState] =
    useState<RuntimeRecoveryState | null>(null)
  const remoteControlsUnavailable =
    remoteModelControlsBlocked(runtimeRecoveryTarget, remoteRecoverySelectionState) ||
    (activeProjectLocation?.kind === 'ssh' && currentSessionIsBusy)
  const activeChatView = (
    <RemoteProjectFileContext.Provider
      value={
        activeProjectLocation?.kind === 'ssh'
          ? {
              sessionId: activePhiSessionId ?? '',
              projectId: activeProjectId ?? '',
              hostAlias: activeRemoteFileScope?.hostAlias ?? '',
              remoteRoot: activeProjectLocation.remoteRoot,
              canonicalRoot: activeProjectLocation.canonicalRoot,
              openPath: (path, kind) =>
                kind === 'directory' ? openRemoteWorkspacePath(path, kind) : onOpenFilePreview(path)
            }
          : null
      }
    >
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          position: 'relative'
        }}
      >
        {activeProjectLocation?.kind === 'ssh' &&
        activeRemoteConnection &&
        !['unchecked', 'connecting', 'reachable'].includes(activeRemoteConnection.phase) ? (
          <RemoteConnectionNotice
            hostAlias={activeProject?.remoteHostAlias}
            connection={activeRemoteConnection}
            onRetry={onRetryRemoteConnection}
            onOpenRemoteSettings={() => openSettings('remote')}
          />
        ) : null}
        <Suspense
          fallback={
            <Box
              role="status"
              aria-live="polite"
              sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <Typography variant="body2" color="text.secondary">
                {appCopy.loadingChat}
              </Typography>
            </Box>
          }
        >
          <ChatView
            messages={messages}
            recoveryNotice={
              <RuntimeRecoveryBanner
                api={rendererApi}
                target={runtimeRecoveryTarget}
                connecting={autoConnectingSessionId === runtimeRecoveryTarget?.sessionId}
                serverConnecting={activeRemoteConnection?.phase === 'connecting'}
                models={availableModels}
                onRecovered={onRuntimeRecovered}
                onStateChange={setRemoteRecoverySelectionState}
                refreshKey={JSON.stringify([
                  currentSessionIsBusy,
                  activeSession?.status,
                  activeSessionRuntimeState.currentRunStartedAt
                ])}
                onSummaryCreated={onRuntimeSummaryCreated}
              />
            }
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
            resourceMentions={chatResourceMentions}
            promptAgents={promptAgents}
            onSelectModel={(model) => {
              void onSelectModel(model)
            }}
            thinkingLevel={thinkingLevel}
            onSelectThinkingLevel={onSelectThinkingLevel}
            onInputChange={setActiveInput}
            onRetryUserMessage={onRetryUserMessage}
            onForkUserMessage={
              currentSessionIsBusy ||
              currentSessionIsCompacting ||
              !activePhiSessionId ||
              activeProjectLocation?.kind === 'ssh'
                ? undefined
                : onForkUserMessage
            }
            onOpenInputAddMenu={onOpenInputAddMenu}
            onRefreshPromptAgents={refreshPromptAgents}
            onPickInputFiles={onPickInputFiles}
            onGetPathForInputFile={rendererApi.getPathForFile}
            onInputFilesDropped={rendererApi.onInputFilesDropped}
            onListInputDirectory={onListInputDirectory}
            onChatSubmit={onChatSubmit}
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
            disablePermissionModeSelect={
              isSessionChanging || currentSessionIsCompacting || isUpdatingPermissionMode
            }
            disableModelControls={
              isSessionChanging || currentSessionIsCompacting || remoteControlsUnavailable
            }
            pendingApproval={pendingApproval}
            pendingUserInteraction={pendingUserInteraction}
            queuedPrompts={activeQueuedPrompts.map((item) => ({
              id: item.id,
              text: item.text || appCopy.imageCount(item.sendOptions?.images?.length ?? 0)
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
            placement={
              activeView === 'analysis' && workspaceSidebarMode === 'conversations'
                ? 'sidebar'
                : 'tab'
            }
            cwd={activeDisplayCwd}
          />
        </Suspense>
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
              {appCopy.selectProjectChat}
            </Typography>
            <Button variant="outlined" onClick={startPlaceholderProjectSession}>
              {projects.length > 0 ? appCopy.newProjectChat : appCopy.newProject}
            </Button>
          </Box>
        </Box>
      ) : (
        activeChatView
      )}
    </>
  )

  const loadHomeResources = useCallback(async (): Promise<void> => {
    await Promise.allSettled([refreshSkillsForNavigation(), refreshMcpServersForNavigation()])
  }, [refreshSkillsForNavigation, refreshMcpServersForNavigation])

  const fetchHomeProjectSessions = useCallback(
    async (project: Project): Promise<SessionSummary[]> => {
      const list =
        project.location.kind === 'ssh'
          ? await rendererApi.listProjectSessionsById(project.id)
          : await rendererApi.listProjectSessions(project.workingDirectory)
      return mergeSessionSummariesRuntimeState(list, project.workingDirectory)
    },
    [mergeSessionSummariesRuntimeState, rendererApi]
  )

  const emptyWorkspaceContent = (
    <HomeView
      sessions={sessions}
      sessionsLoading={isLoadingHomeSessions}
      projects={projects}
      projectSessionRefreshKey={projectSessionRefreshKey}
      onFetchProjectSessions={fetchHomeProjectSessions}
      resources={{
        skills: {
          total: skills.length,
          active: skills.filter((skill) => skill.enabled).length,
          loading: isLoadingSkills,
          icons: homeResourceIcons(skills)
        },
        wrappers: {
          total: wrapperCatalog.length,
          active: wrapperCatalog.filter((wrapper) => !wrapper.hiddenReason).length,
          loading: isLoadingWrappers,
          icons: homeResourceIcons(wrapperCatalog)
        },
        connectors: {
          total: mcpServers.length,
          active: mcpServers.filter((server) => server.enabled !== false && !server.userDisabled)
            .length,
          icons: homeResourceIcons(mcpServers)
        },
        plugins: {
          total: phiPluginsState.plugins.length,
          active: phiPluginsState.plugins.filter((plugin) => plugin.enabled).length,
          loading: phiPluginsState.loading,
          icons: homeResourceIcons(phiPluginsState.plugins)
        }
      }}
      wrapperRuns={wrapperRuns}
      wrapperCatalog={wrapperCatalog}
      lastClosedSessionPath={activeSessionPath}
      onLoadResources={loadHomeResources}
      models={availableModels}
      selectedModel={selectedModel}
      thinkingLevel={thinkingLevel}
      busy={isSessionChanging}
      onSelectModel={(model) => void onSelectModel(model)}
      onSelectThinkingLevel={(level) => void onSelectThinkingLevel(level)}
      onUpdateProjectPermissionMode={onUpdateProjectPermissionMode}
      createdProjectId={homeCreatedProjectId}
      onNewProject={() => {
        homeCreateSelectRef.current = true
        setIsNewProjectDialogOpen(true)
      }}
      onStartPrompt={(request) => onStartHomePrompt(request)}
      composerResources={{
        skills,
        promptAgents,
        resources: chatResourceMentions,
        cwd: activeCwd,
        onPickFiles: onPickInputFiles,
        onOpenAddMenu: onOpenInputAddMenu,
        onRefreshPromptAgents: refreshPromptAgents
      }}
      onOpenSession={(path) => void onOpenSessionFromSidebar(path)}
    />
  )

  const activeAnalysisView = (
    <Suspense
      fallback={
        <Box
          role="status"
          aria-live="polite"
          sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <Typography variant="body2" color="text.secondary">
            {appCopy.loadingAnalysis}
          </Typography>
        </Box>
      }
    >
      <AnalysisView
        key={activeProject?.id ?? activeCwd ?? 'notebook-workspace'}
        hideLeftRail
        notebookRegistry={analysisNotebookRegistry}
        notebookFile={activeAnalysisNotebook}
        notebookViewStateStore={notebookViewStateStore}
        notebookViewStateScope={JSON.stringify([
          activeProjectId,
          activeCwd,
          activeProjectLocation,
          activeProject?.remoteHostAlias
        ])}
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
        pendingJupyterCellStart={pendingJupyterCellStart}
        isStartingJupyterForCell={isStartingAnalysisJupyter}
        jupyterCellStartError={analysisJupyterError}
        onStartJupyterForCell={() => void onStartJupyterForPendingCell()}
        onDismissJupyterCellStart={onDismissJupyterCellStart}
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
        onOpenWebUrl={onOpenWebUrl}
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
        onSaveNotebook={onSaveAnalysisNotebook}
        onCreateNotebook={(cwd) => {
          void onCreateAnalysisNotebook(cwd)
        }}
      />
    </Suspense>
  )

  // One preview element for both workspace layouts: the tab content slot and the
  // analysis file strip render exactly the same panel.
  const workspaceFilePreviewContent = activeFilePreviewState ? (
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
      fileActions={workspaceFileActions}
      treeRevision={workspaceSidePanelTreeRevision}
      onDownloadFile={
        activeFilePreviewState && filePreviewStatePath(activeFilePreviewState).startsWith('ssh://')
          ? downloadWrapperResultFile
          : undefined
      }
      downloadState={fileDownload}
      onCancelDownload={cancelActiveWrapperResultDownload}
    />
  ) : null

  const activeWorkspaceFileTabContent = isWorkspaceFileWorkspaceTab(activeWorkspaceTab)
    ? activeWorkspaceTab.kind === 'notebook'
      ? activeAnalysisView
      : workspaceFilePreviewContent
    : null

  const standardWorkspaceTabContent =
    activeWorkspaceTab?.kind === 'session'
      ? chatWorkspaceContent
      : isWorkspaceFileWorkspaceTab(activeWorkspaceTab)
        ? activeWorkspaceFileTabContent
        : activeWorkspaceResourceContent

  const activeWorkspaceTabContent = standardWorkspaceTabContent

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
    visibleWorkspaceSidebarPreview,
    setIsSidebarOpen,
    setWorkspaceSidebarMode
  ])

  const runtimeCanonicalCwd =
    activeProjectLocation?.kind === 'ssh'
      ? activeProjectLocation.canonicalRoot
      : activeProjectLocation?.kind === 'local'
        ? activeProjectLocation.realPath
        : undefined

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
      onOpenRemoteSettings: () => openSettings('remote'),
      onRestoreConversationToMain: onRestoreConversationToMain,
      activeWorkspacePath: activeWorkspaceSidePanelPath,
      workspaceFileTreeRevision: workspaceSidePanelTreeRevision,
      onOpenWorkspaceFile: onOpenWorkspaceFileFromSidebar,
      onSelectWorkspaceDirectory:
        activeProjectLocation?.kind === 'ssh' ? onSelectRemoteUploadDirectory : undefined,
      onDropLocalPaths:
        activeProjectLocation?.kind === 'ssh'
          ? (paths, destinationPath) => void onDropRemoteProjectFiles(paths, destinationPath)
          : undefined,
      onListWorkspaceDirectory: onListPreviewDirectory,
      workspaceFileActions,
      fileDownloadState: fileDownload,
      onCancelFileDownload: cancelActiveWrapperResultDownload,
      runtimeProjectCwd: activeProject?.workingDirectory ?? activeCwd,
      runtimeCanonicalCwd,
      runtimeStatus: analysisJupyterRuntimeStatus,
      additionalRuntimeStatuses: runningJupyterRuntimes,
      isRuntimeLoading: isLoadingAnalysisJupyterRuntime || isStartingAnalysisJupyter,
      runtimeClosingNotebookPath: closingRuntimeNotebookPath,
      onOpenRuntimeNotebook: onOpenNotebookWorkspaceFile,
      onRefreshRuntime: () => {
        void refreshAnalysisJupyterRuntimeStatus()
        void refreshRunningJupyterRuntimes()
      },
      onStartRuntime: (cwd) => {
        const remote = analysisJupyterRuntimeStatus?.server?.runtimeKind === 'ssh'
        void onStartAnalysisJupyter(cwd).then(async () => {
          await refreshAnalysisJupyterRuntimeStatus()
          await refreshRunningJupyterRuntimes()
        })
        if (remote) onOpenJupyterStartLog(cwd)
      },
      onOpenRuntimeStartLog: onOpenJupyterStartLog,
      runtimeStartLogCwds,
      onStopRuntime: (cwd, options) => {
        void onStopAnalysisJupyter(cwd, options).then(async () => {
          await refreshAnalysisJupyterRuntimeStatus()
          await refreshRunningJupyterRuntimes()
        })
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
      onRegisterMcpConnectorDialogCloser: registerMcpConnectorDialogCloser,
      onOpenConnectorJob: onOpenLocalConnectorJobs,
      wrapperCatalog: wrapperCatalog,
      selectedWrapperId: selectedWrapperId,
      isLoadingWrappers: isLoadingWrappers,
      onOpenWrapper: onOpenWrapperTab,
      onRefreshWrappers: refreshWrappers,
      busyWrapperPackageId: busyWrapperPackageId,
      onSetWrapperPackageEnabled: setPackageEnabled,
      onNotify: showSnackbar,
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
      onOpenJupyterStartLog,
      runtimeStartLogCwds,
      activeWorkspaceIsProject,
      activeWorkspaceTitle,
      activeWorkspaceScopeLabel,
      workspaceFilesRootPath,
      activeProjectLocation?.kind,
      runtimeCanonicalCwd,
      activeProject?.remoteHostAlias,
      activeRemoteConnection,
      onRetryRemoteConnection,
      openSettings,
      onRestoreConversationToMain,
      activeWorkspaceSidePanelPath,
      workspaceSidePanelTreeRevision,
      onOpenWorkspaceFileFromSidebar,
      onSelectRemoteUploadDirectory,
      onDropRemoteProjectFiles,
      onListPreviewDirectory,
      workspaceFileActions,
      fileDownload,
      cancelActiveWrapperResultDownload,
      activeProject?.workingDirectory,
      analysisJupyterRuntimeStatus,
      runningJupyterRuntimes,
      isLoadingAnalysisJupyterRuntime,
      isStartingAnalysisJupyter,
      closingRuntimeNotebookPath,
      onOpenNotebookWorkspaceFile,
      refreshAnalysisJupyterRuntimeStatus,
      refreshRunningJupyterRuntimes,
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
      registerMcpConnectorDialogCloser,
      onOpenLocalConnectorJobs,
      wrapperCatalog,
      selectedWrapperId,
      isLoadingWrappers,
      busyWrapperPackageId,
      setPackageEnabled,
      showSnackbar,
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
          onPickRegistryDirectory={() => rendererApi.pickPackageRegistryDirectory()}
          onReadRegistry={(dir) => rendererApi.readPackageRegistry(dir)}
          onInstallPackage={onInstallSkillPackage}
          onRefresh={refreshSkills}
          onApplyUpdate={async (entry) => {
            await rendererApi.applyPackageUpdate('skill', entry.id)
            await refreshSkills()
            showSnackbar(appCopy.updatedPackage(entry.title), 'success')
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

        <WorkspaceView
          active={isWorkspaceView}
          chromeLayout={chromeLayout}
          mode={workspaceViewMode}
          workspaceTitle={activeWorkspaceTitle}
          showTitlebar={showWorkspaceTitlebar}
          hideTitle={showHomeWorkspace}
          sidePanelCollapsed={workspaceSidePanelCollapsed}
          titlebarTrailing={
            filePreview && !showProjectSessionPlaceholder ? (
              <FilePreviewTitleTab
                state={filePreview}
                titlebarInsetEnd={
                  workspaceSidePanelCollapsed ? titlebarTrailingToggleChromeReserve : 1.25
                }
                onClose={onCloseCurrentFilePreview}
              />
            ) : null
          }
          resourceStrip={{
            tabs: visibleWorkspaceTabs,
            activeKey: effectiveActiveWorkspaceTabKey,
            onSelect: onSelectWorkspaceTab,
            onClose: onCloseWorkspaceTab,
            onDockSessionTab: workspaceFileTabs.length > 0 ? onDockConversationToSidebar : undefined
          }}
          fileStrip={{
            tabs: workspaceFileTabs,
            activeId: activeWorkspaceFileTab?.id ?? null,
            onSelect: onSelectWorkspaceFileTab,
            onClose: onCloseWorkspaceFileTab
          }}
          content={{
            tabs: activeWorkspaceTabContent,
            filePreview: workspaceFilePreviewContent,
            analysis: activeAnalysisView,
            chat: chatWorkspaceContent,
            empty: emptyWorkspaceContent
          }}
        />

        {workspaceSidePanelSlots.length > 0 ? (
          <>
            {!workspaceSidePanelOverlay ? (
              <AppResizeSeparator
                label={appCopy.resizeWorkspace}
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
                onRefreshJobs={() => void refreshBackgroundJobs()}
                onToggleMaximized={toggleWorkspaceSidePanelMaximized}
                renderSlot={(mode, slotContext) => {
                  if (mode === 'jobs') {
                    return (
                      <BackgroundJobsPanel
                        onOpenSession={(path) => void onOpenSessionFromSidebar(path)}
                        onOpenWrapper={onOpenWrapperRunFromJobs}
                        requestedConnectorJobId={requestedConnectorJobId}
                        onRequestedConnectorJobHandled={consumeConnectorJob}
                        requestedJobKey={requestedBackgroundJobKey}
                        onRequestedJobHandled={consumeBackgroundJob}
                        onOpenSetupAgent={onOpenConnectorSetupAgent}
                        onOpenSetupTerminal={onOpenConnectorSetupTerminal}
                      />
                    )
                  }
                  if (mode === 'browser') {
                    return (
                      <BrowserPanel
                        bridge={rendererApi.browser}
                        activePhiSessionId={activeBrowserSessionId}
                        activeSessionGeneration={activeBrowserSessionGeneration}
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
                      requestedInput={requestedTerminalInput}
                      onRequestedInputHandled={consumeTerminalInput}
                    />
                  )
                }}
              />
            </Box>
          </>
        ) : null}

        <AppWindowChrome
          isMac={isMac}
          chromeLayout={chromeLayout}
          isSidebarOpen={isSidebarOpen}
          onToggleSidebar={() => setIsSidebarOpen((value) => !value)}
          onOpenSessionSearch={() => setSessionSearchOpenWithBrowserGate(true)}
          onCloseWindow={() => void rendererApi.closeWindow()}
          onMinimizeWindow={() => void rendererApi.minimizeWindow()}
          onToggleFullscreen={() => void rendererApi.toggleWindowFullscreen()}
          activePanels={workspaceSidePanelSlots}
          sidePanelWidth={activeWorkspaceSidePanelWidth}
          sidePanelOverlay={workspaceSidePanelOverlay}
          onRefreshSidePanel={onRefreshWorkspaceSidePanel}
          onTogglePanel={onToggleWorkspaceSidePanel}
        />

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
          onProjectUpdated={onProjectUpdated}
          onOpenApprovalSession={onOpenApprovalSession}
          onRespondToolApproval={onRespondToolApproval}
          themeMode={themeMode}
          setThemeMode={setThemeMode}
          themePalette={themePalette}
          setThemePalette={setThemePalette}
          noProjectTaskFolder={noProjectTaskFolder}
          allowExternalFileRead={allowExternalFileRead}
          preventSleepDuringRuns={preventSleepDuringRuns}
          nextActionSuggestionsEnabled={nextActionSuggestionsEnabled}
          fileOpenConversationLayout={fileOpenConversationLayout}
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
