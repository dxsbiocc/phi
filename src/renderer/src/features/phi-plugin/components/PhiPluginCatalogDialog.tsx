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
  InputAdornment,
  List,
  ListItemButton,
  Paper,
  Stack,
  TextField,
  Typography
} from '@mui/material'

import type { PackageTrust, PackageUpdateView } from '../../../../../shared/packageManagerTypes'
import { errorMessage } from '../../../../../shared/errorCodes'
import type { PhiPluginInstallPreview } from '../../../../../shared/phiPluginTypes'
import type { ResourceIconRef } from '../../../../../shared/resourceIconTypes'
import { CATALOG_SCROLLBAR_GUTTER } from '../../../components/catalog/catalogPaging'
import { PhiIcons } from '../../../icons'
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
  onAction?: () => void
}): React.JSX.Element {
  useUiLanguage()

  return (
    <Paper variant="outlined" sx={{ p: 1.75, borderRadius: 2 }}>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
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
          <Typography sx={{ fontWeight: 700 }}>{title}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
            {summary}
          </Typography>
          <Stack direction="row" spacing={0.75} useFlexGap sx={{ mt: 1, flexWrap: 'wrap' }}>
            <Chip size="small" label={`v${version}`} />
            {source ? (
              <Chip size="small" variant="outlined" label={resourceSourceLabel(source)} />
            ) : null}
            {resourceSourceLabel(source ?? '') !== PACKAGE_TRUST_LABELS[trust] ? (
              <Chip
                size="small"
                variant="outlined"
                label={PACKAGE_TRUST_LABELS[trust]}
                title={PACKAGE_TRUST_DESCRIPTIONS[trust]}
              />
            ) : null}
          </Stack>
        </Box>
        <Button
          variant={action === 'installed' ? 'outlined' : 'contained'}
          disabled={disabled || action === 'installed' || !onAction}
          onClick={onAction}
        >
          {busy
            ? pluginCopy.processing
            : action === 'update'
              ? resourceUi.update
              : action === 'installed'
                ? resourceUi.installed
                : resourceUi.install}
        </Button>
      </Stack>
    </Paper>
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
  onChooseDirectory: () => void
  onInstall: (entry: PhiPluginCatalogEntry, update: boolean) => void
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
  onChooseDirectory,
  onInstall
}: PhiPluginCatalogContentProps): React.JSX.Element {
  const uiLanguage = useUiLanguage()

  const [category, setCategory] = useState(initialCategory)
  const [query, setQuery] = useState('')
  const installedIds = useMemo(() => new Set(plugins.map((plugin) => plugin.id)), [plugins])
  const catalog = useMemo(() => {
    void uiLanguage // Invalidate localized presentation.
    return buildPhiPluginCatalog(plugins, entries)
  }, [plugins, entries, uiLanguage])
  const groups = useMemo(() => {
    void uiLanguage // Invalidate labels and localized search without changing selection.

    const counts = new Map<string, number>()
    for (const item of catalog) {
      counts.set(item.category, (counts.get(item.category) ?? 0) + 1)
    }
    return [...counts.entries()].sort(([left], [right]) =>
      resourceCategoryLabel(left).localeCompare(resourceCategoryLabel(right), getUiLocale())
    )
  }, [catalog, uiLanguage])
  const normalizedQuery = query.trim().toLowerCase()
  const visiblePlugins = plugins.filter((plugin) =>
    [plugin.title, plugin.id, plugin.version, plugin.summary].some((value) =>
      value.toLowerCase().includes(normalizedQuery)
    )
  )
  const visibleItems = filterPhiPluginCatalog(catalog, category, query)
  const installedSelected = category === 'installed'

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: '230px minmax(0, 1fr)',
        gridTemplateRows: 'minmax(0, 1fr)',
        height: '100%',
        minHeight: 0
      }}
    >
      <Box
        component="nav"
        aria-label={pluginCopy.catalogGroups}
        sx={{
          minHeight: 0,
          overflowY: 'auto',
          scrollbarGutter: 'stable',
          p: 1.5,
          borderRight: 1,
          borderColor: 'divider',
          bgcolor: 'background.default'
        }}
      >
        <List disablePadding>
          <ListItemButton
            selected={category === 'all'}
            onClick={() => setCategory('all')}
            sx={{ borderRadius: 1.5, mb: 0.5 }}
          >
            <Typography variant="body2">
              {pluginCopy.allPlugins} · {catalog.length}
            </Typography>
          </ListItemButton>
          <ListItemButton
            selected={installedSelected}
            onClick={() => setCategory('installed')}
            sx={{ borderRadius: 1.5, mb: 0.5 }}
          >
            <Typography variant="body2">
              {resourceUi.installed} · {plugins.length}
            </Typography>
          </ListItemButton>
          {groups.map(([label, count]) => (
            <ListItemButton
              key={label}
              selected={category === label}
              onClick={() => setCategory(label)}
              sx={{ borderRadius: 1.5, mb: 0.5 }}
            >
              <Typography variant="body2">
                {resourceCategoryLabel(label)} · {count}
              </Typography>
            </ListItemButton>
          ))}
        </List>
        <Button
          fullWidth
          variant="outlined"
          startIcon={<PhiIcons.entity.folder size={16} />}
          disabled={busyId !== null}
          onClick={onChooseDirectory}
          sx={{ mt: 2 }}
        >
          {pluginCopy.installDirectory}
        </Button>
      </Box>

      <Box sx={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', px: 3, py: 2 }}>
          <Typography variant="h5" sx={{ flex: 1, fontWeight: 700 }}>
            {installedSelected
              ? resourceUi.installed
              : category === 'all'
                ? pluginCopy.allPlugins
                : resourceCategoryLabel(category)}
          </Typography>
          <TextField
            size="small"
            placeholder={pluginCopy.searchCatalog}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <PhiIcons.action.search fontSize="small" />
                  </InputAdornment>
                )
              }
            }}
          />
        </Stack>
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            scrollbarGutter: 'stable',
            pl: 3,
            pr: CATALOG_SCROLLBAR_GUTTER,
            pb: 3
          }}
        >
          {error ? (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          ) : null}
          {notice ? (
            <Alert severity="success" sx={{ mb: 2 }}>
              {notice}
            </Alert>
          ) : null}
          {sourceNotice ? (
            <Alert severity="info" sx={{ mb: 2 }}>
              {sourceNotice}
            </Alert>
          ) : null}
          {loading ? (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <CircularProgress size={20} />
              <Typography variant="body2" color="text.secondary">
                {pluginCopy.loadingCatalog}
              </Typography>
            </Stack>
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
        </Box>
      </Box>
    </Box>
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
  onInstallFromDirectory
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
          sx: {
            width: 'min(1080px, calc(100vw - 96px))',
            height: 'min(700px, calc(100vh - 96px))',
            maxHeight: 'calc(100vh - 96px)',
            borderRadius: 2,
            overflow: 'hidden'
          }
        }
      }}
    >
      <Stack
        direction="row"
        spacing={1.5}
        sx={{ alignItems: 'center', px: 3, py: 2, borderBottom: 1, borderColor: 'divider' }}
      >
        <Typography variant="h6" sx={{ flex: 1, fontWeight: 700 }}>
          {pluginCopy.catalog}
        </Typography>
        <IconButton aria-label={pluginCopy.closeCatalog} onClick={close}>
          <PhiIcons.action.close size={18} />
        </IconButton>
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <PhiPluginCatalogContent
          plugins={plugins}
          entries={entries}
          updates={updates}
          loading={loading}
          busyId={busyId ?? (installWorking || pickingDirectory ? '__directory__' : null)}
          error={error ?? feedbackError}
          notice={feedbackNotice}
          sourceNotice={sourceNotice}
          onChooseDirectory={() => void choosePluginDirectory()}
          onInstall={(entry, update) => void install(entry, update)}
        />
      </Box>

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
