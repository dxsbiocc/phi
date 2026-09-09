import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import {
  Alert,
  Box,
  CssBaseline,
  IconButton,
  Snackbar,
  ThemeProvider,
  Tooltip,
  Typography
} from '@mui/material'
import ChatView from './components/ChatView'
import SessionSidebar from './components/SessionSidebar'
import PluginView from './components/PluginView'
import SkillView from './components/SkillView'
import McpView from './components/McpView'
import SettingsDialog, { type SettingsCategory } from './components/SettingsDialog'
import AddProviderDialog from './components/AddProviderDialog'
import OnboardingDialog from './components/OnboardingDialog'
import NewProjectDialog from './components/NewProjectDialog'
import AnalysisView from './components/AnalysisView'
import { createAppTheme } from './theme'
import { useThemeMode } from './useThemeMode'
import { chatItemsFromSessionMessages } from './lib/chatItems'
import { getAppShortcutAction } from './lib/appShortcuts'
import { agentEventBelongsToActiveSession } from './lib/agentEventRouting'
import { getPromptReadiness } from './lib/promptReadiness'
import { shouldRefreshProjectGitStatusForAgentEvent } from './lib/projectGitRefresh'
import { readableErrorMessage } from './lib/sessionNotifications'
import { sessionDraftKey, updateSessionDraft } from './lib/sessionDrafts'
import { sessionDisplayTitle, titleFromMessages, truncateSessionTitle } from './lib/sessionTitles'
import { PhiIcons } from './icons'
import {
  idleSessionRuntimeState,
  mergeSessionRuntimeState,
  reduceSessionRuntimeState,
  sessionRuntimeStateFrom,
  sessionRuntimeStateIsBusy,
  sessionRuntimeStatesEqual,
  sessionStatusIsBusy
} from './lib/sessionRuntimeState'
import {
  type AgentEventReducerState,
  createAgentEventReducerState,
  reduceAgentEventState,
  replaceAgentEventMessages,
  updateAgentEventMessages
} from './lib/agentEventReducer'
import { navigationPaneWidth } from './layout'
import type {
  ActiveAuthPrompt,
  AgentEventSummary,
  AuthInteractionEvent,
  ChatItem,
  CurrentSession,
  AnalysisNotebookRegistry,
  McpServerSummary,
  ModelOption,
  PermissionMode,
  PluginCatalogItem,
  Project,
  ProviderAuthStatus,
  RendererApi,
  SessionRuntimeState,
  SessionSummary,
  SkillSummary,
  ThinkingLevel,
  ToolApprovalRequest
} from './types'

type AppView = 'chat' | 'projects' | 'analysis' | 'plugins' | 'skills' | 'mcp'
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
const NavAnalysisIcon = PhiIcons.nav.analysis
const NavProjectsIcon = PhiIcons.nav.projects
const NavPluginsIcon = PhiIcons.nav.plugins
const NavSkillsIcon = PhiIcons.nav.skills
const NavMcpIcon = PhiIcons.nav.mcp
const NavSettingsIcon = PhiIcons.nav.settings

function getRendererApi(): RendererApi {
  return (window as unknown as { api: RendererApi }).api
}

function modelOptionFromSelection(
  selection: { providerId: string; modelId: string } | null,
  available: ModelOption[]
): ModelOption | null {
  if (!selection) return null
  return (
    available.find(
      (item) => item.providerId === selection.providerId && item.modelId === selection.modelId
    ) ?? null
  )
}

function sessionStateKey(input: {
  path: string | null
  cwd: string
  sessionGeneration: number
}): string {
  return sessionDraftKey(input)
}

function sessionStateKeyFromAgentEvent(event: AgentEventSummary): string | null {
  if (typeof event.sessionGeneration !== 'number' || typeof event.cwd !== 'string') {
    return null
  }
  return sessionStateKey({
    path: typeof event.sessionPath === 'string' ? event.sessionPath : null,
    cwd: event.cwd,
    sessionGeneration: event.sessionGeneration
  })
}

function sessionStateKeyFromToolApproval(
  request: ToolApprovalRequest,
  fallbackGeneration: number
): string | null {
  if (typeof request.cwd !== 'string') return null
  return sessionStateKey({
    path: typeof request.sessionPath === 'string' ? request.sessionPath : null,
    cwd: request.cwd,
    sessionGeneration:
      typeof request.sessionGeneration === 'number' ? request.sessionGeneration : fallbackGeneration
  })
}

function App(): React.JSX.Element {
  const { mode: themeMode, effectiveMode, setMode: setThemeMode } = useThemeMode()
  const theme = useMemo(() => createAppTheme(effectiveMode), [effectiveMode])

  const [agentEventState, setAgentEventState] = useState(() => createAgentEventReducerState())
  const agentEventStateRef = useRef(agentEventState)
  const sessionAgentEventStatesRef = useRef(new Map<string, AgentEventReducerState>())
  const sessionRuntimeStatesRef = useRef(new Map<string, SessionRuntimeState>())
  const pendingApprovalsBySessionRef = useRef(new Map<string, ToolApprovalRequest>())
  const projectsRef = useRef<Project[]>([])
  const activeAgentEventStateKeyRef = useRef<string | null>(null)
  const messages = agentEventState.messages
  const [draftInputs, setDraftInputs] = useState<Record<string, string>>({})
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>('persona')
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(navigationPaneWidth)
  const [activeView, setActiveView] = useState<AppView>('chat')
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeSessionPath, setActiveSessionPath] = useState<string | null>(null)
  const [activeCwd, setActiveCwd] = useState('')
  const [projectSessionRefreshKey, setProjectSessionRefreshKey] = useState(0)
  const [currentPermissionMode, setCurrentPermissionMode] = useState<PermissionMode>('auto')
  const [activeSessionGeneration, setActiveSessionGeneration] = useState(0)
  const [isSessionChanging, setIsSessionChanging] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [isNewProjectDialogOpen, setIsNewProjectDialogOpen] = useState(false)
  const [pendingApproval, setPendingApproval] = useState<ToolApprovalRequest | null>(null)
  const [providerStatuses, setProviderStatuses] = useState<ProviderAuthStatus[]>([])
  const [activePrompts, setActivePrompts] = useState<ActiveAuthPrompt[]>([])
  const [providerHints, setProviderHints] = useState<Record<string, string>>({})
  const [isProviderDialogOpen, setIsProviderDialogOpen] = useState(false)
  const [providerDialogProviderId, setProviderDialogProviderId] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const [isSendingMessage, setIsSendingMessage] = useState(false)
  const [models, setModels] = useState<ModelOption[]>([])
  const [isModelStateReady, setIsModelStateReady] = useState(false)
  const [selectedModel, setSelectedModel] = useState<ModelOption | null>(null)
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>('high')
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [personaMarkdown, setPersonaMarkdownState] = useState<string | null>(null)
  const [plugins, setPlugins] = useState<PluginCatalogItem[]>([])
  const [activePluginId, setActivePluginId] = useState<string | null>(null)
  const [isLoadingPlugins, setIsLoadingPlugins] = useState(false)
  const [busyPluginSource, setBusyPluginSource] = useState<string | null>(null)
  const [pluginOperationError, setPluginOperationError] = useState<string | null>(null)
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [activeSkillId, setActiveSkillId] = useState<string | null>(null)
  const [isLoadingSkills, setIsLoadingSkills] = useState(false)
  const [mcpServers, setMcpServers] = useState<McpServerSummary[]>([])
  const [activeMcpServerId, setActiveMcpServerId] = useState<string | null>(null)
  const [analysisNotebookRegistry, setAnalysisNotebookRegistry] =
    useState<AnalysisNotebookRegistry | null>(null)
  const [isLoadingAnalysisNotebooks, setIsLoadingAnalysisNotebooks] = useState(false)
  const [analysisNotebookError, setAnalysisNotebookError] = useState<string | null>(null)
  const [snackbarNotice, setSnackbarNotice] = useState<SnackbarNotice | null>(null)
  const [activeSessionRuntimeState, setActiveSessionRuntimeState] =
    useState(idleSessionRuntimeState)
  const [, setSessionRuntimeStateRevision] = useState(0)
  const [updatingPermissionProjectId, setUpdatingPermissionProjectId] = useState<string | null>(
    null
  )
  const listRef = useRef<HTMLDivElement | null>(null)
  const isSendingRef = useRef(false)
  const activeSessionGenerationRef = useRef(0)
  const activeSessionPathRef = useRef<string | null>(null)
  const activeCwdRef = useRef('')
  const sessionRequestRef = useRef(0)
  const sendRequestRef = useRef(0)
  const skillsRequestRef = useRef(0)
  const mcpServersRequestRef = useRef(0)
  const analysisNotebooksRequestRef = useRef(0)
  const sessionRefreshTimerRef = useRef<number | null>(null)
  const rendererApi = useMemo(() => getRendererApi(), [])

  const storeSessionRuntimeState = useCallback(
    (key: string, nextState: SessionRuntimeState): boolean => {
      const previous = sessionRuntimeStatesRef.current.get(key)
      if (sessionRuntimeStatesEqual(previous, nextState)) return false

      sessionRuntimeStatesRef.current.set(key, nextState)
      setSessionRuntimeStateRevision((revision) => revision + 1)
      return true
    },
    []
  )

  const mergeSessionSummariesRuntimeState = useCallback(
    (list: SessionSummary[], cwd: string): SessionSummary[] =>
      list.map((session) => {
        const stateKey = sessionStateKey({
          path: session.path,
          cwd,
          sessionGeneration: activeSessionGenerationRef.current
        })
        const nextRuntimeState = mergeSessionRuntimeState(
          sessionRuntimeStatesRef.current.get(stateKey),
          session
        )
        storeSessionRuntimeState(stateKey, nextRuntimeState)
        return { ...session, ...nextRuntimeState }
      }),
    [storeSessionRuntimeState]
  )

  const getSessionRuntimeState = useCallback(
    (path: string, cwd: string): SessionRuntimeState | null =>
      sessionRuntimeStatesRef.current.get(
        sessionStateKey({
          path,
          cwd,
          sessionGeneration: activeSessionGenerationRef.current
        })
      ) ?? null,
    []
  )

  const setVisibleAgentEventState = useCallback(
    (updater: (previous: AgentEventReducerState) => AgentEventReducerState): void => {
      setAgentEventState((previous) => {
        const next = updater(previous)
        agentEventStateRef.current = next
        const activeKey = activeAgentEventStateKeyRef.current
        if (activeKey) {
          sessionAgentEventStatesRef.current.set(activeKey, next)
        }
        return next
      })
    },
    []
  )

  const replaceMessages = useCallback(
    (nextMessages: ChatItem[]): void => {
      setVisibleAgentEventState((prev) => replaceAgentEventMessages(prev, nextMessages))
    },
    [setVisibleAgentEventState]
  )

  const updateMessages = useCallback(
    (updater: (prev: ChatItem[]) => ChatItem[]): void => {
      setVisibleAgentEventState((prev) => updateAgentEventMessages(prev, updater))
    },
    [setVisibleAgentEventState]
  )

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

  const applyCurrentSession = useCallback(
    (current: CurrentSession, options: { resetSending?: boolean } = {}): void => {
      const previousPath = activeSessionPathRef.current
      const previousCwd = activeCwdRef.current
      const previousGeneration = activeSessionGenerationRef.current
      const previousStateKey = activeAgentEventStateKeyRef.current
      const isSameTarget = current.path === previousPath && current.cwd === previousCwd
      if (isSameTarget && current.sessionGeneration < previousGeneration) return

      const nextStateKey = sessionStateKey({
        path: current.path,
        cwd: current.cwd,
        sessionGeneration: current.sessionGeneration
      })
      const generationChanged = current.sessionGeneration !== previousGeneration
      const targetChanged = current.path !== previousPath || current.cwd !== previousCwd
      const stateKeyChanged = nextStateKey !== activeAgentEventStateKeyRef.current
      const shouldCarryFreshState =
        stateKeyChanged &&
        previousPath === null &&
        current.path !== null &&
        current.cwd === previousCwd &&
        current.sessionGeneration === previousGeneration
      if (shouldCarryFreshState && previousStateKey) {
        const previousPendingApproval = pendingApprovalsBySessionRef.current.get(previousStateKey)
        if (previousPendingApproval && !pendingApprovalsBySessionRef.current.has(nextStateKey)) {
          pendingApprovalsBySessionRef.current.set(nextStateKey, previousPendingApproval)
          pendingApprovalsBySessionRef.current.delete(previousStateKey)
        }
        const previousRuntimeState = sessionRuntimeStatesRef.current.get(previousStateKey)
        if (previousRuntimeState && !sessionRuntimeStatesRef.current.has(nextStateKey)) {
          sessionRuntimeStatesRef.current.set(nextStateKey, previousRuntimeState)
        }
        setDraftInputs((prev) => {
          if (prev[nextStateKey] !== undefined || prev[previousStateKey] === undefined) return prev
          const next = { ...prev, [nextStateKey]: prev[previousStateKey] }
          delete next[previousStateKey]
          return next
        })
      }
      activeSessionGenerationRef.current = current.sessionGeneration
      activeSessionPathRef.current = current.path
      activeCwdRef.current = current.cwd
      activeAgentEventStateKeyRef.current = nextStateKey
      setActiveSessionGeneration(current.sessionGeneration)
      setActiveCwd(current.cwd)
      setActiveSessionPath(current.path)
      setCurrentPermissionMode(current.permissionMode ?? 'auto')
      const nextRuntimeState = mergeSessionRuntimeState(
        sessionRuntimeStatesRef.current.get(nextStateKey),
        current,
        { preserveBusy: false }
      )
      storeSessionRuntimeState(nextStateKey, nextRuntimeState)
      setActiveSessionRuntimeState(nextRuntimeState)
      setPendingApproval(pendingApprovalsBySessionRef.current.get(nextStateKey) ?? null)
      if (options.resetSending || generationChanged || targetChanged) {
        sendRequestRef.current += 1
        isSendingRef.current = false
        setIsSendingMessage(false)
      }
      if (generationChanged || targetChanged || stateKeyChanged) {
        const restored =
          sessionAgentEventStatesRef.current.get(nextStateKey) ??
          (shouldCarryFreshState ? agentEventStateRef.current : createAgentEventReducerState())
        sessionAgentEventStatesRef.current.set(nextStateKey, restored)
        agentEventStateRef.current = restored
        setAgentEventState(restored)
      }
    },
    [storeSessionRuntimeState]
  )

  const refreshAuthStatuses = useCallback(async (): Promise<void> => {
    const data = await rendererApi.getAuthStatus()
    setProviderStatuses(data)
  }, [rendererApi])

  const refreshSessions = useCallback(async (): Promise<void> => {
    const list = mergeSessionSummariesRuntimeState(
      await rendererApi.listSessions(),
      activeCwdRef.current
    )
    setSessions(list)
    const activePath = activeSessionPathRef.current
    if (!activePath) return
    const active = list.find((session) => session.path === activePath)
    if (!active) return
    const activeKey = sessionStateKey({
      path: activePath,
      cwd: activeCwdRef.current,
      sessionGeneration: activeSessionGenerationRef.current
    })
    const nextRuntimeState = mergeSessionRuntimeState(
      sessionRuntimeStatesRef.current.get(activeKey),
      active
    )
    storeSessionRuntimeState(activeKey, nextRuntimeState)
    if (activeKey === activeAgentEventStateKeyRef.current) {
      setActiveSessionRuntimeState(nextRuntimeState)
    }
  }, [mergeSessionSummariesRuntimeState, rendererApi, storeSessionRuntimeState])

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
    [models, rendererApi]
  )

  const startFreshChat = useCallback((): void => {
    replaceMessages([])
  }, [replaceMessages])

  const scheduleSessionRefresh = useCallback((): void => {
    if (sessionRefreshTimerRef.current !== null) return
    sessionRefreshTimerRef.current = window.setTimeout(() => {
      sessionRefreshTimerRef.current = null
      void refreshSessions()
      setProjectSessionRefreshKey((key) => key + 1)
    }, 900)
  }, [refreshSessions])

  const onNewChat = useCallback(async (): Promise<void> => {
    const request = ++sessionRequestRef.current
    setIsSessionChanging(true)
    try {
      const current = await rendererApi.createSession()
      if (request !== sessionRequestRef.current) return
      applyCurrentSession(current, { resetSending: true })
      void refreshCurrentModelControls(request)
      startFreshChat()
    } finally {
      if (request === sessionRequestRef.current) {
        setIsSessionChanging(false)
      }
    }
  }, [applyCurrentSession, refreshCurrentModelControls, rendererApi, startFreshChat])

  const onSelectSession = async (path: string): Promise<void> => {
    if (path === activeSessionPathRef.current) {
      const acknowledged = await rendererApi.acknowledgeSession(path)
      if (!acknowledged) return
      const nextRuntimeState = sessionRuntimeStateFrom(acknowledged)
      const stateKey = sessionStateKey({
        path: acknowledged.path,
        cwd: activeCwdRef.current,
        sessionGeneration: activeSessionGenerationRef.current
      })
      storeSessionRuntimeState(stateKey, nextRuntimeState)
      if (stateKey === activeAgentEventStateKeyRef.current) {
        setActiveSessionRuntimeState(nextRuntimeState)
      }
      setSessions((prev) =>
        prev.map((session) =>
          session.path === acknowledged.path ? { ...session, ...nextRuntimeState } : session
        )
      )
      setProjectSessionRefreshKey((key) => key + 1)
      return
    }
    const request = ++sessionRequestRef.current
    setIsSessionChanging(true)
    try {
      const result = await rendererApi.switchSession(path)
      if (!result || request !== sessionRequestRef.current) return
      applyCurrentSession(result, { resetSending: true })
      const targetStateKey = sessionStateKey({
        path: result.path,
        cwd: result.cwd,
        sessionGeneration: result.sessionGeneration
      })
      const cachedState = sessionAgentEventStatesRef.current.get(targetStateKey)
      if (cachedState && cachedState.messages.length > 0) {
        agentEventStateRef.current = cachedState
        setAgentEventState(cachedState)
      } else {
        replaceMessages(chatItemsFromSessionMessages(result.messages))
      }
      void refreshCurrentModelControls(request)
      void refreshSessions()
      setProjectSessionRefreshKey((key) => key + 1)
    } finally {
      if (request === sessionRequestRef.current) {
        setIsSessionChanging(false)
      }
    }
  }

  const onRenameSession = async (path: string, name: string): Promise<void> => {
    await rendererApi.renameSession(path, name)
    await refreshSessions()
    setProjectSessionRefreshKey((key) => key + 1)
  }

  const onDeleteSession = async (path: string): Promise<void> => {
    const request = sessionRequestRef.current
    const wasActive = path === activeSessionPathRef.current
    await rendererApi.deleteSession(path)
    if (wasActive && request === sessionRequestRef.current) {
      const current = await rendererApi.getCurrentSession()
      if (request === sessionRequestRef.current) {
        applyCurrentSession(current, { resetSending: true })
        void refreshCurrentModelControls(request)
        replaceMessages([])
      }
    }
    await refreshSessions()
    setProjectSessionRefreshKey((key) => key + 1)
  }

  const refreshProjects = useCallback(async (): Promise<void> => {
    const list = await rendererApi.listProjects()
    projectsRef.current = list
    setProjects(list)
  }, [rendererApi])

  const refreshPlugins = useCallback(async (): Promise<void> => {
    setIsLoadingPlugins(true)
    setPluginOperationError(null)
    try {
      const list = await rendererApi.listPlugins()
      setPlugins(list)
      setActivePluginId((current) => current ?? list[0]?.id ?? null)
    } finally {
      setIsLoadingPlugins(false)
    }
  }, [rendererApi])

  const refreshSkills = useCallback(async (): Promise<void> => {
    const request = ++skillsRequestRef.current
    const cwd = activeCwdRef.current
    setIsLoadingSkills(true)
    try {
      const list = await rendererApi.listSkills(cwd)
      if (request !== skillsRequestRef.current || cwd !== activeCwdRef.current) return
      setSkills(list)
      setActiveSkillId((current) => current ?? list[0]?.id ?? null)
    } finally {
      if (request === skillsRequestRef.current) {
        setIsLoadingSkills(false)
      }
    }
  }, [rendererApi])

  const refreshMcpServers = useCallback(async (): Promise<void> => {
    const request = ++mcpServersRequestRef.current
    const cwd = activeCwdRef.current
    const list = await rendererApi.listMcpServers(cwd)
    if (request !== mcpServersRequestRef.current || cwd !== activeCwdRef.current) return
    setMcpServers(list)
    setActiveMcpServerId((current) => current ?? list[0]?.id ?? null)
  }, [rendererApi])

  const refreshAnalysisNotebooks = useCallback(async (): Promise<void> => {
    const request = ++analysisNotebooksRequestRef.current
    const cwd = activeCwdRef.current
    setIsLoadingAnalysisNotebooks(true)
    setAnalysisNotebookError(null)
    try {
      const registry = await rendererApi.listAnalysisNotebooks(cwd)
      if (request !== analysisNotebooksRequestRef.current || cwd !== activeCwdRef.current) return
      setAnalysisNotebookRegistry(registry)
    } catch (error) {
      if (request !== analysisNotebooksRequestRef.current) return
      setAnalysisNotebookError(readableErrorMessage(error, '无法读取项目 notebooks'))
    } finally {
      if (request === analysisNotebooksRequestRef.current) {
        setIsLoadingAnalysisNotebooks(false)
      }
    }
  }, [rendererApi])

  const onInitializeProjectAnalysis = useCallback(
    async (cwd: string): Promise<void> => {
      try {
        await rendererApi.initializeProjectAnalysis(cwd)
        await refreshAnalysisNotebooks()
      } catch (error) {
        setAnalysisNotebookError(readableErrorMessage(error, '无法初始化分析目录'))
      }
    },
    [refreshAnalysisNotebooks, rendererApi]
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
    const request = ++sessionRequestRef.current
    setIsSessionChanging(true)
    try {
      const current = await rendererApi.createProjectSession(
        project.workingDirectory,
        project.permissionMode
      )
      if (request !== sessionRequestRef.current) return
      applyCurrentSession(current, { resetSending: true })
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

  const onRespondToolApproval = async (requestId: string, approved: boolean): Promise<void> => {
    const activeKey = activeAgentEventStateKeyRef.current
    if (activeKey) {
      pendingApprovalsBySessionRef.current.delete(activeKey)
    }
    setPendingApproval(null)
    await rendererApi.respondToolApproval(requestId, approved)
    await refreshSessions()
    setProjectSessionRefreshKey((key) => key + 1)
  }

  const onOpenApprovalSession = (path: string): void => {
    setActiveView('chat')
    setIsSettingsOpen(false)
    void onSelectSession(path)
  }

  const closeProviderDialog = useCallback((): void => {
    setIsProviderDialogOpen(false)
    setProviderDialogProviderId(null)
    setActivePrompts([])
  }, [])

  const openProviderDialog = (providerId: string | null = null): void => {
    setProviderDialogProviderId(providerId)
    setIsProviderDialogOpen(true)
  }

  const openSettings = (category?: SettingsCategory): void => {
    if (category) {
      setSettingsCategory(category)
    }
    setIsSettingsOpen(true)
  }

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
        path: activeSessionPathRef.current,
        cwd: activeCwdRef.current,
        sessionGeneration: activeSessionGenerationRef.current
      })
      const eventStateKey = sessionStateKeyFromAgentEvent(event)
      if (eventStateKey) {
        const nextRuntimeState = reduceSessionRuntimeState(
          sessionRuntimeStatesRef.current.get(eventStateKey) ?? idleSessionRuntimeState(),
          event
        )
        const runtimeStateChanged = storeSessionRuntimeState(eventStateKey, nextRuntimeState)
        const baseState =
          sessionAgentEventStatesRef.current.get(eventStateKey) ??
          (belongsToActiveSession ? agentEventStateRef.current : createAgentEventReducerState())
        const nextState = reduceAgentEventState(baseState, event)
        sessionAgentEventStatesRef.current.set(eventStateKey, nextState)
        if (belongsToActiveSession) {
          activeAgentEventStateKeyRef.current = eventStateKey
          agentEventStateRef.current = nextState
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

    const unsubscribeAuthInteraction = rendererApi.onAuthInteraction(
      (event: AuthInteractionEvent) => {
        if (event.type === 'prompt') {
          setActivePrompts((prev) => {
            const exists = prev.some((item) => item.requestId === event.requestId)
            if (exists) {
              return prev.map((item) =>
                item.requestId === event.requestId
                  ? {
                      ...item,
                      prompt: event.prompt,
                      value: item.value
                    }
                  : item
              )
            }

            return [
              ...prev,
              {
                requestId: event.requestId,
                providerId: event.providerId,
                prompt: event.prompt,
                value: ''
              }
            ]
          })

          setProviderDialogProviderId(event.providerId)
          setIsProviderDialogOpen(true)
          setIsSettingsOpen(true)
          return
        }

        const hint =
          event.event.type === 'auth_url'
            ? `授权链接：${event.event.url}`
            : event.event.type === 'info'
              ? event.event.message
              : event.event.type === 'progress'
                ? event.event.message
                : event.event.type === 'device_code'
                  ? `验证码：${event.event.userCode}`
                  : '收到授权提示'

        setProviderHints((prev) => ({
          ...prev,
          [event.providerId]: hint
        }))

        setProviderDialogProviderId(event.providerId)
        if (
          event.event.type === 'progress' ||
          event.event.type === 'auth_url' ||
          event.event.type === 'device_code'
        ) {
          setIsProviderDialogOpen(true)
        }
      }
    )

    const unsubscribeToolApproval = rendererApi.onToolApprovalRequest((event) => {
      const approvalStateKey = sessionStateKeyFromToolApproval(
        event,
        activeSessionGenerationRef.current
      )
      if (approvalStateKey) {
        pendingApprovalsBySessionRef.current.set(approvalStateKey, event)
        const nextRuntimeState = {
          ...(sessionRuntimeStatesRef.current.get(approvalStateKey) ?? idleSessionRuntimeState()),
          status: 'needs_approval' as const,
          unreadKind: 'approval' as const,
          currentRunId: event.runId
        }
        storeSessionRuntimeState(approvalStateKey, nextRuntimeState)
        if (approvalStateKey === activeAgentEventStateKeyRef.current) {
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
      pendingApprovalsBySessionRef.current.clear()
      setPendingApproval(null)
      scheduleSessionRefresh()
    })

    const unsubscribeSessionChanged = rendererApi.onSessionChanged((session) => {
      applyCurrentSession(session)
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
      unsubscribeSessionChanged()
      if (sessionRefreshTimerRef.current !== null) {
        window.clearTimeout(sessionRefreshTimerRef.current)
        sessionRefreshTimerRef.current = null
      }
    }
  }, [
    activeView,
    applyCurrentSession,
    refreshProjects,
    rendererApi,
    scheduleSessionRefresh,
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
      setSessions(mergeSessionSummariesRuntimeState(sessionList, current.cwd))
      applyCurrentSession(current)
      if (Array.isArray(current.messages)) {
        replaceMessages(chatItemsFromSessionMessages(current.messages))
      }
      setProjects(projectList)
      projectsRef.current = projectList
    })()
  }, [applyCurrentSession, mergeSessionSummariesRuntimeState, rendererApi, replaceMessages])

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
      }
    })
  }, [
    activeCwd,
    activeView,
    refreshAnalysisNotebooks,
    refreshMcpServers,
    refreshProjects,
    refreshSkills
  ])

  useEffect(() => {
    void (async () => {
      setIsModelStateReady(false)
      try {
        const [statuses, available, selected, level] = await Promise.all([
          rendererApi.getAuthStatus(),
          rendererApi.listModels(),
          rendererApi.getSelectedModel(),
          rendererApi.getThinkingLevel()
        ])
        setProviderStatuses(statuses)
        setModels(available)
        setSelectedModel(modelOptionFromSelection(selected, available))
        setThinkingLevel(level)
      } catch {
        // 模型列表加载失败不阻塞聊天；发送时会给出明确错误
      } finally {
        setIsModelStateReady(true)
      }
    })()
    const pluginRefreshTimer = window.setTimeout(() => {
      void refreshPlugins()
    }, 0)
    return () => window.clearTimeout(pluginRefreshTimer)
  }, [refreshPlugins, rendererApi])

  const onSelectThinkingLevel = async (level: ThinkingLevel): Promise<void> => {
    const previous = thinkingLevel
    setThinkingLevel(level)
    try {
      await rendererApi.selectThinkingLevel(level)
    } catch (error) {
      setThinkingLevel(previous)
      showSnackbarError(error, '切换思考等级失败')
    }
  }

  const onSelectModel = async (model: ModelOption | null): Promise<void> => {
    if (!model) {
      setSelectedModel(null)
      return
    }

    const previous = selectedModel
    setSelectedModel(model)
    try {
      await rendererApi.selectModel(model.providerId, model.modelId)
    } catch (error) {
      setSelectedModel(previous)
      showSnackbarError(error, '切换模型失败')
    }
  }

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [messages])

  const availableModels = useMemo(() => {
    const configuredIds = new Set(
      providerStatuses
        .filter((provider) => provider.configured)
        .map((provider) => provider.providerId)
    )
    return models.filter((model) => configuredIds.has(model.providerId))
  }, [models, providerStatuses])

  const activeDraftKey = sessionDraftKey({
    path: activeSessionPath,
    cwd: activeCwd,
    sessionGeneration: activeSessionGeneration
  })
  const input = draftInputs[activeDraftKey] ?? ''
  const setActiveInput = useCallback(
    (value: string): void => {
      setDraftInputs((prev) => updateSessionDraft(prev, activeDraftKey, value))
    },
    [activeDraftKey]
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
    const submitGeneration = activeSessionGenerationRef.current
    const sendRequest = ++sendRequestRef.current

    updateMessages((prev) => [...prev, { id: `user-${Date.now()}`, role: 'user', content: text }])
    setActiveInput('')
    setIsSendingMessage(true)

    try {
      const result = await rendererApi.sendPrompt(text)
      if (
        !result ||
        sendRequest !== sendRequestRef.current ||
        result.sessionGeneration !== activeSessionGenerationRef.current
      ) {
        return
      }

      if (result.path && result.path !== activeSessionPath) {
        // First prompt of a fresh chat: it just became a real file — pick it up so
        // the sidebar can highlight it.
        activeSessionPathRef.current = result.path
        setActiveSessionPath(result.path)
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
        submitGeneration !== activeSessionGenerationRef.current
      ) {
        return
      }
      showSnackbarError(error, '发送消息失败')
    } finally {
      if (
        sendRequest === sendRequestRef.current &&
        submitGeneration === activeSessionGenerationRef.current
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

  const onSubmitAuthPrompt = async (requestId: string, value: string): Promise<void> => {
    if (!value.trim()) {
      return
    }

    setIsBusy(true)
    try {
      await rendererApi.submitAuthInteraction(requestId, value)
      setActivePrompts((prev) => prev.filter((item) => item.requestId !== requestId))
    } finally {
      setIsBusy(false)
    }
  }

  const onUpdatePromptValue = (requestId: string, value: string): void => {
    setActivePrompts((prev) =>
      prev.map((prompt) => (prompt.requestId === requestId ? { ...prompt, value } : prompt))
    )
  }

  const submitProviderApiKey = async (providerId: string, key: string): Promise<void> => {
    if (!key.trim()) {
      return
    }

    setIsBusy(true)
    try {
      const next = await rendererApi.loginApiKey(providerId, key)
      setProviderStatuses(next)
      setProviderHints((prev) => ({
        ...prev,
        [providerId]: 'API Key 已提交（实际校验延后到发送消息时）'
      }))
    } finally {
      setIsBusy(false)
    }
  }

  const submitProviderOAuth = async (providerId: string): Promise<void> => {
    setIsBusy(true)
    try {
      const next = await rendererApi.loginOAuth(providerId)
      setProviderStatuses(next)
      setProviderHints((prev) => ({
        ...prev,
        [providerId]: 'OAuth 已触发，授权状态会在对话中完成'
      }))
    } finally {
      setIsBusy(false)
    }
  }

  const logoutProvider = async (providerId: string): Promise<void> => {
    await rendererApi.logout(providerId)
    await refreshAuthStatuses()
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

  const onInstallPlugin = async (source: string): Promise<void> => {
    setBusyPluginSource(source)
    setPluginOperationError(null)
    try {
      const list = await rendererApi.installPlugin(source)
      setPlugins(list)
    } catch (error) {
      setPluginOperationError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyPluginSource(null)
    }
  }

  const onRemovePlugin = async (source: string): Promise<void> => {
    setBusyPluginSource(source)
    setPluginOperationError(null)
    try {
      const list = await rendererApi.removePlugin(source)
      setPlugins(list)
    } catch (error) {
      setPluginOperationError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyPluginSource(null)
    }
  }

  const onUpdateProjectPermissionMode = async (
    projectId: string,
    permissionMode: PermissionMode
  ): Promise<void> => {
    setUpdatingPermissionProjectId(projectId)
    try {
      const project = await rendererApi.updateProjectPermissionMode(projectId, permissionMode)
      setProjects((prev) => prev.map((item) => (item.id === project.id ? project : item)))
    } finally {
      setUpdatingPermissionProjectId(null)
    }
  }

  const onSelectPermissionMode = async (permissionMode: PermissionMode): Promise<void> => {
    if (permissionMode === activePermissionMode) return
    const current = await rendererApi.updateCurrentSessionPermissionMode(permissionMode)
    applyCurrentSession(current)
    setProjectSessionRefreshKey((key) => key + 1)
  }

  const onUpdateProjectDefaults = async (
    projectId: string,
    defaults: {
      defaultModel?: { providerId: string; modelId: string } | null
      defaultThinkingLevel?: ThinkingLevel | null
    }
  ): Promise<void> => {
    setUpdatingPermissionProjectId(projectId)
    try {
      const project = await rendererApi.updateProjectDefaults(projectId, defaults)
      setProjects((prev) => prev.map((item) => (item.id === project.id ? project : item)))
    } catch (error) {
      showSnackbarError(error, '更新项目默认模型失败')
    } finally {
      setUpdatingPermissionProjectId(null)
    }
  }

  const selectedPrompts = activePrompts.filter(
    (item) => item.providerId === providerDialogProviderId
  )
  const isChatWorkspaceView = activeView === 'chat' || activeView === 'projects'
  const activeSession = activeSessionPath
    ? (sessions.find((session) => session.path === activeSessionPath) ?? null)
    : null
  const activeSessionHasWork =
    sessionStatusIsBusy(activeSession) || sessionRuntimeStateIsBusy(activeSessionRuntimeState)
  const currentSessionIsBusy = isSendingMessage || activeSessionHasWork
  const activeWorkspaceTitle = useMemo(() => {
    if (!isChatWorkspaceView) return activeView
    if (activeSession) return sessionDisplayTitle(activeSession)
    return titleFromMessages(messages) ?? truncateSessionTitle('新对话')
  }, [activeSession, activeView, isChatWorkspaceView, messages])
  const activePermissionMode = currentPermissionMode

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
      if (activeView === view) {
        setIsSidebarOpen((value) => !value)
        return
      }
      setActiveView(view)
      setIsSidebarOpen(true)
    },
    [activeView]
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
          <Tooltip title="对话" placement="right">
            <IconButton
              size="small"
              color={activeView === 'chat' ? 'primary' : 'default'}
              onClick={() => onSelectWorkspaceView('chat')}
            >
              <NavChatIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="项目" placement="right">
            <IconButton
              size="small"
              color={activeView === 'projects' ? 'primary' : 'default'}
              onClick={() => onSelectWorkspaceView('projects')}
            >
              <NavProjectsIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="分析" placement="right">
            <IconButton
              size="small"
              color={activeView === 'analysis' ? 'primary' : 'default'}
              onClick={() => {
                setActiveView('analysis')
              }}
            >
              <NavAnalysisIcon fontSize="small" />
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
          <Box sx={{ flex: 1 }} />
          <Tooltip title="设置" placement="right">
            <IconButton size="small" onClick={() => setIsSettingsOpen(true)} sx={{ mb: 1 }}>
              <NavSettingsIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>

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
            <SessionSidebar
              mode={activeView === 'projects' ? 'projects' : 'conversations'}
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
            <Box
              sx={{
                height: macTitlebarHeight,
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                borderBottom: 1,
                borderColor: 'divider',
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
            <ChatView
              messages={messages}
              input={input}
              messagesContainerRef={(node) => {
                listRef.current = node
              }}
              canSend={!isSessionChanging && !currentSessionIsBusy && !isBusy}
              isGenerating={currentSessionIsBusy}
              currentRunStartedAt={activeSessionRuntimeState.currentRunStartedAt}
              models={availableModels}
              selectedModel={selectedModel}
              onSelectModel={(model) => {
                void onSelectModel(model)
              }}
              thinkingLevel={thinkingLevel}
              onSelectThinkingLevel={(level) => {
                void onSelectThinkingLevel(level)
              }}
              onInputChange={setActiveInput}
              onChatSubmit={onChatSubmit}
              onStopGeneration={onStopGeneration}
              onGoSettings={() => openSettings('providers')}
              permissionMode={activePermissionMode}
              onSelectPermissionMode={(mode) => {
                void onSelectPermissionMode(mode)
              }}
              disablePermissionModeSelect={isSessionChanging}
              disableModelControls={isSessionChanging}
              pendingApproval={pendingApproval}
              onRespondApproval={onRespondToolApproval}
              onOpenApprovalSession={onOpenApprovalSession}
              cwd={activeCwd}
            />
          </Box>
        ) : activeView === 'analysis' ? (
          <AnalysisView
            notebookRegistry={analysisNotebookRegistry}
            isLoadingNotebooks={isLoadingAnalysisNotebooks}
            notebookError={analysisNotebookError}
            onRefreshNotebooks={() => {
              void refreshAnalysisNotebooks()
            }}
            onInitializeProjectAnalysis={(cwd) => {
              void onInitializeProjectAnalysis(cwd)
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
