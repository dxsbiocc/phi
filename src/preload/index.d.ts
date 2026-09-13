// Imported (unlike the other ambient types in this file, which are
// hand-duplicated) — see the matching comment in preload/index.ts.
import type { WrapperCatalogEntry } from '../shared/wrapperCatalogTypes'
import type { WrapperRun, WrapperRunPlan } from '../shared/wrapperTypes'

type PreloadSessionSummary = {
  path: string
  id: string
  name?: string
  created: string
  modified: string
  messageCount: number
  firstMessage: string
  phiSessionId?: string
  status: 'idle' | 'running' | 'needs_approval' | 'failed' | 'completed_unread'
  unreadKind: 'completed' | 'failed' | 'approval' | null
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
  host: string
  port?: number
  username: string
  privateKeyPath: string
  hasPassphrase?: boolean
}

type PreloadProject = {
  id: string
  name: string
  workingDirectory: string
  permissionMode: PreloadPermissionMode
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

type PreloadSkillSummary = {
  id: string
  name: string
  description: string
  filePath: string
  source: string
  scope: 'user' | 'project' | 'temporary'
  disabled: boolean
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
  command?: string
  args?: string[]
  envKeys?: string[]
  sourcePath?: string
  status: 'configured'
}

type PreloadFilePreview = {
  path: string
  name: string
  displayPath: string
  rootPath: string
  rootLabel: string
  kind: 'text' | 'image' | 'pdf'
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
      kind: 'image'
      mimeType: 'image/png'
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

type PreloadAnalysisNotebookCodeGenerationInput = {
  prompt: string
  language: string
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

declare global {
  interface Window {
    platform: NodeJS.Platform
    api: {
      closeWindow: () => Promise<void>
      minimizeWindow: () => Promise<void>
      toggleWindowFullscreen: () => Promise<void>
      revealPath: (path: string) => Promise<void>
      openPath: (path: string) => Promise<void>
      pickInputFiles: () => Promise<string[]>
      previewFile: (path: string) => Promise<PreloadFilePreview>
      hoverPreviewFile: (path: string) => Promise<PreloadFileHoverPreview>
      statLocalPaths: (cwd: string, paths: string[]) => Promise<PreloadLocalPathStat[]>
      listDirectory: (path: string) => Promise<PreloadDirectoryListing>
      copyDiagnostics: () => Promise<string>
      sendPrompt: (
        text: string,
        target?: PreloadPromptTarget
      ) => Promise<PreloadPromptResult | null>
      onAgentEvent: (cb: (event: Record<string, unknown>) => void) => () => void
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
        sessionGeneration: number
        permissionMode: PreloadPermissionMode
        messages?: unknown[]
      }>
      updateCurrentSessionPermissionMode: (permissionMode: PreloadPermissionMode) => Promise<{
        path: string | null
        phiSessionId?: string
        cwd: string
        sessionGeneration: number
        permissionMode: PreloadPermissionMode
      }>
      createSession: () => Promise<{
        path: string | null
        phiSessionId?: string
        cwd: string
        sessionGeneration: number
        permissionMode: PreloadPermissionMode
      }>
      switchSession: (path: string) => Promise<{
        path: string
        phiSessionId?: string
        cwd: string
        sessionGeneration: number
        permissionMode: PreloadPermissionMode
        messages: unknown[]
      } | null>
      acknowledgeSession: (path: string) => Promise<PreloadSessionSummary | null>
      deleteSession: (path: string) => Promise<void>
      renameSession: (path: string, name: string) => Promise<void>
      listProjects: () => Promise<PreloadProject[]>
      pickProjectDirectory: () => Promise<string | null>
      createProject: (
        name: string,
        workingDirectory: string,
        permissionMode: PreloadPermissionMode
      ) => Promise<PreloadProject>
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
      pickPrivateKeyFile: () => Promise<string | null>
      isRemoteCredentialStorageAvailable: () => Promise<boolean>
      /**
       * `patch: null` removes the connection. `passphrase` is write-only and
       * never round-trips back through `PreloadProject` — pass `undefined` to
       * leave a previously-stored passphrase untouched, a string to
       * store/rotate it, or `null` to clear it (e.g. the user switched the
       * key to passphrase-less).
       */
      updateProjectRemoteConnection: (
        id: string,
        connectionId: string,
        patch: PreloadProjectRemoteConnection | null,
        passphrase?: string | null
      ) => Promise<PreloadProject>
      updateProjectRemoteDefaults: (
        id: string,
        defaults: {
          defaultRemoteConnectionId?: string | null
          remoteWorkspaceRoot?: string | null
        }
      ) => Promise<PreloadProject>
      listProjectSessions: (workingDirectory: string) => Promise<PreloadSessionSummary[]>
      createProjectSession: (
        workingDirectory: string,
        permissionMode: PreloadPermissionMode
      ) => Promise<{
        path: string | null
        phiSessionId?: string
        cwd: string
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
      executeAnalysisNotebookCell: (
        cwd: string,
        path: string,
        document: Record<string, unknown>,
        cellId: string
      ) => Promise<PreloadAnalysisCellExecutionResult>
      generateAnalysisNotebookCode: (
        cwd: string,
        path: string,
        document: Record<string, unknown>,
        input: PreloadAnalysisNotebookCodeGenerationInput
      ) => Promise<PreloadAnalysisNotebookCodeGenerationResult>
      stopGeneration: () => Promise<void>
      onAnalysisNotebookDraftChanged: (
        cb: (change: PreloadAnalysisNotebookDraftChange) => void
      ) => () => void
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
      listSkills: (cwd?: string) => Promise<PreloadSkillSummary[]>
      listPromptAgents: (cwd?: string) => Promise<PreloadPromptAgentSummary[]>
      listMcpServers: (cwd?: string) => Promise<PreloadMcpServerSummary[]>
      getWrapperPlan: (planId: string) => Promise<WrapperRunPlan | undefined>
      submitWrapperPlan: (
        planId: string,
        heavyWorkloadAcknowledged?: boolean
      ) => Promise<WrapperRun>
      cancelWrapperRunPlan: (planId: string) => Promise<WrapperRunPlan>
      listWrapperCatalog: () => Promise<WrapperCatalogEntry[]>
      addCustomWrapper: (sourceDir: string) => Promise<WrapperCatalogEntry>
      listWrapperRuns: () => Promise<WrapperRun[]>
      getWrapperRun: (runId: string) => Promise<WrapperRun | undefined>
      cancelWrapperRun: (runId: string) => Promise<WrapperRun>
      getWrapperPlanArtifact: (planId: string, fileName: string) => Promise<string | undefined>
      exportWrapperReproducibility: (runId: string) => Promise<string | null>
    }
  }
}

export {}
