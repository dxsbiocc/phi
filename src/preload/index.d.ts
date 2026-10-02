// Imported (unlike the other ambient types in this file, which are
// hand-duplicated) — see the matching comment in preload/index.ts.
import type { WrapperCatalogEntry } from '../shared/wrapperCatalogTypes'
import type { WrapperCompositionCatalogItem } from '../shared/wrapperCompositionManifestTypes'
import type { WrapperModuleDetails } from '../shared/wrapperModuleDetailsTypes'
import type { RemoteHpcSettings } from '../shared/wrapperRemoteTypes'
import type {
  RemoteDoctorOptions,
  RemoteDoctorReport,
  RemoteNextflowInstallResult
} from '../shared/remoteDoctorTypes'
import type {
  ProjectLocation,
  RemoteProjectConnectionChange,
  RemoteProjectConnectionRetryRequest,
  RemoteProjectConnectionState,
  RemoteProjectCreateInput,
  RemoteProjectReachability
} from '../shared/projectLocation'
import type { OpenSshHostInput } from '../shared/remoteHostProfile'
import type { PromptImageInput, StoredPromptImage } from '../shared/promptImageTypes'
import type { SessionExportResult } from '../shared/sessionExportTypes'
import type { BackgroundAgentJob } from '../shared/backgroundJobTypes'
import type {
  AutoCompactionSettingsPatch,
  CurrentAutoCompactionSettings,
  CurrentContextUsage,
  ManualCompactionOutcome,
  ManualCompactionTarget
} from '../shared/contextUsageTypes'
import type { WorkspaceDiffReference } from '../shared/workspaceChangeTypes'
import type {
  WrapperRetargetRequest,
  WrapperInputPathMapping,
  WrapperRun,
  WrapperRunPlan,
  WrapperSubmitConfirmation
} from '../shared/wrapperTypes'
import type { RemoteWorkspaceFileRequest } from '../shared/remoteWorkspacePath'
import type {
  WrapperResultDirectoryRequest,
  WrapperResultDownloadProgress,
  WrapperResultDownloadResult,
  WrapperResultRange,
  WrapperResultRangeRequest,
  WrapperResultReadRequest,
  WrapperResultPreview
} from '../shared/wrapperResultTypes'
import type {
  AgentUserInteractionRequest,
  AgentUserInteractionResponse
} from '../shared/agentInteractionTypes'
import type {
  DefaultProxyMode,
  PhiAppSettings,
  PhiAppSettingsPatch
} from '../shared/appSettingsTypes'
import type { DbConnectorSettingsItem } from '../shared/dbConnectorTypes'
import type {
  EnvironmentGetResult,
  ManagedEnvironmentCleanResult,
  ManagedEnvironmentEntry,
  ManagedEnvironmentRemoveResult,
  EnvironmentSnapshot,
  EnvironmentToolId
} from '../shared/environmentTypes'
import type { EnvironmentBuild } from '../shared/environmentBuildTypes'
import type {
  PhiPluginInstallPreview,
  PhiPluginListItem,
  PhiPluginMutationResult
} from '../shared/phiPluginTypes'
import type {
  KnownPackageRegistryView,
  OfflinePackageImportPreview,
  InstalledPackageView,
  PackageInstallPlanView,
  PackageManagerType,
  PackageRegistryView,
  PackageUpdateView
} from '../shared/packageManagerTypes'
import type {
  EnablementItemKey,
  EnablementScope,
  EnablementSnapshot
} from '../shared/enablementTypes'
import type { SkillContent, SkillSummary } from '../shared/skillTypes'
import type { FeaturedMcpConnector } from '../shared/mcpConnectorCatalog'

type PreloadSessionSummary = {
  path: string
  id: string
  name?: string
  created: string
  modified: string
  messageCount: number
  firstMessage: string
  phiSessionId?: string
  status: 'idle' | 'running' | 'needs_approval' | 'needs_input' | 'failed' | 'completed_unread'
  unreadKind: 'completed' | 'failed' | 'approval' | 'input' | null
  lastRunOutcome?: 'completed' | 'failed' | 'interrupted' | 'stopped'
  currentRunId?: string
  currentRunStartedAt?: string
  lastActivityAt?: string
}

type PreloadPermissionMode = 'auto' | 'ask' | 'full'

type PreloadPromptTarget = {
  path: string | null
  phiSessionId?: string
  cwd: string
  sessionGeneration: number
  suppressUserMessageEvent?: boolean
  retryUserMessageId?: string
  images?: PromptImageInput[]
  planMode?: boolean
}

type PreloadPromptResult = {
  path: string | null
  phiSessionId?: string
  sessionGeneration: number
}

/** Mirrors `ProjectRemoteConnection` (src/main/agent/projects.ts) — no secret material, see that type's doc comment. */
type PreloadProjectRemoteConnection = {
  id: string
  label: string
  hostProfileId: string
  hpc?: RemoteHpcSettings
  inputPathMapping?: WrapperInputPathMapping
}

type PreloadRemoteHostProfile = {
  id: string
  label: string
  hostAlias: string
  user?: string
  port?: number
  identityFile?: string
  source?: 'ssh-config'
}
type PreloadOpenSshHost = {
  alias: string
  hostname?: string
  user?: string
  port?: number
  identityFiles: string[]
}

type PreloadProject = {
  id: string
  name: string
  location: ProjectLocation
  workingDirectory: string
  permissionMode: PreloadPermissionMode
  pathAvailable?: boolean
  remoteReachability?: RemoteProjectReachability
  remoteConnection?: RemoteProjectConnectionState
  remoteHostAlias?: string
  gitStatus?: {
    branch: string
    dirty: boolean
  }
  defaultModel?: { providerId: string; modelId: string }
  defaultThinkingLevel?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  remoteConnections?: PreloadProjectRemoteConnection[]
  defaultRemoteConnectionId?: string
  remoteWorkspaceRoot?: string
  createdAt: string
}

type PreloadToolApprovalRequest = {
  requestId: string
  agentRunId?: string
  sessionId?: string
  sessionPath?: string
  sessionGeneration?: number
  runId?: string
  cwd?: string
  projectName?: string
  toolName: string
  summary: string
}

type PreloadPluginCatalogItem = {
  id: string
  name: string
  source: string
  description: string
  author?: string
  kind: 'extension' | 'skill' | 'prompt' | 'theme' | 'package'
  downloads?: string
  updated?: string
  homepageUrl: string
  npmUrl: string
  installed: boolean
  installedPath?: string
}

type PreloadPromptAgentSummary = {
  id: string
  name: string
  description: string
  source: string
  trigger: string
}

type PreloadMcpServerSummary = {
  id: string
  name: string
  connectorId?: string
  packageId?: string
  category?: string
  command?: string
  args?: string[]
  envKeys?: string[]
  url?: string
  transport?: string
  sourcePath?: string
  managed?: boolean
  enabled?: boolean
  status: 'configured'
}

type PreloadFilePreview = {
  path: string
  name: string
  displayPath: string
  rootPath: string
  rootLabel: string
  kind: 'text' | 'html' | 'image' | 'pdf'
  mimeType: string
  bytes: number
  previewBytes: number
  truncated: boolean
} & (
  | {
      kind: 'text'
      mimeType: 'text/plain'
      content: string
      dataUrl?: never
    }
  | {
      kind: 'html'
      mimeType: 'text/html'
      content: string
      dataUrl?: never
    }
  | {
      kind: 'image'
      mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
      dataUrl: string
      content?: never
    }
  | {
      kind: 'pdf'
      mimeType: 'application/pdf'
      dataUrl: string
      content?: never
    }
)

type PreloadFileHoverPreview = {
  path: string
  name: string
  displayPath: string
  rootPath: string
  rootLabel: string
  bytes: number
  previewBytes: number
  truncated: boolean
} & (
  | {
      kind: 'text'
      mimeType: 'text/plain'
      content: string
      dataUrl?: never
      format?: never
      reason?: never
    }
  | {
      kind: 'spreadsheet'
      mimeType: 'text/csv' | 'text/tab-separated-values'
      format: 'csv' | 'tsv'
      content: string
      dataUrl?: never
      reason?: never
    }
  | {
      kind: 'image'
      mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
      dataUrl: string
      content?: never
      format?: never
      reason?: never
    }
  | {
      kind: 'metadata'
      mimeType: string
      reason: 'binary' | 'large_file' | 'pdf' | 'unsupported_media'
      content?: never
      dataUrl?: never
      format?: never
    }
)

type PreloadFileTreeEntry = {
  path: string
  name: string
  displayPath: string
  kind: 'directory' | 'file'
}

type PreloadLocalPathStat = {
  path: string
  kind: 'file' | 'directory' | 'missing'
}

type PreloadDirectoryListing = {
  path: string
  name: string
  displayPath: string
  rootPath: string
  rootLabel: string
  entries: PreloadFileTreeEntry[]
  truncated: boolean
}

type PreloadDatabaseWebImagePreview = {
  kind: 'string-network' | 'kegg-pathway'
  label: string
  sourceUrl: string
  imageUrl: string
  dataUrl: string
  mimeType: 'image/png'
  bytes: number
}

type PreloadAnalysisNotebookSummary = {
  path: string
  relativePath: string
  name: string
  directory: string
  bytes: number
  modifiedAt: string
}

type PreloadAnalysisNotebookRegistry = {
  projectCwd: string | null
  projectName?: string
  notebooks: PreloadAnalysisNotebookSummary[]
  truncated: boolean
  initialized: boolean
  message?: string
}

type PreloadAnalysisProjectInitialization = {
  notebooksDir: string
  outputsDir: string
}

type PreloadAnalysisNotebookFile = {
  path: string
  relativePath: string
  name: string
  bytes: number
  modifiedAt: string
  savedRevision: string
  document: Record<string, unknown>
}

type PreloadAnalysisNotebookDraftChange = {
  source: 'agent' | 'renderer'
  projectCwd: string
  path: string
  relativePath: string
  document: Record<string, unknown>
  savedRevision: string
  changeKind?: 'synced' | 'inserted' | 'updated' | 'deleted' | 'executed' | 'saved'
  changedCellId?: string
  focusCellId?: string
}

type PreloadAnalysisNotebookFileChange =
  | {
      type: 'changed'
      projectCwd: string
      path: string
      relativePath: string
      file: PreloadAnalysisNotebookFile
    }
  | {
      type: 'deleted'
      projectCwd: string
      path: string
      relativePath: string
    }
  | {
      type: 'error'
      projectCwd: string
      path: string
      relativePath: string
      message: string
    }

type PreloadAnalysisNotebookCodeGenerationInput = {
  prompt: string
  language: string
  requestId?: string
  model?: {
    providerId: string
    modelId: string
  } | null
  afterCellId?: string | null
  references?: Array<{
    id: string
    kind: 'dataframe' | 'data_source' | 'variable' | 'cell_output'
    name: string
    detail?: string
    cellId?: string
    preview?: {
      source?: string
      code?: string
      output?: string
      value?: string
      shape?: string
      columns?: Array<{ name: string; type?: string }>
    }
  }>
}

type PreloadAnalysisNotebookGeneratedCell = {
  cellType: 'code' | 'markdown'
  source: string
  language?: string
}

type PreloadAnalysisNotebookCodeGenerationResult = {
  source: string
  language: string
  cells?: PreloadAnalysisNotebookGeneratedCell[]
}

type PreloadAnalysisNotebookCodeGenerationProgress = {
  requestId: string
  path: string
  relativePath: string
  source: string
  language: string
  cells: PreloadAnalysisNotebookGeneratedCell[]
}

type PreloadSaveAnalysisNotebookInput = {
  path: string
  document: Record<string, unknown>
  expectedRevision?: string
}

type PreloadAnalysisKernelDiagnostics = {
  jupyterServer: {
    available: boolean
    command: 'jupyter'
    version?: string
    error?: string
  }
  kernels: Array<{
    name: string
    displayName: string
    language: 'python' | 'r' | 'other'
    rawLanguage: string
    resourceDir?: string
    executable?: string
  }>
  preferredKernelName?: string
  hasPythonKernel: boolean
  hasRKernel: boolean
  messages: string[]
}

type PreloadJupyterServerStatus = {
  projectCwd: string
  state: 'stopped' | 'starting' | 'ready' | 'error' | 'exited'
  startedAt?: string
  exitedAt?: string
  pid?: number
  port?: number
  hasEndpoint: boolean
  message?: string
}

type PreloadAnalysisNotebookSessionStatus = {
  projectCwd: string
  notebookPath: string
  kernelName?: string
  kernelDisplayName?: string
  sessionId?: string
  state: 'missing' | 'idle' | 'busy' | 'restarting' | 'disconnected' | 'error'
  message?: string
  startedAt?: string
  updatedAt?: string
}

type PreloadAnalysisJupyterRuntimeStatus = {
  server: PreloadJupyterServerStatus
  notebooks: {
    activeSessionCount: number
    busySessionCount: number
    sessions: PreloadAnalysisNotebookSessionStatus[]
  }
}

type PreloadAnalysisCellExecutionResult = {
  cellId: string
  executionCount: number | null
  outputs: Record<string, unknown>[]
  state: 'idle' | 'error'
  startedAt: string
  completedAt: string
  document: Record<string, unknown>
  sessionStatus: PreloadAnalysisNotebookSessionStatus
}

type PreloadAnalysisNotebookCompletionInput = {
  path: string
  document: Record<string, unknown>
  cellId: string
  source: string
  cursorPosition: number
}

type PreloadAnalysisNotebookCompletionResult = {
  matches: string[]
  cursorStart: number
  cursorEnd: number
  metadata: Record<string, unknown>
  status: 'ok' | 'error'
  message?: string
}

type PreloadAnalysisNotebookFormatInput = {
  path: string
  document: Record<string, unknown>
  cellId: string
  source: string
  language?: string
  lineLength?: number
}

type PreloadAnalysisNotebookFormatResult = {
  source: string
  changed: boolean
  formatter: 'ruff' | 'black' | 'none'
  message?: string
}

declare global {
  interface Window {
    platform: NodeJS.Platform
    api: {
      closeWindow: () => Promise<void>
      minimizeWindow: () => Promise<void>
      toggleWindowFullscreen: () => Promise<void>
      revealPath: (path: string) => Promise<void>
      openPath: (path: string) => Promise<void>
      getFileIcon: (path: string) => Promise<string | null>
      pickInputFiles: () => Promise<string[]>
      getPathForFile: (file: File) => string
      onInputFilesDropped: (cb: (paths: string[]) => void) => () => void
      previewFile: (path: string) => Promise<PreloadFilePreview>
      previewRemoteWorkspaceFile: (
        request: RemoteWorkspaceFileRequest
      ) => Promise<PreloadFilePreview>
      hoverPreviewFile: (path: string) => Promise<PreloadFileHoverPreview>
      statLocalPaths: (cwd: string, paths: string[]) => Promise<PreloadLocalPathStat[]>
      listDirectory: (path: string) => Promise<PreloadDirectoryListing>
      listRemoteWorkspaceDirectory: (
        request: RemoteWorkspaceFileRequest
      ) => Promise<PreloadDirectoryListing>
      listWrapperResultDirectory: (
        request: WrapperResultDirectoryRequest
      ) => Promise<PreloadDirectoryListing>
      previewWrapperResult: (request: WrapperResultReadRequest) => Promise<WrapperResultPreview>
      readWrapperResultRange: (request: WrapperResultRangeRequest) => Promise<WrapperResultRange>
      cancelWrapperResultRead: (requestId: string) => Promise<boolean>
      downloadWrapperResult: (
        request: WrapperResultReadRequest
      ) => Promise<WrapperResultDownloadResult>
      cancelWrapperResultDownload: (requestId: string) => Promise<boolean>
      onWrapperResultDownloadProgress: (
        cb: (progress: WrapperResultDownloadProgress) => void
      ) => () => void
      renderMoleculeSvg: (value: string, width: number, height: number) => Promise<string>
      previewDatabaseWebImage: (url: string) => Promise<PreloadDatabaseWebImagePreview>
      copyDiagnostics: () => Promise<string>
      sendPrompt: (
        text: string,
        target?: PreloadPromptTarget
      ) => Promise<PreloadPromptResult | null>
      readPromptImage: (ref: StoredPromptImage) => Promise<PromptImageInput>
      readWorkspaceDiff: (ref: WorkspaceDiffReference) => Promise<string>
      onAgentEvent: (cb: (event: Record<string, unknown>) => void) => () => void
      onAgentUserInteractionRequest: (
        cb: (event: AgentUserInteractionRequest) => void
      ) => () => void
      onAgentUserInteractionCancelled: (cb: () => void) => () => void
      respondAgentUserInteraction: (
        requestId: string,
        response: AgentUserInteractionResponse,
        cancelled?: boolean
      ) => Promise<void>
      getAuthStatus: () => Promise<
        Array<{
          providerId: string
          name: string
          configured: boolean
          source?:
            | 'stored'
            | 'runtime'
            | 'environment'
            | 'fallback'
            | 'models_json_key'
            | 'models_json_command'
          label?: string
          hasApiKey: boolean
          hasOAuth: boolean
          hasConfigError: boolean
          statusText: string
        }>
      >
      loginApiKey: (
        providerId: string,
        key: string
      ) => Promise<
        Array<{
          providerId: string
          name: string
          configured: boolean
          source?:
            | 'stored'
            | 'runtime'
            | 'environment'
            | 'fallback'
            | 'models_json_key'
            | 'models_json_command'
          label?: string
          hasApiKey: boolean
          hasOAuth: boolean
          hasConfigError: boolean
          statusText: string
        }>
      >
      loginOAuth: (providerId: string) => Promise<
        Array<{
          providerId: string
          name: string
          configured: boolean
          source?:
            | 'stored'
            | 'runtime'
            | 'environment'
            | 'fallback'
            | 'models_json_key'
            | 'models_json_command'
          label?: string
          hasApiKey: boolean
          hasOAuth: boolean
          hasConfigError: boolean
          statusText: string
        }>
      >
      logout: (providerId: string) => Promise<void>
      submitAuthInteraction: (requestId: string, value: string) => Promise<void>
      onAuthInteraction: (
        cb: (
          event:
            | {
                type: 'prompt'
                requestId: string
                providerId: string
                prompt: {
                  type: 'text' | 'secret' | 'select' | 'manual_code'
                  message: string
                  placeholder?: string
                  options?: ReadonlyArray<{ id: string; label: string; description?: string }>
                }
              }
            | {
                type: 'notify'
                providerId: string
                event:
                  | {
                      type: 'info'
                      message: string
                      links?: ReadonlyArray<{ url: string; label?: string }>
                    }
                  | { type: 'auth_url'; url: string; instructions?: string }
                  | {
                      type: 'device_code'
                      userCode: string
                      verificationUri: string
                      intervalSeconds?: number
                      expiresInSeconds?: number
                    }
                  | { type: 'progress'; message: string }
              }
        ) => void
      ) => () => void
      getAppSettings: () => Promise<PhiAppSettings>
      updateAppSettings: (patch: PhiAppSettingsPatch) => Promise<PhiAppSettings>
      updateDefaultProxyMode: (mode: DefaultProxyMode) => Promise<PhiAppSettings>
      getEnvironment: () => Promise<EnvironmentGetResult>
      redetectEnvironment: () => Promise<EnvironmentSnapshot>
      dismissEnvironmentSummary: () => Promise<EnvironmentSnapshot>
      setEnvironmentToolPath: (
        toolId: EnvironmentToolId,
        path: string | null
      ) => Promise<EnvironmentSnapshot>
      pickEnvironmentBinary: () => Promise<string | null>
      listManagedEnvironments: (projectCwd?: string) => Promise<ManagedEnvironmentEntry[]>
      buildManagedEnvironment: (ref: string, projectCwd?: string) => Promise<{ envId: string }>
      rebuildManagedEnvironment: (envId: string) => Promise<void>
      removeManagedEnvironment: (envId: string) => Promise<ManagedEnvironmentRemoveResult>
      cleanManagedEnvironments: () => Promise<ManagedEnvironmentCleanResult>
      listDbConnectors: () => Promise<DbConnectorSettingsItem[]>
      setDbConnectorEnabled: (id: string, enabled: boolean) => Promise<DbConnectorSettingsItem[]>
      setDbConnectorApiKey: (id: string, apiKey: string) => Promise<DbConnectorSettingsItem[]>
      clearDbConnectorApiKey: (id: string) => Promise<DbConnectorSettingsItem[]>
      listModels: () => Promise<
        Array<{
          providerId: string
          modelId: string
          name: string
          thinkingLevels: Array<'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>
        }>
      >
      selectModel: (providerId: string, modelId: string) => Promise<void>
      getSelectedModel: () => Promise<{ providerId: string; modelId: string } | null>
      selectThinkingLevel: (
        level: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
      ) => Promise<void>
      getThinkingLevel: () => Promise<'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>
      getAppName: () => Promise<string>
      isOnboarded: () => Promise<boolean>
      getPersonaMarkdown: () => Promise<string>
      setPersonaMarkdown: (markdown: string) => Promise<string>
      skipOnboarding: () => Promise<void>
      completeOnboarding: (description: string) => Promise<string>
      listSessions: () => Promise<PreloadSessionSummary[]>
      getCurrentSession: () => Promise<{
        path: string | null
        phiSessionId?: string
        cwd: string
        displayCwd?: string
        projectId?: string
        projectLocation?: ProjectLocation
        sessionGeneration: number
        permissionMode: PreloadPermissionMode
        messages?: unknown[]
      }>
      getCurrentContextUsage: () => Promise<CurrentContextUsage>
      getAutoCompactionSettings: (
        target: ManualCompactionTarget
      ) => Promise<CurrentAutoCompactionSettings>
      setAutoCompactionSettings: (
        target: ManualCompactionTarget,
        patch: AutoCompactionSettingsPatch
      ) => Promise<CurrentAutoCompactionSettings>
      compactCurrentSession: (target: ManualCompactionTarget) => Promise<ManualCompactionOutcome>
      updateCurrentSessionPermissionMode: (permissionMode: PreloadPermissionMode) => Promise<{
        path: string | null
        phiSessionId?: string
        cwd: string
        displayCwd?: string
        projectId?: string
        projectLocation?: ProjectLocation
        sessionGeneration: number
        permissionMode: PreloadPermissionMode
      }>
      createSession: () => Promise<{
        path: string | null
        phiSessionId?: string
        cwd: string
        displayCwd?: string
        projectId?: string
        projectLocation?: ProjectLocation
        sessionGeneration: number
        permissionMode: PreloadPermissionMode
      }>
      forkSession: (
        sourceId: string,
        eventId: string
      ) => Promise<{ path: string; phiSessionId: string }>
      switchSession: (path: string) => Promise<{
        path: string
        phiSessionId?: string
        cwd: string
        displayCwd?: string
        projectId?: string
        projectLocation?: ProjectLocation
        sessionGeneration: number
        permissionMode: PreloadPermissionMode
        messages: unknown[]
      } | null>
      acknowledgeSession: (path: string) => Promise<PreloadSessionSummary | null>
      deleteSession: (path: string) => Promise<void>
      renameSession: (path: string, name: string) => Promise<void>
      exportSession: (sessionId: string) => Promise<SessionExportResult | null>
      listProjects: () => Promise<PreloadProject[]>
      pickProjectDirectory: () => Promise<string | null>
      createProject: (
        name: string,
        workingDirectory: string,
        permissionMode: PreloadPermissionMode
      ) => Promise<PreloadProject>
      createRemoteProject: (input: RemoteProjectCreateInput) => Promise<PreloadProject>
      retryRemoteProjectConnection: (
        request: RemoteProjectConnectionRetryRequest
      ) => Promise<RemoteProjectConnectionState>
      onRemoteProjectConnectionChanged: (
        cb: (change: RemoteProjectConnectionChange) => void
      ) => () => void
      deleteProject: (id: string) => Promise<void>
      updateProjectPermissionMode: (
        id: string,
        permissionMode: PreloadPermissionMode
      ) => Promise<PreloadProject>
      updateProjectDefaults: (
        id: string,
        defaults: {
          defaultModel?: { providerId: string; modelId: string } | null
          defaultThinkingLevel?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
        }
      ) => Promise<PreloadProject>
      listRemoteHosts: () => Promise<PreloadRemoteHostProfile[]>
      listOpenSshHosts: () => Promise<PreloadOpenSshHost[]>
      saveOpenSshHost: (input: OpenSshHostInput) => Promise<PreloadRemoteHostProfile>
      saveRemoteHost: (input: {
        id?: string
        label: string
        hostAlias: string
        user?: string
        port?: number
        identityFile?: string
      }) => Promise<PreloadRemoteHostProfile>
      deleteRemoteHost: (id: string) => Promise<void>
      remoteDoctor: (
        hostProfileId: string,
        remotePath?: string,
        options?: RemoteDoctorOptions
      ) => Promise<RemoteDoctorReport>
      installRemoteNextflow: (hostProfileId: string) => Promise<RemoteNextflowInstallResult>
      updateProjectRemoteConnection: (
        id: string,
        connectionId: string,
        patch: PreloadProjectRemoteConnection | null
      ) => Promise<PreloadProject>
      updateProjectRemoteDefaults: (
        id: string,
        defaults: {
          defaultRemoteConnectionId?: string | null
          remoteWorkspaceRoot?: string | null
        }
      ) => Promise<PreloadProject>
      listProjectSessions: (workingDirectory: string) => Promise<PreloadSessionSummary[]>
      listProjectSessionsById: (projectId: string) => Promise<PreloadSessionSummary[]>
      createProjectSession: (
        workingDirectory: string,
        permissionMode: PreloadPermissionMode
      ) => Promise<{
        path: string | null
        phiSessionId?: string
        cwd: string
        displayCwd?: string
        projectId?: string
        projectLocation?: ProjectLocation
        sessionGeneration: number
        permissionMode: PreloadPermissionMode
      }>
      createRemoteProjectSession: (projectId: string) => Promise<{
        path: string | null
        phiSessionId?: string
        cwd: string
        displayCwd?: string
        projectId?: string
        projectLocation?: ProjectLocation
        sessionGeneration: number
        permissionMode: PreloadPermissionMode
      }>
      listAnalysisNotebooks: (cwd?: string) => Promise<PreloadAnalysisNotebookRegistry>
      initializeProjectAnalysis: (cwd: string) => Promise<PreloadAnalysisProjectInitialization>
      openAnalysisNotebook: (cwd: string, path: string) => Promise<PreloadAnalysisNotebookFile>
      saveAnalysisNotebook: (
        cwd: string,
        input: PreloadSaveAnalysisNotebookInput
      ) => Promise<PreloadAnalysisNotebookFile>
      syncAnalysisNotebookDraft: (
        cwd: string,
        path: string,
        document: Record<string, unknown>,
        savedRevision?: string
      ) => Promise<PreloadAnalysisNotebookDraftChange>
      createAnalysisNotebook: (
        cwd: string,
        relativePath?: string
      ) => Promise<PreloadAnalysisNotebookFile>
      closeAnalysisNotebook: (cwd: string, path: string) => Promise<{ path: string }>
      deleteAnalysisNotebook: (
        cwd: string,
        path: string
      ) => Promise<{ path: string; relativePath: string }>
      listAnalysisKernels: (cwd?: string) => Promise<PreloadAnalysisKernelDiagnostics>
      getAnalysisJupyterStatus: (cwd: string) => Promise<PreloadJupyterServerStatus>
      getAnalysisJupyterRuntimeStatus: (cwd: string) => Promise<PreloadAnalysisJupyterRuntimeStatus>
      startAnalysisJupyter: (cwd: string) => Promise<PreloadJupyterServerStatus>
      stopAnalysisJupyter: (cwd: string) => Promise<PreloadJupyterServerStatus>
      getAnalysisNotebookSessionStatus: (
        cwd: string,
        path: string,
        document: Record<string, unknown>
      ) => Promise<PreloadAnalysisNotebookSessionStatus>
      ensureAnalysisNotebookSession: (
        cwd: string,
        path: string,
        document: Record<string, unknown>
      ) => Promise<PreloadAnalysisNotebookSessionStatus>
      closeAnalysisNotebookSession: (
        cwd: string,
        path: string
      ) => Promise<PreloadAnalysisNotebookSessionStatus>
      interruptAnalysisNotebookExecution: (
        cwd: string,
        path: string
      ) => Promise<PreloadAnalysisNotebookSessionStatus>
      executeAnalysisNotebookCell: (
        cwd: string,
        path: string,
        document: Record<string, unknown>,
        cellId: string
      ) => Promise<PreloadAnalysisCellExecutionResult>
      completeAnalysisNotebookCell: (
        cwd: string,
        input: PreloadAnalysisNotebookCompletionInput
      ) => Promise<PreloadAnalysisNotebookCompletionResult>
      formatAnalysisNotebookCell: (
        cwd: string,
        input: PreloadAnalysisNotebookFormatInput
      ) => Promise<PreloadAnalysisNotebookFormatResult>
      generateAnalysisNotebookCode: (
        cwd: string,
        path: string,
        document: Record<string, unknown>,
        input: PreloadAnalysisNotebookCodeGenerationInput
      ) => Promise<PreloadAnalysisNotebookCodeGenerationResult>
      onAnalysisNotebookCodeGenerationProgress: (
        cb: (progress: PreloadAnalysisNotebookCodeGenerationProgress) => void
      ) => () => void
      stopGeneration: () => Promise<void>
      steerAgentRun: (
        agentSessionId: string,
        agentRunId: string,
        message: string,
        toolCallId?: string
      ) => Promise<void>
      stopAgentRun: (agentSessionId: string, agentRunId: string) => Promise<void>
      onAnalysisNotebookDraftChanged: (
        cb: (change: PreloadAnalysisNotebookDraftChange) => void
      ) => () => void
      onAnalysisNotebookFileChanged: (
        cb: (change: PreloadAnalysisNotebookFileChange) => void
      ) => () => void
      onWrapperRunsChanged: (cb: (change: { runId: string }) => void) => () => void
      onSessionChanged: (
        cb: (session: {
          path: string | null
          phiSessionId?: string
          cwd: string
          sessionGeneration: number
          permissionMode: PreloadPermissionMode
        }) => void
      ) => () => void
      onToolApprovalRequest: (cb: (event: PreloadToolApprovalRequest) => void) => () => void
      onToolApprovalCancelled: (cb: () => void) => () => void
      respondToolApproval: (requestId: string, approved: boolean) => Promise<void>
      listPlugins: () => Promise<PreloadPluginCatalogItem[]>
      installPlugin: (source: string) => Promise<PreloadPluginCatalogItem[]>
      removePlugin: (source: string) => Promise<PreloadPluginCatalogItem[]>
      listPhiPlugins: () => Promise<PhiPluginListItem[]>
      pickPhiPluginDirectory: () => Promise<string | null>
      previewPhiPluginDirectory: (path: string) => Promise<PhiPluginInstallPreview>
      installPhiPluginFromDirectory: (path: string) => Promise<PhiPluginMutationResult>
      setPhiPluginEnabled: (id: string, enabled: boolean) => Promise<PhiPluginMutationResult>
      uninstallPhiPlugin: (id: string) => Promise<PhiPluginMutationResult>
      pickPackageRegistryDirectory: () => Promise<string | null>
      pickPackageArchive: () => Promise<string | null>
      readPackageRegistry: (dir: string) => Promise<PackageRegistryView>
      listPackageRegistries: () => Promise<KnownPackageRegistryView[]>
      removePackageRegistry: (id: string) => Promise<KnownPackageRegistryView[]>
      previewPackageImport: (path: string) => Promise<OfflinePackageImportPreview>
      importPackage: (path: string) => Promise<InstalledPackageView[]>
      listPackageUpdates: () => Promise<PackageUpdateView[]>
      applyPackageUpdate: (type: PackageManagerType, id: string) => Promise<InstalledPackageView[]>
      applyAllPackageUpdates: () => Promise<InstalledPackageView[]>
      onPackageUpdatesAvailable: (cb: (updates: PackageUpdateView[]) => void) => () => void
      planPackageInstall: (
        dir: string,
        type: PackageManagerType,
        id: string,
        version?: string
      ) => Promise<PackageInstallPlanView>
      installPackage: (
        dir: string,
        type: PackageManagerType,
        id: string,
        version?: string
      ) => Promise<InstalledPackageView[]>
      uninstallPackage: (type: PackageManagerType, id: string) => Promise<InstalledPackageView[]>
      listInstalledPackages: () => Promise<InstalledPackageView[]>
      getEnablement: (projectCwd?: string) => Promise<EnablementSnapshot>
      setEnablement: (
        item: EnablementItemKey,
        value: boolean | null,
        scope: EnablementScope
      ) => Promise<EnablementSnapshot>
      listSkills: (cwd?: string) => Promise<SkillSummary[]>
      readSkillContent: (filePath: string, cwd?: string) => Promise<SkillContent>
      setSkillDisabled: (
        filePath: string,
        disabled: boolean,
        cwd?: string
      ) => Promise<SkillSummary[]>
      deleteSkill: (filePath: string, cwd?: string) => Promise<SkillSummary[]>
      listPromptAgents: (cwd?: string) => Promise<PreloadPromptAgentSummary[]>
      listMcpServers: (cwd?: string) => Promise<PreloadMcpServerSummary[]>
      listMcpConnectorCatalog: () => Promise<FeaturedMcpConnector[]>
      installMcpConnector: (
        id: string,
        version?: string,
        registryDir?: string
      ) => Promise<InstalledPackageView[]>
      uninstallMcpConnector: (id: string) => Promise<InstalledPackageView[]>
      buildMcpConnectorEnvironment: (id: string) => Promise<{ envId: string }>
      addRemoteMcpConnector: (name: string, url: string) => Promise<void>
      removeRemoteMcpConnector: (name: string, url: string) => Promise<void>
      listFeaturedMcpTools: (id: string) => Promise<string[]>
      getFeaturedMcpAuthStatus: (id: string) => Promise<boolean>
      authorizeFeaturedMcp: (id: string) => Promise<void>
      getWrapperPlan: (planId: string) => Promise<WrapperRunPlan | undefined>
      retargetWrapperPlan: (request: WrapperRetargetRequest) => Promise<WrapperRunPlan>
      submitWrapperPlan: (
        planId: string,
        heavyWorkloadAcknowledged?: boolean,
        confirmation?: WrapperSubmitConfirmation
      ) => Promise<WrapperRun>
      cancelWrapperRunPlan: (planId: string) => Promise<WrapperRunPlan>
      listWrapperCatalog: () => Promise<WrapperCatalogEntry[]>
      addCustomWrapper: (sourceDir: string) => Promise<WrapperCatalogEntry>
      listWrapperCompositionCatalog: () => Promise<WrapperCompositionCatalogItem[]>
      getWrapperCompositionDag: (id: string) => Promise<string | undefined>
      getWrapperCompositionModuleDetails: (id: string) => Promise<WrapperModuleDetails | undefined>
      listWrapperRuns: () => Promise<WrapperRun[]>
      listEnvironmentBuilds: () => Promise<EnvironmentBuild[]>
      cancelEnvironmentBuild: (envId: string) => Promise<void>
      onEnvironmentBuildsChanged: (cb: (build: EnvironmentBuild) => void) => () => void
      listAgentJobs: () => Promise<BackgroundAgentJob[]>
      getWrapperRun: (runId: string) => Promise<WrapperRun | undefined>
      cancelWrapperRun: (runId: string) => Promise<WrapperRun>
      getWrapperPlanArtifact: (planId: string, fileName: string) => Promise<string | undefined>
      exportWrapperReproducibility: (runId: string) => Promise<string | null>
    }
  }
}

export {}
