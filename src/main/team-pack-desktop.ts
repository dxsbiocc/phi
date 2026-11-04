import {
  app,
  dialog,
  ipcMain,
  safeStorage,
  type BrowserWindow,
  type IpcMain,
  type IpcMainInvokeEvent
} from 'electron'

import { IPC } from '../shared/ipcChannels'
import { writeAppLog } from './agent/app-logger'
import { readAppSettings } from './agent/app-settings'
import { getAuthManager } from './agent/auth-manager'
import { getPhiAgentDir } from './agent/runtime-paths'
import { TeamPackAdminService } from './agent/team-pack/admin-service'
import {
  exportMemberIdentityBackup,
  getMemberPublicKey,
  importMemberIdentityBackup,
  loadOrCreateMemberIdentity
} from './agent/team-pack/member-service'
import { TeamMemberSubmissionService } from './agent/team-pack/member-submissions'
import { TeamSourceService } from './agent/team-pack/team-source'
import { createTeamSourceScheduler } from './agent/team-pack/team-source-scheduler'
import { registerTeamPackIpc, type TeamPackIpcOptions } from './ipc/team-pack-ipc'
import { nativeUiCopy } from './native-ui-copy'

type NativeUiCopy = ReturnType<typeof nativeUiCopy>

export interface TeamPackDesktopOptions {
  agentDir: string
  getActiveWindow: () => BrowserWindow | null
  uiCopy: () => NativeUiCopy
  sendToAllWindows: (channel: string) => void
}

export interface TeamPackDesktop {
  registerIpc(
    ipcMain: Pick<IpcMain, 'handle'>,
    requireMainWindowRenderer: (event: IpcMainInvokeEvent) => unknown
  ): void
  startScheduler(): Promise<void>
  stopScheduler(): void
  close(): Promise<void>
}

interface FileFilter {
  name: string
  extensions: string[]
}

export interface StartTeamPackDesktopOptions extends Pick<
  TeamPackDesktopOptions,
  'getActiveWindow' | 'sendToAllWindows'
> {
  requireMainWindowRenderer: (event: IpcMainInvokeEvent) => unknown
}

let running: TeamPackDesktop | null = null

/** Register team pack IPC now and begin background pulls once the first window exists. */
export function startTeamPackDesktop(options: StartTeamPackDesktopOptions): void {
  const desktop = createTeamPackDesktop({
    ...options,
    agentDir: getPhiAgentDir(),
    uiCopy: () => nativeUiCopy(readAppSettings().uiLanguage)
  })
  running = desktop
  desktop.registerIpc(ipcMain, options.requireMainWindowRenderer)
  app.once('browser-window-created', () => {
    void desktop.startScheduler().catch(() => {
      writeAppLog({ level: 'error', event: 'team_source_scheduler_start_failed' })
    })
  })
}

/** Stop background pulls and wait for in-flight team source work during app shutdown. */
export async function closeTeamPackDesktop(): Promise<void> {
  running?.stopScheduler()
  await running?.close()
}

/** Team pack services, native pickers, and IPC wiring for the desktop main process. */
export function createTeamPackDesktop(options: TeamPackDesktopOptions): TeamPackDesktop {
  const { agentDir } = options
  const memberIdentityOptions = { agentDir, safeStorage }
  const sources = new TeamSourceService({
    agentDir,
    authStorage: () => getAuthManager().getRuntime(),
    getMemberIdentity: async () =>
      (await loadOrCreateMemberIdentity(memberIdentityOptions)).identity,
    onCredentialsChanged: () => options.sendToAllWindows(IPC.auth.credentialsChanged)
  })
  const scheduler = createTeamSourceScheduler({ service: sources })
  const admin = new TeamPackAdminService({ agentDir, safeStorage })
  const submissions = new TeamMemberSubmissionService({ agentDir, safeStorage })

  return {
    registerIpc(ipcMain, requireMainWindowRenderer) {
      registerTeamPackIpc({
        ipcMain,
        requireMainWindowRenderer,
        member: {
          getPublicKey: () => getMemberPublicKey(memberIdentityOptions),
          exportBackup: (backupPath, passphrase) =>
            exportMemberIdentityBackup({ ...memberIdentityOptions, backupPath, passphrase }),
          importBackup: async (backupPath, passphrase) => {
            await importMemberIdentityBackup({ ...memberIdentityOptions, backupPath, passphrase })
            return getMemberPublicKey(memberIdentityOptions)
          },
          listSubmissionCandidates: (sourceId) => submissions.listCandidates(sourceId),
          submitPackages: (input, pickExportPath) => submissions.submit(input, pickExportPath)
        },
        sources: {
          listSources: () => sources.listSources(),
          configuredProviders: (teamId) => sources.configuredProviders(teamId),
          previewSource: (input) => sources.previewSource(input),
          addSource: (input) => sources.addSource(input),
          pullSource: (id) => sources.pullSource(id),
          removeSource: (id) => sources.removeSource(id)
        },
        scheduler: {
          start: () => scheduler.start(),
          stop: () => scheduler.stop()
        },
        admin,
        dialogs: teamPackDialogs(options)
      })
    },
    startScheduler: () => scheduler.start(),
    stopScheduler: () => scheduler.stop(),
    close: () => sources.close()
  }
}

type TeamPackPickers = Pick<TeamPackDesktopOptions, 'getActiveWindow' | 'uiCopy'>

function teamPackDialogs(options: TeamPackPickers): TeamPackIpcOptions['dialogs'] {
  const backup = (copy: NativeUiCopy): FileFilter => ({
    name: copy.ageBackupFile,
    extensions: ['age']
  })
  const submission = (copy: NativeUiCopy): FileFilter => ({
    name: copy.teamSubmissionFile,
    extensions: ['phi-submission']
  })
  return {
    pickSourceDirectory: () => pickDirectory(options, (copy) => copy.selectTeamSource),
    pickMemberBackupExport: () =>
      pickFile(
        options,
        'export',
        (copy) => copy.exportMemberIdentity,
        backup,
        'phi-member-identity.age'
      ),
    pickMemberBackupImport: () =>
      pickFile(options, 'import', (copy) => copy.importMemberIdentity, backup),
    pickAdminBackupExport: (teamId) =>
      pickFile(
        options,
        'export',
        (copy) => copy.exportTeamSigningKey,
        backup,
        `${teamId}-signing-key.age`
      ),
    pickAdminBackupImport: () =>
      pickFile(options, 'import', (copy) => copy.importTeamSigningKey, backup),
    pickPublishDirectory: () => pickDirectory(options, (copy) => copy.selectTeamPublishFolder),
    pickSubmissionExport: (suggestedName) =>
      pickFile(options, 'export', (copy) => copy.exportTeamSubmission, submission, suggestedName),
    pickSubmissionImport: () =>
      pickFile(options, 'import', (copy) => copy.importTeamSubmission, submission)
  }
}

function pickDirectory(
  options: TeamPackPickers,
  title: (copy: NativeUiCopy) => string
): Promise<string | null> {
  const copy = options.uiCopy()
  return showOpen(options.getActiveWindow(), {
    title: title(copy),
    buttonLabel: copy.select,
    properties: ['openDirectory', 'createDirectory']
  })
}

function pickFile(
  options: TeamPackPickers,
  mode: 'export' | 'import',
  title: (copy: NativeUiCopy) => string,
  filter: (copy: NativeUiCopy) => FileFilter,
  defaultPath?: string
): Promise<string | null> {
  const copy = options.uiCopy()
  const window = options.getActiveWindow()
  return mode === 'export'
    ? showSave(window, {
        title: title(copy),
        buttonLabel: copy.save,
        defaultPath,
        filters: [filter(copy)]
      })
    : showOpen(window, {
        title: title(copy),
        buttonLabel: copy.import,
        properties: ['openFile'],
        filters: [filter(copy)]
      })
}

async function showOpen(
  window: BrowserWindow | null,
  dialogOptions: Electron.OpenDialogOptions
): Promise<string | null> {
  const result = window
    ? await dialog.showOpenDialog(window, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

async function showSave(
  window: BrowserWindow | null,
  dialogOptions: Electron.SaveDialogOptions
): Promise<string | null> {
  const result = window
    ? await dialog.showSaveDialog(window, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions)
  return result.canceled ? null : (result.filePath ?? null)
}
