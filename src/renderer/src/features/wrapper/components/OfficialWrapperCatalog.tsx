import { useEffect, useMemo, useState } from 'react'
import { Box, Button, CircularProgress, Typography } from '@mui/material'
import type {
  PhiWrapperCatalogDetail,
  PhiWrapperCatalogGroup,
  PhiWrapperCatalogTool,
  PhiWrapperGroupsPage
} from '../../../../../shared/phiWebsiteCatalogTypes'
import { CatalogBrowseLayout } from '../../../components/catalog/CatalogBrowseLayout'
import { CatalogPagination } from '../../../components/catalog/CatalogPagination'
import { CatalogResultsTable } from '../../../components/catalog/CatalogResultsTable'
import { CATALOG_DEFAULT_PAGE_SIZE } from '../../../components/catalog/catalogPaging'
import { useUiLanguage } from '../../../lib/i18n'
import { resourceUi } from '../../../lib/resourceUi'
import {
  loadOfficialWrapperDetail,
  loadOfficialWrapperGroups,
  loadOfficialWrapperSuiteTools,
  officialWrapperCategoryGroups,
  officialWrapperDefaultToolId,
  officialWrapperGroupChoices,
  officialWrapperGroupIcon,
  officialWrapperGroupRowDetails,
  officialWrapperGroupsQuery,
  officialWrapperToolChoices,
  type OfficialWrapperCatalogApi,
  type OfficialWrapperToolChoice
} from '../lib/officialWrapperCatalog'
import type { WrapperCatalogChoice } from '../lib/wrapperCatalog'
import { wrapperCopy } from '../lib/wrapperCopy'
import { OfficialWrapperSuiteSplitView } from './OfficialWrapperSuiteSplitView'
import { WrapperResourceIcon } from './WrapperResourceIcon'

export { OfficialWrapperSuiteSplitView as OfficialWrapperSuiteView }

const GROUP_PREFETCH_CONCURRENCY = 4

function LoadingRows(): React.JSX.Element {
  return (
    <Box sx={{ display: 'grid', placeItems: 'center', py: 6 }}>
      <CircularProgress size={22} />
    </Box>
  )
}

export function OfficialWrapperGroupsView({
  page,
  categoryId,
  query,
  loading,
  busy,
  rowsPerPage,
  registryChoices = [],
  registryLoading = false,
  suiteToolsBySuite,
  actions,
  feedback,
  renderSuiteAction,
  renderPendingGroupAction,
  onCategoryChange,
  onQueryChange,
  onPageChange,
  onRowsPerPageChange,
  onOpen,
  onRefresh,
  onClose
}: {
  page?: PhiWrapperGroupsPage
  categoryId: string
  query: string
  loading: boolean
  busy: boolean
  rowsPerPage: number
  registryChoices?: readonly WrapperCatalogChoice[]
  registryLoading?: boolean
  suiteToolsBySuite?: Readonly<Record<string, readonly PhiWrapperCatalogTool[]>>
  actions?: React.ReactNode
  feedback?: React.ReactNode
  renderSuiteAction?: (
    suite: string,
    choices: readonly OfficialWrapperToolChoice[]
  ) => React.ReactNode
  renderPendingGroupAction?: (group: PhiWrapperCatalogGroup) => React.ReactNode
  onCategoryChange: (id: string) => void
  onQueryChange: (value: string) => void
  onPageChange: (page: number) => void
  onRowsPerPageChange: (size: number) => void
  onOpen: (group: PhiWrapperCatalogGroup) => void
  onRefresh?: () => void
  onClose: () => void
}): React.JSX.Element {
  useUiLanguage()
  const categories = page
    ? officialWrapperCategoryGroups(page)
    : [{ id: 'all', label: wrapperCopy.allWrapperGroups, count: 0 }]
  const selectedCategory = categories.some((category) => category.id === categoryId)
    ? categoryId
    : 'all'
  const isRefreshing = loading || registryLoading
  return (
    <CatalogBrowseLayout
      title={wrapperCopy.wrapperGroups}
      closeLabel={wrapperCopy.closeCatalog}
      groups={categories}
      selectedGroupId={selectedCategory}
      onGroupChange={onCategoryChange}
      query={query}
      onQueryChange={onQueryChange}
      searchLabel={wrapperCopy.searchWrapperGroups}
      onClose={onClose}
      busy={busy}
      loading={isRefreshing}
      refreshLabel={isRefreshing ? resourceUi.loading : resourceUi.refresh}
      onRefresh={onRefresh}
      page={Math.max(0, (page?.page ?? 1) - 1)}
      rowsPerPage={rowsPerPage}
      actions={actions}
      footer={
        page ? (
          <CatalogPagination
            count={page.total}
            page={Math.max(0, page.page - 1)}
            rowsPerPage={rowsPerPage}
            onPageChange={onPageChange}
            onRowsPerPageChange={onRowsPerPageChange}
          />
        ) : null
      }
    >
      {feedback}
      {loading && !page ? (
        <LoadingRows />
      ) : (
        <>
          <CatalogResultsTable
            label={wrapperCopy.wrapperGroupList}
            nameLabel={wrapperCopy.wrapperGroups}
            metadataLabel={wrapperCopy.category}
            detailsLabel={wrapperCopy.tools}
            rowAttribute="data-phi-wrapper-catalog-group"
            onOpen={(suite) => {
              const group = page?.items.find((item) => item.suite === suite)
              if (group) onOpen(group)
            }}
            rows={(page?.items ?? []).map((group) => {
              const resolved = officialWrapperGroupChoices(
                group,
                registryChoices,
                suiteToolsBySuite?.[group.suite]
              )
              const action =
                renderSuiteAction && !registryLoading && resolved.choices ? (
                  renderSuiteAction(group.suite, resolved.choices)
                ) : renderPendingGroupAction ? (
                  renderPendingGroupAction(group)
                ) : (
                  <Button
                    size="small"
                    variant="contained"
                    disabled
                    aria-label={`${resourceUi.install} ${group.suite}`}
                    data-phi-wrapper-suite-action="true"
                  >
                    {registryLoading ? <CircularProgress size={16} /> : resourceUi.install}
                  </Button>
                )
              return {
                rowKey: group.suite,
                id: group.suite,
                icon: (
                  <WrapperResourceIcon
                    icon={officialWrapperGroupIcon(resolved.choices)}
                    tier={group.category || group.categoryLabel}
                  />
                ),
                title: group.suite,
                summary: '',
                metadata: group.categoryLabel,
                details: officialWrapperGroupRowDetails(group),
                action
              }
            })}
          />
          {!page?.items.length ? (
            <Typography color="text.secondary" sx={{ py: 4 }}>
              {wrapperCopy.noWrapperGroups}
            </Typography>
          ) : null}
        </>
      )}
    </CatalogBrowseLayout>
  )
}

export function OfficialWrapperCatalog({
  open,
  api,
  registryChoices,
  registryLoading,
  busy,
  onRefreshRegistry,
  actions,
  feedback,
  renderSuiteAction,
  onInstallSuite,
  onUnavailable,
  onClose
}: {
  open: boolean
  api: OfficialWrapperCatalogApi
  registryChoices: readonly WrapperCatalogChoice[]
  registryLoading: boolean
  busy: boolean
  onRefreshRegistry?: () => void
  actions?: React.ReactNode
  feedback?: React.ReactNode
  renderSuiteAction: (
    suite: string,
    choices: readonly OfficialWrapperToolChoice[]
  ) => React.ReactNode
  onInstallSuite?: (
    suite: string,
    choices: readonly OfficialWrapperToolChoice[]
  ) => Promise<void> | void
  onUnavailable: () => void
  onClose: () => void
}): React.JSX.Element {
  const [groupsPage, setGroupsPage] = useState<PhiWrapperGroupsPage>()
  const [cachedGroupPages, setCachedGroupPages] = useState<Record<string, PhiWrapperGroupsPage>>({})
  const [refreshRevision, setRefreshRevision] = useState(0)
  const [groupQuery, setGroupQuery] = useState('')
  const [categoryId, setCategoryId] = useState('all')
  const [groupPage, setGroupPage] = useState(0)
  const [groupPageSize, setGroupPageSize] = useState(CATALOG_DEFAULT_PAGE_SIZE)
  const [selectedSuite, setSelectedSuite] = useState<string>()
  const [suiteTools, setSuiteTools] = useState<PhiWrapperCatalogTool[]>()
  const [suiteToolsBySuite, setSuiteToolsBySuite] = useState<
    Record<string, PhiWrapperCatalogTool[]>
  >({})
  const [resolvingSuites, setResolvingSuites] = useState<Set<string>>(() => new Set())
  const [toolQuery, setToolQuery] = useState('')
  const [selectedToolId, setSelectedToolId] = useState<string>()
  const [suiteDetail, setSuiteDetail] = useState<PhiWrapperCatalogDetail>()
  const [groupsLoading, setGroupsLoading] = useState(true)
  const [toolsLoading, setToolsLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (!open) {
      setSelectedSuite(undefined)
      setSuiteTools(undefined)
      setSelectedToolId(undefined)
      setSuiteDetail(undefined)
      setToolQuery('')
      setToolsLoading(false)
      setDetailLoading(false)
      setGroupQuery('')
      setCategoryId('all')
      setGroupPage(0)
      setGroupPageSize(CATALOG_DEFAULT_PAGE_SIZE)
    }
  }
  const groupQueryKey = `${refreshRevision}\u0000${categoryId}\u0000${groupQuery.trim()}\u0000${groupPage}\u0000${groupPageSize}`
  const cachedGroupsPage = cachedGroupPages[groupQueryKey]

  useEffect(() => {
    if (!open || selectedSuite || cachedGroupsPage) return undefined
    let active = true
    void loadOfficialWrapperGroups(
      api,
      officialWrapperGroupsQuery(groupQuery, categoryId, groupPage, groupPageSize)
    ).then((result) => {
      if (!active) return
      if (result.source === 'fallback') return onUnavailable()
      setGroupsPage(result.data)
      setCachedGroupPages((current) => ({ ...current, [groupQueryKey]: result.data }))
      setGroupsLoading(false)
    })
    return () => {
      active = false
    }
  }, [
    api,
    cachedGroupsPage,
    categoryId,
    groupPage,
    groupPageSize,
    groupQuery,
    groupQueryKey,
    onUnavailable,
    open,
    selectedSuite
  ])

  const activeGroupsPage = cachedGroupsPage ?? groupsPage

  useEffect(() => {
    if (
      !open ||
      selectedSuite ||
      registryLoading ||
      !activeGroupsPage ||
      !api.listOfficialWrapperTools
    ) {
      return undefined
    }
    const pendingSuites = activeGroupsPage.items
      .filter(
        (group) =>
          !suiteToolsBySuite[group.suite] &&
          !officialWrapperGroupChoices(group, registryChoices, undefined).authoritative
      )
      .map((group) => group.suite)
    if (pendingSuites.length === 0) return undefined

    let active = true
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (active && cursor < pendingSuites.length) {
        const suite = pendingSuites[cursor++]!
        const result = await loadOfficialWrapperSuiteTools(api, suite)
        if (!active || result.source === 'fallback') continue
        setSuiteToolsBySuite((current) =>
          current[suite] ? current : { ...current, [suite]: result.data }
        )
      }
    }
    void Promise.all(
      Array.from({ length: Math.min(GROUP_PREFETCH_CONCURRENCY, pendingSuites.length) }, () =>
        worker()
      )
    )
    return () => {
      active = false
    }
  }, [
    activeGroupsPage,
    api,
    open,
    registryChoices,
    registryLoading,
    selectedSuite,
    suiteToolsBySuite
  ])

  useEffect(() => {
    if (!open || !selectedSuite || suiteTools) return undefined
    let active = true
    void loadOfficialWrapperSuiteTools(api, selectedSuite).then((result) => {
      if (!active) return
      if (result.source === 'fallback') return onUnavailable()
      const firstToolId = officialWrapperDefaultToolId(result.data)
      setSuiteToolsBySuite((current) => ({ ...current, [selectedSuite]: result.data }))
      setSuiteTools(result.data)
      setToolsLoading(false)
      setSuiteDetail(undefined)
      setSelectedToolId(firstToolId)
      setDetailLoading(Boolean(firstToolId))
    })
    return () => {
      active = false
    }
  }, [api, onUnavailable, open, selectedSuite, suiteTools])

  useEffect(() => {
    if (!open || !selectedSuite || !selectedToolId) return undefined
    let active = true
    void loadOfficialWrapperDetail(api, selectedToolId).then((result) => {
      if (!active) return
      if (result.source === 'fallback') return onUnavailable()
      setSuiteDetail(result.data)
      setDetailLoading(false)
    })
    return () => {
      active = false
    }
  }, [api, onUnavailable, open, selectedSuite, selectedToolId])

  const toolChoices = useMemo(
    () => officialWrapperToolChoices(suiteTools ?? [], registryChoices),
    [registryChoices, suiteTools]
  )

  async function installPendingGroup(group: PhiWrapperCatalogGroup): Promise<void> {
    if (!onInstallSuite || !api.listOfficialWrapperTools || resolvingSuites.has(group.suite)) return
    setResolvingSuites((current) => new Set(current).add(group.suite))
    try {
      const result = await loadOfficialWrapperSuiteTools(api, group.suite)
      if (result.source === 'fallback') {
        onUnavailable()
        return
      }
      setSuiteToolsBySuite((current) => ({ ...current, [group.suite]: result.data }))
      const resolved = officialWrapperToolChoices(result.data, registryChoices)
      if (resolved.length > 0) await onInstallSuite(group.suite, resolved)
    } finally {
      setResolvingSuites((current) => {
        const next = new Set(current)
        next.delete(group.suite)
        return next
      })
    }
  }

  function resetSuite(): void {
    setSelectedSuite(undefined)
    setSuiteTools(undefined)
    setSelectedToolId(undefined)
    setSuiteDetail(undefined)
    setToolQuery('')
    setToolsLoading(false)
    setDetailLoading(false)
  }

  if (selectedSuite) {
    return (
      <OfficialWrapperSuiteSplitView
        suite={selectedSuite}
        choices={toolChoices}
        selectedToolId={selectedToolId}
        detail={suiteDetail}
        query={toolQuery}
        loading={registryLoading || toolsLoading}
        detailLoading={detailLoading}
        busy={busy}
        feedback={feedback}
        renderSuiteAction={renderSuiteAction}
        onQueryChange={setToolQuery}
        onSelect={(id) => {
          if (id === selectedToolId) return
          setSuiteDetail(undefined)
          setDetailLoading(true)
          setSelectedToolId(id)
        }}
        onBack={resetSuite}
        onClose={() => {
          resetSuite()
          onClose()
        }}
      />
    )
  }
  return (
    <OfficialWrapperGroupsView
      page={activeGroupsPage}
      categoryId={categoryId}
      query={groupQuery}
      loading={cachedGroupsPage ? false : groupsLoading}
      busy={busy}
      rowsPerPage={groupPageSize}
      registryChoices={registryChoices}
      registryLoading={registryLoading}
      suiteToolsBySuite={suiteToolsBySuite}
      actions={actions}
      feedback={feedback}
      renderSuiteAction={renderSuiteAction}
      renderPendingGroupAction={(group) => {
        const resolving = resolvingSuites.has(group.suite)
        const canResolve = Boolean(onInstallSuite && api.listOfficialWrapperTools)
        return (
          <Button
            size="small"
            variant="contained"
            disabled={busy || registryLoading || resolving || !canResolve}
            onClick={() => void installPendingGroup(group)}
            aria-label={`${resourceUi.install} ${group.suite}`}
            data-phi-wrapper-suite-action="true"
          >
            {registryLoading || resolving ? <CircularProgress size={16} /> : resourceUi.install}
          </Button>
        )
      }}
      onCategoryChange={(id) => {
        setGroupsLoading(true)
        setCategoryId(id)
        setGroupPage(0)
      }}
      onQueryChange={(value) => {
        setGroupsLoading(true)
        setGroupQuery(value)
        setGroupPage(0)
      }}
      onPageChange={(nextPage) => {
        setGroupsLoading(true)
        setGroupPage(nextPage)
      }}
      onRowsPerPageChange={(size) => {
        setGroupsLoading(true)
        setGroupPageSize(size)
        setGroupPage(0)
      }}
      onRefresh={() => {
        setGroupsLoading(true)
        setRefreshRevision((value) => value + 1)
        onRefreshRegistry?.()
      }}
      onOpen={(group) => {
        const cached = suiteToolsBySuite[group.suite]
        const firstToolId = cached ? officialWrapperDefaultToolId(cached) : undefined
        setSuiteTools(cached)
        setSelectedToolId(firstToolId)
        setSuiteDetail(undefined)
        setToolQuery('')
        setDetailLoading(Boolean(firstToolId))
        setToolsLoading(!cached)
        setSelectedSuite(group.suite)
      }}
      onClose={() => {
        resetSuite()
        setGroupQuery('')
        setCategoryId('all')
        setGroupPage(0)
        setGroupPageSize(CATALOG_DEFAULT_PAGE_SIZE)
        onClose()
      }}
    />
  )
}
