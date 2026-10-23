import { IPC } from '../shared/ipcChannels'
import { browserPresentationSessionId } from '../shared/browserSessionScope'
import { registerRuntimeSessionOrigin } from './agent/session/runtime-origin-store'
import type { AgentRunFinishedEvent } from '../shared/agentRunNotice'
import { readRuntimeRecoverySummarySeed } from './agent/session/recovery-summary'
import { facadeBindingHash } from './agent/engine/rpc/facade-session-driver'
import { selectionThinking } from './agent/engine/rpc/runtime-selection-control'
import { isPhiEventType, isPhiMessageUpdateSummary } from './agent/engine/events'
import type { WrapperRunFinishedEvent } from '../shared/wrapperRunNotice'
import { shouldBlockHtmlReportNavigation } from '../shared/htmlReportPreview'
import {
  installNotebookOutputProtocol,
  registerNotebookOutputScheme
} from './agent/notebook/notebook-output-protocol'
import type { WrapperRun } from '../shared/wrapperTypes'
import './agent-env'
import { createMainWindowStartup } from './window-startup'
import { migrateStartupPluginEnablement as migratePluginEnablement } from './startup-plugin-enablement'
import { registerWorkspaceFileIpc } from './workspace-file-ipc'
import { registerAnalysisIpc } from './ipc/analysis-ipc'
import { registerGithubSourceIpc } from './ipc/github-sources-ipc'
import {
  registerPackageCatalogIpc,
  registerPackageOperationsIpc,
  registerResourceCatalogIpc
} from './ipc/packages-ipc'
import { registerPhiPluginIpc } from './ipc/phi-plugins-ipc'
import { registerSkillsIpc } from './ipc/skills-ipc'
import { registerMcpIpc, type PendingCustomMcpAuthorization } from './ipc/mcp-ipc'
import { registerEnvironmentBuildsIpc } from './ipc/environment-builds-ipc'
import { registerJobsIpc } from './ipc/jobs-ipc'
import {
  registerWrapperInputUploadIpc,
  registerWrapperPlanIpc,
  registerWrapperRunIpc
} from './ipc/wrappers-ipc'
import { registerWrapperResultsIpc, type WrapperResultDownloads } from './ipc/wrapper-results-ipc'
import {
  registerRemoteProjectUploadControlIpc,
  registerRemoteProjectUploadListIpc,
  registerRemoteProjectUploadPreparationIpc
} from './ipc/remote-project-uploads-ipc'
import { registerRemoteWorkspaceIpc } from './ipc/remote-workspace-ipc'
import { registerRemoteIpc } from './ipc/remote-ipc'
import { registerMemoryIpc } from './ipc/memory-ipc'
import {
  registerAgentInteractionIpc,
  registerAgentPromptIpc,
  registerAgentRunControlIpc,
  type AgentIpcOptions
} from './ipc/agent-ipc'
import { registerAgentsIpc } from './ipc/agents-ipc'
import { registerModelsIpc } from './ipc/models-ipc'
import { registerThinkingIpc } from './ipc/thinking-ipc'
import { registerToolIpc } from './ipc/tool-ipc'
import { registerSessionsIpc } from './ipc/sessions-ipc'
import { registerSystemIpc } from './ipc/system-ipc'
import { registerWindowIpc } from './ipc/window-ipc'
import { registerMenuBarIpc } from './ipc/menu-bar-ipc'
import {
  registerFileBrowsingIpc,
  registerFileOpenIpc,
  registerFilePickerIpc,
  registerFilePreviewIpc,
  type FilesIpcOptions
} from './ipc/files-ipc'
import { registerWebLinkIpc } from './ipc/web-link-ipc'
import { registerRemoteJupyterJobsIpc } from './ipc/remote-jupyter-jobs-ipc'
import { registerMoleculesIpc } from './ipc/molecules-ipc'
import { registerWorkspaceChangesIpc } from './ipc/workspace-changes-ipc'
import { registerAuthIpc } from './ipc/auth-ipc'
import { registerAppIpc } from './ipc/app-ipc'
import { registerSettingsIpc } from './ipc/settings-ipc'
import { registerEnvironmentIpc } from './ipc/environment-ipc'
import { registerManagedEnvironmentsIpc } from './ipc/managed-environments-ipc'
import { registerPersonaIpc } from './ipc/persona-ipc'
import {
  registerProjectsIpc,
  registerProjectsRemoteHostsIpc,
  registerProjectsSessionsIpc,
  type ProjectsIpcOptions
} from './ipc/projects-ipc'
import { nativeUiCopy } from './native-ui-copy'
import { createStartupSplashWindow, dismissStartupSplashWindow } from './startup-splash'
import { createMacMenuBar } from './menu-bar'
import type { MenuBarAction } from '../shared/menuBarTypes'
import type { IpcMainInvokeEvent } from 'electron'
import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync, statSync } from 'node:fs'
import {
  app,
  shell,
  BrowserWindow,
  WebContentsView,
  dialog,
  ipcMain,
  nativeImage,
  net,
  Notification,
  powerSaveBlocker
} from 'electron'
import {
  BrowserIpcCoordinator,
  registerBrowserRendererIpc,
  routeBrowserAppShellWindowOpen,
  type BrowserIpcSession
} from './browser/browser-ipc'
import { FileSystemBrowserCheckpointStore } from './browser/browser-checkpoints'
import { browserPolicyContext } from './browser/browser-policy'
import { ElectronBrowserEngine } from './browser/electron-browser-engine'
import { BrowserWorkspaceRegistry } from './browser/browser-workspace-registry'
import type { BrowserActionApprovalPrompt } from './browser/browser-approval'
import { BrowserToolHostCoordinator } from './agent/browser/browser-tool-host'
import { TerminalIpcCoordinator, registerTerminalRendererIpc } from './terminal/terminal-ipc'
import { TerminalDraftService } from './terminal/terminal-command-draft'
import { buildTerminalDraftSessionFactory } from './terminal/terminal-draft-session'
import { TerminalManager } from './terminal/terminal-manager'
import { resolveTerminalWorkspace } from './terminal/terminal-workspace'
import { dirname, join, resolve } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { createAgentSession } from './agent/session/session-manager'
import type { ThinkingLevel } from './agent/runtime/model-thinking-levels'
import {
  alignCurrentSessionToPromptTarget,
  parsePromptTarget,
  type PromptTargetControlOptions
} from './agent/session/prompt-target-control'
import {
  getCurrentContextUsage,
  getCurrentSessionPayloadWithMessages,
  type CurrentContextUsageOptions,
  type CurrentSessionPayloadMessagesOptions
} from './agent/session/current-session-reads'
import {
  compactCurrentSession,
  getCurrentAutoCompactionSettings,
  setCurrentAutoCompactionSettings,
  type SessionCompactionControlOptions
} from './agent/session/session-compaction-control'
import {
  assistantErrorMessageFromEventSummary,
  extractAssistantMessageText,
  extractMessageText,
  lastAssistantMessageFrom,
  redactStructuredValue
} from './agent/session/message-text'
import { getAuthManager } from './agent/auth-manager'
import { getPersonaMarkdown } from './agent/persona-manager'
import { generatePersonaMarkdown as generatePersonaMarkdownForIpc } from './agent/persona-generation'
import {
  createSessionManager,
  phiOnlySessionPath,
  phiSessionIdFromPath,
  renameSession
} from './agent/session/sessions'
import {
  getProject,
  requireProject,
  getProjectByCwd,
  subscribeRemoteProjectConnection,
  type ModelSelection
} from './agent/projects'
import { getRemoteHostProfile, remoteConnectionConfigForProfile } from './agent/remote-hosts'
import { createDefaultSshBootstrapCoordinator } from './agent/ssh-bootstrap/default-coordinator'
import { registerSshBootstrapIpc } from './agent/ssh-bootstrap/ipc'
import { registerRemoteMicromambaIpc } from './agent/remote-micromamba-ipc'
import { registerRemoteRipgrepIpc } from './agent/remote-ripgrep-ipc'
import { remoteMicromambaManifestVersion } from './agent/remote-micromamba-artifact'
import { readHostRemoteEnvironmentPaths } from './agent/remote-environment-store'
import {
  RemoteRuntimeController,
  controlRemoteRuntimeWorkspace
} from './agent/remote-runtime/controller'
import { createAppRemoteAgentResources } from './agent/remote-runtime/app-remote-agent-resources'
import { createAppRemoteAgentEnvironment } from './agent/remote-runtime/app-remote-agent-environment'
import { createAppRemotePromptContext } from './agent/remote-runtime/app-remote-prompt-context'
import { createAppRemoteDesktopTools } from './agent/remote-runtime/app-remote-desktop-tools'
import { createRemoteRuntimeDispatchControl } from './agent/remote-runtime/remote-runtime-dispatch-control'
import { createProjectRuntimeRootContext } from './agent/remote-runtime/project-runtime-root-context'
import { createRemoteProjectContext } from './agent/remote-runtime/remote-project-context'
import {
  createRemoteProjectRequests,
  remoteRequestProjectId
} from './agent/remote-runtime/remote-project-requests'
import { createRemoteProjectSkills } from './agent/remote-runtime/remote-project-skills'
import { createDesktopWebSearchAdapter } from './agent/engine/rpc/desktop-websearch-adapter'
import { createSkippedMcpNotifier } from './agent/mcp/skipped-notice'
import { createDesktopMcpAdapter } from './agent/engine/rpc/desktop-mcp-adapter'
import { RemoteLibraryService } from './agent/engine/rpc/remote-library-service'
import { resolveRemoteBaseEnvironment } from './agent/remote-runtime/base-environment'
import {
  openRemoteRuntimeWorkspace,
  type RemoteRuntimeTarget
} from './agent/remote-runtime/workspace'
import { remoteDoctor } from './agent/remote-doctor'
import { createCursorH2Bridge } from './agent/cursor-h2-bridge'
import { RemoteProjectConnectionTracker } from './agent/remote-project-connection'
import { RemoteProjectUploadService } from './agent/remote-project-upload'
import { remoteTransferHostKey } from './agent/transfer'
import { loadRemoteProjectInstructions } from './agent/remote-project-instructions'
import { resolveRemoteRuntimePromptContext } from './agent/remote-runtime-context'
import {
  createDesktopProjectMemoryAdapter,
  retireDesktopProjectMemoryAdapters
} from './agent/engine/rpc/desktop-project-memory-adapter'
import {
  resolveAuthorizedRemoteConnectionConfig,
  resolveRemoteWorkspaceHostBinding
} from './agent/remote-workspace-boundary'
import { RemoteProjectDownloadManager } from './agent/download/remote-project-download'
import {
  ensureRemoteProjectAnchor,
  isRemoteProjectAnchorPath,
  remoteProjectAnchorPath
} from './agent/remote-project-anchor'
import {
  cancelToolApprovals,
  requestToolApproval,
  requestRuntimeToolApproval,
  resolveToolApproval
} from './agent/tool-approval'
import { createEnvironmentBuilds } from './agent/content/environment-builds'
import { buildEnvironment } from './agent/content/environment-refs'
import { bindAgentSession } from './agent/content/environment-gate'
import { createSkillHost } from './agent/content/skill-host'
import {
  loadRemoteProjectSkillCatalog,
  readRemoteProjectSkillContent
} from './agent/content/remote-project-skill-service'
import { loadRemoteProjectMcpCatalog } from './agent/mcp/remote-project-mcp-service'
import { getRuntimeRoot } from './agent/envs/runtime'
import { capabilityApprovalSummary } from './agent/packages/capability-approval'
import { createCapabilityHost } from './agent/packages/capability-host'
import { createCapabilityService } from './agent/packages/capability-service'
import { createExternalSkillService } from './agent/packages/external-skills'
import { searchOfficialCatalog } from './agent/packages/official-catalog-api'
import {
  confirmedEnvironmentBuild,
  environmentBuildQuestion
} from './agent/content/environment-build-prompt'
import { confirmedEnvironmentRequest, requestProjectEnvironment } from './agent/content/env-request'
import {
  canRequestAgentUserInteraction,
  cancelAgentUserInteractions,
  resolveAgentUserInteraction,
  waitForAgentUserInteraction
} from './agent/user-interaction'
import { createAgentInteractionRequest } from './agent/host-requests/agent-interaction-request'
import { createDeliverablesPresentation } from './agent/host-requests/deliverables-presentation'
import { createHostConfirmations } from './agent/host-requests/host-confirmations'
import { createPlanReviewRequest } from './agent/host-requests/plan-review-request'
import {
  createInMemoryRuntimeSessionManager,
  getBundledAgentsDir,
  openRuntimeSessionManager,
  type ModelRuntime,
  type RuntimeModel
} from './agent/runtime/runtime-adapter'
import {
  resolveRuntimeModelSelection,
  selectableRuntimeModels
} from './agent/runtime/runtime-model-selection'
import { loadedPlugins } from './agent/plugins/loader'
import { createInstalledPluginNamespace } from './agent/plugins/installed-plugin-namespace'
import { migrateEnablementFromHistory } from './agent/enablement'
import { cleanupStalePackageStaging } from './agent/packages/installer'
import {
  createContentPackageRuntime,
  packageUpdateViews
} from './agent/packages/content-package-runtime'
import { prepareContentPackageInstall } from './agent/packages/content-source'
import {
  listConnectorCatalog,
  mcpOAuthAuthorizationOrigin,
  readCustomRemoteMcpConnector
} from './agent/mcp-connectors'
import {
  apiKeyConnector,
  isFeaturedMcpApiKeyInstalled,
  readFeaturedMcpApiKey
} from './agent/mcp-key-credentials'
import {
  listGlobalMcpServers,
  listGlobalSkills,
  listSkills,
  readGlobalSkillContent
} from './agent/resources'
import { migrateLegacyCustomWrappers, startLegacyBundledCleanup } from './agent/wrappers/catalog'
import { resetWrapperCompositionCatalogCache } from './agent/wrappers/composition/discovery'
import { wrapperJobHostHandlers } from './agent/wrappers/composition/job-host-handlers'
import { resolveWrapperJobHostScope } from './agent/wrappers/composition/job-host-scope'
import { shouldContinueConversation } from './agent/wrappers/composition/job-continue'
import { deliverWrapperRunFinished } from './agent/wrappers/composition/job-notify'
import { WrapperJobManager } from './agent/wrappers/composition/job-manager'
import { markInterruptedCompositionRuns } from './agent/wrappers/composition/run-record'
import { resolveProjectRemoteTarget } from './agent/wrappers/remote-connection-resolver'
import { reconcileRemoteWrapperRuns } from './agent/wrappers/executor-slurm-reconcile'
import { createWrapperResultReadControl } from './agent/wrappers/remote-result-read-control'
import { loadRemoteAgentCatalog } from './agent/agents/remote-agent-service'
import { BackgroundAgentApprovalTracker } from './agent/agents/background-approval'
import {
  createSessionCreationApprovalDependencies,
  createSessionCreationExtensionFactories
} from './agent/session/session-creation-approvals'
import {
  continuationPrompt,
  shouldContinueAfterAgentRun,
  type ContinuationEvent
} from './agent/agents/run-continue'
import { agentRunHostHandlers } from './agent/agents/run-host'
import { customMcpAuthUrl } from './agent/mcp/custom-auth-url'
import { agentRunCompletions } from './agent/plan/execution/agent-run-completions'
import { connectRemoteSshSession } from './agent/wrappers/remote-ssh-session'
import { readWrapperRun } from './agent/wrappers/store'
import { listBackgroundAgentJobs } from './agent/jobs/background-agent-job-listing'
import {
  listBackgroundShellJobs,
  stopBackgroundShellJob
} from './agent/jobs/background-shell-job-operations'
import { cleanupOldLogs, writeAppLog } from './agent/app-logger'
import {
  configureSystemUiLanguage,
  readAppSettings,
  readLastSelectedModel,
  writeLastSelectedModel
} from './agent/app-settings'
import { redactSensitiveText } from './agent/redaction'
import { listProjectNotebooks } from './agent/notebook/analysis-notebooks'
import { AnalysisNotebookFileWatcher } from './agent/notebook/analysis-notebook-watch'
import { getCustomToolPath } from './agent/environment'
import { createBackgroundEnvironment } from './agent/environment/background'
import { JupyterServerRegistry } from './agent/notebook/analysis-jupyter-server'
import { AnalysisNotebookExecutor } from './agent/notebook/analysis-jupyter-execution'
import { AnalysisNotebookSessionRegistry } from './agent/notebook/analysis-jupyter-sessions'
import { AnalysisNotebookToolExecutor } from './agent/notebook/notebook-tool-executor'
import { createAnalysisWorkspaceResolution } from './agent/notebook/analysis-workspace-resolution'
import { createNotebookServerReadiness } from './agent/notebook/notebook-server-readiness'
import { createRemoteNotebookRuntime } from './agent/notebook/remote-notebook-runtime'
import { AnalysisNotebookOperations } from './agent/notebook/analysis-notebook-operations'
import { AnalysisNotebookCodeGenerator } from './agent/notebook/analysis-notebook-code-generator'
import { NotebookToolHostRouter } from './agent/notebook/notebook-tool-host-router'
import { getPhiEngine, ownsRemoteRuntimeSession } from './agent/engine/in-process-engine'
import {
  installAppRemoteSessionRouting,
  createAppRemoteSessionManager
} from './agent/remote-session-routing'
import { RemoteJupyterStartJobs } from './agent/notebook/remote-jupyter-start-jobs'
import { normalizeProjectMemorySettings } from '../shared/projectMemoryTypes'
import { validatePresentedFiles } from './agent/deliverables/present-files'
import { validateRemotePresentedFiles } from './agent/deliverables/remote-present-files'
import { type SessionSnapshot } from './agent/session/session-lifecycle'
import { SessionRunnerRegistry } from './agent/session/session-runner-registry'
import {
  executePromptRun as executePromptRunWithDeps,
  type PromptRunExecutionDeps
} from './agent/session/prompt-run-execution'
import { createLocalFileAccessControl } from './local-file-access-control'
import { createLocalFileIcons } from './local-file-icons'
import { createLocalFilePreviews } from './local-file-previews'
import { SessionTitleGenerator } from './agent/session/session-title-generation'
import { persistPromptImages } from './agent/session/prompt-images'
import {
  appendSessionEvent,
  createRunId,
  findPhiSessionById,
  findPhiSessionByRuntimePath,
  persistToolOutput,
  readSessionEvents,
  recoverInterruptedPhiSessions,
  updateSessionManifest,
  type PhiSessionManifest,
  type StoredSessionEvent
} from './agent/session/session-store'
import type { NotebookDocument } from '../shared/notebookDocument'
import { messageContentTitleText } from '../shared/sessionTitle'
import { createBeforeQuitHandler } from './app-quit'
import { createMainRuntimeContext } from './app-state/main-runtime-context'
import { createSessionKeyLinking } from './session-runtime/session-key-linking'
import { createSessionOrigins } from './session-runtime/session-origins'
import { createSessionResolution } from './session-runtime/session-resolution'
import { createCurrentSessionPayload } from './session-runtime/current-session-payload'
import { createSessionSwitching } from './session-runtime/session-switching'
import { createSessionCleanup } from './session-runtime/session-cleanup'
import { createCreatedSessionEvents } from './session-runtime/created-session-events'
import { createAgentSessionCreation } from './session-runtime/agent-session-creation'
import { createSessionControlTarget } from './session-runtime/session-control-target'
import { createPromptRunStop } from './session-runtime/prompt-run-stop'
import { createPromptRunAdmission } from './session-runtime/prompt-run-admission'
import {
  createPromptRunStart,
  type PromptRunContext,
  type PromptRunState as PromptRun
} from './session-runtime/prompt-run-start'
import { createPromptRunQueue } from './session-runtime/prompt-run-queue'
import icon from '../../resources/icon.png?asset'

import { isRecord } from '../shared/guards'
import { errorMessage } from '../shared/errorCodes'
// Compatibility boundary: Electron derives userData and macOS "Phi Safe Storage" from this name.
const APP_NAME = 'Phi'
const APP_QUIT_CLEANUP_TIMEOUT_MS = 2_000
const APP_ID = 'cn.phiscience.phi'
const DEFAULT_WINDOW_WIDTH = 1280
const DEFAULT_WINDOW_HEIGHT = 820
const MIN_WINDOW_WIDTH = 860
const MIN_WINDOW_HEIGHT = 560
const appIcon = nativeImage.createFromPath(icon)

// Set by agent-env.ts before this module's own top-level code runs.
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR as string

app.setName(APP_NAME)

function applyDockIcon(): void {
  if (process.platform === 'darwin' && !appIcon.isEmpty()) {
    app.dock?.setIcon(appIcon)
  }
}

const mainWindowStartups = new WeakMap<BrowserWindow, ReturnType<typeof createMainWindowStartup>>()

function showMainWindowFromMenuBar(): void {
  const mainWindow = runtime.window.mainWindow
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  const window = runtime.window.mainWindow
  if (!window || window.isDestroyed()) return
  const splash = runtime.window.startupSplashWindow
  if (splash && !splash.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  if (!window.isVisible()) window.show()
  window.focus()
}

function queueMenuBarAction(action: MenuBarAction): void {
  runtime.window.queueMenuBarAction(action)
  showMainWindowFromMenuBar()
}

function hideMainWindowFromMenuBar(): void {
  const mainWindow = runtime.window.mainWindow
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) mainWindow.hide()
}

function requireMainWindowRenderer(event: IpcMainInvokeEvent): BrowserWindow {
  const window = runtime.window.mainWindow
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.sender.isDestroyed() ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error('Window renderer is not authorized')
  }
  return window
}

function finishStartupSplash(window: BrowserWindow | null): void {
  const splash = runtime.window.takeStartupSplashWindow()
  if (!window) {
    if (splash && !splash.isDestroyed()) splash.close()
    return
  }
  dismissStartupSplashWindow(splash, window)
}

function sendMainWindowFullscreenState(window: BrowserWindow, fullscreen: boolean): void {
  if (
    runtime.window.mainWindow !== window ||
    window.isDestroyed() ||
    window.webContents.isDestroyed()
  ) {
    return
  }
  window.webContents.send(IPC.window.fullscreenChanged, fullscreen)
}
const browserCheckpointStore = new FileSystemBrowserCheckpointStore({ agentDir: AGENT_DIR })

function getBrowserWorkspaceRegistry(): BrowserWorkspaceRegistry {
  if (
    runtime.window.cleanupStarted ||
    runtime.workspaceServices.browserWorkspaceRegistryLifecycle !== 'idle'
  ) {
    throw new Error('Browser workspace is unavailable')
  }
  let registry = runtime.workspaceServices.browserWorkspaceRegistry
  if (!registry) {
    registry = new BrowserWorkspaceRegistry({
      engineFactory: () =>
        new ElectronBrowserEngine({
          WebContentsView,
          getOwningWindow: () => {
            const window = runtime.window.mainWindow
            return window && !window.isDestroyed() ? window : null
          },
          policyContext: browserPolicyContext()
        }),
      policyContext: browserPolicyContext(),
      checkpointStore: browserCheckpointStore,
      openExternal: (url) => shell.openExternal(url),
      approveAgentAction: requestBrowserActionApproval
    })
    runtime.workspaceServices.setBrowserWorkspaceRegistry(registry)
    const current = getCurrentSessionPayload()
    void registry.setActiveSession(browserPresentationSessionId(current.phiSessionId)).catch(() => {
      writeAppLog({ level: 'error', event: 'browser_presentation_transition_failed' })
    })
  }
  return registry
}

async function requestBrowserActionApproval(
  prompt: BrowserActionApprovalPrompt,
  signal: AbortSignal
): Promise<'approved' | 'denied' | 'cancelled'> {
  const run = promptRuns.findActiveRun(
    (candidate) =>
      candidate.phiSessionId === prompt.sessionId &&
      candidate.runId === prompt.runId &&
      !candidate.cancelled
  )
  if (!run) return 'cancelled'
  const manifest = findPhiSessionById(run.phiSessionId)
  if (!manifest || signal.aborted) return 'cancelled'
  const project = manifest.projectId ? getProject(manifest.projectId) : undefined
  return requestToolApproval({
    signal,
    getWindow: () => {
      const window = runtime.window.mainWindow
      return window && !window.isDestroyed() ? window : null
    },
    context: {
      sessionId: run.phiSessionId,
      sessionPath: phiOnlySessionPath(run.phiSessionId),
      sessionGeneration: run.sessionGeneration,
      runId: run.runId,
      cwd: run.cwd,
      ...(project?.name ? { projectName: project.name } : {})
    },
    toolCallId: prompt.toolCallId,
    browser: {
      origin: prompt.origin,
      action: prompt.action,
      consequence: prompt.consequence,
      reason: prompt.reason
    },
    onApprovalRequested: (request) => {
      runnerRegistry.markNeedsApproval(run.phiSessionId, request.requestId, {
        toolName: request.toolName,
        summary: request.summary
      })
    },
    onApprovalResolved: (request, approved) => {
      if (approved) runnerRegistry.markApprovalApproved(run.phiSessionId, request.requestId)
      else runnerRegistry.markApprovalDenied(run.phiSessionId, request.requestId)
    },
    onApprovalCancelled: (request) => {
      runnerRegistry.markApprovalCancelled(run.phiSessionId, request.requestId)
      sendToAllWindows(IPC.tool.approvalCancelled, request.requestId)
    }
  })
}

function cleanupBrowserWorkspaceRegistry(): Promise<void> {
  const registry = runtime.workspaceServices.browserWorkspaceRegistry
  if (!registry) {
    return runtime.workspaceServices.browserWorkspaceRegistryDisposal ?? Promise.resolve()
  }
  if (runtime.workspaceServices.browserWorkspaceRegistryLifecycle !== 'idle') {
    return runtime.workspaceServices.browserWorkspaceRegistryDisposal ?? Promise.resolve()
  }
  runtime.workspaceServices.markBrowserWorkspaceRegistryDisposing()
  let disposal: Promise<void>
  try {
    disposal = registry.disposeAll()
  } catch {
    runtime.workspaceServices.markBrowserWorkspaceRegistryDisposalFailed()
    writeAppLog({ level: 'error', event: 'browser_registry_cleanup_failed' })
    return Promise.resolve()
  }
  runtime.workspaceServices.setBrowserWorkspaceRegistryDisposal(disposal)
  void disposal.then(
    () => {
      runtime.workspaceServices.completeBrowserWorkspaceRegistryDisposal(registry, disposal)
    },
    () => {
      if (!runtime.workspaceServices.failBrowserWorkspaceRegistryDisposal(registry, disposal))
        return
      writeAppLog({ level: 'error', event: 'browser_registry_cleanup_failed' })
    }
  )
  return disposal
}

function getTerminalManager(): TerminalManager {
  if (runtime.window.cleanupStarted) throw new Error('Terminal manager is unavailable')
  let manager = runtime.workspaceServices.terminalManager
  if (!manager) {
    manager = new TerminalManager({
      resolveWorkspace: (ref) =>
        resolveTerminalWorkspace(ref, {
          getProject,
          noProjectTaskFolder: getNoProjectTaskFolder,
          realDirectory: (path) => realDirectoryPath(path),
          isRemoteAnchor: (path) => isRemoteProjectAnchorPath(path, AGENT_DIR),
          resolveRemoteWorkspaceHostBinding: (input, options) => {
            const binding = resolveRemoteWorkspaceHostBinding(input, {
              agentDir: AGENT_DIR
            })
            const authorized = resolveAuthorizedRemoteConnectionConfig(input, {
              agentDir: AGENT_DIR,
              userInitiated: options.userInitiated
            })
            return {
              hostAlias: binding.hostAlias,
              remoteRoot: binding.remoteRoot,
              connection: {
                ...authorized.connection,
                userInitiated: options.userInitiated
              }
            }
          }
        }),
      sink: (event) => {
        if (
          event.type === 'state' &&
          (event.snapshot.state === 'closing' ||
            event.snapshot.state === 'exited' ||
            event.snapshot.state === 'failed')
        ) {
          runtime.workspaceServices.terminalDraftService?.terminalClosed(event.snapshot.terminalId)
        }
        terminalIpcCoordinator.sendEvent(event)
      }
    })
    runtime.workspaceServices.setTerminalManager(manager)
  }
  return manager
}

function getTerminalDraftService(): TerminalDraftService {
  if (runtime.window.cleanupStarted) throw new Error('Terminal draft service is unavailable')
  let draftService = runtime.workspaceServices.terminalDraftService
  if (!draftService) {
    draftService = new TerminalDraftService({
      createSession: buildTerminalDraftSessionFactory({
        createAgentSession,
        createSessionManager: createInMemoryRuntimeSessionManager,
        resolveSession: async (context) => {
          const modelRuntime = await getAuthManager().getRuntime()
          const project = context.workspaceKey.startsWith('project:')
            ? getProject(context.workspaceKey.slice('project:'.length))
            : undefined
          const modelSelection = project?.defaultModel ?? sessionState.selectedModel
          const model = modelSelection
            ? resolveRuntimeModelSelection(modelRuntime, modelSelection)?.model
            : undefined
          return {
            modelRuntime,
            model,
            thinkingLevel: project?.defaultThinkingLevel ?? selectedThinkingLevel
          }
        }
      }),
      manager: getTerminalManager()
    })
    runtime.workspaceServices.setTerminalDraftService(draftService)
  }
  return draftService
}

async function disposeTerminalManager(): Promise<void> {
  const { draftService, manager } = runtime.workspaceServices.takeTerminalServices()
  await Promise.all([draftService?.dispose(), manager?.dispose()])
}

function browserSessionForPhiId(phiSessionId: string): BrowserIpcSession | undefined {
  const manifest = findPhiSessionById(phiSessionId)
  if (!manifest) return undefined
  const project = manifest.projectId ? getProject(manifest.projectId) : undefined
  const location = manifest.projectLocation ?? project?.location
  return {
    sessionId: phiSessionId,
    owner: location ? { kind: 'project', location } : { kind: 'ordinary' }
  }
}

const browserIpcCoordinator = new BrowserIpcCoordinator({
  getRegistry: getBrowserWorkspaceRegistry,
  getTrustedRenderer: () => {
    const window = runtime.window.mainWindow
    return window && !window.isDestroyed() ? window.webContents : null
  },
  resolveHumanSession: () => {
    const current = getCurrentSessionPayload()
    if (!current.phiSessionId) return undefined
    return {
      sessionId: current.phiSessionId,
      sessionGeneration: current.sessionGeneration,
      owner: current.projectLocation
        ? { kind: 'project', location: current.projectLocation }
        : { kind: 'ordinary' }
    }
  },
  resolveAgentSession: (originSessionId) => {
    const origin = sessionOrigins.resolveOriginSession(originSessionId)
    return origin ? browserSessionForPhiId(origin.phiSessionId) : undefined
  }
})
const terminalIpcCoordinator = new TerminalIpcCoordinator({
  getManager: getTerminalManager,
  getDraftService: getTerminalDraftService,
  getTrustedRenderer: () => {
    const window = runtime.window.mainWindow
    return window && !window.isDestroyed() ? window.webContents : null
  }
})

// The desktop uses Chromium networking so the operating system's proxy settings also
// apply to catalog metadata and package archives. The transport remains usable in Node/tests.
const officialRegistryFetch: typeof fetch = (input, init) =>
  net.fetch(input instanceof URL ? input.toString() : input, init)

function scheduleStartupPackageUpdateCheck(): void {
  setImmediate(async () => {
    try {
      const updates = await refreshCachedPackageUpdates()
      const mainWindow = runtime.window.mainWindow
      if (updates.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.packages.updatesAvailable, packageUpdateViews(updates))
      }
    } catch (error) {
      writeAppLog({
        level: 'warn',
        event: 'package_update_check_failed',
        metadata: { error: errorMessage(error) }
      })
    }
  })
}

const TOOL_OUTPUT_INLINE_LIMIT = 20000
function modelSelectionLabel(selection: ModelSelection): string {
  return `${selection.providerId}/${selection.modelId}`
}

type AgentSessionResult = Awaited<ReturnType<typeof createAgentSession>>
type AgentSessionInstance = AgentSessionResult['session']

function getNoProjectTaskFolder(): string {
  return readAppSettings(AGENT_DIR).noProjectTaskFolder
}

function realDirectoryPath(
  path: string,
  options: { create?: boolean; fallbackToResolved?: boolean } = {}
): string | null {
  try {
    if (options.create) {
      mkdirSync(path, { recursive: true })
    }
    const realPath = realpathSync(path)
    return statSync(realPath).isDirectory() ? realPath : null
  } catch {
    return options.fallbackToResolved ? resolve(path) : null
  }
}

// The session file currently active in the UI. undefined = a fresh, not-yet-persisted
// chat (nothing appended to it yet, so no file exists and it won't show in the sidebar
// until the first prompt). Distinct from invalidating the session object below: switching
// this is a user-visible "change conversation" action, while invalidation just rebuilds
// the in-memory AgentSession (e.g. after an auth/model/persona change) against whatever
// conversation was already active.
const initialFreshSessionCounter = 0
// Working directory for the active conversation. A plain "对话" (conversation) uses the
// user-configurable no-project task folder; a "项目" (project) uses its own folder and
// carries a permission mode gating bash/edit/write tool calls (see tool-approval.ts).
const initialSessionCwd = getNoProjectTaskFolder()
const initialSelectedModel = readLastSelectedModel()
// Default is deliberately 'high', not the SDK's own default of 'off': many models
// (e.g. DeepSeek V4 Pro) only enable reasoning output at 'high'/'max', and this app
// wants that reasoning visible in the UI out of the box rather than silently absent.
const selectedThinkingLevel: ThinkingLevel = 'high'
const runtime = createMainRuntimeContext<AgentSessionResult, PromptRun>({
  sessions: {
    getFreshSessionCounter: () => runtime.session.freshSessionCounter,
    phiOnlySessionPath
  },
  session: (sessions) => ({
    freshSessionCounter: initialFreshSessionCounter,
    cwd: initialSessionCwd,
    selectedModel: initialSelectedModel,
    sessionKey: sessions.keys.createKey(undefined, initialSessionCwd, initialFreshSessionCounter)
  })
})
const { session: sessionState, sessions: sessionRuntime } = runtime
const { keys: sessionKeys, lifecycles, preferences, runs: promptRuns } = sessionRuntime
const sessionResolution = createSessionResolution({
  promptRuns,
  sessionKeys,
  modelSelections: preferences.modelSelections,
  thinkingLevels: preferences.thinkingLevels,
  permissionModes: preferences.permissionModes,
  getSelectedModel: () => sessionState.selectedModel,
  getDefaultThinkingLevel: () => selectedThinkingLevel
})
const { projectRemoteRuntimeRoot } = createProjectRuntimeRootContext({ agentDir: AGENT_DIR })
const { currentRemoteAnalysisProject, isRemoteResourceScope, remoteSkillProjectContext } =
  createRemoteProjectContext({
    sessionState,
    sessionResolution,
    agentDir: AGENT_DIR
  })
const { listRemoteProjectSkills } = createRemoteProjectSkills({ remoteSkillProjectContext })
const { resolveAnalysisWorkspaceByCwd, isRemoteAnalysisCwd } = createAnalysisWorkspaceResolution({
  agentDir: AGENT_DIR,
  getCurrentSessionCwd: () => sessionState.cwd,
  currentRemoteAnalysisProject,
  getNoProjectTaskFolder,
  realDirectoryPath
})
const sessionOrigins = createSessionOrigins({
  sessionKeys,
  findActivePromptRunByRuntimeSessionId,
  getCurrentCwd: () => sessionState.cwd,
  requireProject,
  projectRemoteRuntimeRoot,
  agentDir: AGENT_DIR
})
const sessionKeyLinking = createSessionKeyLinking({
  sessionRuntime,
  sessionKeys,
  sessionState,
  sessionResolution
})
const loadedSkillNamesBySession = new Map<string, string[]>()
const backgroundAgentApprovals = new BackgroundAgentApprovalTracker({
  readManifest: findPhiSessionById,
  appendEvent: appendSessionEvent,
  updateManifest: updateSessionManifest,
  onEvent: (sessionId, event) =>
    sendRunEventToWindow({ source: 'phi', ...event, phiSessionId: sessionId }),
  onChange: notifySessionChanged
})
// The RPC facade owns persistence; this observer reuses its records for sidebar attention.
const rpcChildApprovals = new BackgroundAgentApprovalTracker({
  readManifest: (sessionId) => {
    const manifest = findPhiSessionById(sessionId)
    const active = runnerRegistry.getActiveRun(sessionId)
    return manifest && active ? { ...manifest, status: 'running', unreadKind: null } : manifest
  },
  appendEvent: (sessionId, event) => {
    const persisted = readSessionEvents(sessionId).findLast(
      (stored) =>
        stored.type === event.type &&
        stored.approvalId === event.approvalId &&
        stored.agentRunId === event.agentRunId
    )
    if (!persisted) throw new Error('RPC child approval notification has no durable record')
    return persisted
  },
  updateManifest: (sessionId, patch) => {
    const attention = { ...patch }
    delete attention.lastRunOutcome
    const active = runnerRegistry.getActiveRun(sessionId)
    if (active) {
      // The live runner owns its status; a finished parent's child cannot change a successor.
      if (attention.unreadKind === 'approval' || active.status !== 'needs_approval')
        updateSessionManifest(sessionId, { unreadKind: attention.unreadKind })
      return
    }
    updateSessionManifest(sessionId, attention)
  },
  onEvent: (sessionId, event) =>
    sendRunEventToWindow({ source: 'phi', ...event, phiSessionId: sessionId }),
  onChange: notifySessionChanged
})
const runnerRegistry = new SessionRunnerRegistry({
  onSessionEvent: broadcastSessionTimelineEvent,
  onRunSettled: (sessionId) => {
    backgroundAgentApprovals.afterParentRunSettled(sessionId)
    rpcChildApprovals.afterParentRunSettled(sessionId)
  }
})
const handleAgentInteractionRequest = createAgentInteractionRequest({
  fields: { optionalStringField },
  runs: { findByRuntimeSessionId: findActivePromptRunByRuntimeSessionId },
  projects: {
    getById: (projectId) => getProject(projectId) ?? undefined,
    getByCwd: (cwd) => getProjectByCwd(cwd) ?? undefined
  },
  renderer: {
    getActiveWindow,
    canRequest: canRequestAgentUserInteraction,
    waitForResponse: waitForAgentUserInteraction
  },
  state: {
    createId: createRunId,
    sessionPath: phiOnlySessionPath,
    markNeedsInput: (sessionId, interactionId, state) =>
      runnerRegistry.markNeedsInput(sessionId, interactionId, state),
    markInputCancelled: (sessionId, interactionId) =>
      runnerRegistry.markInputCancelled(sessionId, interactionId),
    markInputAnswered: (sessionId, interactionId) =>
      runnerRegistry.markInputAnswered(sessionId, interactionId),
    notifySessionChanged
  }
})
const { handlePresentFilesRequest, presentScriptArtifacts } = createDeliverablesPresentation({
  agentDir: AGENT_DIR,
  fields: { optionalStringField },
  runs: { findByRuntimeSessionId: findActivePromptRunByRuntimeSessionId },
  sessions: { findById: findPhiSessionById },
  projects: { getById: (projectId) => getProject(projectId) ?? undefined },
  remote: {
    isProjectAnchorPath: isRemoteProjectAnchorPath,
    ownsRuntimeSession: ownsRemoteRuntimeSession,
    bindingKey: (identity) => resolveRemoteWorkspaceHostBinding(identity).cacheKey
  },
  files: {
    validateLocal: validatePresentedFiles,
    validateRemote: (identity, value) =>
      validateRemotePresentedFiles(identity, value, {
        connectHost: (request) => connectRemoteWorkspaceHost(request)
      }),
    statSize: (path) => statSync(path).size
  },
  timeline: {
    append: appendSessionEvent,
    broadcast: broadcastSessionTimelineEvent
  }
})
const {
  confirmEnvironmentBuild,
  confirmEnvironmentRequest,
  confirmAgentModuleInstallation,
  approveRemoteJupyterStart
} = createHostConfirmations({
  interactions: {
    request: handleAgentInteractionRequest,
    buildQuestion: environmentBuildQuestion,
    buildConfirmed: confirmedEnvironmentBuild,
    requestConfirmed: confirmedEnvironmentRequest
  },
  runs: {
    findByRuntimeSessionId: findActivePromptRunByRuntimeSessionId,
    sessionPath: phiOnlySessionPath
  },
  projects: {
    getById: (projectId) => getProject(projectId) ?? undefined,
    getByCwd: (cwd) => getProjectByCwd(cwd) ?? undefined
  },
  sessions: { findById: findPhiSessionById },
  approvals: {
    createId: createRunId,
    request: requestRuntimeToolApproval,
    getActiveWindow,
    markNeedsApproval: (sessionId, requestId, request) =>
      runnerRegistry.markNeedsApproval(sessionId, requestId, request),
    markApproved: (sessionId, requestId) =>
      runnerRegistry.markApprovalApproved(sessionId, requestId),
    markDenied: (sessionId, requestId) => runnerRegistry.markApprovalDenied(sessionId, requestId),
    markCancelled: (sessionId, requestId) =>
      runnerRegistry.markApprovalCancelled(sessionId, requestId),
    sendCancelled: (requestId) => sendToAllWindows(IPC.tool.approvalCancelled, requestId),
    notifySessionChanged
  },
  capability: { assertCurrent: (context) => capabilityHost.assertCurrent(context) }
})
const handlePlanReviewRequest = createPlanReviewRequest({
  fields: { optionalStringField },
  runs: { findByRuntimeSessionId: findActivePromptRunByRuntimeSessionId },
  projects: { getById: (projectId) => getProject(projectId) ?? undefined },
  sessions: {
    findById: findPhiSessionById,
    sessionPath: phiOnlySessionPath
  },
  renderer: {
    getActiveWindow,
    canRequest: canRequestAgentUserInteraction,
    waitForResponse: waitForAgentUserInteraction
  },
  timeline: {
    append: appendSessionEvent,
    broadcast: broadcastSessionTimelineEvent
  },
  state: {
    createId: createRunId,
    markNeedsInput: (sessionId, reviewId, state) =>
      runnerRegistry.markNeedsInput(sessionId, reviewId, state),
    markInputCancelled: (sessionId, reviewId) =>
      runnerRegistry.markInputCancelled(sessionId, reviewId),
    markInputAnswered: (sessionId, reviewId) =>
      runnerRegistry.markInputAnswered(sessionId, reviewId),
    notifySessionChanged
  }
})
const skippedMcpNotifier = createSkippedMcpNotifier({
  append: appendSessionEvent,
  readEvents: readSessionEvents,
  broadcast: broadcastSessionTimelineEvent
})
const { remoteRuntimeDispatchControl, isRemoteRuntimeCancellation } =
  createRemoteRuntimeDispatchControl({
    fields: { optionalStringField },
    sessions: {
      resolveOriginSession: sessionOrigins.resolveOriginSession,
      getActiveRun: (sessionId) => runnerRegistry.getActiveRun(sessionId),
      ownsRemoteRuntimeSession
    },
    workspace: { resolveBinding: resolveRemoteWorkspaceHostBinding },
    engine: {
      resourceOwner: (runtimeSessionId, agentRunId) =>
        getPhiEngine().agentRuns.resourceOwner?.(runtimeSessionId, agentRunId)
    }
  })
const loadAppRemoteAgentResources = createAppRemoteAgentResources({
  agentDir: AGENT_DIR,
  sessions: { findById: findPhiSessionById },
  workspace: { resolveBinding: resolveRemoteWorkspaceHostBinding },
  catalogs: {
    loadProjectSkills: loadRemoteProjectSkillCatalog,
    listGlobalSkills,
    readProjectSkill: readRemoteProjectSkillContent,
    readGlobalSkill: readGlobalSkillContent
  }
})
const resolveAppRemoteAgentEnvironment = createAppRemoteAgentEnvironment({
  sessions: { findById: findPhiSessionById },
  workspace: {
    resolveBinding: resolveRemoteWorkspaceHostBinding,
    resolveTarget: directRemoteRuntimeTarget
  },
  runtime: {
    describeReadyInWorkspace: (...args) =>
      remoteRuntimeController.environments.describeReadyInWorkspace(...args)
  },
  projects: { require: requireProject },
  facade: { bindingHash: facadeBindingHash }
})
const loadAppRemotePromptContext = createAppRemotePromptContext({
  agentDir: AGENT_DIR,
  sessions: { findById: findPhiSessionById, readEvents: readSessionEvents },
  projects: { require: requireProject, runtimeRoot: projectRemoteRuntimeRoot },
  workspace: { resolveBinding: resolveRemoteWorkspaceHostBinding },
  context: {
    loadProjectInstructions: loadRemoteProjectInstructions,
    getPersonaMarkdown,
    resolveRuntimePrompt: resolveRemoteRuntimePromptContext,
    readRecoverySummary: readRuntimeRecoverySummarySeed
  }
})
const loadAppRemoteDesktopTools = createAppRemoteDesktopTools({
  agentDir: AGENT_DIR,
  sessions: { findById: findPhiSessionById },
  projects: { getById: getProject },
  workspace: { resolveBinding: resolveRemoteWorkspaceHostBinding },
  catalogs: {
    listGlobalSkills,
    loadProjectSkills: loadRemoteProjectSkillCatalog,
    listGlobalMcpServers,
    loadProjectMcp: loadRemoteProjectMcpCatalog
  },
  runtime: {
    scriptTools: (identity) => remoteRuntimeController.scriptTools(identity),
    approvalFor: (name, input, control) =>
      remoteRuntimeController.approvalFor(name, input, control),
    dispatchControl: remoteRuntimeDispatchControl
  },
  adapters: {
    createWebSearch: createDesktopWebSearchAdapter,
    createMcp: createDesktopMcpAdapter,
    createMemory: createDesktopProjectMemoryAdapter
  },
  skippedMcp: { notify: (sessionId, skipped) => skippedMcpNotifier.notify(sessionId, skipped) }
})
const { getSessionStatusPayload, getCurrentSessionPayload } = createCurrentSessionPayload({
  sessionState,
  sessionKeys,
  lifecycles,
  promptRuns,
  runners: runnerRegistry,
  sessionResolution
})
const { getSessionControllerKey, abortAndDisposeSession, cleanupSessionRecord } =
  createSessionCleanup({
    lifecycles,
    sessions: { abortSession, abortSessionWithoutCancellingApprovals },
    errors: {
      isCleanupStarted: () => runtime.window.cleanupStarted,
      reportUnexpectedCleanupError: (error) => {
        logUnexpectedError(error)
        console.error('Failed to clean up agent session:', error)
      }
    }
  })
const {
  createPhiManagedSession,
  createRemoteManagedSession,
  getCurrentResolvedSession,
  invalidateAgentSession,
  disposeAndSwitchSession
} = createSessionSwitching({
  state: {
    sessionState,
    sessionKeys,
    lifecycles,
    promptRuns,
    permissionModes: preferences.permissionModes
  },
  sessions: {
    linkPhiManagedSessionKey: sessionKeyLinking.linkPhiManagedSessionKey,
    resolveSessionPermissionMode: sessionResolution.resolveSessionPermissionMode,
    getCurrentSessionPayload,
    getNoProjectTaskFolder
  },
  creation: {
    getSelectedThinkingLevel: () => selectedThinkingLevel,
    ensureRemoteProjectAnchor
  },
  invalidation: {
    loadedSkillNamesBySession,
    cancelBrowserRun,
    cleanupBrowserRunTabs,
    cancelPendingRunWaits,
    cleanupSessionRecord
  },
  browser: {
    getRegistry: () => runtime.workspaceServices.browserWorkspaceRegistry
  },
  events: { notifySessionChanged, writeAppLog }
})
installAppRemoteSessionRouting({
  ...(process.env.PHI_REMOTE_STARTUP_DIAGNOSTICS === '1'
    ? {
        startupDiagnostics: ({ phiSessionId, status, totalMs, steps }) =>
          writeAppLog({
            event: 'remote_session_startup_profile',
            sessionId: phiSessionId,
            metadata: { status, totalMs, steps }
          })
      }
    : {}),
  onRunTakeover: ({ sessionId, message }) => {
    const stored = appendSessionEvent(sessionId, {
      type: 'remote_run_stopped',
      noticeLevel: 'warning',
      noticeText: message
    })
    broadcastSessionTimelineEvent(sessionId, stored)
  },
  foregroundAgentNames: process.env.PHI_REMOTE_OMP_AGENTS,
  agentDir: AGENT_DIR,
  runners: runnerRegistry,
  appPaths: () => ({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged
  }),
  configuredRoot: (project) => projectRemoteRuntimeRoot(project).configured,
  loadAgents: async (identity) =>
    (
      await loadRemoteAgentCatalog({
        ...identity,
        agentDir: AGENT_DIR,
        bundledDir: getBundledAgentsDir()
      })
    ).agents,
  loadDesktopTools: loadAppRemoteDesktopTools,
  loadPromptContext: loadAppRemotePromptContext,
  loadAgentResources: loadAppRemoteAgentResources,
  resolveAgentEnvironment: resolveAppRemoteAgentEnvironment,
  onChildApprovalEvent: (event) => {
    if (!event.request.cwd) return
    if (event.type === 'approval_requested') {
      rpcChildApprovals.requested({
        sessionId: event.sessionId,
        agentRunId: event.runId,
        approvalId: event.approvalId,
        toolName: event.request.toolName,
        summary: event.request.summary ?? event.request.toolName,
        cwd: event.request.cwd
      })
    } else {
      rpcChildApprovals.resolved(
        event.approvalId,
        event.type === 'approval_approved'
          ? 'approved'
          : event.type === 'approval_denied'
            ? 'denied'
            : 'cancelled'
      )
    }
  },
  onMemoryError: (identity) =>
    writeAppLog({
      level: 'error',
      event: 'project_memory_ingestion_failed',
      sessionId: identity.sessionId,
      metadata: { projectId: identity.projectId, reason: 'ingestion_failed' }
    }),
  approval: {
    shouldGate: (request) => {
      const manifest = request.sessionId ? findPhiSessionById(request.sessionId) : null
      if (!manifest) throw new Error('RPC approval session is unavailable')
      return manifest.permissionMode === 'ask'
    },
    requestToolApproval: (request, signal) =>
      requestRuntimeToolApproval(request, signal, () => {
        const window = runtime.window.mainWindow
        return window && !window.isDestroyed() ? window : null
      }),
    onEvent: (event) => {
      const run = runnerRegistry.getActiveRun(event.sessionId)
      if (!run || run.runId !== event.runId) return
      if (event.type === 'approval_requested')
        runnerRegistry.markNeedsApproval(event.sessionId, event.approvalId, {
          toolName: event.request.toolName,
          summary: event.request.summary
        })
      else if (event.type === 'approval_approved')
        runnerRegistry.markApprovalApproved(event.sessionId, event.approvalId)
      else if (event.type === 'approval_denied')
        runnerRegistry.markApprovalDenied(event.sessionId, event.approvalId)
      else runnerRegistry.markApprovalCancelled(event.sessionId, event.approvalId)
    }
  }
})

function syncPreventSleepBlocker(): void {
  const shouldBlock = readAppSettings().preventSleepDuringRuns && runnerRegistry.activeCount > 0
  const blockerId = runtime.caches.preventSleepBlockerId
  if (shouldBlock && blockerId === null) {
    runtime.caches.setPreventSleepBlockerId(powerSaveBlocker.start('prevent-app-suspension'))
    return
  }
  if (!shouldBlock && blockerId !== null) {
    if (powerSaveBlocker.isStarted(blockerId)) {
      powerSaveBlocker.stop(blockerId)
    }
    runtime.caches.clearPreventSleepBlockerId()
  }
}
const backgroundEnvironment = createBackgroundEnvironment({ agentDir: AGENT_DIR })
const environmentBuilds = createEnvironmentBuilds({
  root: getRuntimeRoot(),
  build: (root, descriptor, options) =>
    buildEnvironment(root, descriptor, { ...options, fetch: officialRegistryFetch }),
  onChange: (build) => {
    sendToAllWindows(IPC.environmentBuilds.changed, build)
  }
})
const {
  officialContentSourceOptions,
  knownContentSourceOptions,
  loadPackageRegistries,
  refreshCachedPackageUpdates
} = createContentPackageRuntime({
  getAgentDir: () => AGENT_DIR,
  getAppVersion: () => app.getVersion(),
  registryFetch: officialRegistryFetch,
  environmentBuilds,
  configuredStdioTools: (request) => getPhiEngine().mcp.configuredStdioTools(request),
  replaceCachedPackageUpdates: (updates) => runtime.caches.replaceCachedPackageUpdates(updates),
  getCachedPackageUpdates: () => runtime.caches.cachedPackageUpdates
})
const { installedPluginNamespace } = createInstalledPluginNamespace({
  getAgentDir: () => AGENT_DIR,
  getSessionCwd: () => sessionState.cwd
})
// The notebook server joins builds started elsewhere (chat prompt or the environment panel).
const jupyterServerRegistry = new JupyterServerRegistry({
  managed: {
    builds: environmentBuilds,
    hostJupyterPath: () => getCustomToolPath('jupyter', AGENT_DIR)
  }
})
const { ensureJupyterServerReady } = createNotebookServerReadiness({
  jupyterServerRegistry,
  delay
})
const notebookSessionRegistry = new AnalysisNotebookSessionRegistry({
  getConnection: (projectCwd) => jupyterServerRegistry.connection(projectCwd)
})
const notebookExecutor = new AnalysisNotebookExecutor()
const activeNotebookPathByProjectCwd = new Map<string, string>()
const notebookToolExecutor = new AnalysisNotebookToolExecutor({
  resolveWorkspaceByCwd: resolveAnalysisWorkspaceByCwd,
  ensureJupyterServerReady,
  notebookSessionRegistry,
  notebookExecutor,
  onDraftChanged: notifyAnalysisNotebookDraftChanged
})
const remoteJupyterStartJobs = new RemoteJupyterStartJobs()
const {
  activeRemoteNotebookBackends,
  remoteNotebookBackend,
  resolveRemoteNotebookToolBackend,
  disposeRemoteNotebookBackend,
  disposeRemoteNotebookBackends
} = createRemoteNotebookRuntime({
  agentDir: AGENT_DIR,
  projectRemoteRuntimeRoot,
  sessionKeys,
  notebookExecutor,
  startJobs: remoteJupyterStartJobs,
  onDraftChanged: notifyAnalysisNotebookDraftChanged
})
const notebookFileWatcher = new AnalysisNotebookFileWatcher({
  onChange: notifyAnalysisNotebookFileChanged
})
const analysisNotebookOperations = new AnalysisNotebookOperations({
  remoteNotebookBackend,
  notebookSessionRegistry,
  notebookToolExecutor,
  notebookFileWatcher,
  notifyAnalysisNotebookFileChanged
})
const analysisNotebookCodeGenerator = new AnalysisNotebookCodeGenerator({
  agentDir: AGENT_DIR,
  notebooks: {
    resolveWorkspaceByCwd: resolveAnalysisWorkspaceByCwd,
    remoteBackendFor: (workspace) => analysisNotebookOperations.remoteBackendFor(workspace),
    openFile: (workspace, notebookPath, watch) =>
      analysisNotebookOperations.openFile(workspace, notebookPath, watch),
    sessions: (workspace) => analysisNotebookOperations.sessions(workspace)
  },
  notebookSessionRegistry,
  notebookExecutor,
  models: {
    selected: () => sessionState.selectedModel,
    thinkingLevel: () => selectedThinkingLevel,
    resolve: resolveRuntimeModelSelection,
    label: modelSelectionLabel
  },
  messages: {
    extractAssistantText: extractAssistantMessageText,
    assistantErrorMessageFromEventSummary
  }
})
const notebookToolHostRouter = new NotebookToolHostRouter({
  local: (request, control) => notebookToolExecutor.execute(request, control),
  isRemoteCwd: isRemoteAnalysisCwd,
  resolveRemote: resolveRemoteNotebookToolBackend
})
getPhiEngine().host.register('notebookTool.execute', async (params, context) => {
  const request = params as Parameters<typeof notebookToolHostRouter.execute>[0]
  const identity = request.remoteProject
  const binding = identity
    ? resolveRemoteWorkspaceHostBinding({
        sessionId: identity.sessionId,
        projectId: identity.projectId
      })
    : undefined
  const rpcControl =
    identity && context
      ? remoteRuntimeDispatchControl(
          {
            runtimeSessionId: identity.runtimeSessionId,
            remoteSessionId: identity.sessionId,
            projectId: identity.projectId
          },
          context
        )
      : undefined
  const beforeDispatch = (): void => {
    rpcControl?.beforeDispatch()
    if (!identity) return
    const origin = sessionKeys.originFor(identity.runtimeSessionId)
    if (
      context?.originSessionId !== identity.runtimeSessionId ||
      !origin ||
      sessionKeys.phiSessionIdFor(origin.sessionKey) !== identity.sessionId ||
      resolveRemoteWorkspaceHostBinding({
        sessionId: identity.sessionId,
        projectId: identity.projectId
      }).cacheKey !== binding?.cacheKey
    )
      throw new Error('远程 Notebook 后端不可用：运行或项目绑定已改变；没有回退到本机执行。')
  }
  beforeDispatch()
  return notebookToolHostRouter.execute(request, {
    signal: context?.signal,
    beforeDispatch,
    ...(identity && context
      ? {
          approveRemoteJupyterStart: (info) => approveRemoteJupyterStart(identity, info, context)
        }
      : {})
  })
})
const skillHost = createSkillHost({
  listSkillDirs: async (cwd) => {
    const skills = await listSkills(cwd)
    return skills.map((skill) => dirname(skill.filePath))
  },
  builds: environmentBuilds,
  confirmBuild: (request) => confirmEnvironmentBuild(request),
  presentArtifacts: (request) => presentScriptArtifacts(request)
})

function directRemoteRuntimeTarget(params: unknown): RemoteRuntimeTarget | undefined {
  if (!isRecord(params)) return undefined
  const runtimeSessionId = optionalStringField(params, 'runtimeSessionId')
  const sessionId = optionalStringField(params, 'remoteSessionId')
  const projectId = optionalStringField(params, 'projectId')
  if (!runtimeSessionId || !sessionId || !projectId) return undefined
  if (findPhiSessionById(sessionId)?.projectId !== projectId) return undefined
  const project = getProject(projectId)
  if (!project || project.location.kind !== 'ssh') return undefined
  const root = projectRemoteRuntimeRoot(project)
  const micromambaPath = readHostRemoteEnvironmentPaths(
    project.location.hostProfileId,
    AGENT_DIR
  ).micromamba
  return {
    runtimeSessionId,
    sessionId,
    projectId,
    configuredRoot: root.configured,
    ...(micromambaPath ? { micromambaPath } : {})
  }
}

const remoteRuntimeController = new RemoteRuntimeController({
  micromambaVersion: remoteMicromambaManifestVersion(),
  resolveTarget: directRemoteRuntimeTarget,
  confirmEnvironment: (request) => confirmEnvironmentRequest(request),
  resolveBaseEnvironment: (ref, pluginId) => resolveRemoteBaseEnvironment(ref, pluginId, AGENT_DIR),
  listSkills: async (_runtimeSessionId, target) => {
    const plugins = new Map(
      loadedPlugins({ agentDir: AGENT_DIR }).map((plugin) => [plugin.id, plugin])
    )
    const globalSkills = (await listGlobalSkills())
      .filter((skill) => skill.enabled)
      .map((skill) => {
        const plugin = skill.sourceId ? plugins.get(skill.sourceId) : undefined
        return {
          name: skill.name,
          filePath: skill.filePath,
          dir: dirname(skill.filePath),
          insidePlugin: skill.sourceCategory === 'plugin',
          ...(plugin ? { pluginId: plugin.id, toolPrefix: plugin.toolPrefix } : {})
        }
      })
    if (!target) return globalSkills
    const projectCatalog = await loadRemoteProjectSkillCatalog({
      sessionId: target.sessionId,
      projectId: target.projectId,
      cwd: remoteProjectAnchorPath(target.projectId, AGENT_DIR),
      agentDir: AGENT_DIR
    })
    const projectNames = new Set(projectCatalog.sources.map((skill) => skill.name))
    return [
      ...projectCatalog.sources,
      ...globalSkills.filter((skill) => !projectNames.has(skill.name))
    ]
  }
})

const remoteLibraryService = new RemoteLibraryService(async (identity, signal, context) => {
  const control = remoteRuntimeDispatchControl(
    {
      runtimeSessionId: identity.runtimeSessionId,
      remoteSessionId: identity.sessionId,
      projectId: identity.projectId
    },
    { ...context, originSessionId: identity.runtimeSessionId, signal }
  )!
  const project = getProject(identity.projectId)!
  const binding = resolveRemoteWorkspaceHostBinding({
    sessionId: identity.sessionId,
    projectId: identity.projectId
  })
  const workspace = await openRemoteRuntimeWorkspace(
    {
      ...identity,
      configuredRoot: projectRemoteRuntimeRoot(project).configured
    },
    signal
  )
  let session: Awaited<ReturnType<typeof binding.config.connect>> | undefined
  try {
    control.beforeDispatch()
    session = await binding.config.connect()
    control.beforeDispatch()
    if (!session.openStdio) throw new Error('远程 Library 需要当前 SSH stdio 能力')
    return {
      workspace: {
        ...controlRemoteRuntimeWorkspace(workspace, control.beforeDispatch),
        close: async () => {
          await Promise.allSettled([workspace.close?.(), session!.close()])
        }
      },
      openLockStdio: async (command) => {
        control.beforeDispatch()
        const process = await session!.openStdio!(command)
        try {
          control.beforeDispatch()
          return process
        } catch (error) {
          await process.close().catch(() => undefined)
          throw error
        }
      }
    }
  } catch (error) {
    await Promise.allSettled([workspace.close?.(), session?.close()])
    throw error
  }
})
getPhiEngine().host.register('library.execute', (params, context) =>
  remoteLibraryService.execute(params, context)
)
getPhiEngine().host.register('library.cancel', (params, context) =>
  remoteLibraryService.cancel(params, context)
)

getPhiEngine().host.register('skills.scriptTools', (params) =>
  remoteRuntimeController.owns(params)
    ? remoteRuntimeController.scriptTools(params)
    : skillHost.scriptTools(params)
)
getPhiEngine().host.register('skills.run', (params, context) => {
  const control = remoteRuntimeDispatchControl(params, context)
  return remoteRuntimeController.owns(params)
    ? remoteRuntimeController.runSkill(params, control)
    : skillHost.run(params)
})
getPhiEngine().host.register('skills.scriptTool', (params, context) => {
  const control = remoteRuntimeDispatchControl(params, context)
  return remoteRuntimeController.owns(params)
    ? remoteRuntimeController.runScriptTool(params, control)
    : skillHost.scriptTool(params)
})
getPhiEngine().host.register('skills.cancel', (params, context) => {
  if (isRemoteRuntimeCancellation(params, context))
    return remoteRuntimeController.skills.cancel(params)
  return skillHost.cancel(params)
})
getPhiEngine().host.register('environments.bindSession', (params, context) => {
  const control = remoteRuntimeDispatchControl(params, context)
  return remoteRuntimeController.owns(params)
    ? remoteRuntimeController.bindEnvironment(params, control)
    : bindAgentSession(params, {
        builds: environmentBuilds,
        confirmBuild: (request) => confirmEnvironmentBuild(request)
      })
})
getPhiEngine().host.register('environments.request', (params, context) => {
  const control = remoteRuntimeDispatchControl(params, context)
  return remoteRuntimeController.owns(params)
    ? remoteRuntimeController.requestEnvironment(params, control)
    : requestProjectEnvironment(params, {
        root: getRuntimeRoot(),
        builds: environmentBuilds,
        confirm: (request) => confirmEnvironmentRequest(request)
      })
})
getPhiEngine().host.register('environments.cancel', (params, context) =>
  isRemoteRuntimeCancellation(params, context)
    ? remoteRuntimeController.environments.cancel(params)
    : undefined
)
const capabilityService = createCapabilityService({
  agentDir: AGENT_DIR,
  appVersion: app.getVersion(),
  loadRegistries: loadPackageRegistries,
  searchOfficial: (query, type, signal) =>
    searchOfficialCatalog(query, type, signal, { fetch: officialRegistryFetch }),
  confirm: (request, context) =>
    confirmAgentModuleInstallation(
      request.runtimeSessionId,
      capabilityApprovalSummary(request),
      context
    ),
  prepare: (registry, request, _options, signal) =>
    prepareContentPackageInstall(registry, request, {
      ...officialContentSourceOptions(),
      fetch: (input, init) =>
        officialRegistryFetch(input, {
          ...init,
          signal: signal
            ? AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])])
            : init?.signal
        })
    }),
  installerOptions: async () => ({
    ...officialContentSourceOptions(),
    runtimeRoot: getRuntimeRoot(),
    names: await installedPluginNamespace(),
    build: (descriptor, buildOptions) => environmentBuilds.start(descriptor, buildOptions)
  }),
  assertCurrent: (context) => capabilityHost.assertCurrent(context)
})
const externalSkillService = createExternalSkillService({
  agentDir: AGENT_DIR,
  appVersion: app.getVersion(),
  fetch: officialRegistryFetch,
  confirm: (request, context) =>
    confirmAgentModuleInstallation(request.runtimeSessionId, request.question, context),
  assertCurrent: (context) => capabilityHost.assertCurrent(context)
})
const capabilityHost: ReturnType<typeof createCapabilityHost> = createCapabilityHost({
  service: capabilityService,
  external: externalSkillService,
  onInstalled: (_result, context) => {
    const run = context.originSessionId
      ? findActivePromptRunByRuntimeSessionId(context.originSessionId)
      : undefined
    if (run) loadedSkillNamesBySession.delete(run.phiSessionId)
    sendToAllWindows(IPC.packages.resourcesChanged)
  },
  resolveRun: (runtimeSessionId) => {
    const run = findActivePromptRunByRuntimeSessionId(runtimeSessionId)
    if (!run || run.cancelled) throw new Error('模块操作所属任务已结束')
    return {
      assertCurrent: () => {
        if (run.cancelled || findActivePromptRunByRuntimeSessionId(runtimeSessionId) !== run)
          throw new Error('模块操作所属任务已结束或改变')
      }
    }
  }
})
for (const [method, handler] of Object.entries(capabilityHost.handlers))
  getPhiEngine().host.register(method, handler)
getPhiEngine().host.register('agentInteraction.request', handleAgentInteractionRequest)
getPhiEngine().host.register(
  'settings.nextActionSuggestionsEnabled',
  () => readAppSettings().nextActionSuggestionsEnabled
)
const cursorH2Bridge = createCursorH2Bridge()
getPhiEngine().host.register('cursorBridge.ensure', async () => ({
  baseUrl: await cursorH2Bridge.ensure()
}))
getPhiEngine().host.register('planReview.request', handlePlanReviewRequest)
getPhiEngine().host.register('deliverables.present', handlePresentFilesRequest)
getPhiEngine().host.register('mcp.openAuthUrl', async (params) => {
  const request = params as { id?: unknown; url?: unknown } | null
  if (typeof request?.id !== 'string' || typeof request.url !== 'string') {
    throw new Error('授权地址无效')
  }
  const catalogConnector = listConnectorCatalog({
    agentDir: AGENT_DIR,
    appVersion: app.getVersion(),
    runtimeRoot: getRuntimeRoot(),
    registries: (await loadPackageRegistries('mcp')).registries
  }).find((entry) => entry.id === request.id)
  const authorizationOrigin = catalogConnector?.url
    ? mcpOAuthAuthorizationOrigin(request.id, catalogConnector.url)
    : undefined
  if (!authorizationOrigin) throw new Error('授权地址无效')
  const url = new URL(request.url)
  if (url.origin !== authorizationOrigin || url.username || url.password) {
    throw new Error('The authorization URL does not match this Connector')
  }
  await shell.openExternal(url.toString())
})
const pendingCustomMcpAuthorizations = new Map<string, PendingCustomMcpAuthorization>()

function customMcpConfigDigest(connector: ReturnType<typeof readCustomRemoteMcpConnector>): string {
  return createHash('sha256').update(JSON.stringify(connector)).digest('hex')
}

getPhiEngine().host.register('mcp.openCustomAuthUrl', async (params) => {
  const request = params as { name?: unknown; attemptId?: unknown; url?: unknown } | null
  if (typeof request?.name !== 'string' || typeof request.attemptId !== 'string') {
    throw new Error('Invalid Connector authorization request')
  }
  const pending = pendingCustomMcpAuthorizations.get(request.name)
  if (
    !pending ||
    pending.cancelled ||
    pending.attemptId !== request.attemptId ||
    !pending.authorizationOrigin
  ) {
    throw new Error('The Connector authorization request has expired')
  }
  const connector = readCustomRemoteMcpConnector(request.name, AGENT_DIR)
  if (
    connector.url !== pending.serverUrl ||
    customMcpConfigDigest(connector) !== pending.configDigest
  ) {
    throw new Error('Connector configuration changed. Authorize again.')
  }
  const url = customMcpAuthUrl(request.url)
  if (url.origin !== pending.authorizationOrigin || url.pathname !== pending.authorizationPath) {
    throw new Error('The authorization URL does not match this Connector')
  }
  await shell.openExternal(url.toString())
})
getPhiEngine().host.register('mcp.featuredApiKey', (params) => {
  const id = (params as { id?: unknown } | null)?.id
  if (typeof id !== 'string') throw new Error('Invalid Connector ID')
  apiKeyConnector(id)
  if (!isFeaturedMcpApiKeyInstalled(id)) return undefined
  return readFeaturedMcpApiKey(id)
})
const remoteConnectionTracker = new RemoteProjectConnectionTracker()
const { scheduleRemoteProjectCheck } = createRemoteProjectRequests({ remoteConnectionTracker })
const remoteProjectUploads = new RemoteProjectUploadService({
  connectProject: async (projectId) => {
    const project = getProject(projectId)
    if (!project || project.location.kind !== 'ssh') {
      throw new Error('只能向已登记的 SSH 项目上传本机文件')
    }
    const profile = getRemoteHostProfile(project.location.hostProfileId, AGENT_DIR)
    if (!profile) throw new Error('远程项目的 SSH 服务器档案不可用')
    const session = await connectRemoteSshSession({
      ...remoteConnectionConfigForProfile(profile),
      readyTimeoutMs: 10_000,
      execTimeoutMs: 30_000
    })
    return {
      session,
      remoteProjectRoot: project.location.remoteRoot,
      canonicalRemoteProjectRoot: project.location.canonicalRoot,
      hostKey: remoteTransferHostKey(profile.hostAlias),
      workspaceId: createHash('sha256').update(project.location.canonicalRoot).digest('hex')
    }
  }
})
remoteProjectUploads.subscribe((job) => {
  sendToAllWindows(IPC.remoteProjectUploads.changed, job)
})
remoteJupyterStartJobs.subscribe((job) => {
  sendToAllWindows(IPC.remoteJupyterJobs.changed, job)
})
const wrapperResultReadControl = createWrapperResultReadControl({
  observeRemote: (projectId, operation) => remoteConnectionTracker.observe(projectId, operation),
  remoteRequestProjectId
})
const wrapperResultDownloads: WrapperResultDownloads = new Map()
subscribeRemoteProjectConnection((projectId, state) => {
  sendToAllWindows(IPC.projects.remoteConnectionChanged, { projectId, state })
})
const connectRemoteWorkspaceHost = async (request: {
  sessionId: string
  projectId: string
  execTimeoutMs: number
}): Promise<import('./agent/wrappers/remote-ssh-session').RemoteSshSession> =>
  (await import('./agent/workspace-host/remote-registry')).remoteWorkspaceHosts.connect(request)
const remoteProjectDownloadManager = new RemoteProjectDownloadManager({
  agentDir: AGENT_DIR
})
getPhiEngine().host.register('remoteWorkspace.download', (params, context) => {
  const request = isRecord(params) ? params : {}
  const control = remoteRuntimeDispatchControl(
    {
      runtimeSessionId: context.originSessionId,
      remoteSessionId: request.sessionId,
      projectId: request.projectId
    },
    context
  )
  return remoteConnectionTracker.observe(remoteRequestProjectId(params), () =>
    remoteProjectDownloadManager.run(params, control)
  )
})
getPhiEngine().host.register('remoteWorkspace.cancelDownload', (params, context) => {
  const request = isRecord(params) ? params : {}
  isRemoteRuntimeCancellation(
    {
      runtimeSessionId: context.originSessionId,
      remoteSessionId: request.sessionId,
      projectId: request.projectId
    },
    context
  )
  return remoteProjectDownloadManager.cancel(params)
})

// Background wrapper runs. The manager lives here, not in the agent worker: a run
// must outlive any chat session, and the worker is stopped whenever it idles.
const wrapperJobs = new WrapperJobManager({
  // Local runs use phi:nextflow@1; a missing environment is offered for building in the chat
  // that started the run.
  nextflowLaunch: {
    builds: environmentBuilds,
    confirmBuild: (request) => confirmEnvironmentBuild(request)
  },
  resolveProjectForRun: (originSessionId) => {
    const origin = sessionOrigins.resolveRecoverableJobOrigin(originSessionId)
    const manifest = origin ? findPhiSessionById(origin.phiSessionId) : null
    if (!manifest) return undefined
    return manifest.projectId ? getProject(manifest.projectId) : null
  },
  // A remote run goes to the HPC connection saved on the project the chat belongs to; a run
  // being resumed after a restart names its project and connection itself.
  resolveRemoteTarget: ({ originSessionId, projectId, connectionId }) => {
    const origin = sessionOrigins.resolveRecoverableJobOrigin(originSessionId)
    const manifest = origin ? findPhiSessionById(origin.phiSessionId) : null
    const project = projectId
      ? getProject(projectId)
      : manifest?.projectId
        ? getProject(manifest.projectId)
        : undefined
    return resolveProjectRemoteTarget(project, connectionId)
  },
  checkRemoteEnvironment: async ({ project, resolved, profile }) => {
    const remoteConnection = project.remoteConnections?.find(
      (connection) => connection.id === resolved.connectionId
    )
    const hostProfileId =
      project.location.kind === 'ssh'
        ? project.location.hostProfileId
        : remoteConnection?.hostProfileId
    if (!hostProfileId) throw new Error('找不到 Wrapper 运行连接的服务器档案')
    const hpc = resolved.target.hpc ?? { scheduler: 'local' as const }
    const controller = hpc.controller ?? 'login'
    const report = await remoteDoctor(
      hostProfileId,
      resolved.target.workspaceRoot,
      {
        scope: 'full',
        scheduler: hpc.scheduler,
        controller,
        runtime: profile,
        ...(remoteConnection?.runtimeRoot
          ? {
              runtimeRootOverride: {
                source: 'project' as const,
                configured: remoteConnection.runtimeRoot
              }
            }
          : {}),
        ...(hpc.nextflowBin ? { nextflowBin: hpc.nextflowBin } : {}),
        ...(hpc.containerRuntimeBin ? { containerRuntimeBin: hpc.containerRuntimeBin } : {})
      },
      { deferToolChecksToLaunch: Boolean(hpc.setupCommands?.length) }
    )
    return {
      report,
      remotePath: resolved.target.workspaceRoot,
      scheduler: hpc.scheduler,
      controller,
      runtime: profile,
      deferToolChecksToLaunch: Boolean(hpc.setupCommands?.length)
    }
  }
})
for (const [method, handler] of Object.entries(
  wrapperJobHostHandlers(wrapperJobs, {
    scopeFor: (context) =>
      resolveWrapperJobHostScope(context, {
        resolveOrigin: sessionOrigins.resolveOriginSession,
        findSession: findPhiSessionById,
        getProject,
        ownsRemoteRuntimeSession,
        resolveBinding: resolveRemoteWorkspaceHostBinding,
        resolveTarget: (project) => resolveProjectRemoteTarget(project, undefined),
        readRun: (runId) => readWrapperRun(runId)
      })
  })
)) {
  getPhiEngine().host.register(method, handler)
}
wrapperJobs.onChange((runId) => sendToAllWindows(IPC.wrappers.runsChanged, { runId }))

const browserToolHostCoordinator = new BrowserToolHostCoordinator({
  resolveActiveRun: (originSessionId) => {
    const run = findActivePromptRunByRuntimeSessionId(originSessionId)
    return run ? { runId: run.runId, cancelled: run.cancelled } : undefined
  },
  executeAgent: (params, signal, control) =>
    browserIpcCoordinator.executeAgent(params, signal, control)
})

function cancelBrowserRun(run: PromptRun): void {
  browserToolHostCoordinator.cancelRun(run.runId, run.session?.runtimeSessionId)
}

async function cleanupBrowserRunTabs(run: PromptRun): Promise<void> {
  try {
    await runtime.workspaceServices.browserWorkspaceRegistry?.disposeRun(
      run.phiSessionId,
      run.runId
    )
  } catch {
    writeAppLog({ level: 'error', event: 'browser_run_cleanup_failed' })
  }
}

function browserChildDispatchControl(
  params: unknown,
  context: import('./agent/engine/types').PhiHostRequestContext | undefined
): import('./agent/browser/browser-tool-host').BrowserToolDispatchControl | undefined {
  if (!context?.agentRunId) return undefined
  const runtimeId = isRecord(params) ? optionalStringField(params, 'originSessionId') : undefined
  if (!runtimeId || context.originSessionId !== runtimeId)
    throw new Error('专家浏览器请求缺少已验证的来源')
  const origin = sessionOrigins.resolveOriginSession(runtimeId)
  const manifest = origin && findPhiSessionById(origin.phiSessionId)
  if (!ownsRemoteRuntimeSession(runtimeId)) {
    if (manifest?.projectLocation?.kind === 'ssh') throw new Error('远程专家浏览器连接不可用')
    return undefined
  }
  if (!origin || !manifest?.projectId || !context.signal)
    throw new Error('专家浏览器请求缺少独立运行范围')
  const control = remoteRuntimeDispatchControl(
    {
      runtimeSessionId: runtimeId,
      remoteSessionId: origin.phiSessionId,
      projectId: manifest.projectId
    },
    context
  )!
  return {
    runId: context.agentRunId,
    signal: context.signal,
    allowTypeText: false,
    assertCurrent: control.beforeDispatch
  }
}
getPhiEngine().host.register('browser.execute', (params, context) =>
  browserToolHostCoordinator.execute(params, browserChildDispatchControl(params, context))
)
getPhiEngine().host.register('browser.cancel', (params, context) => {
  if (context?.agentRunId) {
    if (!isRecord(params) || context.originSessionId !== params.originSessionId)
      throw new Error('专家浏览器取消请求的来源不匹配')
    // Terminal cancellation uses only the captured child ID, never a successor's active run.
    return browserToolHostCoordinator.cancel(params, { runId: context.agentRunId })
  }
  return browserToolHostCoordinator.cancel(params)
})
const backgroundAgentJobListingOptions = {
  agentDir: AGENT_DIR,
  resolveRecoverableJobOrigin: sessionOrigins.resolveRecoverableJobOrigin,
  currentRuntimeOriginScope: sessionOrigins.currentRuntimeOriginScope,
  optionalStringField
}
const backgroundShellJobOperationsOptions = {
  resolveOriginSession: sessionOrigins.resolveOriginSession,
  optionalStringField
}
const backgroundJobOperations = {
  listAgentJobs: () => listBackgroundAgentJobs(backgroundAgentJobListingOptions),
  listShellJobs: () => listBackgroundShellJobs(backgroundShellJobOperationsOptions),
  stopShellJob: stopBackgroundShellJob
}

function sendRunEventToWindow(payload: Record<string, unknown>): void {
  sendToWindow(getActiveWindow(), IPC.agent.event, {
    ...payload,
    sessionPath: phiOnlySessionPath(String(payload.phiSessionId))
  })
}

function showRunNotification({ title, body }: { title: string; body: string }): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({ title, body })
  notification.on('click', () => {
    const window = getActiveWindow()
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })
  notification.show()
}

wrapperJobs.onFinish((run, status) => {
  const liveOrigin = sessionOrigins.resolveOriginSession(run.originSessionId)
  if (status.state === 'lost' && run.remote?.projectId) {
    remoteConnectionTracker.noteRemoteRunLost(run.remote.projectId)
  }
  return deliverWrapperRunFinished(run, status, {
    resolveSession: sessionOrigins.resolveRecoverableJobOrigin,
    appendToSession: (phiSessionId, event) => appendSessionEvent(phiSessionId, { ...event }),
    sendToWindow: sendRunEventToWindow,
    isAppFocused: () => BrowserWindow.getFocusedWindow() !== null,
    continueConversation: liveOrigin ? continueConversationAfterWrapperRun : async () => undefined,
    showOsNotification: showRunNotification,
    getUiLanguage: () => readAppSettings().uiLanguage
  })
})

// Background agent runs live in the agent worker, one registry per conversation; the worker
// tells us here when one ends, or when the main agent has already collected its report.
for (const [method, handler] of Object.entries(
  agentRunHostHandlers({
    resolveSession: sessionOrigins.resolveOriginSession,
    appendToSession: (phiSessionId, event) => appendSessionEvent(phiSessionId, { ...event }),
    sendToWindow: sendRunEventToWindow,
    isAppFocused: () => BrowserWindow.getFocusedWindow() !== null,
    continueConversation: continueConversationAfterAgentRun,
    showOsNotification: showRunNotification,
    getUiLanguage: () => readAppSettings().uiLanguage,
    redact: redactSensitiveText,
    persistStepOutput: (phiSessionId, toolCallId, stepId, output) =>
      persistToolOutput(phiSessionId, {
        runId: 'agent-run',
        toolCallId: `${toolCallId}-${stepId}`,
        output,
        inlineLimit: TOOL_OUTPUT_INLINE_LIMIT
      }),
    redactValue: redactStructuredValue,
    markReported: (phiSessionId, agentRunId) => markAgentRunReported(phiSessionId, agentRunId),
    clearReported: (phiSessionId, agentRunId) => clearAgentRunReported(phiSessionId, agentRunId),
    deliverHostRun: (runtimeSessionId, run) => agentRunCompletions.deliver(runtimeSessionId, run)
  })
)) {
  getPhiEngine().host.register(method, handler)
}

function optionalStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function findActivePromptRunByRuntimeSessionId(runtimeSessionId: string): PromptRun | null {
  return (
    promptRuns.findActiveRun((run) => run.session?.runtimeSessionId === runtimeSessionId) ?? null
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function broadcastSessionTimelineEvent(sessionId: string, event: StoredSessionEvent): void {
  const run = promptRuns.findActiveRun((item) => item.phiSessionId === sessionId)
  if (!run) return

  const targetWindow = getActiveWindow()
  sendToWindow(targetWindow, IPC.agent.event, {
    source: 'phi',
    ...event,
    phiSessionId: run.phiSessionId,
    sessionGeneration: run.sessionGeneration,
    sessionPath: run.sessionPath ?? run.session?.sessionFile ?? null,
    cwd: run.cwd
  })
}

function logUnexpectedError(error: unknown): void {
  const message = errorMessage(error)
  writeAppLog({
    level: 'error',
    event: 'error_summary',
    metadata: { message }
  })
}

function deleteActivePromptRun(sessionKey: string, run: PromptRun): void {
  cancelBrowserRun(run)
  void cleanupBrowserRunTabs(run)
  promptRuns.deleteActiveRunIfCurrent(sessionKey, run)
}

function linkMaterializedRuntimeSessionPath(
  sessionKey: string,
  cwd: string,
  sessionFile: string | undefined,
  phiSessionId?: string
): void {
  const path = sessionKeyLinking.runtimeSessionPath(sessionFile)
  if (!path) return

  const materializedKey = sessionKeys.createKey(path, cwd)
  sessionKeyLinking.aliasMaterializedSessionPath(sessionKey, path, cwd)
  if (phiSessionId) {
    sessionKeys.setPhiSessionId(sessionKey, phiSessionId)
    sessionKeys.setPhiSessionId(materializedKey, phiSessionId)
    sessionKeyLinking.updatePhiRuntimeSessionPath(phiSessionId, path)
  }
  if (phiSessionId) {
    sessionKeyLinking.linkPhiManagedSessionKey(sessionKey, cwd, phiSessionId)
    return
  }
  sessionState.linkMaterializedSessionKey(
    sessionKey,
    materializedKey,
    sessionKeys.sameCanonical.bind(sessionKeys)
  )
}

function linkPromptRunRuntimeSessionPath(
  sessionKey: string,
  cwd: string,
  promptRun: PromptRun,
  session: AgentSessionInstance
): void {
  const path = sessionKeyLinking.runtimeSessionPath(session.sessionFile)
  if (!path) return
  promptRun.sessionPath = phiOnlySessionPath(promptRun.phiSessionId)
  linkMaterializedRuntimeSessionPath(sessionKey, cwd, path, promptRun.phiSessionId)
}

function runtimeSessionPathForSnapshot(
  sessionKey: string,
  snapshot: SessionSnapshot
): string | undefined {
  return (
    sessionResolution.findPhiManifestForSession(sessionKey, snapshot.path, snapshot.cwd)
      ?.runtimeSessionPath ?? sessionKeyLinking.runtimeSessionPath(snapshot.path)
  )
}

function uiSessionPathForKey(sessionKey: string, fallbackPath: string | undefined): string | null {
  const phiSessionId = sessionKeys.phiSessionIdFor(sessionKey)
  return phiSessionId ? phiOnlySessionPath(phiSessionId) : (fallbackPath ?? null)
}

// Waking a conversation when a background run it started has ended: a wrapper run, or a
// specialist agent run. The policy and the message are in job-continue.ts and run-continue.ts;
// this is the plumbing, shared by both so they count against one cap and can be reported in one
// message. State is per Phi conversation.
const automaticContinuations = new Map<string, number>()
const pendingContinuations = new Map<string, ContinuationEvent[]>()
// Agent runs whose report the main agent was already handed (agent_wait / agent_status), so no
// wake-up repeats it. Wrapper has the same in `wrapperJobs.hasBeenReported`.
const reportedAgentRuns = new Map<string, Set<string>>()

function markAgentRunReported(phiSessionId: string, agentRunId: string): void {
  reportedAgentRuns.set(
    phiSessionId,
    (reportedAgentRuns.get(phiSessionId) ?? new Set()).add(agentRunId)
  )
}

function clearAgentRunReported(phiSessionId: string, agentRunId: string): void {
  reportedAgentRuns.get(phiSessionId)?.delete(agentRunId)
}

function hasAgentRunBeenReported(phiSessionId: string, agentRunId: string): boolean {
  return reportedAgentRuns.get(phiSessionId)?.has(agentRunId) === true
}

function startAutomaticContinuation(
  phiSessionId: string,
  events: readonly ContinuationEvent[]
): void {
  const manifest = findPhiSessionById(phiSessionId)
  if (!manifest) return
  const sessionKey = sessionKeys.createPhiKey(manifest.sessionId, manifest.cwd)
  sessionKeyLinking.linkPhiManagedSessionKey(sessionKey, manifest.cwd, manifest.sessionId)
  preferences.permissionModes.set(sessionKeys.canonicalize(sessionKey), manifest.permissionMode)
  automaticContinuations.set(phiSessionId, (automaticContinuations.get(phiSessionId) ?? 0) + 1)

  void submitPromptRun({
    sessionKey,
    snapshot: {
      path: undefined,
      cwd: manifest.cwd,
      permissionMode: manifest.permissionMode
    },
    text: continuationPrompt(events),
    promptTarget: null,
    automatic: true
  }).catch((error: unknown) => {
    logUnexpectedError(error)
    writeAppLog({
      level: 'error',
      event: 'wrapper_run_continue_failed',
      metadata: {
        phiSessionId,
        error: errorMessage(error)
      }
    })
  })
}

function continueConversationAfterWrapperRun(
  phiSessionId: string,
  event: WrapperRunFinishedEvent,
  run: WrapperRun
): void {
  const decision = shouldContinueConversation({
    run,
    state: event.state,
    automaticCount: automaticContinuations.get(phiSessionId) ?? 0
  })
  if (!decision.continue) {
    if (decision.reason === 'limit') {
      writeAppLog({
        event: 'wrapper_run_continue_limit',
        metadata: { phiSessionId, wrapperRunId: event.wrapperRunId }
      })
    }
    return
  }
  wakeConversation(phiSessionId, event)
}

function continueConversationAfterAgentRun(
  phiSessionId: string,
  event: AgentRunFinishedEvent
): void {
  const decision = shouldContinueAfterAgentRun({
    state: event.state,
    automaticCount: automaticContinuations.get(phiSessionId) ?? 0
  })
  if (!decision.continue) {
    if (decision.reason === 'limit') {
      writeAppLog({
        event: 'agent_run_continue_limit',
        metadata: { phiSessionId, agentRunId: event.agentRunId }
      })
    }
    return
  }
  wakeConversation(phiSessionId, event)
}

/** Wakes the conversation when its run or manual compaction has settled. */
function wakeConversation(phiSessionId: string, event: ContinuationEvent): void {
  const manifest = findPhiSessionById(phiSessionId)
  if (!manifest) return
  if (
    promptRuns.hasActiveRun(sessionKeys.createPhiKey(manifest.sessionId, manifest.cwd)) ||
    promptRuns.manualCompactionIds.has(phiSessionId)
  ) {
    // Keep the report for the next turn after the active run or compaction finishes.
    pendingContinuations.set(phiSessionId, [
      ...(pendingContinuations.get(phiSessionId) ?? []),
      event
    ])
    return
  }
  startAutomaticContinuation(phiSessionId, [event])
}

/** A prompt run just ended: deliver what came in meanwhile, unless the user stopped that run. */
function flushPendingContinuations(phiSessionId: string, runWasCancelled: boolean): void {
  const queued = pendingContinuations.get(phiSessionId)
  if (!queued) return
  pendingContinuations.delete(phiSessionId)
  // A run whose outcome the agent was already handed during that turn (it waited for it) needs no announcement.
  const events = queued.filter((event) =>
    event.type === 'agent_run_finished'
      ? !hasAgentRunBeenReported(phiSessionId, event.agentRunId)
      : !wrapperJobs.hasBeenReported(event.wrapperRunId)
  )
  if (runWasCancelled || events.length === 0) return
  try {
    startAutomaticContinuation(phiSessionId, events)
  } catch (error) {
    logUnexpectedError(error)
  }
}

const { resolveTarget: resolvePromptRunTarget, admit: admitPromptRun } =
  createPromptRunAdmission<AgentSessionResult>({
    keys: { canonicalize: (key) => sessionKeys.canonicalize(key) },
    lifecycles: { forKey: (key) => lifecycles.forKey(key) },
    resolution: {
      projectForSession: sessionResolution.projectForSession,
      resolveSessionModelSelection: sessionResolution.resolveSessionModelSelection
    },
    linking: { ensurePhiSessionId: sessionKeyLinking.ensurePhiSessionId },
    sessions: { findById: findPhiSessionById },
    runs: {
      hasActiveRun: (key) => promptRuns.hasActiveRun(key),
      runtimeRecoveryOperations: promptRuns.runtimeRecoveryOperations,
      manualCompactionIds: promptRuns.manualCompactionIds
    },
    paths: {
      phiOnlySessionPath,
      isRemoteAnchorPath: (cwd) => isRemoteProjectAnchorPath(cwd)
    },
    createRunId
  })

const promptRunStart = createPromptRunStart({
  runs: {
    advanceGeneration: (key) => promptRuns.advanceGeneration(key),
    setActiveRun: (key, run) => promptRuns.setActiveRun(key, run),
    activeRuns: () => promptRuns.activeRuns()
  },
  continuations: { delete: (phiSessionId) => automaticContinuations.delete(phiSessionId) },
  images: { persist: (phiSessionId, images) => persistPromptImages(phiSessionId, images) },
  events: { append: (phiSessionId, event) => appendSessionEvent(phiSessionId, event) },
  cleanup: {
    deleteActiveRun: (sessionKey, run) => deleteActivePromptRun(sessionKey, run)
  },
  notify: {
    parallelRun: (sessionGeneration, sessionPath, cwd, activeCount) =>
      notifyProjectParallelRun(sessionGeneration, sessionPath, cwd, activeCount)
  }
})

const sessionCreationContextDependencies = {
  getPromptGeneration: promptRuns.generationFor.bind(promptRuns),
  getActiveRun: promptRuns.activeRun.bind(promptRuns),
  findManifest: sessionResolution.findPhiManifestForSession,
  getProject,
  getProjectByCwd,
  normalizeMemory: normalizeProjectMemorySettings,
  remoteBinding: (input: { sessionId: string; projectId: string }) =>
    resolveRemoteWorkspaceHostBinding(input).cacheKey
}
const sessionCreationApprovalDependencies = createSessionCreationApprovalDependencies({
  classifyLocal: (toolName, input) => skillHost.approvalFor(toolName, input),
  permissionMode: sessionResolution.resolveSessionPermissionMode,
  activeRun: promptRuns.activeRun.bind(promptRuns),
  sessionPath: phiOnlySessionPath,
  background: {
    backgroundRequested: (request) => backgroundAgentApprovals.requested(request),
    backgroundResolved: (approvalId, decision) =>
      backgroundAgentApprovals.resolved(approvalId, decision)
  },
  runner: {
    requested: (sessionId, approvalId, metadata) =>
      runnerRegistry.markNeedsApproval(sessionId, approvalId, metadata),
    approved: (sessionId, approvalId) => runnerRegistry.markApprovalApproved(sessionId, approvalId),
    denied: (sessionId, approvalId) => runnerRegistry.markApprovalDenied(sessionId, approvalId),
    cancelled: (sessionId, approvalId) =>
      runnerRegistry.markApprovalCancelled(sessionId, approvalId)
  }
})
const { subscribeToCreatedSession } = createCreatedSessionEvents({
  state: { promptRuns, sessionKeys },
  persistence: {
    storage: {
      appendSessionEvent,
      persistToolOutput,
      toolOutputInlineLimit: TOOL_OUTPUT_INLINE_LIMIT
    },
    extractAssistantText: extractAssistantMessageText,
    redactStructuredValue
  },
  runtime: {
    redactSensitiveText,
    abortSessionWithoutCancellingApprovals,
    phiOnlySessionPath
  },
  events: {
    publish: (payload) => sendToWindow(getActiveWindow(), IPC.agent.event, payload),
    logUnexpectedError
  }
})
const { getAgentSession } = createAgentSessionCreation({
  workspace: {
    agentDir: AGENT_DIR,
    getPersonaMarkdown,
    getBundledAgentsDir
  },
  state: {
    sessionState,
    sessionKeys,
    lifecycles,
    promptRuns,
    modelSelections: preferences.modelSelections
  },
  context: sessionCreationContextDependencies,
  sessions: {
    resolution: sessionResolution,
    origins: sessionOrigins,
    findById: findPhiSessionById,
    updateManifest: updateSessionManifest,
    appendEvent: appendSessionEvent,
    runtimeSessionPathForSnapshot,
    uiSessionPathForKey,
    linkPromptRunRuntimeSessionPath,
    linkMaterializedRuntimeSessionPath,
    notifySessionChanged
  },
  runtime: {
    getModelRuntime: () => getAuthManager().getRuntime(),
    resolveRuntimeModelSelection,
    selectionThinking,
    createSessionManager,
    createRemoteSessionManager: createAppRemoteSessionManager,
    createAgentSession,
    ownsRemoteRuntimeSession,
    projectRemoteRuntimeRoot,
    requireProject,
    loadRemoteProjectInstructions
  },
  resources: {
    notebook: {
      getProjectByCwd,
      status: (cwd) => jupyterServerRegistry.status(cwd),
      activePath: (cwd) => activeNotebookPathByProjectCwd.get(cwd),
      list: listProjectNotebooks
    },
    createApprovalExtensions: createSessionCreationExtensionFactories,
    approvalDependencies: sessionCreationApprovalDependencies,
    writeAppLog
  },
  linking: { recordRuntimeOrigin: registerRuntimeSessionOrigin },
  events: {
    publish: (payload) => sendToWindow(getActiveWindow(), IPC.agent.event, payload),
    subscribeToCreatedSession
  },
  cleanup: {
    getSessionControllerKey,
    abortAndDisposeSession,
    abortSessionWithoutCancellingApprovals,
    logUnexpectedError
  }
})

const promptRunExecutionDeps: PromptRunExecutionDeps<PromptRunContext> = {
  lifecycle: { getPromptGeneration: promptRuns.generationFor.bind(promptRuns) },
  session: {
    getAgentSession,
    applyNextRunConfiguration,
    abortSession,
    abortSessionWithoutCancellingApprovals,
    linkRuntimeSessionPath: (context, session) => {
      linkPromptRunRuntimeSessionPath(
        context.runSessionKey,
        context.runSnapshot.cwd,
        context.promptRun,
        session
      )
    },
    recordMaterialization: (context) => {
      sessionState.recordPromptRunMaterialization(
        context.runSessionKey,
        context.stableSessionPath,
        sessionKeys.sameCanonical.bind(sessionKeys)
      )
    }
  },
  models: { selectableRuntimeModels },
  timeline: { broadcastSessionTimelineEvent, logUnexpectedError }
}

const { submitPromptRun } = createPromptRunQueue({
  admission: { resolve: resolvePromptRunTarget, admit: admitPromptRun },
  start: { allocate: promptRunStart.allocate, prepare: promptRunStart.prepare },
  runs: {
    queueFor: (sessionKey) => promptRuns.queueFor(sessionKey),
    generationFor: (sessionKey) => promptRuns.generationFor(sessionKey),
    setQueue: (sessionKey, queue) => promptRuns.setQueue(sessionKey, queue)
  },
  execution: {
    runner: runnerRegistry,
    execute: (context, signal, setResult) =>
      executePromptRunWithDeps(context, promptRunExecutionDeps, signal, setResult)
  },
  skills: {
    get: (phiSessionId) => loadedSkillNamesBySession.get(phiSessionId),
    set: (phiSessionId, names) => loadedSkillNamesBySession.set(phiSessionId, names),
    resolve: async (cwd) =>
      isRemoteResourceScope(cwd) ? await listRemoteProjectSkills(cwd) : await listSkills(cwd)
  },
  timeline: {
    append: (phiSessionId, event) => appendSessionEvent(phiSessionId, event),
    broadcast: (phiSessionId, event) => broadcastSessionTimelineEvent(phiSessionId, event),
    logUnexpected: (error) => logUnexpectedError(error),
    logSkillLookupFailure: (phiSessionId, error) =>
      writeAppLog({
        event: 'session_loaded_skills_unavailable',
        level: 'warn',
        sessionId: phiSessionId,
        metadata: { error: errorMessage(error) }
      })
  },
  events: {
    notifySessionChanged: () => notifySessionChanged(),
    flushContinuations: (phiSessionId, cancelled) =>
      flushPendingContinuations(phiSessionId, cancelled),
    scheduleTitle: (phiSessionId) => scheduleAutomaticSessionTitle(phiSessionId)
  },
  cleanup: {
    deleteActiveRun: (sessionKey, run) => deleteActivePromptRun(sessionKey, run)
  },
  sleep: { sync: () => syncPreventSleepBlocker() }
})

const automaticTitleJobs = new Map<string, Promise<void>>()
const titleRenameQueues = new Map<string, Promise<void>>()
const manualTitleRequests = new Set<string>()

function sessionTitleContext(path: string): {
  manifest: PhiSessionManifest
  firstUserMessage: string
  userMessage: string
  assistantMessage?: string
} {
  const id = phiSessionIdFromPath(path)
  const manifest = id ? findPhiSessionById(id) : findPhiSessionByRuntimePath(path)
  if (!manifest) throw new Error('请先打开该对话，再生成标题')
  const events = readSessionEvents(manifest.sessionId)
  const userMessages = events
    .filter((event) => event.type === 'user_message' && typeof event.content === 'string')
    .map((event) => messageContentTitleText(event.content as string))
    .filter(Boolean)
  const firstUserMessage = userMessages[0]
  const userMessage = userMessages.find(hasSessionTitleTopic) ?? firstUserMessage
  if (!userMessage) throw new Error('对话还没有可用于生成标题的内容')
  const reply = events.find(
    (event) => event.type === 'assistant_message_finalized' && typeof event.content === 'string'
  )
  return {
    manifest,
    firstUserMessage,
    userMessage,
    ...(reply ? { assistantMessage: reply.content as string } : {})
  }
}

function hasSessionTitleTopic(message: string): boolean {
  return !/^(?:hi|hello|hey|你好|您好|哈喽|嗨|谢谢|thanks|thank you|继续|continue|好的|ok|okay|好)[！!。，,.\s]*$/i.test(
    message.trim()
  )
}

// The title model follows the conversation: its explicit selection, or else the model the
// live session already resolved. An explicit selection that no longer resolves is an error.
async function resolveSessionTitleModel(
  key: string,
  selection: ModelSelection | null,
  signal: AbortSignal
): Promise<{ modelRuntime: ModelRuntime; model: RuntimeModel | undefined }> {
  const modelRuntime = await getAuthManager().getRuntime()
  signal.throwIfAborted()
  let model = selection ? resolveRuntimeModelSelection(modelRuntime, selection)?.model : undefined
  if (!selection) {
    const lifecycle = lifecycles.forKey(key)
    const record = lifecycle.currentRecord
    if (record) {
      const ready = await record.promise
      if (lifecycle.isCurrent(record)) model = ready.session.model
    }
    signal.throwIfAborted()
  }
  if (selection && !model) throw new Error('请先为对话配置可用模型')
  return { modelRuntime, model }
}

function getSessionTitleGenerator(): SessionTitleGenerator {
  if (runtime.window.cleanupStarted) throw new Error('标题生成服务已关闭')
  const cachedGenerator = runtime.caches.sessionTitleGenerator
  if (cachedGenerator) return cachedGenerator
  const generator = new SessionTitleGenerator({
    request: async ({ sessionPath, prompt, signal }) => {
      const { manifest } = sessionTitleContext(sessionPath)
      const key = sessionKeys.createPhiKey(manifest.sessionId, manifest.cwd)
      const selection = sessionResolution.resolveSessionModelSelection(key, {
        path: sessionPath,
        cwd: manifest.cwd,
        permissionMode: manifest.permissionMode
      })
      const { modelRuntime, model } = await resolveSessionTitleModel(key, selection, signal)
      const cwd = getNoProjectTaskFolder()
      let streamedText = ''
      let replyFailed = false
      const { session } = await createAgentSession(
        {
          cwd,
          modelRuntime,
          ...(model ? { model } : {}),
          thinkingLevel: 'minimal',
          noTools: 'all',
          sessionManager: createInMemoryRuntimeSessionManager(cwd)
        },
        (summary) => {
          if (assistantErrorMessageFromEventSummary(summary)) replyFailed = true
          const event = isPhiMessageUpdateSummary(summary)
            ? summary.assistantMessageEvent
            : undefined
          if (event?.type === 'text_delta' && typeof event.delta === 'string') {
            streamedText += event.delta
          }
          const message = isPhiEventType(summary, 'message_end')
            ? summary.message
            : (event?.partial ?? event?.message)
          if ((message as { role?: string } | undefined)?.role === 'assistant') {
            const body = extractAssistantMessageText(message).trim()
            if (body) streamedText = body
          }
        },
        { signal, assertCurrent: () => signal.throwIfAborted() }
      )
      const abort = (): void => {
        void session.abort().catch(logUnexpectedError)
      }
      signal.addEventListener('abort', abort, { once: true })
      try {
        signal.throwIfAborted()
        await session.prompt(prompt, {
          expandPromptTemplates: false,
          userInitiated: true,
          skipCompactionCheck: true
        })
        signal.throwIfAborted()
        const assistant = session.messages.findLast(
          (message) => (message as { role?: string }).role === 'assistant'
        )
        const final = assistant as { stopReason?: string; errorMessage?: unknown } | undefined
        if (
          final?.stopReason === 'error' ||
          final?.stopReason === 'aborted' ||
          final?.errorMessage ||
          (replyFailed && final?.stopReason !== 'stop')
        )
          return ''
        return extractAssistantMessageText(assistant).trim() || streamedText.trim()
      } finally {
        signal.removeEventListener('abort', abort)
        await session.dispose()
      }
    }
  })
  runtime.caches.setSessionTitleGenerator(generator)
  return generator
}

function enqueueSessionTitleWrite<T>(path: string, write: () => Promise<T>): Promise<T> {
  const previous = titleRenameQueues.get(path) ?? Promise.resolve()
  const result = previous.then(write)
  const settled = result.then(
    () => {},
    () => {}
  )
  titleRenameQueues.set(path, settled)
  void settled.then(() => {
    if (titleRenameQueues.get(path) === settled) titleRenameQueues.delete(path)
  })
  return result
}

async function renameConversation(
  path: string,
  name: string,
  source: 'auto' | 'user'
): Promise<void> {
  const id = phiSessionIdFromPath(path)
  if (!id) {
    const current = await getCurrentResolvedSession()
    if (sessionState.sessionPath === path && current) {
      await current.session.sessionManager.setSessionName(name, source)
    } else {
      await renameSession(path, name)
    }
    return
  }

  const manifest = findPhiSessionById(id)
  if (!manifest) throw new Error('会话不存在')
  const rpc = Boolean(manifest.runtimeRef || manifest.projectLocation?.kind === 'ssh')
  if (rpc) {
    const key = sessionKeys.createKey(path, manifest.cwd)
    const captured = captureSessionControlTarget(key, manifest.sessionId, false, true, false)
    const ready = await captured.resolved()
    captured.assertCurrent()
    if (ready) {
      if (!ownsRemoteRuntimeSession(ready.session.runtimeSessionId))
        throw new Error('RPC rename requires an exact live attachment')
      const confirmed = await ready.session.sessionManager.setSessionName(name, source, captured)
      captured.assertCurrent()
      if (!confirmed) throw new Error('远程会话名称尚未确认')
    } else {
      if (manifest.runtimeRef) throw new Error('远程会话名称需要显式恢复后修改')
      await renameSession(path, name)
    }
  } else {
    await renameSession(path, name)
  }
  updateSessionManifest(id, { titleSource: source })
  notifySessionChanged()
}

function scheduleAutomaticSessionTitle(sessionId: string): void {
  if (runtime.window.cleanupStarted || automaticTitleJobs.has(sessionId)) return
  const path = phiOnlySessionPath(sessionId)
  const job = (async () => {
    const context = sessionTitleContext(path)
    const { manifest, userMessage, firstUserMessage } = context
    if (
      manifest.titleSource ||
      !hasSessionTitleTopic(userMessage) ||
      manifest.runtimeRecoveryError ||
      (manifest.title && messageContentTitleText(manifest.title) !== firstUserMessage)
    )
      return
    const target = captureSessionControlTarget(
      sessionKeys.createPhiKey(sessionId, manifest.cwd),
      sessionId,
      false,
      true,
      false
    )
    const title = await getSessionTitleGenerator().generate({ sessionPath: path, ...context })
    if (!title || runtime.window.cleanupStarted) return
    await enqueueSessionTitleWrite(path, async () => {
      if (runtime.window.cleanupStarted) return
      target.assertCurrent()
      const latest = findPhiSessionById(sessionId)
      if (
        !latest ||
        latest.titleSource ||
        latest.title !== manifest.title ||
        latest.runtimeRecoveryError ||
        manualTitleRequests.has(path) ||
        runnerRegistry.getActiveRun(sessionId) ||
        promptRuns.runtimeRecoveryOperations.has(sessionId)
      )
        return
      await renameConversation(path, title, 'auto')
    })
  })()
    .catch(() => {
      writeAppLog({ level: 'warn', event: 'session_auto_title_unavailable', sessionId })
    })
    .finally(() => {
      if (automaticTitleJobs.get(sessionId) === job) automaticTitleJobs.delete(sessionId)
    })
  automaticTitleJobs.set(sessionId, job)
}

function isUsableWindow(window: BrowserWindow | null): window is BrowserWindow {
  return Boolean(window && !window.isDestroyed() && !window.webContents.isDestroyed())
}

function isDisposedFrameSendError(error: unknown): boolean {
  const message = errorMessage(error)
  return (
    message.includes('Render frame was disposed before WebFrameMain could be accessed') ||
    message.includes('Object has been destroyed')
  )
}

function sendToWindow(window: BrowserWindow | null, channel: string, ...args: unknown[]): boolean {
  if (!isUsableWindow(window)) return false
  try {
    window.webContents.send(channel, ...args)
    return true
  } catch (error) {
    if (isDisposedFrameSendError(error)) return false
    throw error
  }
}
function sendToAllWindows(channel: string, ...args: unknown[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    sendToWindow(window, channel, ...args)
  }
}

function getActiveWindow(): BrowserWindow | null {
  const focusedWindow = BrowserWindow.getFocusedWindow()
  if (isUsableWindow(focusedWindow)) return focusedWindow
  return BrowserWindow.getAllWindows().find((window) => isUsableWindow(window)) ?? null
}

function notifyToolApprovalsCancelled(): void {
  sendToAllWindows(IPC.tool.approvalCancelled)
}

function notifyAgentUserInteractionsCancelled(): void {
  sendToAllWindows(IPC.agent.interactionCancelled)
}

function notifyAnalysisNotebookDraftChanged(change: {
  source: string
  projectCwd: string
  path: string
  relativePath: string
  document: NotebookDocument
  savedRevision: string
  contentHash?: string
  changeKind?: string
  changedCellId?: string
  focusCellId?: string
}): void {
  sendToAllWindows(IPC.analysis.notebookDraftChanged, change)
}

function notifyAnalysisNotebookFileChanged(change: unknown): void {
  sendToAllWindows(IPC.analysis.notebookFileChanged, change)
}

function cancelPendingToolApprovals(scope?: { sessionId: string; runId: string }): void {
  const cancelled = cancelToolApprovals(scope) ?? []
  if (!scope) {
    notifyToolApprovalsCancelled()
    return
  }
  for (const request of cancelled) {
    sendToAllWindows(IPC.tool.approvalCancelled, request.requestId)
  }
}

function cancelPendingAgentUserInteractions(): void {
  cancelAgentUserInteractions()
  notifyAgentUserInteractionsCancelled()
}

function cancelPendingRunWaits(scope?: { sessionId: string; runId: string }): void {
  cancelPendingToolApprovals(scope)
  cancelPendingAgentUserInteractions()
}

async function abortSession(session: AgentSessionInstance): Promise<void> {
  cancelPendingRunWaits()
  await session.abort()
}

async function abortSessionWithoutCancellingApprovals(
  session: AgentSessionInstance
): Promise<void> {
  await session.abort({ preserveApprovals: true })
}

const { capture: captureSessionControlTarget } = createSessionControlTarget<AgentSessionResult>({
  state: {
    currentSessionKey: () => sessionState.sessionKey,
    currentPayload: getCurrentSessionPayload,
    keys: {
      canonicalize: (key) => sessionKeys.canonicalize(key),
      sameCanonical: (left, right) => sessionKeys.sameCanonical(left, right),
      phiSessionIdFor: (key) => sessionKeys.phiSessionIdFor(key)
    },
    lifecycles: { forKey: (key) => lifecycles.forKey(key) },
    runs: {
      generationFor: (key) => promptRuns.generationFor(key),
      hasActiveRun: (key) => promptRuns.hasActiveRun(key),
      manualCompactionIds: promptRuns.manualCompactionIds
    },
    runnerActiveRun: (phiSessionId) => runnerRegistry.getActiveRun(phiSessionId)
  },
  sessions: {
    findById: (phiSessionId) => findPhiSessionById(phiSessionId),
    get: (key, snapshot, control) => getAgentSession(key, snapshot, control)
  },
  projects: {
    get: (projectId) => getProject(projectId),
    hostProfile: (profileId) => getRemoteHostProfile(profileId),
    connectionConfig: (profile) => remoteConnectionConfigForProfile(profile)
  }
})

function notifySessionChanged(): void {
  const payload = getCurrentSessionPayload()
  void runtime.workspaceServices.browserWorkspaceRegistry
    ?.setActiveSession(browserPresentationSessionId(payload.phiSessionId))
    .catch(() => {
      writeAppLog({ level: 'error', event: 'browser_presentation_transition_failed' })
    })
  sendToAllWindows(IPC.sessions.changed, payload)
}

function notifyProjectParallelRun(
  sessionGeneration: number,
  sessionPath: string | undefined,
  cwd: string,
  activeCount: number
): void {
  const window = getActiveWindow()
  sendToWindow(window, IPC.agent.event, {
    type: 'project_parallel_warning',
    sessionGeneration,
    sessionPath: sessionPath ?? null,
    cwd,
    activeCount
  })
}

const { stopPromptRun, stopAllPromptRuns } = createPromptRunStop<PromptRun, AgentSessionInstance>({
  runs: {
    advanceGeneration: (key) => promptRuns.advanceGeneration(key),
    activeRuns: () => promptRuns.activeRuns(),
    activeEntries: () => promptRuns.activeEntries(),
    runtimeRecoveryOperations: promptRuns.runtimeRecoveryOperations
  },
  browser: { cancel: cancelBrowserRun, cleanup: cleanupBrowserRunTabs },
  agents: {
    stop: (phiSessionId) => runnerRegistry.stopRun(phiSessionId),
    stopAll: () => runnerRegistry.stopAll()
  },
  waits: { cancel: (scope) => cancelPendingRunWaits(scope) },
  sessions: { abort: abortSessionWithoutCancellingApprovals }
})

function safeCleanupStep(event: string, run: () => void | Promise<void>): Promise<void> {
  try {
    return Promise.resolve(run()).catch(() => {
      writeAppLog({ level: 'error', event })
    })
  } catch {
    writeAppLog({ level: 'error', event })
    return Promise.resolve()
  }
}

function cleanupMainWindowRuntime(): Promise<void> {
  return runtime.window.beginCleanup(
    () => runtime.caches.disposeSessionTitleGenerator(),
    async () => {
      let promptShutdown = {
        browserCleanup: Promise.resolve(),
        runtimeAbort: Promise.resolve()
      }
      try {
        promptShutdown = stopAllPromptRuns()
      } catch {
        writeAppLog({ level: 'error', event: 'prompt_shutdown_failed' })
      }
      void promptShutdown.runtimeAbort.catch(() => {
        writeAppLog({ level: 'error', event: 'agent_runtime_abort_failed' })
      })
      await Promise.allSettled([
        promptShutdown.browserCleanup,
        safeCleanupStep('terminal_cleanup_failed', () => disposeTerminalManager()),
        safeCleanupStep('notebook_watcher_cleanup_failed', () => notebookFileWatcher.dispose()),
        safeCleanupStep('jupyter_cleanup_failed', () => jupyterServerRegistry.disposeAll()),
        safeCleanupStep('remote_jupyter_cleanup_failed', disposeRemoteNotebookBackends),
        safeCleanupStep('remote_upload_cleanup_failed', () => remoteProjectUploads.dispose()),
        safeCleanupStep('agent_session_cleanup_failed', () => invalidateAgentSession()),
        safeCleanupStep('cursor_bridge_cleanup_failed', () => cursorH2Bridge.close())
      ])
      await Promise.allSettled([cleanupBrowserWorkspaceRegistry()])
    }
  )
}

async function applyNextRunConfiguration(
  session: AgentSessionInstance,
  sessionKey: string,
  snapshot: SessionSnapshot
): Promise<void> {
  const manifest = sessionResolution.findPhiManifestForSession(
    sessionKey,
    snapshot.path,
    snapshot.cwd
  )
  if (session.runtimeSessionId && ownsRemoteRuntimeSession(session.runtimeSessionId)) {
    // The selected RPC generation already owns this saved policy. Unsupported changes are explicit.
    const selection = sessionResolution.resolveSessionModelSelection(sessionKey, snapshot)
    if (
      !selection ||
      selection.providerId !== session.model?.provider ||
      selection.modelId !== session.model?.id ||
      selectionThinking(
        session.model!,
        sessionResolution.resolveSessionThinkingLevel(sessionKey, snapshot)
      ).phi !== session.thinkingLevel
    )
      throw new Error('RPC model/thinking changes require a supported remote control path')
    return
  }
  await session.setAutoCompactionSettings(manifest?.autoCompaction ?? {})
  const runtime = await getAuthManager().getRuntime()
  const modelSelection = sessionResolution.resolveSessionModelSelection(sessionKey, snapshot)
  if (modelSelection) {
    const resolvedModel = resolveRuntimeModelSelection(runtime, modelSelection)
    if (!resolvedModel) {
      throw new Error(`模型不可用: ${modelSelectionLabel(modelSelection)}`)
    }
    await session.setModel(resolvedModel.model)
  }
  await session.setThinkingLevel(
    sessionResolution.resolveSessionThinkingLevel(sessionKey, snapshot)
  )
}

function createMainBrowserWindow(): BrowserWindow {
  // Create the browser window.
  const window = new BrowserWindow({
    title: APP_NAME,
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    transparent: false,
    // macOS titleBarStyle paints a system sidebar material behind the left pane.
    // Use a frameless window and opt the traffic lights back in so the renderer
    // owns every background pixel.
    ...(process.platform === 'darwin' ? { frame: false } : {}),
    backgroundMaterial: 'none',
    // Hidden until the renderer supplies its selected theme and first content frame.
    backgroundColor: '#FFFFFF',
    icon: appIcon,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })
  runtime.window.setMainWindow(window)
  return window
}

function createMainWindowStartupCoordinator(
  window: BrowserWindow
): ReturnType<typeof createMainWindowStartup> {
  const startup = createMainWindowStartup(
    window,
    (reason) => {
      finishStartupSplash(window)
      writeAppLog({ level: 'error', event: 'window_startup_failed', metadata: { reason } })
      const dialogCopy = nativeUiCopy(readAppSettings().uiLanguage)
      void dialog
        .showMessageBox({
          type: 'error',
          title: APP_NAME,
          message: dialogCopy.startupFailed,
          detail: dialogCopy.startupRecovery,
          buttons: [dialogCopy.reload, dialogCopy.close],
          defaultId: 0,
          cancelId: 1,
          noLink: true
        })
        .then(({ response }) => {
          if (window.isDestroyed()) return
          if (response === 0) {
            if (startup.retry()) window.webContents.reload()
          } else {
            window.close()
          }
        })
        .catch(() => {
          if (!window.isDestroyed()) window.close()
        })
    },
    15_000,
    () => finishStartupSplash(window)
  )
  return startup
}

function registerMainWindowStartupHandlers(
  window: BrowserWindow,
  startup: ReturnType<typeof createMainWindowStartup>
): void {
  mainWindowStartups.set(window, startup)
  window.webContents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) startup.fail('main-frame-load-failed')
  })
  window.webContents.on('render-process-gone', () => startup.fail('renderer-process-gone'))
  window.webContents.setBackgroundThrottling(false)
}

function registerMacMainWindowHandlers(window: BrowserWindow): void {
  if (process.platform === 'darwin') {
    window.setVibrancy(null)
    window.setWindowButtonVisibility(false)
    window.webContents.on('did-finish-load', () => {
      sendMainWindowFullscreenState(window, window.isFullScreen())
    })
    // In fullscreen the renderer hides its drawn traffic lights; hand the job back to macOS so the
    // native buttons slide in with the menu bar when the pointer reaches the top edge.
    window.on('enter-full-screen', () => {
      if (!window.isDestroyed()) window.setWindowButtonVisibility(true)
      sendMainWindowFullscreenState(window, true)
    })
    window.on('leave-full-screen', () => {
      if (!window.isDestroyed()) window.setWindowButtonVisibility(false)
      sendMainWindowFullscreenState(window, false)
    })
  }
}

function registerMainWindowLifecycleHandlers(
  window: BrowserWindow,
  startup: ReturnType<typeof createMainWindowStartup>
): void {
  window.once('ready-to-show', startup.painted)

  window.on('close', () => {
    void cleanupMainWindowRuntime()
  })

  window.on('closed', () => {
    startup.dispose()
    runtime.window.clearMainWindow(window)
  })
}

function registerMainWindowNavigationHandlers(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler((details) => {
    return routeBrowserAppShellWindowOpen({
      details,
      coordinator: browserIpcCoordinator,
      policyContext: browserPolicyContext(),
      openExternal: (url) => shell.openExternal(url)
    })
  })

  window.webContents.on('will-frame-navigate', (event) => {
    if (
      shouldBlockHtmlReportNavigation({
        isMainFrame: event.isMainFrame,
        frameName: event.frame?.name,
        url: event.url
      })
    ) {
      event.preventDefault()
    }
  })
}

function loadMainWindow(
  window: BrowserWindow,
  startup: ReturnType<typeof createMainWindowStartup>
): void {
  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void window
      .loadURL(process.env['ELECTRON_RENDERER_URL'])
      .catch(() => startup.fail('load-failed'))
  } else {
    void window
      .loadFile(join(import.meta.dirname, '../renderer/index.html'))
      .catch(() => startup.fail('load-failed'))
  }
}

function createWindow(): void {
  runtime.window.resetCleanup()
  const window = createMainBrowserWindow()
  const startup = createMainWindowStartupCoordinator(window)
  registerMainWindowStartupHandlers(window, startup)
  registerMacMainWindowHandlers(window)
  registerMainWindowLifecycleHandlers(window, startup)
  registerMainWindowNavigationHandlers(window)
  loadMainWindow(window, startup)
}

registerNotebookOutputScheme()

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
function prepareStartupInterface(): void {
  try {
    configureSystemUiLanguage(app.getPreferredSystemLanguages())
  } catch {
    configureSystemUiLanguage([])
  }
  installNotebookOutputProtocol()
  applyDockIcon()
  runtime.window.setMenuBarController(
    createMacMenuBar({
      getUiLanguage: () => readAppSettings().uiLanguage,
      openWindow: showMainWindowFromMenuBar,
      queueAction: queueMenuBarAction,
      hideWindow: hideMainWindowFromMenuBar,
      canHideWindow: () => {
        const mainWindow = runtime.window.mainWindow
        return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible())
      },
      quit: () => app.quit()
    })
  )
}

function openStartupSplash(): ReturnType<typeof createStartupSplashWindow> {
  return createStartupSplashWindow(
    (options) => new BrowserWindow(options),
    appIcon.isEmpty() ? '' : appIcon.toDataURL(),
    Date.now,
    readAppSettings().uiLanguage
  )
}

function runStartupMaintenance(): void {
  const removedLogs = cleanupOldLogs()
  try {
    cleanupStalePackageStaging({ agentDir: AGENT_DIR })
  } catch (error) {
    writeAppLog({
      level: 'error',
      event: 'package_staging_cleanup_failed',
      metadata: { error: errorMessage(error) }
    })
  }
  writeAppLog({ event: 'app_started', metadata: { removedOldLogs: removedLogs } })
  migrateEnablementFromHistory(['create-wrapper'], { agentDir: AGENT_DIR })
}

function migrateStartupPluginEnablement(): void {
  migratePluginEnablement(AGENT_DIR, getRuntimeRoot)
}

function recoverStartupState(): void {
  // Domain packages are installed only after a catalog choice. Core runtime assets remain bundled.
  mkdirSync(sessionState.cwd, { recursive: true })
  recoverInterruptedPhiSessions()
  // Wrapper packages are installed from the catalogue only after a user choice.
  // Keep legacy user-authored wrappers available without seeding every bundled package.
  try {
    const migratedCustom = migrateLegacyCustomWrappers(AGENT_DIR)
    if (migratedCustom.length > 0) {
      writeAppLog({ event: 'wrapper_custom_migrated', metadata: { ids: migratedCustom } })
    }
    resetWrapperCompositionCatalogCache()
  } catch (error) {
    writeAppLog({
      level: 'error',
      event: 'wrapper_custom_migration_failed',
      metadata: { error: errorMessage(error) }
    })
  }
  void startLegacyBundledCleanup({ agentDir: AGENT_DIR, appVersion: app.getVersion() })
  // Fire-and-forget: resumes remote Slurm and detached runs left mid-flight by
  // the previous app session (see executor-slurm-reconcile.ts's doc comment).
  // Must never block startup — a network hiccup here shouldn't delay the window.
  void reconcileRemoteWrapperRuns().catch((error: unknown) => {
    writeAppLog({
      level: 'error',
      event: 'wrapper_remote_run_reconcile_failed',
      metadata: { error: errorMessage(error) }
    })
  })
  // Agent-started (wrapper_run) local runs cannot outlive the worker that owned
  // them: anything still non-terminal from the previous session is `lost`.
  try {
    const lost = markInterruptedCompositionRuns()
    if (lost > 0) {
      writeAppLog({ event: 'wrapper_composition_runs_marked_lost', metadata: { count: lost } })
    }
  } catch (error) {
    writeAppLog({
      level: 'error',
      event: 'wrapper_composition_run_reconcile_failed',
      metadata: { error: errorMessage(error) }
    })
  }
  // Remote runs are the exception: they kept running on the cluster while Phi was closed, so
  // watch them again (any that cannot be reached are recorded `lost`).
  void wrapperJobs
    .adoptRemoteRuns()
    .then((adopted) => {
      if (adopted > 0) {
        writeAppLog({ event: 'wrapper_remote_runs_adopted', metadata: { count: adopted } })
      }
    })
    .catch((error) => {
      writeAppLog({
        level: 'error',
        event: 'wrapper_remote_run_adopt_failed',
        metadata: { error: errorMessage(error) }
      })
    })
}

function configureStartupWindowDefaults(): void {
  // Set app user model id for windows
  electronApp.setAppUserModelId(APP_ID)

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
}

function registerWindowAndFileIpc(): FilesIpcOptions {
  // IPC test
  registerSystemIpc({ ipcMain })
  registerBrowserRendererIpc(ipcMain, browserIpcCoordinator)
  registerTerminalRendererIpc(ipcMain, terminalIpcCoordinator)
  registerSshBootstrapIpc(
    ipcMain,
    () => runtime.window.mainWindow?.webContents ?? null,
    createDefaultSshBootstrapCoordinator()
  )
  registerRemoteMicromambaIpc(ipcMain)
  registerRemoteRipgrepIpc(ipcMain)
  registerWindowIpc({
    ipcMain,
    getActiveWindow,
    requireMainWindowRenderer,
    getWindowStartup: (window) => mainWindowStartups.get(window)
  })
  registerMenuBarIpc({
    ipcMain,
    requireMainWindowRenderer,
    consumePendingAction: () => runtime.window.consumeMenuBarAction()
  })
  const localFileAccess = createLocalFileAccessControl({
    agentDir: AGENT_DIR,
    getCurrentCwd: () => sessionState.cwd
  })
  const filesIpcOptions: FilesIpcOptions = {
    ipcMain,
    dialog,
    shell,
    agentDir: AGENT_DIR,
    getCurrentCwd: () => sessionState.cwd,
    getActiveWindow,
    getUiLanguage: () => readAppSettings().uiLanguage,
    access: localFileAccess,
    previews: createLocalFilePreviews(localFileAccess),
    icons: createLocalFileIcons({
      access: localFileAccess,
      getMacLaunchServicesHandlers: () => runtime.caches.macLaunchServicesHandlers,
      setMacLaunchServicesHandlers: (handlers) =>
        runtime.caches.setMacLaunchServicesHandlers(handlers),
      getFileIcon: (path) => app.getFileIcon(path, { size: 'normal' })
    })
  }
  registerFileOpenIpc(filesIpcOptions)
  registerResourceCatalogIpc(ipcMain)
  registerWebLinkIpc({
    ipcMain,
    requireMainWindowRenderer
  })
  registerFilePickerIpc(filesIpcOptions)
  return filesIpcOptions
}

function registerRemoteFileAndWrapperIpc(
  filesIpcOptions: FilesIpcOptions
): Parameters<typeof registerWrapperInputUploadIpc>[0] {
  const remoteProjectUploadsIpcOptions = { ipcMain, uploads: remoteProjectUploads }
  registerRemoteProjectUploadPreparationIpc(remoteProjectUploadsIpcOptions)
  registerRemoteProjectUploadListIpc(remoteProjectUploadsIpcOptions)
  registerRemoteJupyterJobsIpc({ ipcMain, jobs: remoteJupyterStartJobs })
  registerRemoteProjectUploadControlIpc(remoteProjectUploadsIpcOptions)
  const wrappersIpcOptions = {
    ipcMain,
    lifecycle: { logUnexpectedError },
    workspace: { agentDir: AGENT_DIR },
    session: {
      getCurrent: () => ({
        key: sessionState.sessionKey,
        path: sessionState.sessionPath,
        cwd: sessionState.cwd
      }),
      findPhiManifestForSession: sessionResolution.findPhiManifestForSession
    },
    execution: { environmentBuilds, wrapperJobs },
    uploads: remoteProjectUploads,
    windows: { getActiveWindow }
  }
  registerWrapperInputUploadIpc(wrappersIpcOptions)
  registerWorkspaceFileIpc({
    ipcMain,
    dialog,
    shell,
    getUiLanguage: () => readAppSettings().uiLanguage,
    requireRenderer: requireMainWindowRenderer,
    requireLocalWorkspaceRoot: (rootPath) => {
      if (
        isRemoteResourceScope() ||
        resolve(rootPath) !== resolve(sessionState.cwd) ||
        isRemoteProjectAnchorPath(rootPath, AGENT_DIR)
      ) {
        throw new Error('只能修改当前本地工作区中的文件')
      }
    },
    observeRemote: (projectId, operation) => remoteConnectionTracker.observe(projectId, operation),
    downloads: wrapperResultDownloads
  })
  registerFilePreviewIpc(filesIpcOptions)
  registerRemoteWorkspaceIpc({
    ipcMain,
    remote: {
      observe: (projectId, operation) => remoteConnectionTracker.observe(projectId, operation),
      requestProjectId: remoteRequestProjectId,
      connectWorkspaceHost: connectRemoteWorkspaceHost
    }
  })
  registerWrapperResultsIpc({
    ipcMain,
    windows: { getActiveWindow, requireMainWindowRenderer },
    remote: {
      observe: (projectId, operation) => remoteConnectionTracker.observe(projectId, operation),
      requestProjectId: remoteRequestProjectId
    },
    reads: wrapperResultReadControl,
    downloads: wrapperResultDownloads
  })
  registerFileBrowsingIpc(filesIpcOptions)
  registerMoleculesIpc({ ipcMain })
  return wrappersIpcOptions
}

function registerAgentIpc(): void {
  const promptTargetControlOptions: PromptTargetControlOptions = {
    state: {
      getCurrentSessionPath: () => sessionState.sessionPath,
      getCurrentCwd: () => sessionState.cwd,
      sessionPermissionModes: preferences.permissionModes
    },
    identity: {
      createPhiSessionKey: sessionKeys.createPhiKey.bind(sessionKeys),
      createSessionKey: sessionKeys.createKey.bind(sessionKeys),
      linkPhiManagedSessionKey: sessionKeyLinking.linkPhiManagedSessionKey,
      setPhiSessionIdForKey: sessionKeys.setPhiSessionId.bind(sessionKeys),
      resolveSessionKeyAlias: sessionKeys.canonicalize.bind(sessionKeys)
    },
    lifecycle: {
      getLifecycleForKey: lifecycles.forKey.bind(lifecycles),
      getCurrentLifecycle: () => lifecycles.forKey(sessionState.sessionKey),
      disposeAndSwitchSession,
      openRuntimeSessionManager,
      resolveSessionPermissionMode: sessionResolution.resolveSessionPermissionMode
    }
  }
  const agentIpcOptions: AgentIpcOptions = {
    ipcMain,
    state: {
      getCurrentSessionKey: () => sessionState.sessionKey,
      getCurrentSessionPath: () => sessionState.sessionPath,
      getCurrentCwd: () => sessionState.cwd,
      getCurrentPermissionMode: () => sessionState.permissionMode,
      resolveSessionKeyAlias: sessionKeys.canonicalize.bind(sessionKeys),
      runtimeSessionPath: sessionKeyLinking.runtimeSessionPath
    },
    prompt: {
      parseTarget: (input) => parsePromptTarget(input, () => sessionState.cwd),
      alignCurrentSessionToTarget: (input) =>
        alignCurrentSessionToPromptTarget(input, promptTargetControlOptions),
      submit: submitPromptRun
    },
    stop: {
      advancePromptGeneration: promptRuns.advanceGeneration.bind(promptRuns),
      getActivePromptRun: promptRuns.activeRun.bind(promptRuns),
      getPhiSessionIdForKey: sessionKeys.phiSessionIdFor.bind(sessionKeys),
      getRuntimeRecoveryOperation: (sessionId) =>
        promptRuns.runtimeRecoveryOperations.get(sessionId),
      getManualCompactionOperation: (sessionId) =>
        promptRuns.manualCompactionOperations.get(sessionId),
      stopPromptRun: (sessionKey, run, invalidateGeneration) =>
        stopPromptRun(sessionKey, run as PromptRun, invalidateGeneration)
    },
    agentRuns: {
      control: {
        resolveRecoverableJobOrigin: sessionOrigins.resolveRecoverableJobOrigin,
        findPhiSessionById,
        ownsRemoteRuntimeSession,
        resolveOriginSession: sessionOrigins.resolveOriginSession,
        hasEngineSession: (sessionId) => getPhiEngine().sessions.has(sessionId),
        currentRuntimeOriginScope: sessionOrigins.currentRuntimeOriginScope,
        steer: (params) => getPhiEngine().agentRuns.steer(params),
        stop: (params) => getPhiEngine().agentRuns.stop(params)
      },
      persistence: {
        resolveOriginSession: sessionOrigins.resolveOriginSession,
        appendSessionEvent: (phiSessionId, event) => appendSessionEvent(phiSessionId, event),
        redactSensitiveText,
        sendRunEventToWindow,
        logUnexpectedError
      }
    }
  }
  registerAgentPromptIpc(agentIpcOptions)
  registerWorkspaceChangesIpc({ ipcMain })
  registerAgentRunControlIpc(agentIpcOptions)
}

function registerApplicationAndModelIpc(): void {
  registerAuthIpc({ ipcMain, invalidateAgentSession })

  registerAppIpc({
    ipcMain,
    getVersion: () => app.getVersion(),
    openExternal: (url) => shell.openExternal(url)
  })
  registerSettingsIpc({
    ipcMain,
    agentDir: AGENT_DIR,
    syncPreventSleepBlocker
  })

  registerEnvironmentIpc({
    ipcMain,
    environment: backgroundEnvironment,
    getActiveWindow,
    dialog,
    getUiLanguage: () => readAppSettings().uiLanguage
  })
  registerManagedEnvironmentsIpc({
    ipcMain,
    agentDir: AGENT_DIR,
    builds: environmentBuilds
  })
  const modelSelectionTarget = {
    getCurrentSessionKey: () => sessionState.sessionKey,
    getCurrentCwd: () => sessionState.cwd,
    resolveSessionKeyAlias: sessionKeys.canonicalize.bind(sessionKeys),
    getPhiSessionIdForKey: sessionKeys.phiSessionIdFor.bind(sessionKeys),
    findPhiSessionById,
    getCurrentLifecycle: () => lifecycles.forKey(sessionState.sessionKey),
    sameCanonicalSessionKey: sessionKeys.sameCanonical.bind(sessionKeys),
    hasActivePromptRun: promptRuns.hasActiveRun.bind(promptRuns),
    getActiveSessionRun: (sessionId: string) => runnerRegistry.getActiveRun(sessionId)
  }
  const modelSessionState = {
    getCurrentSessionPath: () => sessionState.sessionPath,
    getCurrentPermissionMode: () => sessionState.permissionMode,
    sessionModelSelections: preferences.modelSelections,
    sessionThinkingLevels: preferences.thinkingLevels
  }
  const modelSelectionRequests = {
    nextModelSelectionRequest: () => sessionState.nextModelSelectionRequest(),
    rememberModelSelection: (request: number, model: ModelSelection | null) =>
      sessionState.rememberModelSelection(request, model, writeLastSelectedModel)
  }
  const modelSelectionOperations = {
    resolveRuntimeModelSelection,
    resolveSessionThinkingLevel: sessionResolution.resolveSessionThinkingLevel
  }
  registerModelsIpc({
    ipcMain,
    selectionTarget: modelSelectionTarget,
    sessionState: modelSessionState,
    requests: modelSelectionRequests,
    models: {
      ...modelSelectionOperations,
      selectableRuntimeModels,
      resolveSessionModelSelection: sessionResolution.resolveSessionModelSelection
    }
  })
  registerThinkingIpc({
    ipcMain,
    selectionTarget: modelSelectionTarget,
    sessionState: {
      ...modelSessionState,
      getCurrentResolvedSession
    },
    models: modelSelectionOperations
  })
}

function createCurrentContextUsageOptions(): CurrentContextUsageOptions {
  return {
    getCurrentPayload: getCurrentSessionPayload,
    getCurrentSessionKey: () => sessionState.sessionKey,
    getCurrentSessionPath: () => sessionState.sessionPath,
    getCurrentCwd: () => sessionState.cwd,
    getCurrentPermissionMode: () => sessionState.permissionMode,
    findPhiManifestForSession: sessionResolution.findPhiManifestForSession,
    runtimeSessionPathForSnapshot,
    getCurrentLifecycle: () => lifecycles.forKey(sessionState.sessionKey),
    getAgentSession
  }
}

function createCurrentSessionPayloadMessagesOptions(): CurrentSessionPayloadMessagesOptions {
  return {
    getCurrentPayload: getCurrentSessionPayload,
    getCurrentSessionKey: () => sessionState.sessionKey,
    getPhiSessionIdForKey: sessionKeys.phiSessionIdFor.bind(sessionKeys),
    getCurrentLifecycle: () => lifecycles.forKey(sessionState.sessionKey),
    getCurrentResolvedSession
  }
}

function createSessionCompactionControlOptions(): SessionCompactionControlOptions {
  return {
    workspace: { agentDir: AGENT_DIR },
    state: {
      getCurrentPayload: getCurrentSessionPayload,
      getCurrentSessionKey: () => sessionState.sessionKey,
      getCurrentSessionPath: () => sessionState.sessionPath,
      getCurrentCwd: () => sessionState.cwd,
      getCurrentPermissionMode: () => sessionState.permissionMode,
      manualCompactionIds: promptRuns.manualCompactionIds,
      manualCompactionOperations: promptRuns.manualCompactionOperations
    },
    sessions: {
      findPhiManifestForSession: sessionResolution.findPhiManifestForSession,
      runtimeSessionPathForSnapshot,
      ensurePhiSessionId: sessionKeyLinking.ensurePhiSessionId,
      hasActivePromptRun: promptRuns.hasActiveRun.bind(promptRuns),
      captureSessionControlTarget,
      getSessionGeneration: (sessionKey) => lifecycles.forKey(sessionKey).currentGeneration
    },
    events: {
      sendToAllWindows,
      notifySessionChanged,
      logUnexpectedError,
      flushPendingContinuations
    }
  }
}

type SessionsIpcOptions = Parameters<typeof registerSessionsIpc>[0]
function createSessionRecoveryIpcOptions(): SessionsIpcOptions['recovery'] {
  return {
    state: {
      getCurrentPayload: getCurrentSessionPayload,
      getCurrentSessionKey: () => sessionState.sessionKey,
      getCurrentSessionPath: () => sessionState.sessionPath,
      getCurrentCwd: () => sessionState.cwd,
      getCurrentPermissionMode: () => sessionState.permissionMode,
      runtimeRecoveryOperations: promptRuns.runtimeRecoveryOperations,
      runtimeRecoveryFailures: promptRuns.runtimeRecoveryFailures,
      manualCompactionIds: promptRuns.manualCompactionIds,
      sessionModelSelections: preferences.modelSelections,
      sessionThinkingLevels: preferences.thinkingLevels
    },
    identity: {
      resolveSessionKeyAlias: sessionKeys.canonicalize.bind(sessionKeys),
      sameCanonicalSessionKey: sessionKeys.sameCanonical.bind(sessionKeys),
      getPromptGeneration: promptRuns.generationFor.bind(promptRuns),
      advancePromptGeneration: promptRuns.advanceGeneration.bind(promptRuns)
    },
    lifecycle: {
      getLifecycleForKey: lifecycles.forKey.bind(lifecycles),
      hasActivePromptRun: promptRuns.hasActiveRun.bind(promptRuns),
      runnerGetActiveRun: (sessionId) => runnerRegistry.getActiveRun(sessionId),
      cleanupSessionRecord,
      getAgentSession
    },
    projects: { projectRemoteRuntimeRoot },
    models: { resolveRuntimeModelSelection },
    sessions: { createRemoteManagedSession, disposeAndSwitchSession },
    events: { notifySessionChanged }
  }
}
function createSessionsIpcOptions(
  currentContextUsageOptions: CurrentContextUsageOptions,
  currentSessionPayloadMessagesOptions: CurrentSessionPayloadMessagesOptions,
  sessionCompactionControlOptions: SessionCompactionControlOptions
): SessionsIpcOptions {
  return {
    ipcMain,
    state: {
      getCurrentSessionKey: () => sessionState.sessionKey,
      getCurrentSessionPath: () => sessionState.sessionPath,
      getCurrentCwd: () => sessionState.cwd,
      getCurrentPermissionMode: () => sessionState.permissionMode,
      setCurrentPermissionMode: (permissionMode) => sessionState.setPermissionMode(permissionMode),
      nextSessionSwitchRequest: () => sessionState.nextSessionSwitchRequest(),
      getSessionSwitchRequest: () => sessionState.sessionSwitchRequest,
      sessionPermissionModes: preferences.permissionModes,
      loadedSkillNamesBySession
    },
    reads: {
      getNoProjectTaskFolder,
      getCurrentSessionPayload,
      getCurrentSessionPayloadWithMessages: () =>
        getCurrentSessionPayloadWithMessages(currentSessionPayloadMessagesOptions),
      getCurrentContextUsage: () => getCurrentContextUsage(currentContextUsageOptions)
    },
    recovery: createSessionRecoveryIpcOptions(),
    compaction: {
      getSettings: (target) =>
        getCurrentAutoCompactionSettings(target, sessionCompactionControlOptions),
      setSettings: (target, patch) =>
        setCurrentAutoCompactionSettings(target, patch, sessionCompactionControlOptions),
      compact: (target) => compactCurrentSession(target, sessionCompactionControlOptions)
    },
    identity: {
      createSessionKey: sessionKeys.createKey.bind(sessionKeys),
      resolveSessionKeyAlias: sessionKeys.canonicalize.bind(sessionKeys),
      setPhiSessionIdForKey: sessionKeys.setPhiSessionId.bind(sessionKeys),
      getPhiSessionIdForKey: sessionKeys.phiSessionIdFor.bind(sessionKeys),
      findPhiManifestForSession: sessionResolution.findPhiManifestForSession,
      runtimeSessionPath: sessionKeyLinking.runtimeSessionPath
    },
    lifecycle: {
      createPhiManagedSession,
      disposeAndSwitchSession,
      openRuntimeSessionManager,
      resolveSessionPermissionMode: sessionResolution.resolveSessionPermissionMode,
      getLifecycleForKey: lifecycles.forKey.bind(lifecycles),
      getAgentSession,
      cleanupSessionRecord,
      waitForSessionCleanup: lifecycles.waitForCleanup.bind(lifecycles)
    },
    status: {
      runnerGetActiveRun: (sessionId) => runnerRegistry.getActiveRun(sessionId),
      activePromptEntries: () => promptRuns.activeEntries(),
      stopPromptRun: (sessionKey, run) => stopPromptRun(sessionKey, run as PromptRun),
      getSessionStatusPayload,
      notifySessionChanged
    },
    remote: {
      scheduleRemoteProjectCheck,
      observeRemote: (projectId, operation) => remoteConnectionTracker.observe(projectId, operation)
    },
    browser: {
      getRegistry: () => runtime.workspaceServices.browserWorkspaceRegistry
    },
    titles: {
      getGenerator: getSessionTitleGenerator,
      getGeneratorIfCreated: () => runtime.caches.sessionTitleGenerator,
      context: (path) => sessionTitleContext(path),
      manualRequests: manualTitleRequests,
      enqueueWrite: enqueueSessionTitleWrite,
      renameConversation
    },
    windows: { getActiveWindow, requireMainWindowRenderer }
  }
}
function registerSessionIpc(): void {
  const currentContextUsageOptions = createCurrentContextUsageOptions()
  const currentSessionPayloadMessagesOptions = createCurrentSessionPayloadMessagesOptions()
  const sessionCompactionControlOptions = createSessionCompactionControlOptions()
  registerSessionsIpc(
    createSessionsIpcOptions(
      currentContextUsageOptions,
      currentSessionPayloadMessagesOptions,
      sessionCompactionControlOptions
    )
  )
}

function registerProjectAndAnalysisIpc(): void {
  const projectsIpcOptions: ProjectsIpcOptions = {
    ipcMain,
    windows: { getActiveWindow, requireMainWindowRenderer },
    workspace: {
      agentDir: AGENT_DIR,
      getTerminalManager: () => runtime.workspaceServices.terminalManager
    },
    projects: {
      requireProject,
      applyCurrentPermissionMode: (id, project, permissionMode) =>
        sessionState.applyProjectPermissionMode(id, project, permissionMode, {
          findPhiManifestForSession: sessionResolution.findPhiManifestForSession,
          resolveSessionKeyAlias: sessionKeys.canonicalize.bind(sessionKeys),
          sessionPermissionModes: preferences.permissionModes,
          notifySessionChanged
        }),
      resolveRuntimeModelSelection,
      remoteRuntimeRoot: projectRemoteRuntimeRoot
    },
    sessions: {
      createLocal: createPhiManagedSession,
      createRemote: createRemoteManagedSession,
      switchTo: disposeAndSwitchSession
    },
    notebooks: { disposeRemoteBackend: disposeRemoteNotebookBackend },
    remote: {
      checkConnection: (sessionId, projectId, options) =>
        remoteConnectionTracker.check(sessionId, projectId, options),
      scheduleProjectCheck: scheduleRemoteProjectCheck
    }
  }
  registerProjectsIpc(projectsIpcOptions)
  registerMemoryIpc({
    ipcMain,
    workspace: { agentDir: AGENT_DIR },
    projects: { requireProject },
    memory: { retireProjectAdapters: retireDesktopProjectMemoryAdapters }
  })
  registerProjectsRemoteHostsIpc(projectsIpcOptions)
  registerRemoteIpc({ ipcMain })
  registerProjectsSessionsIpc(projectsIpcOptions)
  registerAnalysisIpc({
    ipcMain,
    notebooks: {
      resolveWorkspaceByCwd: resolveAnalysisWorkspaceByCwd,
      operations: analysisNotebookOperations,
      activePathByProjectCwd: activeNotebookPathByProjectCwd,
      activeRemoteNotebookBackends
    },
    jupyter: {
      getCurrentCwd: () => sessionState.cwd,
      isRemoteAnalysisCwd,
      serverRegistry: jupyterServerRegistry,
      localSessions: notebookSessionRegistry,
      executor: notebookExecutor,
      fileWatcher: notebookFileWatcher,
      ensureServerReady: ensureJupyterServerReady
    },
    generation: analysisNotebookCodeGenerator
  })
  registerToolIpc({ ipcMain, resolveToolApproval })
  registerAgentInteractionIpc({
    ipcMain,
    requireMainWindowRenderer,
    resolveAgentUserInteraction
  })
}

function registerPluginAndPackageIpc(): void {
  registerPhiPluginIpc({
    ipcMain,
    lifecycle: { invalidateAgentSession, logUnexpectedError },
    workspace: { agentDir: AGENT_DIR },
    plugins: { installedPluginNamespace, environmentBuilds },
    windows: { getActiveWindow }
  })
  const packagesIpcOptions = {
    ipcMain,
    lifecycle: { getAppVersion: () => app.getVersion(), invalidateAgentSession },
    workspace: { agentDir: AGENT_DIR },
    windows: { getActiveWindow },
    plugins: { installedPluginNamespace, environmentBuilds },
    packages: {
      officialContentSourceOptions,
      knownContentSourceOptions,
      loadPackageRegistries
    },
    updates: {
      refreshCachedPackageUpdates,
      packageUpdateViews,
      replaceCachedPackageUpdates: (updates) => runtime.caches.replaceCachedPackageUpdates(updates)
    }
  }
  registerPackageCatalogIpc(packagesIpcOptions)
  registerGithubSourceIpc({
    ipcMain,
    workspace: { agentDir: AGENT_DIR },
    sources: { officialRegistryFetch },
    updates: {
      clearCachedPackageUpdates: () => runtime.caches.clearCachedPackageUpdates(),
      sendNoAvailableUpdates: () => {
        const mainWindow = runtime.window.mainWindow
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.packages.updatesAvailable, [])
        }
      }
    }
  })
  registerPackageOperationsIpc(packagesIpcOptions)
}

function registerSkillAgentAndMcpIpc(
  wrappersIpcOptions: ReturnType<typeof registerRemoteFileAndWrapperIpc>
): void {
  registerSkillsIpc({
    ipcMain,
    lifecycle: { invalidateAgentSession },
    workspace: {
      agentDir: AGENT_DIR,
      getCurrentCwd: () => sessionState.cwd,
      isRemoteResourceScope,
      remoteSkillProjectContext,
      listRemoteProjectSkills
    },
    plugins: { installedPluginNamespace }
  })
  registerAgentsIpc({
    ipcMain,
    lifecycle: { invalidateAgentSession },
    workspace: {
      agentDir: AGENT_DIR,
      bundledDir: getBundledAgentsDir(),
      getCurrentCwd: () => sessionState.cwd,
      currentRemoteAnalysisProject,
      isRemoteResourceScope
    }
  })
  registerMcpIpc({
    ipcMain,
    lifecycle: {
      getAppVersion: () => app.getVersion(),
      invalidateAgentSession,
      sendToAllWindows
    },
    workspace: {
      agentDir: AGENT_DIR,
      getCurrentCwd: () => sessionState.cwd,
      isRemoteResourceScope,
      resolveRemoteProjectContext: remoteSkillProjectContext
    },
    packages: {
      loadPackageRegistries,
      officialContentSourceOptions,
      environmentBuilds
    },
    customAuthorization: {
      pending: pendingCustomMcpAuthorizations,
      parseUrl: customMcpAuthUrl,
      configDigest: customMcpConfigDigest
    }
  })
  registerWrapperPlanIpc(wrappersIpcOptions)
}

function registerWrapperJobsAndPersonaIpc(
  wrappersIpcOptions: ReturnType<typeof registerRemoteFileAndWrapperIpc>
): void {
  registerEnvironmentBuildsIpc({ ipcMain, environmentBuilds })
  registerJobsIpc({ ipcMain, operations: backgroundJobOperations })
  registerWrapperRunIpc(wrappersIpcOptions)

  registerPersonaIpc({
    ipcMain,
    appName: APP_NAME,
    lifecycle: { invalidateAgentSession, logUnexpectedError },
    generation: {
      generatePersonaMarkdown: (description, control) =>
        generatePersonaMarkdownForIpc(description, control, {
          getSelectedModel: () => sessionState.selectedModel,
          getNoProjectTaskFolder,
          text: {
            extractAssistantText: extractAssistantMessageText,
            extractMessageText,
            lastAssistantMessageFrom
          }
        })
    },
    rpc: {
      getCurrentSessionKey: () => sessionState.sessionKey,
      resolveSessionKeyAlias: sessionKeys.canonicalize.bind(sessionKeys),
      getPhiSessionIdForKey: sessionKeys.phiSessionIdFor.bind(sessionKeys),
      findPhiSessionById,
      captureSessionControlTarget
    }
  })
}

function openInitialWindow(): void {
  createWindow()
  scheduleStartupPackageUpdateCheck()
}

function registerAppActivationHandler(): void {
  app.on('activate', function () {
    applyDockIcon()

    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

app.whenReady().then(async () => {
  prepareStartupInterface()
  const startupSplashWindow = await openStartupSplash()
  runtime.window.setStartupSplashWindow(startupSplashWindow)
  runStartupMaintenance()
  migrateStartupPluginEnablement()
  recoverStartupState()
  configureStartupWindowDefaults()
  const filesIpcOptions = registerWindowAndFileIpc()
  const wrappersIpcOptions = registerRemoteFileAndWrapperIpc(filesIpcOptions)
  registerAgentIpc()
  registerApplicationAndModelIpc()
  registerSessionIpc()
  registerProjectAndAnalysisIpc()
  registerPluginAndPackageIpc()
  registerSkillAgentAndMcpIpc(wrappersIpcOptions)
  registerWrapperJobsAndPersonaIpc(wrappersIpcOptions)
  openInitialWindow()
  registerAppActivationHandler()
})

app.on(
  'before-quit',
  createBeforeQuitHandler({
    beginShutdown: () => {
      finishStartupSplash(null)
      runtime.window.destroyMenuBarController()
      // Stop local wrapper runs; detach remote runs so the next app launch can resume watching them.
      try {
        wrapperJobs.shutdown()
      } catch {
        writeAppLog({ level: 'error', event: 'wrapper_shutdown_failed' })
      }
      try {
        const blockerId = runtime.caches.preventSleepBlockerId
        if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) {
          powerSaveBlocker.stop(blockerId)
          runtime.caches.clearPreventSleepBlockerId()
        }
      } catch {
        writeAppLog({ level: 'error', event: 'power_blocker_cleanup_failed' })
      }
    },
    cleanup: async () => {
      await Promise.all([
        cleanupMainWindowRuntime(),
        safeCleanupStep('environment_scan_cleanup_failed', () => backgroundEnvironment.dispose())
      ])
    },
    quit: () => app.quit(),
    timeoutMs: APP_QUIT_CLEANUP_TIMEOUT_MS
  })
)

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
