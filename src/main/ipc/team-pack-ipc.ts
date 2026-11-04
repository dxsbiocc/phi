import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import type {
  TeamAdminDetail,
  TeamPackResult,
  TeamSourcePreview,
  TeamSourceView
} from '../../shared/teamPackTypes'
import type { TeamPackAdminService } from '../agent/team-pack/admin-service'
import { isTeamPackError } from '../agent/team-pack/errors'
import type {
  AddTeamSourceInput,
  TeamSource,
  TeamSourcePreview as ServiceTeamSourcePreview
} from '../agent/team-pack/team-source'
import {
  addMemberInput,
  adminBackupInput,
  backupPassphrase,
  createTeamInput,
  modelGrantInput,
  publishInput,
  removeMemberInput,
  sourceIdInput,
  sourceInput,
  teamIdInput,
  withdrawInput
} from './team-pack-ipc-validation'

export interface TeamPackIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  requireMainWindowRenderer: (event: IpcMainInvokeEvent) => unknown
  member: {
    getRecipient: () => Promise<string>
    exportBackup: (path: string, passphrase: string) => Promise<void>
    importBackup: (path: string, passphrase: string) => Promise<string>
  }
  sources: {
    listSources: () => TeamSource[]
    configuredProviders: (teamId: string) => string[]
    previewSource: (input: AddTeamSourceInput) => Promise<ServiceTeamSourcePreview>
    addSource: (input: AddTeamSourceInput) => Promise<TeamSource>
    pullSource: (id: string) => Promise<TeamSource>
    removeSource: (id: string) => Promise<boolean>
  }
  scheduler: {
    start: () => Promise<void>
    stop: () => void
  }
  admin: Pick<
    TeamPackAdminService,
    | 'listTeams'
    | 'getTeamSummary'
    | 'listMembers'
    | 'createTeam'
    | 'exportSigningKeyBackup'
    | 'importSigningKeyBackup'
    | 'addMember'
    | 'removeMember'
    | 'setMemberModelGrants'
    | 'publishRelease'
    | 'withdrawRelease'
  >
  dialogs: {
    pickSourceDirectory: () => Promise<string | null>
    pickMemberBackupExport: () => Promise<string | null>
    pickMemberBackupImport: () => Promise<string | null>
    pickAdminBackupExport: (teamId: string) => Promise<string | null>
    pickAdminBackupImport: () => Promise<string | null>
    pickPublishDirectory: (teamId: string) => Promise<string | null>
  }
}

export function registerTeamPackIpc(options: TeamPackIpcOptions): void {
  registerMemberTeamPackIpc(options)
  registerAdminTeamPackIpc(options)
  registerSourceTeamPackIpc(options)
}

function registerMemberTeamPackIpc(options: TeamPackIpcOptions): void {
  options.ipcMain.handle(
    IPC.teamPack.getMemberSnapshot,
    trustedHandler(options, async () =>
      teamPackResult(async () => ({ recipient: await options.member.getRecipient() }))
    )
  )
  options.ipcMain.handle(
    IPC.teamPack.exportMemberBackup,
    trustedHandler(options, async (_, input: unknown) =>
      teamPackResult(async () => {
        const passphrase = backupPassphrase(input)
        const path = await options.dialogs.pickMemberBackupExport()
        if (path === null) return { exported: false }
        await options.member.exportBackup(path, passphrase)
        return { exported: true }
      })
    )
  )
  options.ipcMain.handle(
    IPC.teamPack.importMemberBackup,
    trustedHandler(options, async (_, input: unknown) =>
      teamPackResult(async () => {
        const passphrase = backupPassphrase(input)
        const path = await options.dialogs.pickMemberBackupImport()
        if (path === null) return { imported: false }
        const recipient = await options.member.importBackup(path, passphrase)
        return { imported: true, recipient }
      })
    )
  )
}

function registerAdminTeamPackIpc(options: TeamPackIpcOptions): void {
  options.ipcMain.handle(
    IPC.teamPack.listAdminTeams,
    trustedHandler(options, async () => teamPackResult(() => options.admin.listTeams()))
  )
  options.ipcMain.handle(
    IPC.teamPack.getAdminTeam,
    trustedHandler(options, async (_, input: unknown) =>
      teamPackResult(() => adminDetail(options.admin, teamIdInput(input)))
    )
  )
  options.ipcMain.handle(
    IPC.teamPack.createAdminTeam,
    trustedHandler(options, async (_, input: unknown) =>
      teamPackResult(() => options.admin.createTeam(createTeamInput(input)))
    )
  )
  options.ipcMain.handle(
    IPC.teamPack.addAdminMember,
    trustedHandler(options, async (_, input: unknown) =>
      teamPackResult(() => options.admin.addMember(addMemberInput(input)))
    )
  )
  options.ipcMain.handle(
    IPC.teamPack.removeAdminMember,
    trustedHandler(options, async (_, input: unknown) =>
      teamPackResult(() => options.admin.removeMember(removeMemberInput(input)))
    )
  )
  options.ipcMain.handle(
    IPC.teamPack.setAdminMemberModels,
    trustedHandler(options, async (_, input: unknown) =>
      teamPackResult(() => options.admin.setMemberModelGrants(modelGrantInput(input)))
    )
  )
  registerAdminBackupTeamPackIpc(options)
  registerAdminReleaseTeamPackIpc(options)
}

function registerAdminBackupTeamPackIpc(options: TeamPackIpcOptions): void {
  options.ipcMain.handle(
    IPC.teamPack.exportAdminBackup,
    trustedHandler(options, async (_, input: unknown) =>
      teamPackResult(async () => {
        const backup = adminBackupInput(input)
        const path = await options.dialogs.pickAdminBackupExport(backup.teamId)
        if (path === null) return { exported: false }
        await options.admin.exportSigningKeyBackup({
          teamId: backup.teamId,
          backupPath: path,
          passphrase: backup.passphrase
        })
        return { exported: true }
      })
    )
  )
  options.ipcMain.handle(
    IPC.teamPack.importAdminBackup,
    trustedHandler(options, async (_, input: unknown) =>
      teamPackResult(async () => {
        const passphrase = backupPassphrase(input)
        const path = await options.dialogs.pickAdminBackupImport()
        if (path === null) return { imported: false }
        const team = await options.admin.importSigningKeyBackup({
          backupPath: path,
          passphrase
        })
        return { imported: true, team }
      })
    )
  )
}

function registerAdminReleaseTeamPackIpc(options: TeamPackIpcOptions): void {
  options.ipcMain.handle(
    IPC.teamPack.publishAdminRelease,
    trustedHandler(options, async (_, input: unknown) =>
      teamPackResult(async () => {
        const request = publishInput(input)
        const summary = options.admin.getTeamSummary(request.teamId)
        const storeDir =
          summary.storeDir ?? (await options.dialogs.pickPublishDirectory(request.teamId))
        if (storeDir === null) return null
        return options.admin.publishRelease({ ...request, storeDir })
      })
    )
  )
  options.ipcMain.handle(
    IPC.teamPack.withdrawAdminRelease,
    trustedHandler(options, async (_, input: unknown) =>
      teamPackResult(() => options.admin.withdrawRelease(withdrawInput(input)))
    )
  )
}

function registerSourceTeamPackIpc(options: TeamPackIpcOptions): void {
  options.ipcMain.handle(
    IPC.teamPack.listSources,
    trustedHandler(options, async () =>
      teamPackResult(() =>
        options.sources
          .listSources()
          .map((source) => sourceView(source, options.sources.configuredProviders(source.teamId)))
      )
    )
  )
  options.ipcMain.handle(
    IPC.teamPack.pickSourceDirectory,
    trustedHandler(options, async () => teamPackResult(() => options.dialogs.pickSourceDirectory()))
  )
  options.ipcMain.handle(
    IPC.teamPack.previewSource,
    trustedHandler(options, async (_, input: unknown) =>
      teamPackResult(async () =>
        previewView(await options.sources.previewSource(sourceInput(input)))
      )
    )
  )
  options.ipcMain.handle(
    IPC.teamPack.addSource,
    trustedHandler(options, async (_, input: unknown) =>
      teamPackResult(async () => {
        const source = await options.sources.addSource(sourceInput(input))
        await options.scheduler.start()
        const current =
          options.sources.listSources().find((entry) => entry.id === source.id) ?? source
        return sourceView(current, options.sources.configuredProviders(current.teamId))
      })
    )
  )
  options.ipcMain.handle(
    IPC.teamPack.checkSource,
    trustedHandler(options, async (_, input: unknown) =>
      teamPackResult(async () => {
        const source = await options.sources.pullSource(sourceIdInput(input))
        return sourceView(source, options.sources.configuredProviders(source.teamId))
      })
    )
  )
  options.ipcMain.handle(
    IPC.teamPack.removeSource,
    trustedHandler(options, async (_, input: unknown) =>
      teamPackResult(async () => {
        const removed = await options.sources.removeSource(sourceIdInput(input))
        if (removed && options.sources.listSources().length === 0) options.scheduler.stop()
        return { removed }
      })
    )
  )
}

function trustedHandler(
  options: TeamPackIpcOptions,
  handler: (event: IpcMainInvokeEvent, input?: unknown) => unknown
): (event: IpcMainInvokeEvent, input?: unknown) => unknown {
  return (event, input) => {
    options.requireMainWindowRenderer(event)
    return handler(event, input)
  }
}

function adminDetail(
  admin: Pick<TeamPackAdminService, 'getTeamSummary' | 'listMembers'>,
  teamId: string
): TeamAdminDetail {
  const summary = admin.getTeamSummary(teamId)
  return {
    ...summary,
    releases: summary.releases.map((release) => ({
      ...release,
      memberIds: [...release.memberIds]
    })),
    withdrawnReleases: [...summary.withdrawnReleases],
    members: admin.listMembers(teamId).map((member) => ({ ...member })),
    modelGrants: summary.modelGrants.map((grant) => ({
      memberId: grant.memberId,
      models: grant.models.map((model) => ({ ...model }))
    }))
  }
}

function previewView(preview: ServiceTeamSourcePreview): TeamSourcePreview {
  return {
    teamId: preview.teamId,
    teamName: preview.teamName,
    publicKeyFingerprint: preview.teamKeyId,
    location: preview.location
  }
}

function sourceView(source: TeamSource, configuredProviders: string[]): TeamSourceView {
  return {
    id: source.id,
    teamId: source.teamId,
    teamName: source.teamName,
    publicKeyFingerprint: source.teamKeyId,
    location: source.location,
    addedAt: source.addedAt,
    status: {
      ...source.status,
      withdrawnReleases: [...source.status.withdrawnReleases],
      credentialConflicts: [...source.status.credentialConflicts],
      skippedProviders: [...source.status.skippedProviders],
      announcements: source.status.announcements.map((announcement) => ({ ...announcement })),
      resources: Object.fromEntries(
        Object.entries(source.status.resources).map(([identity, metadata]) => [
          identity,
          {
            sharing: metadata.sharing,
            ...(metadata.originalSource
              ? {
                  originalSource: {
                    teamId: metadata.originalSource.teamId,
                    teamName: metadata.originalSource.teamName,
                    publicKeyFingerprint: metadata.originalSource.teamKeyId
                  }
                }
              : {})
          }
        ])
      ),
      configuredProviders: [...configuredProviders]
    }
  }
}

async function teamPackResult<T>(operation: () => T | Promise<T>): Promise<TeamPackResult<T>> {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    if (isTeamPackError(error)) {
      return { ok: false, error: { code: error.code, message: error.message } }
    }
    return {
      ok: false,
      error: { code: 'STORE_UNAVAILABLE', message: '团队包操作暂时不可用' }
    }
  }
}
