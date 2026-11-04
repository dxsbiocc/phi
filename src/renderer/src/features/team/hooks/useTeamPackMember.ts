import { useCallback, useEffect, useState } from 'react'
import type { TeamSourceInput, TeamSourcePreview } from '../../../../../shared/teamPackTypes'

import { resultErrorCode, resultValue, sourceView, teamPackApi } from '../lib/teamApi'
import type { TeamSourceView } from '../lib/teamTypes'

export interface TeamPackMemberController {
  recipient: string | null
  sources: TeamSourceView[]
  errorCode: string | null
  busy: string | null
  clearError: () => void
  pickDirectory: () => Promise<string | null>
  previewSource: (input: TeamSourceInput) => Promise<TeamSourcePreview | null>
  addSource: (input: TeamSourceInput) => Promise<boolean>
  checkSource: (sourceId: string) => Promise<void>
  removeSource: (sourceId: string) => Promise<boolean>
  exportBackup: (passphrase: string) => Promise<boolean>
  importBackup: (passphrase: string) => Promise<boolean>
}

// eslint-disable-next-line max-lines-per-function -- public hook composes the bounded member IPC workflow
export function useTeamPackMember(): TeamPackMemberController {
  const [recipient, setRecipient] = useState<string | null>(null)
  const [sources, setSources] = useState<TeamSourceView[]>([])
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>('load-member')

  const run = useCallback(
    async <T>(key: string, operation: () => Promise<T>): Promise<T | null> => {
      setBusy(key)
      setErrorCode(null)
      try {
        return await operation()
      } catch (cause) {
        setErrorCode(resultErrorCode(cause))
        return null
      } finally {
        setBusy(null)
      }
    },
    []
  )

  useEffect(() => {
    let active = true
    Promise.allSettled([teamPackApi().getMemberSnapshot(), teamPackApi().listSources()])
      .then(([memberSettled, sourceSettled]) => {
        if (!active) return
        if (memberSettled.status === 'fulfilled') {
          if (memberSettled.value.ok) setRecipient(memberSettled.value.value.recipient)
          else setErrorCode(memberSettled.value.error.code)
        } else {
          setErrorCode(resultErrorCode(memberSettled.reason))
        }
        if (sourceSettled.status === 'fulfilled') {
          if (sourceSettled.value.ok) setSources(sourceSettled.value.value.map(sourceView))
          else setErrorCode(sourceSettled.value.error.code)
        } else {
          setErrorCode(resultErrorCode(sourceSettled.reason))
        }
      })
      .finally(() => {
        if (active) setBusy(null)
      })
    return () => {
      active = false
    }
  }, [])

  return {
    recipient,
    sources,
    errorCode,
    busy,
    clearError: () => setErrorCode(null),
    pickDirectory: async () =>
      (await run('pick-source', async () =>
        resultValue(await teamPackApi().pickSourceDirectory())
      )) ?? null,
    previewSource: (input) =>
      run('preview-source', async () => resultValue(await teamPackApi().previewSource(input))),
    addSource: async (input) => {
      const added = await run('add-source', async () =>
        sourceView(resultValue(await teamPackApi().addSource(input)))
      )
      if (!added) return false
      setSources((current) => [...current.filter((source) => source.id !== added.id), added])
      return true
    },
    checkSource: async (sourceId) => {
      const checked = await run(`check:${sourceId}`, async () =>
        sourceView(resultValue(await teamPackApi().checkSource({ sourceId })))
      )
      if (!checked) {
        try {
          const refreshed = await teamPackApi().listSources()
          if (refreshed.ok) setSources(refreshed.value.map(sourceView))
        } catch {
          // Keep the localized check error; the last good list remains usable.
        }
        return
      }
      setSources((current) =>
        current.map((source) => (source.id === checked.id ? checked : source))
      )
    },
    removeSource: async (sourceId) => {
      const removed = await run(`remove:${sourceId}`, async () =>
        resultValue(await teamPackApi().removeSource({ sourceId }))
      )
      if (!removed?.removed) return false
      setSources((current) => current.filter((source) => source.id !== sourceId))
      return true
    },
    exportBackup: async (passphrase) => {
      const result = await run('member-export', async () =>
        resultValue(await teamPackApi().exportMemberBackup({ passphrase }))
      )
      return result?.exported === true
    },
    importBackup: async (passphrase) => {
      const imported = await run('member-import', async () =>
        resultValue(await teamPackApi().importMemberBackup({ passphrase }))
      )
      if (!imported?.imported) return false
      if (imported.recipient) setRecipient(imported.recipient)
      return true
    }
  }
}
