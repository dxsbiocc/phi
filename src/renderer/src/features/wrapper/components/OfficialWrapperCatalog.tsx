import { useEffect, useMemo, useState } from 'react'
import { Box, Button, CircularProgress, Typography } from '@mui/material'
import type {
  PhiWrapperCatalogDetail,
  PhiWrapperCatalogGroup,
  PhiWrapperCatalogTool,
  PhiWrapperGroupsPage
} from '../../../../../shared/phiWebsiteCatalogTypes'
import { ResourceIcon } from '../../../components/ResourceIcon'
import { CatalogBrowseLayout } from '../../../components/catalog/CatalogBrowseLayout'
import { CatalogPagination } from '../../../components/catalog/CatalogPagination'
import { CatalogResultsTable } from '../../../components/catalog/CatalogResultsTable'
import { CATALOG_DEFAULT_PAGE_SIZE } from '../../../components/catalog/catalogPaging'
import { useUiLanguage } from '../../../lib/i18n'
import {
  loadOfficialWrapperDetail,
  loadOfficialWrapperGroups,
  loadOfficialWrapperSuiteTools,
  officialWrapperCategoryGroups,
  officialWrapperDefaultToolId,
  officialWrapperGroupRowDetails,
  officialWrapperGroupsQuery,
  officialWrapperToolChoices,
  type OfficialWrapperCatalogApi,
  type OfficialWrapperToolChoice
} from '../lib/officialWrapperCatalog'
import type { WrapperCatalogChoice } from '../lib/wrapperCatalog'
import { wrapperCopy } from '../lib/wrapperCopy'
import { OfficialWrapperSuiteSplitView } from './OfficialWrapperSuiteSplitView'

export { OfficialWrapperSuiteSplitView as OfficialWrapperSuiteView }

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
  actions,
  feedback,
  onCategoryChange,
  onQueryChange,
  onPageChange,
  onRowsPerPageChange,
  onOpen,
  onClose
}: {
  page?: PhiWrapperGroupsPage
  categoryId: string
  query: string
  loading: boolean
  busy: boolean
  rowsPerPage: number
  actions?: React.ReactNode
  feedback?: React.ReactNode
  onCategoryChange: (id: string) => void
  onQueryChange: (value: string) => void
  onPageChange: (page: number) => void
  onRowsPerPageChange: (size: number) => void
  onOpen: (group: PhiWrapperCatalogGroup) => void
  onClose: () => void
}): React.JSX.Element {
  useUiLanguage()
  const categories = page
    ? officialWrapperCategoryGroups(page)
    : [{ id: 'all', label: wrapperCopy.allWrapperGroups, count: 0 }]
  const selectedCategory = categories.some((category) => category.id === categoryId)
    ? categoryId
    : 'all'
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
      {loading ? (
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
            rows={(page?.items ?? []).map((group) => ({
              rowKey: group.suite,
              id: group.suite,
              icon: <ResourceIcon kind="wrapper" sx={{ color: 'primary.main' }} />,
              title: group.suite,
              summary: '',
              metadata: group.categoryLabel,
              details: officialWrapperGroupRowDetails(group),
              action: (
                <Button size="small" variant="outlined" onClick={() => onOpen(group)}>
                  {wrapperCopy.viewTools}
                </Button>
              )
            }))}
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
  actions,
  feedback,
  renderSuiteAction,
  onUnavailable,
  onClose
}: {
  open: boolean
  api: OfficialWrapperCatalogApi
  registryChoices: readonly WrapperCatalogChoice[]
  registryLoading: boolean
  busy: boolean
  actions?: React.ReactNode
  feedback?: React.ReactNode
  renderSuiteAction: (
    suite: string,
    choices: readonly OfficialWrapperToolChoice[]
  ) => React.ReactNode
  onUnavailable: () => void
  onClose: () => void
}): React.JSX.Element {
  const [groupsPage, setGroupsPage] = useState<PhiWrapperGroupsPage>()
  const [groupQuery, setGroupQuery] = useState('')
  const [categoryId, setCategoryId] = useState('all')
  const [groupPage, setGroupPage] = useState(0)
  const [groupPageSize, setGroupPageSize] = useState(CATALOG_DEFAULT_PAGE_SIZE)
  const [selectedSuite, setSelectedSuite] = useState<string>()
  const [suiteTools, setSuiteTools] = useState<PhiWrapperCatalogTool[]>()
  const [toolQuery, setToolQuery] = useState('')
  const [selectedToolId, setSelectedToolId] = useState<string>()
  const [suiteDetail, setSuiteDetail] = useState<PhiWrapperCatalogDetail>()
  const [groupsLoading, setGroupsLoading] = useState(true)
  const [toolsLoading, setToolsLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)

  useEffect(() => {
    if (!open || selectedSuite) return undefined
    let active = true
    void loadOfficialWrapperGroups(
      api,
      officialWrapperGroupsQuery(groupQuery, categoryId, groupPage, groupPageSize)
    ).then((result) => {
      if (!active) return
      if (result.source === 'fallback') return onUnavailable()
      setGroupsPage(result.data)
      setGroupsLoading(false)
    })
    return () => {
      active = false
    }
  }, [api, categoryId, groupPage, groupPageSize, groupQuery, onUnavailable, open, selectedSuite])

  useEffect(() => {
    if (!open || !selectedSuite) return undefined
    let active = true
    void loadOfficialWrapperSuiteTools(api, selectedSuite).then((result) => {
      if (!active) return
      if (result.source === 'fallback') return onUnavailable()
      const firstToolId = officialWrapperDefaultToolId(result.data)
      setSuiteTools(result.data)
      setToolsLoading(false)
      setSuiteDetail(undefined)
      setSelectedToolId(firstToolId)
      setDetailLoading(Boolean(firstToolId))
    })
    return () => {
      active = false
    }
  }, [api, onUnavailable, open, selectedSuite])

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
      page={groupsPage}
      categoryId={categoryId}
      query={groupQuery}
      loading={groupsLoading}
      busy={busy}
      rowsPerPage={groupPageSize}
      actions={actions}
      feedback={feedback}
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
      onOpen={(group) => {
        setSuiteTools(undefined)
        setSelectedToolId(undefined)
        setSuiteDetail(undefined)
        setToolQuery('')
        setDetailLoading(false)
        setToolsLoading(true)
        setSelectedSuite(group.suite)
      }}
      onClose={() => {
        resetSuite()
        onClose()
      }}
    />
  )
}
