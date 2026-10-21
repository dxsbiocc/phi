import { dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron'

import type {
  CurrentAutoCompactionSettings,
  ManualCompactionOutcome
} from '../../shared/contextUsageTypes'
import { IPC } from '../../shared/ipcChannels'
import { writeAppLog } from '../agent/app-logger'
import { readAppSettings } from '../agent/app-settings'
import { getPhiEngine } from '../agent/engine/in-process-engine'
import type { PermissionMode } from '../agent/projects'
import { getProject } from '../agent/projects'
import { exportPhiSession } from '../agent/session/session-export'
import { prepareRemotePhiDeletion } from '../agent/session/remote-session-delete'
import { readPhiTimelineMessages } from '../agent/session/phi-timeline-messages'
import { validateSessionPermissionModeUpdate } from '../agent/session/permission-mode-control'
import {
  findPhiSessionById,
  findPhiSessionByRuntimePath,
  forkPhiSession,
  readSessionEvents,
  updateSessionManifest,
  type PhiSessionManifest
} from '../agent/session/session-store'
import {
  acknowledgeSession,
  deleteSession,
  listSessions,
  phiOnlySessionPath,
  phiSessionIdFromPath
} from '../agent/session/sessions'
import { getHomeActivity } from '../agent/session/home-activity'
import {
  isStaleSessionError,
  type SessionLifecycle,
  type SessionLifecycleRecord
} from '../agent/session/session-lifecycle'
import {
  type SessionTitleGenerator,
  type SessionTitleInput
} from '../agent/session/session-title-generation'
import type { CreateAgentSessionResult } from '../agent/runtime/runtime-adapter'
import { nativeUiCopy } from '../native-ui-copy'
import {
  createMainRuntimeRecoveryController,
  type RuntimeRecoveryControlOptions
} from '../agent/session/runtime-recovery-control'
import { runtimeRecoveryTarget } from '../agent/session/runtime-recovery-ipc'
import type { SessionPreferenceTable } from '../app-state/session-preferences'

interface CurrentSessionPayload {
  path: string | null
  phiSessionId?: string
  cwd: string
  displayCwd: string
  projectId?: string
  sessionGeneration: number
  permissionMode: PermissionMode
}

interface SwitchResult {
  path: string | null
  cwd: string
  sessionGeneration: number
  permissionMode: PermissionMode
}

export interface SessionsIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  state: {
    getCurrentSessionKey: () => string
    getCurrentSessionPath: () => string | undefined
    getCurrentCwd: () => string
    getCurrentPermissionMode: () => PermissionMode
    setCurrentPermissionMode: (permissionMode: PermissionMode) => void
    nextSessionSwitchRequest: () => number
    getSessionSwitchRequest: () => number
    sessionPermissionModes: SessionPreferenceTable<PermissionMode>
    loadedSkillNamesBySession: Pick<Map<string, unknown>, 'delete'>
  }
  reads: {
    getNoProjectTaskFolder: () => string
    getCurrentSessionPayload: () => CurrentSessionPayload
    getCurrentSessionPayloadWithMessages: () => Promise<unknown>
    getCurrentContextUsage: () => Promise<unknown>
  }
  recovery: RuntimeRecoveryControlOptions
  compaction: {
    getSettings: (target: unknown) => Promise<CurrentAutoCompactionSettings>
    setSettings: (target: unknown, patch: unknown) => Promise<CurrentAutoCompactionSettings>
    compact: (target: unknown) => Promise<ManualCompactionOutcome>
  }
  identity: {
    createSessionKey: (path: string | undefined, cwd: string) => string
    resolveSessionKeyAlias: (sessionKey: string) => string
    setPhiSessionIdForKey: (sessionKey: string, sessionId: string) => void
    getPhiSessionIdForKey: (sessionKey: string) => string | undefined
    findPhiManifestForSession: (
      sessionKey: string,
      path: string | undefined,
      cwd: string
    ) => PhiSessionManifest | null
    runtimeSessionPath: (path: string | undefined) => string | undefined
  }
  lifecycle: {
    createPhiManagedSession: (
      cwd: string,
      permissionMode: PermissionMode
    ) => { path: string; permissionMode: PermissionMode }
    disposeAndSwitchSession: (
      path: string | undefined,
      cwd?: string,
      permissionMode?: PermissionMode,
      options?: { notify?: boolean }
    ) => Promise<SwitchResult>
    openRuntimeSessionManager: (path: string) => Promise<{ getCwd(): string }>
    resolveSessionPermissionMode: (
      sessionKey: string,
      snapshot: { path: string; cwd: string }
    ) => PermissionMode
    getLifecycleForKey: (sessionKey: string) => SessionLifecycle<CreateAgentSessionResult>
    cleanupSessionRecord: (
      record: SessionLifecycleRecord<CreateAgentSessionResult> | null,
      options?: { cancelApprovals: boolean }
    ) => Promise<void>
    getAgentSession: (
      sessionKey: string,
      snapshot: { path: string; cwd: string; permissionMode: PermissionMode }
    ) => Promise<CreateAgentSessionResult>
    waitForSessionCleanup: (snapshot: {
      path: string | undefined
      cwd: string
      permissionMode: PermissionMode
    }) => Promise<void>
  }
  status: {
    runnerGetActiveRun: (sessionId: string) => unknown
    activePromptEntries: () => Array<[string, { phiSessionId: string }]>
    stopPromptRun: (sessionKey: string, run: unknown) => Promise<void>
    getSessionStatusPayload: (sessionKey: string, path: string | undefined, cwd: string) => object
    notifySessionChanged: () => void
  }
  remote: {
    scheduleRemoteProjectCheck: (sessionId: string, projectId: string) => void
    observeRemote: <T>(projectId: string, operation: () => Promise<T>) => Promise<T>
    remoteNotebookSessionIds: Pick<Map<string, string>, 'get'>
    disposeRemoteNotebookBackend: (projectId: string) => Promise<void>
  }
  browser: {
    getRegistry: () => { disposeSession(sessionId: string): Promise<void> } | null
  }
  titles: {
    getGenerator: () => SessionTitleGenerator
    getGeneratorIfCreated: () => SessionTitleGenerator | null
    context: (path: string) => Omit<SessionTitleInput, 'sessionPath'> & {
      manifest: PhiSessionManifest
      firstUserMessage: string
    }
    manualRequests: Pick<Set<string>, 'add' | 'delete'>
    enqueueWrite: <T>(path: string, write: () => Promise<T>) => Promise<T>
    renameConversation: (path: string, name: string, source: 'user' | 'auto') => Promise<unknown>
  }
  windows: {
    getActiveWindow: () => BrowserWindow | null
    requireMainWindowRenderer: (event: IpcMainInvokeEvent) => BrowserWindow
  }
}

/* eslint-disable complexity, max-lines-per-function -- Preserves the contiguous session handlers verbatim. */
export function registerSessionsIpc(options: SessionsIpcOptions): void {
  const ipcMain = options.ipcMain
  const state = options.state
  const reads = options.reads
  const identity = options.identity
  const lifecycle = options.lifecycle
  const status = options.status
  const getActiveWindow = options.windows.getActiveWindow
  const runtimeRecoveryController = createMainRuntimeRecoveryController(options.recovery)

  ipcMain.handle(IPC.sessions.list, async () => listSessions(reads.getNoProjectTaskFolder()))
  ipcMain.handle(IPC.sessions.homeActivity, async () => getHomeActivity())
  ipcMain.handle(IPC.sessions.current, async () => reads.getCurrentSessionPayloadWithMessages())
  ipcMain.handle(IPC.sessions.contextUsage, async () => reads.getCurrentContextUsage())
  ipcMain.handle(IPC.sessions.runtimeRecovery, async (_, target: unknown) =>
    runtimeRecoveryController.getState(target)
  )
  ipcMain.handle(IPC.sessions.resumeRuntime, async (_, value: unknown, replacement?: unknown) => {
    const target = runtimeRecoveryTarget(value)
    return options.remote.observeRemote(target.projectId, () =>
      runtimeRecoveryController.resume(target, replacement)
    )
  })
  ipcMain.handle(IPC.sessions.continueRuntimeSummary, async (_, target: unknown, sha256: unknown) =>
    runtimeRecoveryController.continueFromSummary(target, sha256)
  )
  ipcMain.handle(IPC.sessions.autoCompactionSettings, async (_, target: unknown) =>
    options.compaction.getSettings(target)
  )
  ipcMain.handle(
    IPC.sessions.autoCompactionSettingsSet,
    async (_, target: unknown, patch: unknown) => options.compaction.setSettings(target, patch)
  )
  ipcMain.handle(IPC.sessions.compact, async (_, target: unknown) =>
    options.compaction.compact(target)
  )
  ipcMain.handle(
    IPC.sessions.updatePermissionMode,
    async (event, value: unknown, target: unknown) => {
      options.windows.requireMainWindowRenderer(event)
      const permissionMode = validateSessionPermissionModeUpdate(
        value,
        target,
        reads.getCurrentSessionPayload()
      )
      state.setCurrentPermissionMode(permissionMode)
      state.sessionPermissionModes.set(
        identity.resolveSessionKeyAlias(state.getCurrentSessionKey()),
        permissionMode
      )
      const phiSessionId =
        identity.getPhiSessionIdForKey(state.getCurrentSessionKey()) ??
        (state.getCurrentSessionPath()
          ? identity.findPhiManifestForSession(
              state.getCurrentSessionKey(),
              state.getCurrentSessionPath(),
              state.getCurrentCwd()
            )?.sessionId
          : undefined)
      if (phiSessionId) {
        updateSessionManifest(phiSessionId, { permissionMode })
      }
      status.notifySessionChanged()
      return reads.getCurrentSessionPayload()
    }
  )
  ipcMain.handle(IPC.sessions.create, async () => {
    const cwd = reads.getNoProjectTaskFolder()
    const session = lifecycle.createPhiManagedSession(cwd, 'auto')
    return lifecycle.disposeAndSwitchSession(session.path, cwd, session.permissionMode)
  })
  ipcMain.handle(IPC.sessions.fork, async (_, sourceId: unknown, eventId: unknown) => {
    if (typeof sourceId !== 'string' || typeof eventId !== 'string') {
      throw new Error('无效的会话分叉请求')
    }
    const source = findPhiSessionById(sourceId)
    if (!source) throw new Error('来源会话不存在')
    if (
      source.status === 'running' ||
      source.status === 'needs_approval' ||
      source.status === 'needs_input' ||
      status.runnerGetActiveRun(sourceId)
    ) {
      throw new Error('请等待来源会话运行结束后再分叉')
    }
    if (!source.runtimeSessionPath) throw new Error('来源会话尚无可分叉的历史')
    const events = readSessionEvents(sourceId)
    const userMessages = events.filter((event) => event.type === 'user_message')
    const selectedIndex = userMessages.findIndex((event) => event.eventId === eventId)
    if (selectedIndex < 0) throw new Error('分叉消息不存在')
    const result = await getPhiEngine().history.fork({
      path: source.runtimeSessionPath,
      cwd: source.cwd,
      userMessages: userMessages
        .slice(0, selectedIndex + 2)
        .map((event) => (typeof event.content === 'string' ? event.content : '')),
      selectedIndex
    })
    try {
      const fork = forkPhiSession(sourceId, eventId, result.path)
      status.notifySessionChanged()
      return { path: phiOnlySessionPath(fork.sessionId), phiSessionId: fork.sessionId }
    } catch (error) {
      deleteSession(result.path)
      throw error
    }
  })
  ipcMain.handle(IPC.sessions.switch, async (_, path: string) => {
    const request = state.nextSessionSwitchRequest()
    const phiOnlySessionId = phiSessionIdFromPath(path)
    if (phiOnlySessionId) {
      const manifest = findPhiSessionById(phiOnlySessionId)
      if (!manifest) return null
      const targetKey = identity.createSessionKey(path, manifest.cwd)
      identity.setPhiSessionIdForKey(targetKey, phiOnlySessionId)
      state.sessionPermissionModes.set(
        identity.resolveSessionKeyAlias(targetKey),
        manifest.permissionMode
      )
      const shouldBecomeCurrent = request === state.getSessionSwitchRequest()
      const target = shouldBecomeCurrent
        ? await lifecycle.disposeAndSwitchSession(path, manifest.cwd, manifest.permissionMode, {
            notify: false
          })
        : {
            path,
            cwd: manifest.cwd,
            sessionGeneration: lifecycle.getLifecycleForKey(targetKey).currentGeneration,
            permissionMode: manifest.permissionMode
          }
      if (shouldBecomeCurrent) {
        acknowledgeSession(path, manifest.cwd)
      }
      const project = manifest.projectId ? getProject(manifest.projectId) : undefined
      const projectLocation = manifest.projectLocation ?? project?.location
      if (
        shouldBecomeCurrent &&
        projectLocation?.kind === 'ssh' &&
        manifest.projectId &&
        !(options.recovery.state.isRemoteOmpRpcEnabled() && manifest.runtimeRef)
      ) {
        options.remote.scheduleRemoteProjectCheck(manifest.sessionId, manifest.projectId)
      }
      return {
        path,
        phiSessionId: manifest.sessionId,
        cwd: target.cwd,
        displayCwd: projectLocation?.kind === 'ssh' ? projectLocation.remoteRoot : target.cwd,
        ...(manifest.projectId ? { projectId: manifest.projectId } : {}),
        ...(projectLocation ? { projectLocation } : {}),
        sessionGeneration: target.sessionGeneration,
        permissionMode: manifest.permissionMode,
        ...status.getSessionStatusPayload(targetKey, path, target.cwd),
        messages: readPhiTimelineMessages(null, target.cwd, phiOnlySessionId)
      }
    }

    // The session file already knows its own cwd (a project session was created with
    // that project's folder as cwd) — read it so switching to it also restores the
    // right permission mode, regardless of which sidebar section it was opened from.
    const cwd = (await lifecycle.openRuntimeSessionManager(path)).getCwd()
    const targetKey = identity.createSessionKey(path, cwd)
    const permissionMode = lifecycle.resolveSessionPermissionMode(targetKey, { path, cwd })
    const shouldBecomeCurrent = request === state.getSessionSwitchRequest()
    const target = shouldBecomeCurrent
      ? await lifecycle.disposeAndSwitchSession(path, cwd, permissionMode, { notify: false })
      : {
          path,
          cwd,
          sessionGeneration: lifecycle.getLifecycleForKey(identity.createSessionKey(path, cwd))
            .currentGeneration,
          permissionMode
        }
    const targetLifecycle = lifecycle.getLifecycleForKey(targetKey)
    const targetSnapshot = { path, cwd, permissionMode }
    let session: CreateAgentSessionResult['session']
    try {
      const result = await lifecycle.getAgentSession(targetKey, targetSnapshot)
      session = result.session
    } catch (error) {
      if (
        isStaleSessionError(error) ||
        !targetLifecycle.isCurrentGeneration(target.sessionGeneration)
      ) {
        return null
      }
      throw error
    }
    if (!targetLifecycle.isCurrentGeneration(target.sessionGeneration)) {
      return null
    }
    if (shouldBecomeCurrent && target.path) {
      acknowledgeSession(target.path, target.cwd)
    }
    const sessionPath = session.sessionFile ?? path
    const phiSessionId = identity.getPhiSessionIdForKey(targetKey)
    const linkedManifest = phiSessionId
      ? findPhiSessionById(phiSessionId)
      : findPhiSessionByRuntimePath(sessionPath, target.cwd)
    const project = linkedManifest?.projectId ? getProject(linkedManifest.projectId) : undefined
    const projectLocation = linkedManifest?.projectLocation ?? project?.location
    return {
      path: phiSessionId ? phiOnlySessionPath(phiSessionId) : sessionPath,
      ...(phiSessionId ? { phiSessionId } : {}),
      cwd: target.cwd,
      displayCwd: projectLocation?.kind === 'ssh' ? projectLocation.remoteRoot : target.cwd,
      ...(linkedManifest?.projectId ? { projectId: linkedManifest.projectId } : {}),
      ...(projectLocation ? { projectLocation } : {}),
      sessionGeneration: target.sessionGeneration,
      permissionMode,
      ...status.getSessionStatusPayload(targetKey, sessionPath, target.cwd),
      messages: [
        ...session.messages,
        ...readPhiTimelineMessages(
          sessionPath,
          target.cwd,
          identity.getPhiSessionIdForKey(targetKey)
        )
      ]
    }
  })
  ipcMain.handle(IPC.sessions.acknowledge, async (_, path: string) => {
    const phiOnlySessionId = phiSessionIdFromPath(path)
    const cwd = phiOnlySessionId
      ? (findPhiSessionById(phiOnlySessionId)?.cwd ?? state.getCurrentCwd())
      : (await lifecycle.openRuntimeSessionManager(path)).getCwd()
    return acknowledgeSession(path, cwd)
  })
  ipcMain.handle(IPC.sessions.delete, async (_, path: string) => {
    const deletionCwd = state.getCurrentCwd()
    const phiSessionId = phiSessionIdFromPath(path)
    const manifest = phiSessionId
      ? findPhiSessionById(phiSessionId)
      : findPhiSessionByRuntimePath(path, deletionCwd)
    if ((manifest?.runtimeRef || manifest?.runtimeRecoveryError) && !phiSessionId)
      throw new Error('远程会话必须使用 Phi 会话标识删除')
    const remoteDeletion =
      phiSessionId && (manifest?.runtimeRef || manifest?.runtimeRecoveryError)
        ? await prepareRemotePhiDeletion(phiSessionId)
        : undefined
    const wasCurrent = state.getCurrentSessionPath() === path
    try {
      options.titles.getGeneratorIfCreated()?.cancel(path)
      const activeEntry = status
        .activePromptEntries()
        .find(([, run]) => run.phiSessionId === manifest?.sessionId)
      if (activeEntry) await status.stopPromptRun(activeEntry[0], activeEntry[1])
      if (remoteDeletion && manifest) {
        const key = identity.resolveSessionKeyAlias(identity.createSessionKey(path, manifest.cwd))
        const record = lifecycle.getLifecycleForKey(key).advance()
        await lifecycle.cleanupSessionRecord(record, { cancelApprovals: true })
      }
      if (state.getCurrentSessionPath() === path) {
        await lifecycle.disposeAndSwitchSession(undefined)
      }
      // Let an aborted run finish persisting before unlinking its history; otherwise
      // the final SDK write can recreate a conversation the user just deleted.
      await lifecycle.waitForSessionCleanup({
        path: manifest?.runtimeSessionPath ?? identity.runtimeSessionPath(path),
        cwd: manifest?.cwd ?? state.getCurrentCwd(),
        permissionMode: state.getCurrentPermissionMode()
      })
      if (manifest?.sessionId && options.browser.getRegistry()) {
        try {
          await options.browser.getRegistry()!.disposeSession(manifest.sessionId)
        } catch {
          writeAppLog({ level: 'error', event: 'browser_session_cleanup_failed' })
        }
      }
      if (
        manifest?.projectId &&
        options.remote.remoteNotebookSessionIds.get(manifest.projectId) === manifest.sessionId
      ) {
        await options.remote.disposeRemoteNotebookBackend(manifest.projectId)
      }
      // Session-private drafts and their registries are deleted here; Save As copies are project
      // files and intentionally remain outside this tree. Draft garbage collection is out of scope.
      if (remoteDeletion) await remoteDeletion.delete()
      else {
        deleteSession(path)
      }
      if (manifest) state.loadedSkillNamesBySession.delete(manifest.sessionId)
    } catch (error) {
      if (
        remoteDeletion &&
        wasCurrent &&
        manifest &&
        !state.getCurrentSessionPath() &&
        findPhiSessionById(manifest.sessionId)
      ) {
        await lifecycle
          .disposeAndSwitchSession(path, manifest.cwd, manifest.permissionMode)
          .catch(() => undefined)
      }
      throw error
    } finally {
      try {
        await remoteDeletion?.close()
      } catch {
        writeAppLog({ level: 'error', event: 'remote_session_delete_connection_close_failed' })
      }
    }
  })
  ipcMain.handle(IPC.sessions.generateTitle, async (event, path: unknown) => {
    options.windows.requireMainWindowRenderer(event)
    if (typeof path !== 'string' || !path || path.length > 8192) {
      throw new Error('对话路径无效')
    }
    const context = options.titles.context(path)
    if (status.runnerGetActiveRun(context.manifest.sessionId)) {
      throw new Error('请等待对话运行结束后再生成标题')
    }
    const title = await options.titles.getGenerator().generate({ sessionPath: path, ...context })
    if (!title) throw new Error('暂时无法生成标题，请稍后重试，并检查当前模型是否可用')
    return title
  })
  ipcMain.handle(IPC.sessions.rename, async (_, path: string, name: string) => {
    const trimmedName = name.trim()
    if (!trimmedName) return

    options.titles.manualRequests.add(path)
    options.titles.getGeneratorIfCreated()?.cancel(path)
    try {
      await options.titles.enqueueWrite(path, () =>
        options.titles.renameConversation(path, trimmedName, 'user')
      )
    } finally {
      options.titles.manualRequests.delete(path)
    }
  })
  ipcMain.handle(IPC.sessions.export, async (_, sessionId: unknown) => {
    if (typeof sessionId !== 'string') throw new Error('会话编号无效')
    const manifest = findPhiSessionById(sessionId)
    if (!manifest) throw new Error('会话不存在')
    if (status.runnerGetActiveRun(sessionId)) throw new Error('请等待会话运行结束后再导出')
    const window = getActiveWindow()
    const dialogCopy = nativeUiCopy(readAppSettings().uiLanguage)
    const options: Electron.OpenDialogOptions = {
      title: dialogCopy.exportChat,
      buttonLabel: dialogCopy.select,
      properties: ['openDirectory', 'createDirectory']
    }
    const choice = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (choice.canceled || !choice.filePaths[0]) return null
    const result = await exportPhiSession(sessionId, choice.filePaths[0])
    writeAppLog({
      event: 'session_exported',
      sessionId,
      metadata: { fileCount: result.fileCount, bytes: result.bytes }
    })
    return result
  })
}
/* eslint-enable complexity, max-lines-per-function */
