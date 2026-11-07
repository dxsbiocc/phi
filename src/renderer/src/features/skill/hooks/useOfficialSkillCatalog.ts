import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import type {
  PhiSkillGroupId,
  PhiSkillListPage
} from '../../../../../shared/phiWebsiteCatalogTypes'
import {
  officialSkillCatalogGroups,
  resolveSkillCatalogGroupId,
  type SkillCatalogGroup
} from '../lib/skillCatalogBrowser'

export interface OfficialSkillCatalogState {
  status: 'loading' | 'available' | 'unavailable'
  groups: SkillCatalogGroup[]
  selectedGroupId: PhiSkillGroupId
  page: PhiSkillListPage | null
  isLoading: boolean
  markUnavailable: () => void
}

const OfficialSkillCatalogContext = createContext<OfficialSkillCatalogState | null>(null)

/** Controlled catalog data for isolated renderer surfaces such as previews and tests. */
export const OfficialSkillCatalogProvider = OfficialSkillCatalogContext.Provider

/** Website-backed purpose groups and server-paged skill rows. */
export function useOfficialSkillCatalog({
  open,
  revision,
  requestedGroupId,
  query,
  page,
  pageSize
}: {
  open: boolean
  revision: number
  requestedGroupId: string
  query: string
  page: number
  pageSize: number
}): OfficialSkillCatalogState {
  const controlled = useContext(OfficialSkillCatalogContext)
  const live = useLiveOfficialSkillCatalog({
    open,
    revision,
    requestedGroupId,
    query,
    page,
    pageSize
  })
  return controlled ?? live
}

function useLiveOfficialSkillCatalog({
  open,
  revision,
  requestedGroupId,
  query,
  page,
  pageSize
}: {
  open: boolean
  revision: number
  requestedGroupId: string
  query: string
  page: number
  pageSize: number
}): OfficialSkillCatalogState {
  const [status, setStatus] = useState<OfficialSkillCatalogState['status']>('loading')
  const [groups, setGroups] = useState<SkillCatalogGroup[]>([])
  const [catalogPage, setCatalogPage] = useState<PhiSkillListPage | null>(null)
  const [isListLoading, setIsListLoading] = useState(false)
  const selectedGroupId = resolveSkillCatalogGroupId(groups, requestedGroupId) as PhiSkillGroupId

  const markUnavailable = useCallback((): void => {
    setCatalogPage(null)
    setStatus('unavailable')
    setIsListLoading(false)
  }, [])

  useEffect(() => {
    if (!open || revision === 0) return undefined
    let active = true
    void Promise.resolve()
      .then(() => {
        setStatus('loading')
        setIsListLoading(false)
        return window.api.listOfficialSkillGroups({ page: 1, pageSize: 100 })
      })
      .then((result) => {
        if (!active) return
        if (result.status === 'unavailable') {
          setGroups([])
          markUnavailable()
          return
        }
        setGroups(officialSkillCatalogGroups(result.data.items))
        setStatus('available')
      })
      .catch(() => {
        if (!active) return
        setGroups([])
        markUnavailable()
      })
    return () => {
      active = false
    }
  }, [markUnavailable, open, revision])

  useEffect(() => {
    if (!open || status !== 'available' || groups.length === 0) return undefined
    let active = true
    const trimmedQuery = query.trim()
    void Promise.resolve()
      .then(() => {
        setIsListLoading(true)
        return window.api.listOfficialSkills({
          group: selectedGroupId,
          ...(trimmedQuery ? { q: trimmedQuery } : {}),
          page: page + 1,
          pageSize
        })
      })
      .then((result) => {
        if (!active) return
        if (result.status === 'unavailable') {
          markUnavailable()
          return
        }
        setCatalogPage(result.data)
      })
      .catch(() => {
        if (active) markUnavailable()
      })
      .finally(() => {
        if (active) setIsListLoading(false)
      })
    return () => {
      active = false
    }
  }, [groups.length, markUnavailable, open, page, pageSize, query, selectedGroupId, status])

  return useMemo(
    () => ({
      status,
      groups,
      selectedGroupId,
      page: catalogPage,
      isLoading: status === 'loading' || isListLoading,
      markUnavailable
    }),
    [catalogPage, groups, isListLoading, markUnavailable, selectedGroupId, status]
  )
}
