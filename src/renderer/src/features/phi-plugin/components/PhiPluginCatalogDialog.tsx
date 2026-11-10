import { getUiLocale } from '../../../lib/i18n'
import { useUiLanguage } from '../../../lib/i18n'
import { resourceUi, resourceCategoryLabel, resourceSourceLabel } from '../../../lib/resourceUi'
import { pluginCopy } from '../lib/pluginCopy'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ConfirmationDialog } from '../../../components/ConfirmationDialog'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Stack,
  Typography
} from '@mui/material'
import { alpha } from '@mui/material/styles'
import { GoCheck, GoPlus, GoSync } from 'react-icons/go'

import type { PackageTrust, PackageUpdateView } from '../../../../../shared/packageManagerTypes'
import { errorMessage } from '../../../../../shared/errorCodes'
import type { PhiPluginInstallPreview } from '../../../../../shared/phiPluginTypes'
import type { ResourceIconRef } from '../../../../../shared/resourceIconTypes'
import { CatalogAddButton } from '../../../components/catalog/CatalogAddButton'
import {
  CatalogBrowseLayout,
  type CatalogBrowseGroup
} from '../../../components/catalog/CatalogBrowseLayout'
import { catalogDialogPaperSx } from '../../../components/catalog/catalogPaging'
import { ResourceIcon } from '../../../components/ResourceIcon'
import { PACKAGE_TRUST_DESCRIPTIONS, PACKAGE_TRUST_LABELS } from '../../../lib/packageTrust'
import {
  catalogPackages,
  installCatalogPackage,
  loadContentCatalog
} from '../../../lib/contentCatalog'
import type { PhiPluginDisplayItem } from '../hooks/usePhiPlugins'
import {
  buildPhiPluginCatalog,
  filterPhiPluginCatalog,
  phiPluginCatalogAction,
  type PhiPluginCatalogAction,
  type PhiPluginCatalogEntry
} from '../lib/phiPluginCatalog'
import {
  formatPhiPluginProblems,
  isSemanticUpgrade,
  phiPluginDisplayTitle,
  phiPluginDistributionLabel
} from '../lib/phiPlugins'
import { PhiPluginDetail } from './PhiPluginDetail'

function installIsUpgrade(preview: PhiPluginInstallPreview): boolean {
  return (
    preview.action === 'upgrade' || isSemanticUpgrade(preview.installedVersion, preview.version)
  )
}

function pluginDisplayName(preview: PhiPluginInstallPreview): string {
  const title = preview.title?.trim()
  return title
    ? phiPluginDisplayTitle({ id: preview.id ?? '', title })
    : preview.id?.trim() || pluginCopy.fallbackPlugin
}

function PluginAddedMark({ label }: { label: string }): React.JSX.Element {
  return (
    <Box
      role="img"
      aria-label={label}
      data-phi-plugin-state="added"
      sx={{
        width: 34,
        height: 34,
        display: 'grid',
        placeItems: 'center',
        flexShrink: 0,
        borderRadius: 1.5,
        color: 'success.dark',
        bgcolor: (theme) =>
          alpha(theme.palette.success.main, theme.palette.mode === 'dark' ? 0.28 : 0.16)
      }}
    >
      <GoCheck size={20} aria-hidden="true" />
    </Box>
  )
}

function CatalogCard({
  icon,
  title,
  summary,
  version,
  trust,
  source,
  action,
  busy,
  disabled,
  onOpen,
  onAction
}: {
  icon?: ResourceIconRef
  title: string
  summary: string
  version: string
  trust: PackageTrust
  source?: string
  action: PhiPluginCatalogAction
  busy: boolean
  disabled: boolean
  onOpen: () => void
  onAction?: () => void
}): React.JSX.Element {
  useUiLanguage()

  const actionLabel =
    action === 'update'
      ? pluginCopy.updateNamed(title)
      : action === 'installed'
        ? pluginCopy.installedNamed(title)
        : pluginCopy.installNamed(title)
  const showTrustChip =
    trust !== 'imported' && resourceSourceLabel(source ?? '') !== PACKAGE_TRUST_LABELS[trust]

  return (
    <Box
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      sx={{
        minWidth: 0,
        minHeight: 108,
        p: 1.75,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 2,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1.5,
        cursor: 'pointer',
        '&:hover': { bgcolor: 'action.hover' }
      }}
    >
      <Box
        sx={{
          width: 42,
          height: 42,
          flexShrink: 0,
          borderRadius: 1.5,
          display: 'grid',
          placeItems: 'center',
          bgcolor: 'action.hover',
          color: 'primary.main'
        }}
      >
        <ResourceIcon icon={icon} kind="plugin" size={42} fallbackSize={23} />
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography noWrap title={title} sx={{ fontWeight: 700 }}>
          {title}
        </Typography>
        <Typography noWrap title={summary} variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
          {summary}
        </Typography>
        <Stack direction="row" spacing={0.75} useFlexGap sx={{ mt: 1, flexWrap: 'wrap' }}>
          <Chip size="small" label={`v${version}`} />
          {source ? (
            <Chip size="small" variant="outlined" label={resourceSourceLabel(source)} />
          ) : null}
          {showTrustChip ? (
            <Chip
              size="small"
              variant="outlined"
              label={PACKAGE_TRUST_LABELS[trust]}
              title={PACKAGE_TRUST_DESCRIPTIONS[trust]}
            />
          ) : null}
        </Stack>
      </Box>
      {busy ? (
        <Box
          role="status"
          aria-label={pluginCopy.processing}
          sx={{ width: 34, height: 34, display: 'grid', placeItems: 'center', flexShrink: 0 }}
        >
          <CircularProgress size={18} />
        </Box>
      ) : action === 'installed' ? (
        <PluginAddedMark label={actionLabel} />
      ) : (
        <IconButton
          aria-label={actionLabel}
          title={actionLabel}
          size="small"
          disabled={disabled || !onAction}
          onClick={(event) => {
            event.stopPropagation()
            onAction?.()
          }}
          sx={{
            width: 34,
            height: 34,
            p: 0,
            display: 'grid',
            placeItems: 'center',
            flexShrink: 0,
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 1.5
          }}
        >
          {action === 'update' ? (
            <GoSync size={18} aria-hidden="true" />
          ) : (
            <GoPlus size={18} aria-hidden="true" />
          )}
        </IconButton>
      )}
    </Box>
  )
}

export type PhiPluginCatalogContentProps = {
  plugins: readonly PhiPluginDisplayItem[]
  entries: readonly PhiPluginCatalogEntry[]
  updates: readonly PackageUpdateView[]
  loading: boolean
  busyId: string | null
  error?: string | null
  notice?: string | null
  sourceNotice?: string | null
  initialCategory?: string
  onClose: () => void
  onChooseDirectory: () => void
  onInstall: (entry: PhiPluginCatalogEntry, update: boolean) => void
  onClearError: () => void
  onClearNotice: () => void
  onRefresh?: () => Promise<void>
  onSetEnabled: (plugin: PhiPluginDisplayItem, enabled: boolean) => Promise<boolean>
  onUninstall: (plugin: PhiPluginDisplayItem) => Promise<boolean>
}

export function PhiPluginCatalogContent({
  plugins,
  entries,
  updates,
  loading,
  busyId,
  error,
  notice,
  sourceNotice,
  initialCategory = 'all',
  onClose,
  onChooseDirectory,
  onInstall,
  onClearError,
  onClearNotice,
  onRefresh,
  onSetEnabled,
  onUninstall
}: PhiPluginCatalogContentProps): React.JSX.Element {
  const uiLanguage = useUiLanguage()

  const [category, setCategory] = useState(initialCategory)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState<'list' | 'detail'>('list')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const installedIds = useMemo(() => new Set(plugins.map((plugin) => plugin.id)), [plugins])
  const catalog = useMemo(() => {
    void uiLanguage // Invalidate localized presentation.
    return buildPhiPluginCatalog(plugins, entries)
  }, [plugins, entries, uiLanguage])
  const browseGroups = useMemo((): CatalogBrowseGroup[] => {
    void uiLanguage // Invalidate labels and localized search without changing selection.

    const counts = new Map<string, number>()
    for (const item of catalog) {
      counts.set(item.category, (counts.get(item.category) ?? 0) + 1)
    }
    const categories = [...counts.entries()]
      .sort(([left], [right]) =>
        resourceCategoryLabel(left).localeCompare(resourceCategoryLabel(right), getUiLocale())
      )
      .map(([id, count]) => ({
        id,
        label: resourceCategoryLabel(id),
        count
      }))
    return [
      { id: 'all', label: pluginCopy.allPlugins, count: catalog.length },
      { id: 'installed', label: resourceUi.installed, count: plugins.length },
      ...categories
    ]
  }, [catalog, plugins.length, uiLanguage])
  const normalizedQuery = query.trim().toLowerCase()
  const visiblePlugins = plugins.filter((plugin) =>
    [plugin.title, plugin.id, plugin.version, plugin.summary].some((value) =>
      value.toLowerCase().includes(normalizedQuery)
    )
  )
  const visibleItems = filterPhiPluginCatalog(catalog, category, query)
  const installedSelected = category === 'installed'
  const selectedPlugin = selectedId
    ? (plugins.find((plugin) => plugin.id === selectedId) ?? null)
    : null
  const selectedCatalogItem = selectedId
    ? (catalog.find((item) => item.id === selectedId) ?? null)
    : null
  const selectedEntry = selectedCatalogItem?.entry ?? null
  const selectedAction = selectedEntry
    ? phiPluginCatalogAction(selectedEntry, installedIds, updates)
    : selectedPlugin
      ? 'installed'
      : 'install'
  const showingDetail =
    page === 'detail' && selectedId !== null && (selectedPlugin !== null || selectedEntry !== null)
  const selectedGroup = browseGroups.find((group) => group.id === category) ??
    browseGroups[0] ?? {
      id: 'all',
      label: pluginCopy.allPlugins,
      count: catalog.length
    }

  function openDetail(id: string): void {
    setSelectedId(id)
    setPage('detail')
  }

  function backToList(): void {
    setPage('list')
  }

  function selectCategory(next: string): void {
    setCategory(next)
    setPage('list')
  }

  return (
    <CatalogBrowseLayout
      title={resourceUi.plugins}
      closeLabel={pluginCopy.closeCatalog}
      groups={browseGroups}
      selectedGroupId={selectedGroup.id}
      onGroupChange={selectCategory}
      query={query}
      onQueryChange={setQuery}
      searchLabel={pluginCopy.searchCatalog}
      hideSearch={showingDetail}
      heading={
        showingDetail ? (
          <Button onClick={backToList} sx={{ px: 0, minWidth: 0 }}>
            {pluginCopy.backToCatalog}
          </Button>
        ) : normalizedQuery ? (
          pluginCopy.searchResults
        ) : undefined
      }
      scrollContent={!showingDetail}
      onClose={onClose}
      busy={busyId !== null}
      actions={
        showingDetail ? undefined : (
          <CatalogAddButton
            label={pluginCopy.installDirectory}
            disabled={busyId !== null}
            onClick={onChooseDirectory}
          />
        )
      }
    >
      {showingDetail ? (
        <Box sx={{ flex: 1, minHeight: 0, height: '100%', overflow: 'hidden' }}>
          <PhiPluginDetail
            plugin={selectedPlugin}
            busyPluginId={busyId}
            error={error ?? null}
            notice={notice ?? null}
            onClearError={onClearError}
            onClearNotice={onClearNotice}
            onRefresh={onRefresh ?? (async () => undefined)}
            onSetEnabled={onSetEnabled}
            onUninstall={onUninstall}
            catalogEntry={selectedPlugin ? null : selectedEntry}
            catalogAction={selectedAction}
            installBusy={busyId !== null && busyId === selectedId}
            onInstall={
              selectedEntry
                ? () => onInstall(selectedEntry, selectedAction === 'update')
                : undefined
            }
          />
        </Box>
      ) : (
        <>
          {error ? (
            <Alert severity="error" sx={{ mb: 2 }} onClose={onClearError}>
              {error}
            </Alert>
          ) : null}
          {notice ? (
            <Alert severity="success" sx={{ mb: 2 }} onClose={onClearNotice}>
              {notice}
            </Alert>
          ) : null}
          {sourceNotice ? (
            <Alert severity="info" sx={{ mb: 2 }}>
              {sourceNotice}
            </Alert>
          ) : null}
          {loading ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <CircularProgress size={20} />
              <Typography variant="body2" color="text.secondary">
                {pluginCopy.loadingCatalog}
              </Typography>
            </Box>
          ) : (
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' },
                gap: 1.5
              }}
            >
              {installedSelected
                ? visiblePlugins.map((plugin) => (
                    <CatalogCard
                      key={plugin.id}
                      icon={plugin.icon}
                      title={plugin.title}
                      summary={plugin.summary}
                      version={plugin.version}
                      trust={plugin.trust}
                      source={phiPluginDistributionLabel(plugin.distribution)}
                      action="installed"
                      busy={false}
                      disabled
                      onOpen={() => openDetail(plugin.id)}
                    />
                  ))
                : visibleItems.map((item) => {
                    const entry = item.entry
                    const action = entry
                      ? phiPluginCatalogAction(entry, installedIds, updates)
                      : 'installed'
                    return (
                      <CatalogCard
                        key={item.id}
                        icon={item.icon}
                        title={item.title}
                        summary={item.summary}
                        version={item.version}
                        trust={item.trust}
                        source={item.source}
                        action={action}
                        busy={busyId === item.id}
                        disabled={busyId !== null}
                        onOpen={() => openDetail(item.id)}
                        onAction={entry ? () => onInstall(entry, action === 'update') : undefined}
                      />
                    )
                  })}
            </Box>
          )}
          {!loading &&
          ((installedSelected && visiblePlugins.length === 0) ||
            (!installedSelected && visibleItems.length === 0)) ? (
            <Typography variant="body2" color="text.secondary">
              {normalizedQuery
                ? pluginCopy.noCatalogMatches
                : installedSelected
                  ? pluginCopy.noneInstalled
                  : pluginCopy.noCategoryPlugins}
            </Typography>
          ) : null}
        </>
      )}
    </CatalogBrowseLayout>
  )
}

export type PhiPluginCatalogDialogProps = {
  open: boolean
  plugins: readonly PhiPluginDisplayItem[]
  installWorking: boolean
  feedbackError: string | null
  feedbackNotice: string | null
  onClose: () => void
  onChanged: () => Promise<void>
  onClearFeedback: () => void
  onShowError: (message: string) => void
  onInstallFromDirectory: (path: string, description: string) => Promise<boolean>
  onSetEnabled: (plugin: PhiPluginDisplayItem, enabled: boolean) => Promise<boolean>
  onUninstall: (plugin: PhiPluginDisplayItem) => Promise<boolean>
}

export function PhiPluginCatalogDialog({
  open,
  plugins,
  installWorking,
  feedbackError,
  feedbackNotice,
  onClose,
  onChanged,
  onClearFeedback,
  onShowError,
  onInstallFromDirectory,
  onSetEnabled,
  onUninstall
}: PhiPluginCatalogDialogProps): React.JSX.Element {
  useUiLanguage()

  const [entries, setEntries] = useState<PhiPluginCatalogEntry[]>([])
  const [updates, setUpdates] = useState<PackageUpdateView[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sourceNotice, setSourceNotice] = useState<string | null>(null)
  const [pickingDirectory, setPickingDirectory] = useState(false)
  const [pendingInstall, setPendingInstall] = useState<PhiPluginInstallPreview | null>(null)

  const fetchCatalog = useCallback(async (): Promise<{
    entries: PhiPluginCatalogEntry[]
    updates: PackageUpdateView[]
    error: string | null
    notice: string | null
  }> => {
    const [catalog, availableUpdates] = await Promise.all([
      loadContentCatalog(window.api),
      window.api.listPackageUpdates().catch(() => [])
    ])
    return {
      entries: catalogPackages(catalog.registries, 'plugin').map(({ entry, registry }) => ({
        ...entry,
        registryPath: registry.dir,
        registryLabel: registry.label ?? registry.id,
        trust: registry.trust
      })),
      updates: availableUpdates,
      error: catalog.errors.join('\n') || null,
      notice: catalog.notices.join('\n') || null
    }
  }, [])

  useEffect(() => {
    if (!open) return
    let active = true
    void Promise.resolve().then(() => {
      if (active) setLoading(true)
    })
    void fetchCatalog()
      .then((catalog) => {
        if (!active) return
        setEntries(catalog.entries)
        setUpdates(catalog.updates)
        setError(catalog.error)
        setSourceNotice(catalog.notice)
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
  }, [fetchCatalog, open])

  async function install(entry: PhiPluginCatalogEntry, update: boolean): Promise<void> {
    if (busyId || installWorking || pickingDirectory) return
    setBusyId(entry.id)
    setError(null)
    try {
      if (update) await window.api.applyPackageUpdate('plugin', entry.id)
      else await installCatalogPackage(window.api, entry.registryPath, entry)
      const catalog = await fetchCatalog()
      setEntries(catalog.entries)
      setUpdates(catalog.updates)
      setError(catalog.error)
      setSourceNotice(catalog.notice)
      await onChanged()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusyId(null)
    }
  }

  async function choosePluginDirectory(): Promise<void> {
    if (busyId || installWorking || pickingDirectory) return
    setPickingDirectory(true)
    setError(null)
    onClearFeedback()
    try {
      const path = await window.api.pickPhiPluginDirectory()
      if (!path) return
      const preview = await window.api.previewPhiPluginDirectory(path)
      if (!preview.ok) {
        onShowError(pluginCopy.invalidDirectory(formatPhiPluginProblems(preview.problems)))
        return
      }
      if (preview.action === 'same-or-older') {
        onShowError(pluginCopy.newerDirectoryRequired(preview.installedVersion))
        return
      }
      setPendingInstall(preview)
    } catch (cause) {
      onShowError(pluginCopy.readDirectoryFailed(errorMessage(cause)))
    } finally {
      setPickingDirectory(false)
    }
  }

  async function confirmInstall(): Promise<void> {
    if (!pendingInstall) return
    const upgrade = installIsUpgrade(pendingInstall)
    const succeeded = await onInstallFromDirectory(
      pendingInstall.path,
      upgrade ? pluginCopy.upgradeAction : pluginCopy.installAction
    )
    if (succeeded) setPendingInstall(null)
  }

  function close(): void {
    if (busyId || installWorking || pickingDirectory) return
    setLoading(true)
    setPendingInstall(null)
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      maxWidth={false}
      slotProps={{
        paper: {
          sx: { ...catalogDialogPaperSx, WebkitAppRegion: 'no-drag' }
        }
      }}
    >
      <PhiPluginCatalogContent
        plugins={plugins}
        entries={entries}
        updates={updates}
        loading={loading}
        busyId={busyId ?? (installWorking || pickingDirectory ? '__directory__' : null)}
        error={error ?? feedbackError}
        notice={feedbackNotice}
        sourceNotice={sourceNotice}
        onClose={close}
        onChooseDirectory={() => void choosePluginDirectory()}
        onInstall={(entry, update) => void install(entry, update)}
        onClearError={() => {
          setError(null)
          onClearFeedback()
        }}
        onClearNotice={() => {
          setError(null)
          onClearFeedback()
        }}
        onRefresh={onChanged}
        onSetEnabled={onSetEnabled}
        onUninstall={onUninstall}
      />

      <ConfirmationDialog
        open={pendingInstall !== null}
        onClose={installWorking ? undefined : () => setPendingInstall(null)}
      >
        <DialogTitle>
          {pendingInstall && installIsUpgrade(pendingInstall)
            ? pluginCopy.upgradeTitle
            : pluginCopy.installTitle}
        </DialogTitle>
        <DialogContent>
          {pendingInstall ? (
            <Stack spacing={1.5}>
              <DialogContentText>
                {installIsUpgrade(pendingInstall)
                  ? pluginCopy.upgradeDescription(
                      pluginDisplayName(pendingInstall),
                      pendingInstall.installedVersion,
                      pendingInstall.version
                    )
                  : pluginCopy.installDescription(
                      pluginDisplayName(pendingInstall),
                      pendingInstall.version
                    )}
              </DialogContentText>
              {pendingInstall.summary ? (
                <Typography variant="body2" color="text.secondary">
                  {pendingInstall.summary}
                </Typography>
              ) : null}
              <Typography
                component="code"
                variant="caption"
                sx={{
                  p: 1.25,
                  borderRadius: 1,
                  bgcolor: 'action.hover',
                  fontFamily: 'var(--font-mono)',
                  overflowWrap: 'anywhere'
                }}
              >
                {pendingInstall.path}
              </Typography>
              {pendingInstall.problems.length > 0 ? (
                <Alert severity="warning" variant="outlined">
                  {formatPhiPluginProblems(pendingInstall.problems)}
                </Alert>
              ) : null}
            </Stack>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button disabled={installWorking} onClick={() => setPendingInstall(null)}>
            {resourceUi.cancel}
          </Button>
          <Button
            variant="contained"
            disabled={installWorking}
            onClick={() => void confirmInstall()}
          >
            {installWorking
              ? pluginCopy.processing
              : pendingInstall && installIsUpgrade(pendingInstall)
                ? pluginCopy.confirmUpgrade
                : pluginCopy.confirmInstall}
          </Button>
        </DialogActions>
      </ConfirmationDialog>
    </Dialog>
  )
}
