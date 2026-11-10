import { useUiLanguage } from '../../../lib/i18n'
import { resourceUi, resourceCategoryLabel, resourceSourceLabel } from '../../../lib/resourceUi'
import { localizeWrapperMessage, wrapperCopy } from '../lib/wrapperCopy'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Box, Button, CircularProgress, Dialog, Typography } from '@mui/material'
import type {
  InstalledPackageView,
  PackageRegistryView,
  PackageUpdateView
} from '../../../../../shared/packageManagerTypes'
import { errorMessage } from '../../../../../shared/errorCodes'
import type { WrapperCompositionCatalogItem } from '../../../../../shared/wrapperCompositionManifestTypes'
import { ResourceIcon } from '../../../components/ResourceIcon'
import { CatalogBrowseLayout } from '../../../components/catalog/CatalogBrowseLayout'
import { CatalogAddButton } from '../../../components/catalog/CatalogAddButton'
import { useBusyKeys } from '../../../components/catalog/useBusyKeys'
import { CatalogResultsTable } from '../../../components/catalog/CatalogResultsTable'
import { CatalogPagination } from '../../../components/catalog/CatalogPagination'
import {
  CATALOG_DEFAULT_PAGE_SIZE,
  catalogDialogPaperSx,
  getCatalogPage
} from '../../../components/catalog/catalogPaging'
import {
  filterWrapperCatalogChoices,
  flatWrapperCatalogGroups,
  wrapperCatalogChoices,
  wrapperChoiceAction,
  wrapperChoiceIcon,
  wrapperChoiceNeedsRegistryInstall,
  wrapperCatalogGroups,
  type WrapperCatalogChoice
} from '../lib/wrapperCatalog'
import { installCatalogPackage, loadContentCatalog } from '../../../lib/contentCatalog'
import { summarizeWrapperInstallPlan, type WrapperInstallSummary } from '../lib/wrapperInstallPlan'
import type { OfficialWrapperToolChoice } from '../lib/officialWrapperCatalog'
import {
  wrapperSuiteAction,
  wrapperSuiteBusyKey,
  wrapperSuiteUpdateIds
} from '../lib/wrapperSuiteAction'
import { useWrapperRemoval } from '../hooks/useWrapperRemoval'
import { useWrapperSuiteActions } from '../hooks/useWrapperSuiteActions'
import type { SnackbarSeverity } from '../../../components/AppSnackbarCard'
import { WrapperInstallConfirmDialog } from './WrapperInstallConfirmDialog'
import { WrapperSuiteInstallConfirmDialog } from './WrapperSuiteInstallConfirmDialog'
import { OfficialWrapperCatalog } from './OfficialWrapperCatalog'
import { WrapperPackageDetailPage } from './WrapperPackageDetailPage'
import { WrapperRemovalDialog } from './WrapperRemovalDialog'
import { WrapperSuiteRemovalDialog } from './WrapperSuiteRemovalDialog'

const DIRECTORY_KEY = '__directory__'

export interface WrapperCatalogDialogProps {
  open: boolean
  catalog: WrapperCompositionCatalogItem[]
  onClose: () => void
  onRefresh: () => Promise<void> | void
  onSetPackageEnabled?: (id: string, enabled: boolean) => Promise<boolean | void> | void
  onNotify?: (message: string, severity?: SnackbarSeverity) => void
}

interface CatalogSnapshot {
  registries: PackageRegistryView[]
  installed: InstalledPackageView[]
  updates: PackageUpdateView[]
  error: string | null
  notice: string | null
}

export function WrapperCatalogDialog({
  open,
  catalog,
  onClose,
  onRefresh,
  onSetPackageEnabled,
  onNotify
}: WrapperCatalogDialogProps): React.JSX.Element {
  const language = useUiLanguage()
  const websiteCatalogApi = typeof window === 'undefined' ? {} : window.api
  const [query, setQuery] = useState('')
  const [groupId, setGroupId] = useState('all')
  const [page, setPage] = useState(0)
  const [rowsPerPage, setRowsPerPage] = useState(CATALOG_DEFAULT_PAGE_SIZE)
  const [registries, setRegistries] = useState<PackageRegistryView[]>([])
  const [installedPackages, setInstalledPackages] = useState<InstalledPackageView[]>([])
  const [updates, setUpdates] = useState<PackageUpdateView[]>([])
  const [loading, setLoading] = useState(true)
  const busy = useBusyKeys()
  const [error, setError] = useState<string | null>(null)
  const [sourceNotice, setSourceNotice] = useState<string | null>(null)
  const [catalogMode, setCatalogMode] = useState<'official' | 'fallback'>('official')
  const [detailId, setDetailId] = useState<string | null>(null)
  const [pendingInstall, setPendingInstall] = useState<{
    choice: WrapperCatalogChoice
    summary: WrapperInstallSummary
  } | null>(null)

  const applySnapshot = useCallback((snapshot: CatalogSnapshot): void => {
    setRegistries(snapshot.registries)
    setInstalledPackages(snapshot.installed)
    setUpdates(snapshot.updates)
    setError(snapshot.error)
    setSourceNotice(snapshot.notice)
  }, [])

  const readCatalog = useCallback(async (): Promise<CatalogSnapshot> => {
    const packageUpdates = window.api.listPackageUpdates
      ? window.api
          .listPackageUpdates()
          .then((result) => result.filter((update) => update.type === 'wrapper'))
          .catch(() => [] as PackageUpdateView[])
      : Promise.resolve([] as PackageUpdateView[])
    const [sources, installed] = await Promise.all([
      loadContentCatalog(window.api),
      window.api.listInstalledPackages()
    ])
    return {
      registries: sources.registries,
      installed,
      updates: await packageUpdates,
      error: sources.errors.join('\n') || null,
      notice: sources.notices.join('\n') || null
    }
  }, [])

  /** Group actions refresh the wrapper catalog once after all sequential work finishes. */
  const refreshCatalog = useCallback(async (): Promise<void> => {
    await onRefresh()
    applySnapshot(await readCatalog())
  }, [applySnapshot, onRefresh, readCatalog])
  const removal = useWrapperRemoval(refreshCatalog, onNotify)
  useEffect(() => {
    if (!open) return undefined
    let active = true
    void Promise.resolve().then(() => {
      if (active) setLoading(true)
    })
    void readCatalog()
      .then((data) => {
        if (active) applySnapshot(data)
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [applySnapshot, open, readCatalog])

  const choices = useMemo(
    () => wrapperCatalogChoices(catalog, registries, installedPackages),
    [catalog, registries, installedPackages]
  )
  const updateIds = useMemo(() => wrapperSuiteUpdateIds(updates), [updates])
  const suiteActions = useWrapperSuiteActions({
    busy,
    updateIds,
    refresh: refreshCatalog,
    clearError: () => setError(null),
    onError: setError,
    onSetPackageEnabled,
    onNotify
  })
  const groups = useMemo(
    () => wrapperCatalogGroups(choices),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Copy proxy reads depend on the UI language.
    [choices, language]
  )
  const fallbackGroups = useMemo(
    () => flatWrapperCatalogGroups(choices),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Copy proxy reads depend on the UI language.
    [choices, language]
  )
  const selectedGroupId = groups.some((group) => group.id === groupId) ? groupId : 'all'
  if (groupId !== selectedGroupId) {
    setGroupId(selectedGroupId)
    setPage(0)
  }
  const filtered = useMemo(
    () =>
      filterWrapperCatalogChoices(
        choices,
        query,
        catalogMode === 'fallback' ? 'all' : selectedGroupId
      ),
    [catalogMode, choices, query, selectedGroupId]
  )
  const result = getCatalogPage(filtered, groupId === selectedGroupId ? page : 0, rowsPerPage)
  if (!loading && page !== result.page) setPage(result.page)
  const visibleChoices = result.rows
  const detailChoice = detailId ? choices.find((choice) => choice.id === detailId) : undefined

  const showRegistryFallback = useCallback((): void => {
    setCatalogMode('fallback')
    setDetailId(null)
    setGroupId('all')
    setQuery('')
    setPage(0)
  }, [])

  async function enableChoice(choice: WrapperCatalogChoice, refresh: boolean): Promise<void> {
    if (onSetPackageEnabled) {
      if ((await onSetPackageEnabled(choice.id, true)) === false)
        throw new Error(wrapperCopy.enableFailed)
      return
    }
    await window.api.setEnablement(`wrapper:${choice.id}`, true, { type: 'global' })
    if (refresh) await onRefresh()
  }

  async function add(choice: WrapperCatalogChoice, confirmed = false): Promise<void> {
    if (busy.has(choice.id)) return
    busy.start(choice.id)
    setError(null)
    try {
      if (wrapperChoiceNeedsRegistryInstall(choice)) {
        if (!choice.registryPath || !choice.registryEntry)
          throw new Error(wrapperCopy.noInstallSource)
        const plan = await window.api.planPackageInstall(
          choice.registryPath,
          'wrapper',
          choice.id,
          choice.registryEntry.version
        )
        const summary = summarizeWrapperInstallPlan(plan, choice.id)
        if (summary.needsConfirmation && !confirmed) {
          setPendingInstall({ choice, summary })
          return
        }
        const installed = await installCatalogPackage(
          window.api,
          choice.registryPath,
          choice.registryEntry
        )
        setInstalledPackages(installed)
      }
      await enableChoice(choice, true)
      applySnapshot(await readCatalog())
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      busy.finish(choice.id)
    }
  }

  function renderAction(choice: WrapperCatalogChoice): React.JSX.Element {
    const { label, kind } = wrapperChoiceAction(choice)
    const removing = kind === 'remove'
    const working = busy.has(choice.id) || removal.busyId === choice.id
    const missingRegistryEntry = !choice.installed && !choice.registryEntry
    return (
      <Button
        size="small"
        variant="outlined"
        color={removing ? 'error' : 'primary'}
        disabled={working || missingRegistryEntry}
        onClick={() => void (removing ? removal.request(choice.id) : add(choice))}
        aria-label={`${label} ${choice.title}`}
      >
        {working ? <CircularProgress size={16} /> : label}
      </Button>
    )
  }

  function renderSuiteAction(
    suite: string,
    choices: readonly OfficialWrapperToolChoice[]
  ): React.JSX.Element {
    const action = wrapperSuiteAction(choices, updateIds)
    const working = busy.has(wrapperSuiteBusyKey(suite))
    const missingRegistryEntry =
      action.kind === 'install' &&
      choices.some(
        ({ choice }) =>
          wrapperChoiceNeedsRegistryInstall(choice) &&
          (!choice.registryPath || !choice.registryEntry)
      )
    const onClick =
      action.kind === 'uninstall'
        ? () => void suiteActions.requestRemoval(suite, choices)
        : action.kind === 'update'
          ? () => void suiteActions.update(suite, choices)
          : () => void suiteActions.install(suite, choices)
    return (
      <Button
        size="small"
        variant={action.kind === 'uninstall' ? 'outlined' : 'contained'}
        color={action.kind === 'uninstall' ? 'error' : 'primary'}
        disabled={working || missingRegistryEntry}
        onClick={onClick}
        aria-label={`${action.label} ${suite}`}
        data-phi-wrapper-suite-action="true"
      >
        {working ? <CircularProgress size={16} /> : action.label}
      </Button>
    )
  }

  async function chooseDirectory(): Promise<void> {
    if (busy.has(DIRECTORY_KEY)) return
    busy.start(DIRECTORY_KEY)
    setError(null)
    try {
      const path = await window.api.pickPackageRegistryDirectory()
      if (!path) return
      const registry = await window.api.readPackageRegistry(path)
      setRegistries((current) => [...current.filter((entry) => entry.id !== registry.id), registry])
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      busy.finish(DIRECTORY_KEY)
    }
  }

  function close(): void {
    if (busy.any) return
    setDetailId(null)
    setPendingInstall(null)
    suiteActions.cancelInstall()
    suiteActions.cancelRemoval()
    setLoading(true)
    setError(null)
    setCatalogMode('official')
    setPage(0)
    setRowsPerPage(CATALOG_DEFAULT_PAGE_SIZE)
    setGroupId('all')
    setQuery('')
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      maxWidth={false}
      aria-label={wrapperCopy.catalog}
      slotProps={{
        paper: {
          sx: catalogDialogPaperSx
        }
      }}
    >
      {catalogMode === 'official' ? (
        <OfficialWrapperCatalog
          key={open ? 'open' : 'closed'}
          open={open}
          api={websiteCatalogApi}
          registryChoices={choices}
          registryLoading={loading}
          busy={busy.any || removal.removing}
          actions={
            <CatalogAddButton
              label={wrapperCopy.addDirectory}
              disabled={busy.has(DIRECTORY_KEY)}
              onClick={() => void chooseDirectory()}
            />
          }
          feedback={
            <>
              {(error ?? (!onNotify ? removal.error : null)) ? (
                <Alert
                  severity="error"
                  sx={{ mb: 2 }}
                  onClose={error ? undefined : removal.clearError}
                >
                  {localizeWrapperMessage(error ?? removal.error ?? '')}
                </Alert>
              ) : null}
              {sourceNotice ? (
                <Alert severity="info" sx={{ mb: 2 }}>
                  {sourceNotice}
                </Alert>
              ) : null}
            </>
          }
          renderSuiteAction={renderSuiteAction}
          onUnavailable={showRegistryFallback}
          onClose={close}
        />
      ) : detailChoice ? (
        <WrapperPackageDetailPage
          choice={detailChoice}
          catalog={catalog}
          action={renderAction(detailChoice)}
          onBack={() => setDetailId(null)}
        />
      ) : (
        <CatalogBrowseLayout
          title={resourceUi.wrappers}
          closeLabel={wrapperCopy.closeCatalog}
          groups={fallbackGroups}
          selectedGroupId="all"
          onGroupChange={() => undefined}
          query={query}
          onQueryChange={(value) => {
            setQuery(value)
            setPage(0)
          }}
          searchLabel={wrapperCopy.searchCatalog}
          onClose={close}
          busy={busy.any}
          page={result.page}
          rowsPerPage={rowsPerPage}
          actions={
            <CatalogAddButton
              label={wrapperCopy.addDirectory}
              disabled={busy.has(DIRECTORY_KEY)}
              onClick={() => void chooseDirectory()}
            />
          }
          footer={
            !loading ? (
              <CatalogPagination
                count={filtered.length}
                page={result.page}
                rowsPerPage={rowsPerPage}
                onPageChange={setPage}
                onRowsPerPageChange={(size) => {
                  setRowsPerPage(size)
                  setPage(0)
                }}
              />
            ) : null
          }
        >
          <Alert severity="info" variant="outlined" sx={{ mb: 2 }}>
            {wrapperCopy.websiteCatalogUnavailable}
          </Alert>
          {(error ?? (!onNotify ? removal.error : null)) ? (
            <Alert severity="error" sx={{ mb: 2 }} onClose={error ? undefined : removal.clearError}>
              {localizeWrapperMessage(error ?? removal.error ?? '')}
            </Alert>
          ) : null}
          {sourceNotice ? (
            <Alert severity="info" sx={{ mb: 2 }}>
              {sourceNotice}
            </Alert>
          ) : null}
          {loading ? (
            <Box sx={{ display: 'grid', placeItems: 'center', py: 6 }}>
              <CircularProgress size={22} />
            </Box>
          ) : (
            <>
              <CatalogResultsTable
                label={wrapperCopy.catalogList}
                nameLabel={resourceUi.tools}
                detailsLabel={wrapperCopy.categoryVersion}
                rowAttribute="data-phi-wrapper-catalog-choice"
                onOpen={setDetailId}
                rows={visibleChoices.map((choice) => {
                  return {
                    rowKey: choice.id,
                    id: choice.id,
                    icon: (
                      <ResourceIcon
                        icon={wrapperChoiceIcon(choice)}
                        kind="wrapper"
                        sx={{ color: 'primary.main' }}
                      />
                    ),
                    title: choice.title,
                    summary: '',
                    metadata: resourceSourceLabel(choice.metadata),
                    details: `${resourceCategoryLabel(choice.category)}${choice.version ? ` · v${choice.version}` : ''}`,
                    action: renderAction(choice)
                  }
                })}
              />
              {filtered.length === 0 ? (
                <Typography color="text.secondary" sx={{ py: 4 }}>
                  {query.trim() ? wrapperCopy.noMatches : wrapperCopy.emptyGroup}
                </Typography>
              ) : null}
            </>
          )}
        </CatalogBrowseLayout>
      )}
      <WrapperRemovalDialog
        target={removal.pending}
        removing={removal.removing}
        onClose={removal.cancel}
        onConfirm={removal.confirm}
      />
      <WrapperInstallConfirmDialog
        title={pendingInstall?.choice.title ?? ''}
        summary={pendingInstall?.summary ?? null}
        onCancel={() => setPendingInstall(null)}
        onConfirm={() => {
          const target = pendingInstall?.choice
          setPendingInstall(null)
          if (target) void add(target, true)
        }}
      />
      <WrapperSuiteInstallConfirmDialog
        suite={suiteActions.pendingInstall?.suite ?? null}
        summary={suiteActions.pendingInstall?.summary ?? null}
        onCancel={suiteActions.cancelInstall}
        onConfirm={() => void suiteActions.confirmInstall()}
      />
      <WrapperSuiteRemovalDialog
        suite={suiteActions.pendingRemoval?.suite ?? null}
        targets={suiteActions.pendingRemoval?.previews ?? []}
        removing={busy.has(
          suiteActions.pendingRemoval ? wrapperSuiteBusyKey(suiteActions.pendingRemoval.suite) : ''
        )}
        onClose={suiteActions.cancelRemoval}
        onConfirm={() => void suiteActions.confirmRemoval()}
      />
    </Dialog>
  )
}
