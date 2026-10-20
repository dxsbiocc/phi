import { dialog, type BrowserWindow, type IpcMain } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import type { RemoteProjectCreateInput } from '../../shared/projectLocation'
import { normalizeProjectMemorySettings } from '../../shared/projectMemoryTypes'
import { sshConfigHostId, type OpenSshHostInput } from '../../shared/remoteHostProfile'
import { writeAppLog } from '../agent/app-logger'
import { readAppSettings } from '../agent/app-settings'
import { getAuthManager } from '../agent/auth-manager'
import { getPhiEngine } from '../agent/engine/in-process-engine'
import { retireDesktopProjectMemoryAdapters } from '../agent/engine/rpc/desktop-project-memory-adapter'
import { createProjectMemoryAccess } from '../agent/memory/project-memory-access'
import {
  assertProjectPathAvailable,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProjectDefaults,
  updateProjectMemory,
  updateProjectPermissionMode,
  updateProjectRemoteDefaults,
  type ModelSelection,
  type PermissionMode,
  type Project,
  type ProjectRemoteConnection,
  type ThinkingLevel
} from '../agent/projects'
import { listRemoteProjectDirectories } from '../agent/remote-directory-browser'
import {
  deleteRemoteHostProfile,
  getRemoteHostProfile,
  remoteConnectionConfigForProfile,
  saveRemoteHostProfile
} from '../agent/remote-hosts'
import { createCheckedRemoteProject } from '../agent/remote-project-create'
import {
  clearRemoteEnvironmentSetting,
  clearRemoteMicromambaMirrorSetting,
  clearRemoteRuntimeRootSetting,
  listRemoteHostsWithRuntimeRoots,
  remoteHostProfileWithRuntimeRoot,
  updateProjectRemoteConnectionRuntimeAware
} from '../agent/remote-runtime-root-settings'
import type { ModelRuntime } from '../agent/runtime/runtime-adapter'
import { validatePermissionMode } from '../agent/session/permission-mode-control'
import { listPhiSessions, updateSessionManifest } from '../agent/session/session-store'
import { listSessions } from '../agent/session/sessions'
import { StaleSessionError } from '../agent/session/session-lifecycle'
import type { TerminalManager } from '../terminal/terminal-manager'
import { listOpenSshHosts } from '../agent/ssh-config-discovery'
import { saveOpenSshHost } from '../agent/ssh-config-editor'
import { ensureRemoteProjectAnchor } from '../agent/remote-project-anchor'
import { nativeUiCopy } from '../native-ui-copy'

const projectMemoryPolicyUpdates = new Set<string>()

export interface ProjectsIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  windows: {
    getActiveWindow: () => BrowserWindow | null
    requireMainWindowRenderer: (event: Electron.IpcMainInvokeEvent) => BrowserWindow
  }
  workspace: {
    agentDir: string
    getTerminalManager: () => Pick<TerminalManager, 'closeWorkspace'> | null
  }
  projects: {
    requireProject: (id: string) => Project
    applyCurrentPermissionMode: (
      id: string,
      project: Project,
      permissionMode: PermissionMode
    ) => void
    resolveRuntimeModelSelection: (
      runtime: ModelRuntime,
      selection: ModelSelection
    ) => { migratedFrom?: ModelSelection } | null
    remoteRuntimeRoot: (project: Project) => unknown
  }
  sessions: {
    createLocal: (
      cwd: string,
      permissionMode: PermissionMode
    ) => { path: string; permissionMode: PermissionMode }
    createRemote: (projectId: string) => {
      path: string
      sessionId: string
      cwd: string
      permissionMode: PermissionMode
    }
    switchTo: (
      path: string | undefined,
      cwd?: string,
      permissionMode?: PermissionMode
    ) => Promise<unknown>
  }
  notebooks: {
    disposeRemoteBackend: (projectId: string) => Promise<void>
  }
  remote: {
    checkConnection: (
      sessionId: string,
      projectId: string,
      options?: { userInitiated?: boolean }
    ) => Promise<unknown>
    scheduleProjectCheck: (sessionId: string, projectId: string) => void
  }
}

// eslint-disable-next-line max-lines-per-function -- Preserves the contiguous project handlers verbatim.
export function registerProjectsIpc(options: ProjectsIpcOptions): void {
  const ipcMain = options.ipcMain
  const getActiveWindow = options.windows.getActiveWindow
  const requireMainWindowRenderer = options.windows.requireMainWindowRenderer
  const getTerminalManager = options.workspace.getTerminalManager
  const requireProject = options.projects.requireProject
  const resolveRuntimeModelSelection = options.projects.resolveRuntimeModelSelection
  const projectRemoteRuntimeRoot = options.projects.remoteRuntimeRoot
  const disposeRemoteNotebookBackend = options.notebooks.disposeRemoteBackend
  const { projectMemoryTarget } = createProjectMemoryAccess({
    agentDir: options.workspace.agentDir,
    requireProject
  })

  ipcMain.handle(IPC.projects.list, async () => listProjects())
  ipcMain.handle(IPC.projects.pickDirectory, async () => {
    const window = getActiveWindow()
    const dialogCopy = nativeUiCopy(readAppSettings().uiLanguage)
    const options: Electron.OpenDialogOptions = {
      title: dialogCopy.selectProject,
      buttonLabel: dialogCopy.select,
      properties: ['openDirectory', 'createDirectory']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(
    IPC.projects.create,
    async (_, name: string, workingDirectory: string, permissionMode: PermissionMode) =>
      createProject({ name, workingDirectory, permissionMode })
  )
  ipcMain.handle(IPC.projects.createRemote, async (_, input: RemoteProjectCreateInput) =>
    createCheckedRemoteProject(input)
  )
  ipcMain.handle(IPC.projects.delete, async (_, id: string) => {
    // A broken terminal host must not make the project undeletable; its shells are already gone.
    await getTerminalManager()
      ?.closeWorkspace(`project:${id}`)
      .catch(() => {
        writeAppLog({ level: 'error', event: 'terminal_project_close_failed' })
      })
    await disposeRemoteNotebookBackend(id)
    const project = getProject(id)
    await retireDesktopProjectMemoryAdapters(id)
    if (project?.memory) {
      // Memory lives under Phi's own directory, so it would outlive the project otherwise.
      await getPhiEngine()
        .memory.clear(projectMemoryTarget(project))
        .catch(() => writeAppLog({ level: 'error', event: 'project_memory_clear_failed' }))
    }
    deleteProject(id)
  })
  ipcMain.handle(IPC.projects.updatePermissionMode, async (event, id: string, value: unknown) => {
    requireMainWindowRenderer(event)
    const permissionMode = validatePermissionMode(value)
    const project = updateProjectPermissionMode(id, permissionMode)
    for (const manifest of listPhiSessions()) {
      if (manifest.projectId === id) {
        updateSessionManifest(manifest.sessionId, { permissionMode })
      }
    }
    options.projects.applyCurrentPermissionMode(id, project, permissionMode)
    return project
  })
  ipcMain.handle(
    IPC.projects.updateDefaults,
    async (
      _,
      id: string,
      defaults: {
        defaultModel?: ModelSelection | null
        defaultThinkingLevel?: ThinkingLevel | null
      }
    ) => {
      if (defaults.defaultModel) {
        const runtime = await getAuthManager().getRuntime()
        const resolved = resolveRuntimeModelSelection(runtime, defaults.defaultModel)
        if (!resolved || resolved.migratedFrom) {
          throw new Error(
            `模型不可用: ${defaults.defaultModel.providerId}/${defaults.defaultModel.modelId}`
          )
        }
      }
      return updateProjectDefaults(id, defaults)
    }
  )
  // Memory settings reach the worker at session creation, so they apply to new conversations.
  ipcMain.handle(IPC.projects.updateMemory, async (_, id: string, settings: unknown) => {
    if (projectMemoryPolicyUpdates.has(id)) throw new Error('项目记忆设置正在更新，请稍后重试')
    const project = requireProject(id)
    const previous = normalizeProjectMemorySettings(project.memory)
    const next = normalizeProjectMemorySettings(settings)
    const currentBinding = (): string => {
      const current = requireProject(id)
      const profile =
        current.location.kind === 'ssh'
          ? getRemoteHostProfile(current.location.hostProfileId)
          : undefined
      return JSON.stringify([
        current.location,
        current.workingDirectory,
        current.workingDirectoryRealPath,
        normalizeProjectMemorySettings(current.memory),
        profile ? remoteConnectionConfigForProfile(profile) : null,
        current.location.kind === 'ssh' ? projectRemoteRuntimeRoot(current) : null
      ])
    }
    const binding = currentBinding()
    projectMemoryPolicyUpdates.add(id)
    try {
      if (previous.enabled !== next.enabled || previous.learn !== next.learn) {
        await retireDesktopProjectMemoryAdapters(id)
        if (currentBinding() !== binding) throw new StaleSessionError()
      }
      return updateProjectMemory(id, next)
    } finally {
      projectMemoryPolicyUpdates.delete(id)
    }
  })
}

// eslint-disable-next-line max-lines-per-function -- Preserves the contiguous remote-host handlers verbatim.
export function registerProjectsRemoteHostsIpc(options: ProjectsIpcOptions): void {
  const ipcMain = options.ipcMain

  ipcMain.handle(IPC.projects.listRemoteHosts, async () => listRemoteHostsWithRuntimeRoots())
  ipcMain.handle(IPC.projects.listRemoteDirectories, async (_, input: unknown) =>
    listRemoteProjectDirectories(input)
  )
  ipcMain.handle(IPC.projects.listOpenSshHosts, async () => listOpenSshHosts())
  ipcMain.handle(IPC.projects.saveOpenSshHost, async (_, input: OpenSshHostInput) => {
    if (!input || typeof input !== 'object') throw new Error('SSH 服务器配置无效')
    if (input.originalAlias) {
      const id = sshConfigHostId(input.originalAlias)
      const inUse = listProjects().some(
        (project) =>
          (project.location.kind === 'ssh' && project.location.hostProfileId === id) ||
          project.remoteConnections?.some((connection) => connection.hostProfileId === id)
      )
      if (inUse) {
        const current = (await listOpenSshHosts()).find(
          (host) => host.alias === input.originalAlias
        )
        if (
          !current ||
          current.hostname !== input.hostname ||
          (current.user ?? '') !== (input.user ?? '') ||
          current.port !== input.port
        ) {
          throw new Error('该服务器已绑定项目；更改地址、用户或端口前请先解除项目绑定')
        }
      }
    }
    const alias = await saveOpenSshHost(input)
    const profile = getRemoteHostProfile(sshConfigHostId(alias))
    if (!profile) throw new Error('SSH 配置已保存，但重新读取服务器失败；请刷新列表')
    return remoteHostProfileWithRuntimeRoot(profile)
  })
  ipcMain.handle(
    IPC.projects.saveRemoteHost,
    async (
      _,
      input: {
        id?: string
        label: string
        hostAlias: string
        user?: string
        port?: number
        identityFile?: string
      }
    ) => {
      const saved = input.id ? getRemoteHostProfile(input.id) : undefined
      const inUse =
        input.id &&
        listProjects().some(
          (project) =>
            (project.location.kind === 'ssh' && project.location.hostProfileId === input.id) ||
            project.remoteConnections?.some((connection) => connection.hostProfileId === input.id)
        )
      if (
        saved &&
        inUse &&
        (saved.hostAlias !== input.hostAlias.trim() ||
          (saved.user ?? '') !== (input.user?.trim() ?? '') ||
          saved.port !== input.port)
      ) {
        throw new Error('该服务器已绑定项目；请先解除项目绑定，再修改地址或认证设置')
      }
      return remoteHostProfileWithRuntimeRoot(saveRemoteHostProfile(input))
    }
  )
  ipcMain.handle(IPC.projects.deleteRemoteHost, async (_, id: string) => {
    if (
      listProjects().some(
        (project) =>
          (project.location.kind === 'ssh' && project.location.hostProfileId === id) ||
          project.remoteConnections?.some((connection) => connection.hostProfileId === id)
      )
    ) {
      throw new Error('该服务器仍被项目使用，请先移除项目中的远程连接')
    }
    clearRemoteMicromambaMirrorSetting(id)
    clearRemoteEnvironmentSetting(id)
    clearRemoteRuntimeRootSetting(id)
    deleteRemoteHostProfile(id)
  })
}

export function registerProjectsSessionsIpc(options: ProjectsIpcOptions): void {
  const ipcMain = options.ipcMain
  const createRemoteManagedSession = options.sessions.createRemote
  const createPhiManagedSession = options.sessions.createLocal
  const disposeAndSwitchSession = options.sessions.switchTo
  const scheduleRemoteProjectCheck = options.remote.scheduleProjectCheck
  const remoteConnectionTracker = { check: options.remote.checkConnection }

  ipcMain.handle(
    IPC.projects.updateRemoteConnection,
    async (_, id: string, connectionId: string, patch: ProjectRemoteConnection | null) =>
      updateProjectRemoteConnectionRuntimeAware(id, connectionId, patch)
  )
  ipcMain.handle(
    IPC.projects.updateRemoteDefaults,
    async (
      _,
      id: string,
      defaults: {
        defaultRemoteConnectionId?: string | null
        remoteWorkspaceRoot?: string | null
      }
    ) => updateProjectRemoteDefaults(id, defaults)
  )
  ipcMain.handle(IPC.projects.sessions, async (_, workingDirectory: string) =>
    listSessions(workingDirectory)
  )
  ipcMain.handle(IPC.projects.sessionsById, async (_, projectId: string) => {
    const project = getProject(projectId)
    if (!project) throw new Error('项目不存在')
    const cwd =
      project.location.kind === 'ssh'
        ? ensureRemoteProjectAnchor(project.id)
        : project.workingDirectory
    return listSessions(cwd)
  })
  ipcMain.handle(IPC.projects.newRemoteSession, async (_, projectId: string) => {
    const session = createRemoteManagedSession(projectId)
    const current = await disposeAndSwitchSession(session.path, session.cwd, session.permissionMode)
    scheduleRemoteProjectCheck(session.sessionId, projectId)
    return current
  })
  ipcMain.handle(IPC.projects.retryRemoteConnection, async (_, request: unknown) => {
    if (
      !request ||
      typeof request !== 'object' ||
      Array.isArray(request) ||
      Object.keys(request).length !== 2 ||
      typeof (request as Record<string, unknown>).sessionId !== 'string' ||
      typeof (request as Record<string, unknown>).projectId !== 'string'
    ) {
      throw new Error('远程重连请求必须包含会话和项目 ID')
    }
    const { sessionId, projectId } = request as { sessionId: string; projectId: string }
    return remoteConnectionTracker.check(sessionId, projectId, { userInitiated: true })
  })
  ipcMain.handle(
    IPC.projects.newSession,
    async (_, workingDirectory: string, permissionMode: PermissionMode) => {
      assertProjectPathAvailable(workingDirectory)
      const session = createPhiManagedSession(workingDirectory, permissionMode)
      return disposeAndSwitchSession(session.path, workingDirectory, session.permissionMode)
    }
  )
}
