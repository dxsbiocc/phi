import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import type {
  PhiWrapperCatalogDetail,
  PhiWrapperCatalogGroup,
  PhiWrapperCatalogTool,
  PhiWrapperGroupsPage,
  PhiWrapperToolsPage
} from '../../../../../shared/phiWebsiteCatalogTypes'
import { ResourceIcon } from '../../../components/ResourceIcon'
import { CatalogBrowseLayout } from '../../../components/catalog/CatalogBrowseLayout'
import { CatalogDetailFrame } from '../../../components/catalog/CatalogDetailFrame'
import { CatalogPagination } from '../../../components/catalog/CatalogPagination'
import { CatalogResultsTable } from '../../../components/catalog/CatalogResultsTable'
import { CATALOG_DEFAULT_PAGE_SIZE } from '../../../components/catalog/catalogPaging'
import { PhiIcons } from '../../../icons'
import { useUiLanguage } from '../../../lib/i18n'
import {
  loadOfficialWrapperDetail,
  loadOfficialWrapperGroups,
  loadOfficialWrapperTools,
  officialWrapperCategoryGroups,
  officialWrapperGroupRowDetails,
  officialWrapperGroupsQuery,
  officialWrapperToolChoices,
  officialWrapperToolsQuery,
  type OfficialWrapperCatalogApi,
  type OfficialWrapperToolChoice
} from '../lib/officialWrapperCatalog'
import { wrapperChoiceIcon, type WrapperCatalogChoice } from '../lib/wrapperCatalog'
import { wrapperCopy } from '../lib/wrapperCopy'
import { OfficialWrapperDetailPage } from './OfficialWrapperDetailPage'

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

export function OfficialWrapperSuiteView({
  suite,
  page,
  choices,
  query,
  loading,
  busy,
  rowsPerPage,
  feedback,
  renderAction,
  onQueryChange,
  onPageChange,
  onRowsPerPageChange,
  onOpen,
  onBack,
  onClose
}: {
  suite: string
  page?: PhiWrapperToolsPage
  choices: readonly OfficialWrapperToolChoice[]
  query: string
  loading: boolean
  busy: boolean
  rowsPerPage: number
  feedback?: React.ReactNode
  renderAction: (choice: WrapperCatalogChoice) => React.ReactNode
  onQueryChange: (value: string) => void
  onPageChange: (page: number) => void
  onRowsPerPageChange: (size: number) => void
  onOpen: (id: string) => void
  onBack: () => void
  onClose: () => void
}): React.JSX.Element {
  useUiLanguage()
  return (
    <CatalogDetailFrame
      entryId={`group:${suite}`}
      backLabel={wrapperCopy.backToWrapperGroups}
      onBack={onBack}
      action={
        <IconButton aria-label={wrapperCopy.closeCatalog} disabled={busy} onClick={onClose}>
          <PhiIcons.action.close size={20} />
        </IconButton>
      }
    >
      <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Stack direction="row" sx={{ alignItems: 'baseline', px: 3, pt: 2.5, pb: 2 }} spacing={1}>
          <Typography variant="h5" sx={{ fontWeight: 700 }}>
            {suite}
          </Typography>
          {page ? (
            <Typography variant="body2" color="text.secondary">
              {wrapperCopy.toolCount(page.total)}
            </Typography>
          ) : null}
        </Stack>
        <Box sx={{ px: 3, pb: 2 }}>
          <TextField
            fullWidth
            size="small"
            value={query}
            placeholder={wrapperCopy.searchTools}
            onChange={(event) => onQueryChange(event.target.value)}
            slotProps={{
              htmlInput: { 'aria-label': wrapperCopy.searchTools },
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <PhiIcons.action.search size={16} />
                  </InputAdornment>
                )
              }
            }}
          />
        </Box>
        <Box sx={{ flex: 1, minHeight: 0, px: 3, pb: 2, display: 'flex', flexDirection: 'column' }}>
          {feedback}
          {loading ? (
            <LoadingRows />
          ) : (
            <>
              <CatalogResultsTable
                label={wrapperCopy.wrapperToolList}
                nameLabel={wrapperCopy.tools}
                detailsLabel={wrapperCopy.categoryVersion}
                rowAttribute="data-phi-wrapper-catalog-tool"
                onOpen={onOpen}
                rows={choices.map(({ tool, choice }) => ({
                  rowKey: tool.id,
                  id: tool.id,
                  icon: (
                    <ResourceIcon
                      icon={wrapperChoiceIcon(choice)}
                      kind="wrapper"
                      sx={{ color: 'primary.main' }}
                    />
                  ),
                  title: tool.name,
                  summary: tool.summary ?? '',
                  metadata: tool.source,
                  details: `${tool.categoryLabel} · v${tool.version}`,
                  action: renderAction(choice)
                }))}
              />
              {choices.length === 0 ? (
                <Typography color="text.secondary" sx={{ py: 4 }}>
                  {wrapperCopy.noSuiteTools}
                </Typography>
              ) : null}
            </>
          )}
        </Box>
        {page ? (
          <Box sx={{ px: 3, py: 1.5 }}>
            <CatalogPagination
              count={page.total}
              page={Math.max(0, page.page - 1)}
              rowsPerPage={rowsPerPage}
              onPageChange={onPageChange}
              onRowsPerPageChange={onRowsPerPageChange}
            />
          </Box>
        ) : null}
      </Box>
    </CatalogDetailFrame>
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
  renderAction,
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
  renderAction: (choice: WrapperCatalogChoice) => React.ReactNode
  onUnavailable: () => void
  onClose: () => void
}): React.JSX.Element {
  const [groupsPage, setGroupsPage] = useState<PhiWrapperGroupsPage>()
  const [groupQuery, setGroupQuery] = useState('')
  const [categoryId, setCategoryId] = useState('all')
  const [groupPage, setGroupPage] = useState(0)
  const [groupPageSize, setGroupPageSize] = useState(CATALOG_DEFAULT_PAGE_SIZE)
  const [selectedSuite, setSelectedSuite] = useState<string>()
  const [toolsPage, setToolsPage] = useState<PhiWrapperToolsPage>()
  const [toolQuery, setToolQuery] = useState('')
  const [toolPage, setToolPage] = useState(0)
  const [toolPageSize, setToolPageSize] = useState(CATALOG_DEFAULT_PAGE_SIZE)
  const [groupsLoading, setGroupsLoading] = useState(true)
  const [toolsLoading, setToolsLoading] = useState(false)
  const [detailSelection, setDetailSelection] = useState<{
    detail: PhiWrapperCatalogDetail
    tool: PhiWrapperCatalogTool
  }>()
  const detailSequence = useRef(0)

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
    void loadOfficialWrapperTools(
      api,
      officialWrapperToolsQuery(selectedSuite, toolQuery, toolPage, toolPageSize)
    ).then((result) => {
      if (!active) return
      if (result.source === 'fallback') return onUnavailable()
      setToolsPage(result.data)
      setToolsLoading(false)
    })
    return () => {
      active = false
    }
  }, [api, onUnavailable, open, selectedSuite, toolPage, toolPageSize, toolQuery])

  const toolChoices = useMemo(
    () => officialWrapperToolChoices(toolsPage?.items ?? [], registryChoices),
    [registryChoices, toolsPage]
  )

  async function openDetail(id: string): Promise<void> {
    const selected = toolChoices.find(({ tool }) => tool.id === id)
    if (!selected) return
    const sequence = ++detailSequence.current
    const result = await loadOfficialWrapperDetail(api, id)
    if (sequence !== detailSequence.current) return
    if (result.source === 'fallback') return onUnavailable()
    setDetailSelection({ detail: result.data, tool: selected.tool })
  }

  if (detailSelection) {
    const currentChoice = officialWrapperToolChoices([detailSelection.tool], registryChoices)[0]!
      .choice
    return (
      <OfficialWrapperDetailPage
        detail={detailSelection.detail}
        choice={currentChoice}
        action={renderAction(currentChoice)}
        onBack={() => setDetailSelection(undefined)}
      />
    )
  }
  if (selectedSuite) {
    return (
      <OfficialWrapperSuiteView
        suite={selectedSuite}
        page={toolsPage}
        choices={toolChoices}
        query={toolQuery}
        loading={registryLoading || toolsLoading}
        busy={busy}
        rowsPerPage={toolPageSize}
        feedback={feedback}
        renderAction={renderAction}
        onQueryChange={(value) => {
          setToolsLoading(true)
          setToolQuery(value)
          setToolPage(0)
        }}
        onPageChange={(nextPage) => {
          setToolsLoading(true)
          setToolPage(nextPage)
        }}
        onRowsPerPageChange={(size) => {
          setToolsLoading(true)
          setToolPageSize(size)
          setToolPage(0)
        }}
        onOpen={(id) => void openDetail(id)}
        onBack={() => {
          detailSequence.current += 1
          setSelectedSuite(undefined)
          setToolsPage(undefined)
          setToolQuery('')
          setToolPage(0)
        }}
        onClose={() => {
          detailSequence.current += 1
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
        setToolsLoading(true)
        setSelectedSuite(group.suite)
        setToolsPage(undefined)
        setToolQuery('')
        setToolPage(0)
      }}
      onClose={() => {
        detailSequence.current += 1
        onClose()
      }}
    />
  )
}
