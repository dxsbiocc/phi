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
  createdAt: string
}

type PreloadToolApprovalRequest = {
  requestId: string
  sessionId?: string
  sessionPath?: string
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

type PreloadMcpServerSummary = {
  id: string
  name: string
  command?: string
  args?: string[]
  envKeys?: string[]
  sourcePath?: string
  status: 'configured'
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

declare global {
  interface Window {
    platform: NodeJS.Platform
    api: {
      closeWindow: () => Promise<void>
      minimizeWindow: () => Promise<void>
      toggleWindowFullscreen: () => Promise<void>
      revealPath: (path: string) => Promise<void>
      copyDiagnostics: () => Promise<string>
      sendPrompt: (text: string) => Promise<string | null>
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
        cwd: string
        sessionGeneration: number
        permissionMode: PreloadPermissionMode
        messages?: unknown[]
      }>
      updateCurrentSessionPermissionMode: (permissionMode: PreloadPermissionMode) => Promise<{
        path: string | null
        cwd: string
        sessionGeneration: number
        permissionMode: PreloadPermissionMode
      }>
      createSession: () => Promise<{
        path: string | null
        cwd: string
        sessionGeneration: number
        permissionMode: PreloadPermissionMode
      }>
      switchSession: (path: string) => Promise<{
        path: string
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
      listProjectSessions: (workingDirectory: string) => Promise<PreloadSessionSummary[]>
      createProjectSession: (
        workingDirectory: string,
        permissionMode: PreloadPermissionMode
      ) => Promise<{
        path: string | null
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
      createAnalysisNotebook: (
        cwd: string,
        relativePath?: string
      ) => Promise<PreloadAnalysisNotebookFile>
      closeAnalysisNotebook: (cwd: string, path: string) => Promise<{ path: string }>
      listAnalysisKernels: (cwd?: string) => Promise<PreloadAnalysisKernelDiagnostics>
      stopGeneration: () => Promise<void>
      onSessionChanged: (
        cb: (session: {
          path: string | null
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
      listMcpServers: (cwd?: string) => Promise<PreloadMcpServerSummary[]>
    }
  }
}

export {}
