export const IPC = {
  agent: {
    event: 'agent:event',
    interactionCancelled: 'agent:interaction-cancelled',
    interactionRequested: 'agent:interaction-request',
    interactionResponse: 'agent:interaction-response',
    prompt: 'agent:prompt',
    readPromptImage: 'agent:readPromptImage',
    steerRun: 'agent:steerRun',
    stop: 'agent:stop',
    stopRun: 'agent:stopRun'
  },
  agents: {
    list: 'agents:list',
    revokeRemoteProjectTrust: 'agents:revokeRemoteProjectTrust',
    trustRemoteProject: 'agents:trustRemoteProject'
  },
  analysis: {
    closeNotebook: 'analysis:closeNotebook',
    closeNotebookSession: 'analysis:closeNotebookSession',
    completeNotebookCell: 'analysis:completeNotebookCell',
    createNotebook: 'analysis:createNotebook',
    deleteNotebook: 'analysis:deleteNotebook',
    ensureNotebookSession: 'analysis:ensureNotebookSession',
    executeNotebookCell: 'analysis:executeNotebookCell',
    formatNotebookCell: 'analysis:formatNotebookCell',
    generateNotebookCode: 'analysis:generateNotebookCode',
    initializeProject: 'analysis:initializeProject',
    interruptNotebookExecution: 'analysis:interruptNotebookExecution',
    jupyterRuntimeStatus: 'analysis:jupyterRuntimeStatus',
    listJupyterRuntimeStatuses: 'analysis:listJupyterRuntimeStatuses',
    jupyterStatus: 'analysis:jupyterStatus',
    listKernels: 'analysis:listKernels',
    listNotebookAiGenerationJobs: 'analysis:listNotebookAiGenerationJobs',
    listNotebooks: 'analysis:listNotebooks',
    notebookCodeGenerationProgress: 'analysis:notebookCodeGenerationProgress',
    notebookDraftChanged: 'analysis:notebookDraftChanged',
    notebookFileChanged: 'analysis:notebookFileChanged',
    notebookSessionStatus: 'analysis:notebookSessionStatus',
    openNotebook: 'analysis:openNotebook',
    publishNotebookOutputFrame: 'analysis:publishNotebookOutputFrame',
    refreshNotebook: 'analysis:refreshNotebook',
    releaseNotebookOutputFrame: 'analysis:releaseNotebookOutputFrame',
    saveNotebook: 'analysis:saveNotebook',
    startJupyter: 'analysis:startJupyter',
    stopJupyter: 'analysis:stopJupyter',
    syncNotebookDraft: 'analysis:syncNotebookDraft'
  },
  app: {
    checkForUpdates: 'app:checkForUpdates',
    openReleasesPage: 'app:openReleasesPage',
    openWebUrl: 'app:openWebUrl'
  },
  auth: {
    interactionRequested: 'auth:interaction',
    interactionResponse: 'auth:interaction-response',
    loginApiKey: 'auth:loginApiKey',
    loginOAuth: 'auth:loginOAuth',
    logout: 'auth:logout',
    status: 'auth:status'
  },
  browser: {
    event: 'browser:event',
    execute: 'browser:execute',
    setViewport: 'browser:setViewport',
    snapshot: 'browser:snapshot'
  },
  enablement: {
    get: 'enablement:get',
    set: 'enablement:set'
  },
  environment: {
    dismissSummary: 'environment:dismissSummary',
    get: 'environment:get',
    pickBinary: 'environment:pickBinary',
    redetect: 'environment:redetect',
    setToolPath: 'environment:setToolPath'
  },
  environmentBuilds: {
    cancel: 'environmentBuilds:cancel',
    changed: 'environmentBuilds:changed',
    list: 'environmentBuilds:list'
  },
  files: {
    deleteWorkspaceFile: 'files:deleteWorkspaceFile',
    getIcon: 'files:getIcon',
    hoverPreview: 'files:hoverPreview',
    listDirectory: 'files:listDirectory',
    openPath: 'files:openPath',
    pickInput: 'files:pickInput',
    pickLocalUpload: 'files:pickLocalUpload',
    preview: 'files:preview',
    renameWorkspaceFile: 'files:renameWorkspaceFile',
    reveal: 'files:reveal',
    saveMarkdownFile: 'files:saveMarkdownFile',
    saveTextFile: 'files:saveTextFile',
    statLocalPaths: 'files:statLocalPaths'
  },
  jobs: {
    listAgents: 'jobs:listAgents',
    listShell: 'jobs:listShell',
    stopShell: 'jobs:stopShell'
  },
  managedEnvironments: {
    build: 'managedEnvironments:build',
    clean: 'managedEnvironments:clean',
    list: 'managedEnvironments:list',
    rebuild: 'managedEnvironments:rebuild',
    remove: 'managedEnvironments:remove'
  },
  mcp: {
    addLocalConnector: 'mcp:addLocalConnector',
    addRemoteConnector: 'mcp:addRemoteConnector',
    authorizeFeatured: 'mcp:authorizeFeatured',
    authorizeRemoteConnector: 'mcp:authorizeRemoteConnector',
    buildConnectorEnvironment: 'mcp:buildConnectorEnvironment',
    cancelFeaturedAuth: 'mcp:cancelFeaturedAuth',
    cancelLocalConnectorAdd: 'mcp:cancelLocalConnectorAdd',
    cancelRemoteAuth: 'mcp:cancelRemoteAuth',
    clearFeaturedApiKey: 'mcp:clearFeaturedApiKey',
    connectorSetupChanged: 'mcp:connectorSetupChanged',
    featuredApiKeyStatus: 'mcp:featuredApiKeyStatus',
    featuredAuthStatus: 'mcp:featuredAuthStatus',
    featuredTools: 'mcp:featuredTools',
    installConnector: 'mcp:installConnector',
    listConnectorCatalog: 'mcp:listConnectorCatalog',
    listLocalConnectorJobs: 'mcp:listLocalConnectorJobs',
    listLocalRuntimes: 'mcp:listLocalRuntimes',
    listServers: 'mcp:listServers',
    removeLocalConnector: 'mcp:removeLocalConnector',
    removeRemoteConnector: 'mcp:removeRemoteConnector',
    retryLocalConnectorAdd: 'mcp:retryLocalConnectorAdd',
    revokeRemoteProjectTrust: 'mcp:revokeRemoteProjectTrust',
    setConnectorEnabled: 'mcp:setConnectorEnabled',
    setFeaturedApiKey: 'mcp:setFeaturedApiKey',
    startLocalConnectorAdd: 'mcp:startLocalConnectorAdd',
    trustRemoteProject: 'mcp:trustRemoteProject',
    uninstallConnector: 'mcp:uninstallConnector'
  },
  memory: {
    clear: 'memory:clear',
    deleteLesson: 'memory:deleteLesson',
    snapshot: 'memory:snapshot'
  },
  menuBar: {
    consumeAction: 'menu-bar:consume-action'
  },
  models: {
    availability: 'models:availability',
    setEnabled: 'models:setEnabled',
    list: 'models:list',
    select: 'models:select',
    selected: 'models:selected'
  },
  molecules: {
    renderSvg: 'molecules:renderSvg'
  },
  packages: {
    applyAllUpdates: 'packages:applyAllUpdates',
    applyUpdate: 'packages:applyUpdate',
    contentCatalog: 'packages:contentCatalog',
    import: 'packages:import',
    install: 'packages:install',
    listInstalled: 'packages:listInstalled',
    listRegistries: 'packages:listRegistries',
    listUpdates: 'packages:listUpdates',
    pickArchive: 'packages:pickArchive',
    pickRegistryDirectory: 'packages:pickRegistryDirectory',
    plan: 'packages:plan',
    previewImport: 'packages:previewImport',
    registry: 'packages:registry',
    removeRegistry: 'packages:removeRegistry',
    removeWrapper: 'packages:removeWrapper',
    resourcesChanged: 'packages:resourcesChanged',
    skillDetail: 'packages:skillDetail',
    uninstall: 'packages:uninstall',
    updatesAvailable: 'packages:updatesAvailable',
    wrapperDetail: 'packages:wrapperDetail'
  },
  persona: {
    completeOnboarding: 'persona:completeOnboarding',
    getAppName: 'persona:getAppName',
    getMarkdown: 'persona:getMarkdown',
    isOnboarded: 'persona:isOnboarded',
    setMarkdown: 'persona:setMarkdown',
    skip: 'persona:skip'
  },
  phiPlugins: {
    installFromDirectory: 'phiPlugins:installFromDirectory',
    list: 'phiPlugins:list',
    pickDirectory: 'phiPlugins:pickDirectory',
    previewDirectory: 'phiPlugins:previewDirectory',
    setEnabled: 'phiPlugins:setEnabled',
    uninstall: 'phiPlugins:uninstall'
  },
  projects: {
    create: 'projects:create',
    createRemote: 'projects:createRemote',
    delete: 'projects:delete',
    deleteRemoteHost: 'projects:deleteRemoteHost',
    list: 'projects:list',
    listOpenSshHosts: 'projects:listOpenSshHosts',
    listRemoteDirectories: 'projects:listRemoteDirectories',
    listRemoteHosts: 'projects:listRemoteHosts',
    newRemoteSession: 'projects:newRemoteSession',
    newSession: 'projects:newSession',
    pickDirectory: 'projects:pickDirectory',
    remoteConnectionChanged: 'projects:remoteConnectionChanged',
    retryRemoteConnection: 'projects:retryRemoteConnection',
    saveOpenSshHost: 'projects:saveOpenSshHost',
    saveRemoteHost: 'projects:saveRemoteHost',
    sessions: 'projects:sessions',
    sessionsById: 'projects:sessionsById',
    updateDefaults: 'projects:updateDefaults',
    updateMemory: 'projects:updateMemory',
    updatePermissionMode: 'projects:updatePermissionMode',
    updateRemoteConnection: 'projects:updateRemoteConnection',
    updateRemoteDefaults: 'projects:updateRemoteDefaults'
  },
  remote: {
    doctor: 'remote:doctor',
    listHostAvailability: 'remote:listHostAvailability',
    saveHostAvailability: 'remote:saveHostAvailability',
    installNextflow: 'remote:installNextflow',
    micromamba: 'remote:micromamba',
    micromambaProgress: 'remote:micromambaProgress',
    ripgrep: 'remote:ripgrep',
    ripgrepProgress: 'remote:ripgrepProgress',
    saveEnvironment: 'remote:saveEnvironment',
    saveMicromambaMirror: 'remote:saveMicromambaMirror',
    saveRuntimeRoot: 'remote:saveRuntimeRoot'
  },
  remoteJupyterJobs: {
    changed: 'remoteJupyterJobs:changed',
    list: 'remoteJupyterJobs:list'
  },
  remoteProjectUploads: {
    cancel: 'remoteProjectUploads:cancel',
    changed: 'remoteProjectUploads:changed',
    list: 'remoteProjectUploads:list',
    prepare: 'remoteProjectUploads:prepare',
    retry: 'remoteProjectUploads:retry',
    start: 'remoteProjectUploads:start'
  },
  remoteWorkspace: {
    download: 'remoteWorkspace:download',
    listDirectory: 'remoteWorkspace:listDirectory',
    preview: 'remoteWorkspace:preview',
    statPaths: 'remoteWorkspace:statPaths'
  },
  resources: {
    readIcon: 'resources:readIcon'
  },
  sessions: {
    acknowledge: 'sessions:acknowledge',
    autoCompactionSettings: 'sessions:autoCompactionSettings',
    autoCompactionSettingsSet: 'sessions:autoCompactionSettings:set',
    changed: 'sessions:changed',
    compact: 'sessions:compact',
    contextUsage: 'sessions:contextUsage',
    continueRuntimeSummary: 'sessions:continueRuntimeSummary',
    create: 'sessions:create',
    current: 'sessions:current',
    delete: 'sessions:delete',
    export: 'sessions:export',
    fork: 'sessions:fork',
    generateTitle: 'sessions:generateTitle',
    homeActivity: 'sessions:homeActivity',
    list: 'sessions:list',
    rename: 'sessions:rename',
    resumeRuntime: 'sessions:resumeRuntime',
    runtimeRecovery: 'sessions:runtimeRecovery',
    switch: 'sessions:switch',
    updatePermissionMode: 'sessions:updatePermissionMode'
  },
  settings: {
    get: 'settings:get',
    update: 'settings:update',
    webSearchApiKeyClear: 'settings:webSearch:apiKey:clear',
    webSearchApiKeySet: 'settings:webSearch:apiKey:set',
    webSearchGet: 'settings:webSearch:get',
    webSearchSearxngEngines: 'settings:webSearch:searxngEngines',
    webSearchUpdate: 'settings:webSearch:update'
  },
  skills: {
    delete: 'skills:delete',
    list: 'skills:list',
    read: 'skills:read',
    revokeRemoteProjectTrust: 'skills:revokeRemoteProjectTrust',
    setDisabled: 'skills:setDisabled',
    trustRemoteProject: 'skills:trustRemoteProject'
  },
  sources: {
    addGithub: 'sources:addGithub',
    applyGithubUpdate: 'sources:applyGithubUpdate',
    checkGithubUpdate: 'sources:checkGithubUpdate',
    listGithub: 'sources:listGithub',
    previewGithub: 'sources:previewGithub',
    removeGithub: 'sources:removeGithub'
  },
  sshBootstrap: {
    cancel: 'sshBootstrap:cancel',
    completeWithKeyProtection: 'sshBootstrap:completeWithKeyProtection',
    confirmHostKey: 'sshBootstrap:confirmHostKey',
    declineConfig: 'sshBootstrap:declineConfig',
    inspectTarget: 'sshBootstrap:inspectTarget',
    saveConfig: 'sshBootstrap:saveConfig',
    verifyPassword: 'sshBootstrap:verifyPassword'
  },
  system: {
    ping: 'ping'
  },
  terminal: {
    ack: 'terminal:ack',
    attach: 'terminal:attach',
    cancelDraft: 'terminal:cancelDraft',
    close: 'terminal:close',
    create: 'terminal:create',
    event: 'terminal:event',
    generateDraft: 'terminal:generateDraft',
    input: 'terminal:input',
    list: 'terminal:list',
    resize: 'terminal:resize',
    submitDraft: 'terminal:submitDraft'
  },
  thinking: {
    select: 'thinking:select',
    selected: 'thinking:selected'
  },
  tool: {
    approvalCancelled: 'tool:approval-cancelled',
    approvalRequested: 'tool:approval-request',
    approvalResponse: 'tool:approval-response'
  },
  webLink: {
    preview: 'web-link:preview'
  },
  window: {
    close: 'window:close',
    fullscreenChanged: 'window:fullscreen-changed',
    getFullscreen: 'window:get-fullscreen',
    minimize: 'window:minimize',
    rendererReady: 'window:renderer-ready',
    toggleFullscreen: 'window:toggle-fullscreen'
  },
  workspaceChanges: {
    readDiff: 'workspaceChanges:readDiff'
  },
  wrapperResults: {
    cancelDownload: 'wrapperResults:cancelDownload',
    cancelRead: 'wrapperResults:cancelRead',
    download: 'wrapperResults:download',
    downloadProgress: 'wrapperResults:downloadProgress',
    listDirectory: 'wrapperResults:listDirectory',
    preview: 'wrapperResults:preview',
    readRange: 'wrapperResults:readRange'
  },
  wrappers: {
    addCustom: 'wrappers:addCustom',
    cancelPlan: 'wrappers:cancelPlan',
    cancelRun: 'wrappers:cancelRun',
    completeInputUpload: 'wrappers:completeInputUpload',
    exportReproducibility: 'wrappers:exportReproducibility',
    getCompositionDag: 'wrappers:getCompositionDag',
    getCompositionModuleDetails: 'wrappers:getCompositionModuleDetails',
    getPlan: 'wrappers:getPlan',
    getPlanArtifact: 'wrappers:getPlanArtifact',
    getRun: 'wrappers:getRun',
    listCatalog: 'wrappers:listCatalog',
    listCompositionCatalog: 'wrappers:listCompositionCatalog',
    listRuns: 'wrappers:listRuns',
    retargetPlan: 'wrappers:retargetPlan',
    runsChanged: 'wrappers:runsChanged',
    submitPlan: 'wrappers:submitPlan'
  }
} as const

export type IpcChannel = {
  [Domain in keyof typeof IPC]: (typeof IPC)[Domain][keyof (typeof IPC)[Domain]]
}[keyof typeof IPC]

export const ALL_IPC_CHANNELS: readonly IpcChannel[] = Object.values(IPC).flatMap((domain) =>
  Object.values(domain)
)
