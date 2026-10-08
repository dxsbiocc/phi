import { useCallback, useEffect, useMemo, useState } from 'react'
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
import type { PhiPluginInstallPreview } from '../../../../../shared/phiPluginTypes'
import type { ResourceIconRef } from '../../../../../shared/resourceIconTypes'
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
  phiPluginCatalogAction,
  type PhiPluginCatalogAction,
  type PhiPluginCatalogEntry
} from '../lib/phiPluginCatalog'
import {
  formatPhiPluginProblems,
  isSemanticUpgrade,
  phiPluginDistributionLabel
} from '../lib/phiPlugins'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function installIsUpgrade(preview: PhiPluginInstallPreview): boolean {
  return (
    preview.action === 'upgrade' || isSemanticUpgrade(preview.installedVersion, preview.version)
  )
}

function pluginDisplayName(preview: PhiPluginInstallPreview): string {
  return preview.title?.trim() || preview.id?.trim() || '这个插件'
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
            {source ? <Chip size="small" variant="outlined" label={source} /> : null}
            {source !== PACKAGE_TRUST_LABELS[trust] ? (
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
            ? '处理中…'
            : action === 'update'
              ? '更新'
              : action === 'installed'
                ? '已安装'
                : '安装'}
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
  const [category, setCategory] = useState(initialCategory)
  const [query, setQuery] = useState('')
  const installedIds = useMemo(() => new Set(plugins.map((plugin) => plugin.id)), [plugins])
  const groups = useMemo(() => {
    const counts = new Map<string, number>()
    for (const entry of entries) {
      const label = entry.category?.trim() || '其他'
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))
  }, [entries])
  const normalizedQuery = query.trim().toLowerCase()
  const visiblePlugins = plugins.filter((plugin) =>
    [plugin.title, plugin.id, plugin.version, plugin.summary].some((value) =>
      value.toLowerCase().includes(normalizedQuery)
    )
  )
  const visibleEntries = entries.filter((entry) => {
    if (category !== 'all' && (entry.category?.trim() || '其他') !== category) return false
    if (!normalizedQuery) return true
    return [entry.title, entry.id, entry.version, entry.summary, entry.category]
      .filter(Boolean)
      .some((value) => value!.toLowerCase().includes(normalizedQuery))
  })
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
        aria-label="插件目录分组"
        sx={{
          minHeight: 0,
          overflowY: 'auto',
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
            <Typography variant="body2">全部插件 · {entries.length}</Typography>
          </ListItemButton>
          <ListItemButton
            selected={installedSelected}
            onClick={() => setCategory('installed')}
            sx={{ borderRadius: 1.5, mb: 0.5 }}
          >
            <Typography variant="body2">已安装 · {plugins.length}</Typography>
          </ListItemButton>
          {groups.map(([label, count]) => (
            <ListItemButton
              key={label}
              selected={category === label}
              onClick={() => setCategory(label)}
              sx={{ borderRadius: 1.5, mb: 0.5 }}
            >
              <Typography variant="body2">
                {label} · {count}
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
          从本地目录安装
        </Button>
      </Box>

      <Box sx={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', px: 3, py: 2 }}>
          <Typography variant="h5" sx={{ flex: 1, fontWeight: 700 }}>
            {installedSelected ? '已安装' : category === 'all' ? '全部插件' : category}
          </Typography>
          <TextField
            size="small"
            placeholder="搜索插件目录"
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
        <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 3, pb: 3 }}>
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
                正在加载插件目录…
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
                : visibleEntries.map((entry) => {
                    const action = phiPluginCatalogAction(entry, installedIds, updates)
                    return (
                      <CatalogCard
                        key={entry.id}
                        icon={entry.icon}
                        title={entry.title}
                        summary={entry.summary}
                        version={entry.version}
                        trust={entry.trust}
                        source={entry.registryLabel}
                        action={action}
                        busy={busyId === entry.id}
                        disabled={busyId !== null}
                        onAction={() => onInstall(entry, action === 'update')}
                      />
                    )
                  })}
            </Box>
          )}
          {!loading &&
          ((installedSelected && visiblePlugins.length === 0) ||
            (!installedSelected && visibleEntries.length === 0)) ? (
            <Typography variant="body2" color="text.secondary">
              {normalizedQuery
                ? '没有符合搜索条件的插件'
                : installedSelected
                  ? '尚未安装插件'
                  : '这个分组目前没有插件'}
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
      notice: catalog.notices.join('\n') || '首选来源：Phi Packages'
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
        onShowError(`插件目录验证失败：${formatPhiPluginProblems(preview.problems)}`)
        return
      }
      if (preview.action === 'same-or-older') {
        onShowError(
          `${preview.installedVersion ? `已安装版本为 ${preview.installedVersion}，` : ''}请选择版本更高的插件目录进行升级。`
        )
        return
      }
      setPendingInstall(preview)
    } catch (cause) {
      onShowError(`无法读取插件目录：${errorMessage(cause)}`)
    } finally {
      setPickingDirectory(false)
    }
  }

  async function confirmInstall(): Promise<void> {
    if (!pendingInstall) return
    const upgrade = installIsUpgrade(pendingInstall)
    const succeeded = await onInstallFromDirectory(
      pendingInstall.path,
      upgrade ? '插件升级' : '插件安装'
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
          插件目录
        </Typography>
        <IconButton aria-label="关闭插件目录" onClick={close}>
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

      <Dialog
        open={pendingInstall !== null}
        onClose={installWorking ? undefined : () => setPendingInstall(null)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>
          {pendingInstall && installIsUpgrade(pendingInstall) ? '升级插件？' : '安装插件？'}
        </DialogTitle>
        <DialogContent>
          {pendingInstall ? (
            <Stack spacing={1.5}>
              <DialogContentText>
                {installIsUpgrade(pendingInstall)
                  ? `将 ${pluginDisplayName(pendingInstall)} 从 ${pendingInstall.installedVersion ?? '当前版本'} 升级到 ${pendingInstall.version ?? '新版本'}。升级前请确认插件目录可信。`
                  : `将从这个本地目录安装 ${pluginDisplayName(pendingInstall)} ${pendingInstall.version ?? ''}。安装后插件默认可用。`}
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
            取消
          </Button>
          <Button
            variant="contained"
            disabled={installWorking}
            onClick={() => void confirmInstall()}
          >
            {installWorking
              ? '处理中…'
              : pendingInstall && installIsUpgrade(pendingInstall)
                ? '确认升级'
                : '确认安装'}
          </Button>
        </DialogActions>
      </Dialog>
    </Dialog>
  )
}
