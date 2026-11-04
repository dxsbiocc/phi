import { useCallback, useEffect, useRef, useState } from 'react'
import type { InstalledPackageView } from '../../../../../shared/packageManagerTypes'
import type {
  TeamAdminDetail,
  TeamAdminListItem,
  TeamAdminModelInput,
  TeamCreatedAdminTeam,
  TeamPackageSelection,
  TeamPublishedAdminRelease
} from '../../../../../shared/teamPackTypes'

import { resultErrorCode, resultValue, teamPackApi } from '../lib/teamApi'

export interface TeamPackAdminController {
  teams: TeamAdminListItem[]
  detail: TeamAdminDetail | null
  packages: InstalledPackageView[]
  createdTeam: TeamCreatedAdminTeam | null
  published: TeamPublishedAdminRelease | null
  errorCode: string | null
  busy: string | null
  setCreatedTeam: (team: TeamCreatedAdminTeam | null) => void
  clearError: () => void
  selectTeam: (teamId: string) => Promise<TeamAdminDetail | null>
  createTeam: (name: string) => Promise<boolean>
  exportBackup: (teamId: string, passphrase: string) => Promise<boolean>
  importBackup: (passphrase: string) => Promise<boolean>
  addMember: (displayName: string, recipient: string) => Promise<boolean>
  removeMember: (memberId: string) => Promise<boolean>
  setMemberModels: (memberId: string, models: TeamAdminModelInput[]) => Promise<boolean>
  publish: (selections: TeamPackageSelection[], announcement?: string) => Promise<boolean>
  announceOnly: (announcement: string) => Promise<boolean>
  withdraw: (release: number) => Promise<boolean>
}

// eslint-disable-next-line max-lines-per-function -- public hook composes the bounded administrator IPC workflow
export function useTeamPackAdmin(): TeamPackAdminController {
  const [teams, setTeams] = useState<TeamAdminListItem[]>([])
  const [detail, setDetail] = useState<TeamAdminDetail | null>(null)
  const [packages, setPackages] = useState<InstalledPackageView[]>([])
  const [createdTeam, setCreatedTeam] = useState<TeamCreatedAdminTeam | null>(null)
  const [published, setPublished] = useState<TeamPublishedAdminRelease | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const selectedTeamId = useRef<string | null>(null)
  const detailRequest = useRef(0)
  const operationRequest = useRef(0)

  const run = useCallback(
    async <T>(key: string, operation: () => Promise<T>): Promise<T | null> => {
      const request = ++operationRequest.current
      setBusy(key)
      setErrorCode(null)
      try {
        return await operation()
      } catch (cause) {
        if (operationRequest.current === request) setErrorCode(resultErrorCode(cause))
        return null
      } finally {
        if (operationRequest.current === request) setBusy(null)
      }
    },
    []
  )

  const loadDetail = useCallback(
    async (teamId: string, preservePublished = false): Promise<TeamAdminDetail | null> => {
      selectedTeamId.current = teamId
      const request = ++detailRequest.current
      if (!preservePublished) {
        setPublished(null)
        setDetail(null)
      }
      const next = await run('load-team', async () =>
        resultValue(await teamPackApi().getAdminTeam({ teamId }))
      )
      if (request !== detailRequest.current || selectedTeamId.current !== teamId) return null
      if (next) setDetail(next)
      return next
    },
    [run]
  )

  useEffect(() => {
    let active = true
    Promise.all([teamPackApi().listAdminTeams(), window.api.listInstalledPackages()])
      .then(([teamResult, installed]) => {
        if (!active) return
        setTeams(resultValue(teamResult))
        setPackages(installed)
      })
      .catch((cause: unknown) => {
        if (active) setErrorCode(resultErrorCode(cause))
      })
    return () => {
      active = false
    }
  }, [])

  async function refreshDetail(teamId: string): Promise<void> {
    if (selectedTeamId.current === teamId) await loadDetail(teamId, true)
  }

  async function publishRelease(
    packages: TeamPackageSelection[],
    announcement?: string,
    announcementOnly = false
  ): Promise<boolean> {
    if (!detail) return false
    const teamId = detail.teamId
    const release = await run('publish', async () =>
      resultValue(
        await teamPackApi().publishAdminRelease({
          teamId,
          packages,
          ...(announcement === undefined ? {} : { announcement }),
          ...(announcementOnly ? { announcementOnly: true } : {})
        })
      )
    )
    if (!release) return false
    if (selectedTeamId.current !== teamId) return false
    setPublished(release)
    await refreshDetail(teamId)
    return true
  }

  return {
    teams,
    detail,
    packages,
    createdTeam,
    published,
    errorCode,
    busy,
    setCreatedTeam,
    clearError: () => setErrorCode(null),
    selectTeam: (teamId: string) => loadDetail(teamId),
    createTeam: async (name: string) => {
      const created = await run('create-team', async () =>
        resultValue(await teamPackApi().createAdminTeam({ name }))
      )
      if (!created) return false
      setCreatedTeam(created)
      setTeams((current) => [...current, created])
      await loadDetail(created.teamId)
      return true
    },
    exportBackup: async (teamId: string, passphrase: string) => {
      const result = await run('admin-export', async () =>
        resultValue(await teamPackApi().exportAdminBackup({ teamId, passphrase }))
      )
      return result?.exported === true
    },
    importBackup: async (passphrase: string) => {
      const imported = await run('admin-import', async () =>
        resultValue(await teamPackApi().importAdminBackup({ passphrase }))
      )
      if (!imported?.imported || !imported.team) return false
      setTeams((current) => [
        ...current.filter((team) => team.teamId !== imported.team!.teamId),
        imported.team!
      ])
      await loadDetail(imported.team.teamId)
      return true
    },
    addMember: async (displayName: string, recipient: string) => {
      if (!detail) return false
      const teamId = detail.teamId
      const added = await run('add-member', async () =>
        resultValue(await teamPackApi().addAdminMember({ teamId, displayName, recipient }))
      )
      if (!added) return false
      if (selectedTeamId.current !== teamId) return false
      await refreshDetail(teamId)
      return true
    },
    removeMember: async (memberId: string) => {
      if (!detail) return false
      const teamId = detail.teamId
      const removed = await run('remove-member', async () =>
        resultValue(await teamPackApi().removeAdminMember({ teamId, memberId }))
      )
      if (!removed) return false
      if (selectedTeamId.current !== teamId) return false
      await refreshDetail(teamId)
      return true
    },
    setMemberModels: async (memberId: string, models: TeamAdminModelInput[]) => {
      if (!detail) return false
      const teamId = detail.teamId
      const saved = await run('save-models', async () =>
        resultValue(await teamPackApi().setAdminMemberModels({ teamId, memberId, models }))
      )
      if (!saved) return false
      if (selectedTeamId.current !== teamId) return false
      await refreshDetail(teamId)
      return true
    },
    publish: (selections: TeamPackageSelection[], announcement?: string) =>
      publishRelease(selections, announcement),
    announceOnly: (announcement: string) => publishRelease([], announcement, true),
    withdraw: async (release: number) => {
      if (!detail) return false
      const teamId = detail.teamId
      const withdrawn = await run('withdraw', async () =>
        resultValue(await teamPackApi().withdrawAdminRelease({ teamId, release }))
      )
      if (!withdrawn) return false
      if (selectedTeamId.current !== teamId) return false
      await refreshDetail(teamId)
      return true
    }
  }
}
