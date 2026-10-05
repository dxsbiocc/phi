import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import type {
  InstalledPackageView,
  PackageRegistryView
} from '../../../../../shared/packageManagerTypes'
import type { WrapperCompositionCatalogItem } from '../../../../../shared/wrapperCompositionManifestTypes'
import { PhiIcons } from '../../../icons'
import {
  filterWrapperCatalogChoices,
  wrapperCatalogChoices,
  type WrapperCatalogChoice
} from '../lib/wrapperCatalog'

export interface WrapperCatalogDialogProps {
  open: boolean
  catalog: WrapperCompositionCatalogItem[]
  onClose: () => void
  onRefresh: () => Promise<void> | void
  onSetPackageEnabled?: (id: string, enabled: boolean) => Promise<boolean | void> | void
}

export function WrapperCatalogDialog({
  open,
  catalog,
  onClose,
  onRefresh,
  onSetPackageEnabled
}: WrapperCatalogDialogProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [visibleCount, setVisibleCount] = useState(40)
  const [registries, setRegistries] = useState<PackageRegistryView[]>([])
  const [installedPackages, setInstalledPackages] = useState<InstalledPackageView[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const readCatalog = useCallback(async (): Promise<{
    registries: PackageRegistryView[]
    installed: InstalledPackageView[]
  }> => {
    const [sources, installed] = await Promise.all([
      window.api.listPackageRegistries(),
      window.api.listInstalledPackages()
    ])
    const readable = await Promise.allSettled(
      sources
        .filter((source) => !source.error)
        .map((source) => window.api.readPackageRegistry(source.path))
    )
    const registries = readable.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []
    )
    if (sources.length > 0 && registries.length === 0) {
      throw new Error('无法读取 wrapper 目录，请重试或添加本地目录。')
    }
    return { registries, installed }
  }, [])

  useEffect(() => {
    if (!open) return undefined
    let active = true
    void readCatalog()
      .then((data) => {
        if (!active) return
        setRegistries(data.registries)
        setInstalledPackages(data.installed)
        setError(null)
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [open, readCatalog])

  const choices = useMemo(
    () => wrapperCatalogChoices(catalog, registries, installedPackages),
    [catalog, registries, installedPackages]
  )
  const filtered = useMemo(() => filterWrapperCatalogChoices(choices, query), [choices, query])
  const visibleChoices = filtered.slice(0, visibleCount)

  async function add(choice: WrapperCatalogChoice): Promise<void> {
    if (busyId) return
    setBusyId(choice.id)
    setError(null)
    try {
      if (!choice.installed) {
        if (!choice.registryPath || !choice.registryEntry)
          throw new Error('这个 wrapper 没有可用的安装来源。')
        await window.api.planPackageInstall(
          choice.registryPath,
          'wrapper',
          choice.id,
          choice.registryEntry.version
        )
        const installed = await window.api.installPackage(
          choice.registryPath,
          'wrapper',
          choice.id,
          choice.registryEntry.version
        )
        setInstalledPackages(installed)
      }
      if (onSetPackageEnabled) {
        if ((await onSetPackageEnabled(choice.id, true)) === false)
          throw new Error('未能启用 wrapper，请重试。')
      } else {
        await window.api.setEnablement(`wrapper:${choice.id}`, true, { type: 'global' })
        await onRefresh()
      }
      const refreshed = await readCatalog()
      setRegistries(refreshed.registries)
      setInstalledPackages(refreshed.installed)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyId(null)
    }
  }

  async function chooseDirectory(): Promise<void> {
    if (busyId) return
    setBusyId('__directory__')
    setError(null)
    try {
      const path = await window.api.pickPackageRegistryDirectory()
      if (!path) return
      const registry = await window.api.readPackageRegistry(path)
      setRegistries((current) => [...current.filter((entry) => entry.id !== registry.id), registry])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyId(null)
    }
  }

  function close(): void {
    if (busyId) return
    setLoading(true)
    setError(null)
    setVisibleCount(40)
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      maxWidth={false}
      aria-labelledby="wrapper-catalog-title"
      slotProps={{
        paper: {
          sx: {
            width: 'min(800px, calc(100vw - 48px))',
            height: 'min(680px, calc(100vh - 64px))',
            borderRadius: 2,
            overflow: 'hidden'
          }
        }
      }}
    >
      <Stack direction="row" sx={{ alignItems: 'center', px: 3, pt: 2, pb: 1 }}>
        <Typography id="wrapper-catalog-title" variant="h6" sx={{ flex: 1, fontWeight: 700 }}>
          Wrapper 目录
        </Typography>
        <IconButton
          aria-label="关闭 wrapper 目录"
          disabled={Boolean(busyId)}
          onClick={close}
          size="small"
        >
          <PhiIcons.action.close size={18} />
        </IconButton>
      </Stack>
      <Box sx={{ px: 3, pb: 2 }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          选择需要的 wrapper，添加后即可在侧边栏开启或关闭。
        </Typography>
        <TextField
          fullWidth
          size="small"
          placeholder="搜索 wrapper 目录"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setVisibleCount(40)
          }}
          slotProps={{
            htmlInput: { 'aria-label': '搜索 wrapper 目录' },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <PhiIcons.action.search size={16} />
                </InputAdornment>
              )
            }
          }}
        />
        {error && (
          <Alert severity="error" sx={{ mt: 1.5 }}>
            {error}
          </Alert>
        )}
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 3, pb: 2 }}>
        {loading ? (
          <Box sx={{ display: 'grid', placeItems: 'center', py: 6 }}>
            <CircularProgress size={22} />
          </Box>
        ) : filtered.length === 0 ? (
          <Typography color="text.secondary" sx={{ py: 4 }}>
            {query.trim() ? '没有匹配的 wrapper' : '目录中暂无 wrapper，可添加本地目录。'}
          </Typography>
        ) : (
          visibleChoices.map((choice) => {
            const added = choice.selected && choice.enabled
            return (
              <Stack
                key={choice.id}
                data-phi-wrapper-catalog-choice={choice.id}
                direction="row"
                spacing={1.5}
                sx={{ alignItems: 'center', py: 1.5 }}
              >
                <Box
                  sx={{
                    width: 36,
                    height: 36,
                    flexShrink: 0,
                    display: 'grid',
                    placeItems: 'center',
                    bgcolor: 'action.hover',
                    color: 'primary.main',
                    borderRadius: 1.25
                  }}
                >
                  <PhiIcons.entity.wrapper sx={{ fontSize: 20 }} />
                </Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography
                    noWrap
                    title={choice.title}
                    sx={{ fontWeight: 600, fontSize: '0.875rem' }}
                  >
                    {choice.title}
                  </Typography>
                  <Typography variant="body2" noWrap title={choice.summary} color="text.secondary">
                    {choice.summary}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {choice.metadata}
                  </Typography>
                </Box>
                <Button
                  size="small"
                  variant={added ? 'text' : 'outlined'}
                  disabled={added || Boolean(busyId)}
                  onClick={() => void add(choice)}
                  aria-label={`${added ? '已添加' : choice.selected ? '启用' : choice.installed ? '添加' : '安装'} ${choice.title}`}
                  sx={{ minWidth: 72, flexShrink: 0 }}
                >
                  {busyId === choice.id ? (
                    <CircularProgress size={16} />
                  ) : added ? (
                    '已添加'
                  ) : choice.selected ? (
                    '启用'
                  ) : choice.installed ? (
                    '添加'
                  ) : (
                    '安装'
                  )}
                </Button>
              </Stack>
            )
          })
        )}
        {!loading && filtered.length > visibleCount && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 1 }}>
            <Button size="small" onClick={() => setVisibleCount((count) => count + 40)}>
              加载更多 · 还有 {filtered.length - visibleCount} 个
            </Button>
          </Box>
        )}
      </Box>
      <Box sx={{ px: 3, py: 1.5 }}>
        <Button
          size="small"
          disabled={Boolean(busyId)}
          onClick={() => void chooseDirectory()}
          startIcon={<PhiIcons.action.add size={16} />}
        >
          添加本地目录
        </Button>
      </Box>
    </Dialog>
  )
}
