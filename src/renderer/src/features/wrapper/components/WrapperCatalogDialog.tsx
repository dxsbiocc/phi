import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Box, Button, CircularProgress, Dialog, Typography } from '@mui/material'
import type {
  InstalledPackageView,
  PackageRegistryView
} from '../../../../../shared/packageManagerTypes'
import type { WrapperCompositionCatalogItem } from '../../../../../shared/wrapperCompositionManifestTypes'
import { PhiIcons } from '../../../icons'
import { ResourceIcon } from '../../../components/ResourceIcon'
import { CatalogBrowseLayout } from '../../../components/catalog/CatalogBrowseLayout'
import { CatalogResultsTable } from '../../../components/catalog/CatalogResultsTable'
import { CatalogPagination } from '../../../components/catalog/CatalogPagination'
import {
  CATALOG_DEFAULT_PAGE_SIZE,
  getCatalogPage
} from '../../../components/catalog/catalogPaging'
import {
  filterWrapperCatalogChoices,
  wrapperCatalogChoices,
  wrapperCatalogGroups,
  type WrapperCatalogChoice
} from '../lib/wrapperCatalog'
import { installCatalogPackage, loadContentCatalog } from '../../../lib/contentCatalog'

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
  const [groupId, setGroupId] = useState('all')
  const [page, setPage] = useState(0)
  const [rowsPerPage, setRowsPerPage] = useState(CATALOG_DEFAULT_PAGE_SIZE)
  const [registries, setRegistries] = useState<PackageRegistryView[]>([])
  const [installedPackages, setInstalledPackages] = useState<InstalledPackageView[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sourceNotice, setSourceNotice] = useState<string | null>(null)

  const readCatalog = useCallback(async (): Promise<{
    registries: PackageRegistryView[]
    installed: InstalledPackageView[]
    error: string | null
    notice: string | null
  }> => {
    const [sources, installed] = await Promise.all([
      loadContentCatalog(window.api),
      window.api.listInstalledPackages()
    ])
    return {
      registries: sources.registries,
      installed,
      error: sources.errors.join('\n') || null,
      notice: sources.notices.join('\n') || '首选来源：Phi Packages'
    }
  }, [])

  useEffect(() => {
    if (!open) return undefined
    let active = true
    void Promise.resolve().then(() => {
      if (active) setLoading(true)
    })
    void readCatalog()
      .then((data) => {
        if (!active) return
        setRegistries(data.registries)
        setInstalledPackages(data.installed)
        setError(data.error)
        setSourceNotice(data.notice)
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
  const groups = useMemo(() => wrapperCatalogGroups(choices), [choices])
  const selectedGroupId = groups.some((group) => group.id === groupId) ? groupId : 'all'
  if (groupId !== selectedGroupId) {
    setGroupId(selectedGroupId)
    setPage(0)
  }
  const filtered = useMemo(
    () => filterWrapperCatalogChoices(choices, query, selectedGroupId),
    [choices, query, selectedGroupId]
  )
  const result = getCatalogPage(filtered, groupId === selectedGroupId ? page : 0, rowsPerPage)
  if (!loading && page !== result.page) setPage(result.page)
  const visibleChoices = result.rows

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
        const installed = await installCatalogPackage(
          window.api,
          choice.registryPath,
          choice.registryEntry
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
      setError(refreshed.error)
      setSourceNotice(refreshed.notice)
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
      aria-label="Wrapper 目录"
      slotProps={{
        paper: {
          sx: {
            width: 'min(1100px, calc(100vw - 48px))',
            height: 'min(720px, calc(100vh - 64px))',
            borderRadius: 2,
            overflow: 'hidden'
          }
        }
      }}
    >
      <CatalogBrowseLayout
        title="Wrapper"
        closeLabel="关闭 wrapper 目录"
        groups={groups}
        selectedGroupId={selectedGroupId}
        onGroupChange={(id) => {
          setGroupId(id)
          setPage(0)
        }}
        query={query}
        onQueryChange={(value) => {
          setQuery(value)
          setPage(0)
        }}
        searchLabel="搜索 wrapper 目录"
        onClose={close}
        busy={Boolean(busyId)}
        page={result.page}
        rowsPerPage={rowsPerPage}
        actions={
          <Button
            size="small"
            disabled={Boolean(busyId)}
            onClick={() => void chooseDirectory()}
            startIcon={<PhiIcons.entity.folder size={16} />}
          >
            添加本地目录
          </Button>
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
        {error ? (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
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
        ) : filtered.length === 0 ? (
          <Typography color="text.secondary" sx={{ py: 4 }}>
            {query.trim() ? '没有匹配的 wrapper' : '这个分组暂无 wrapper，可添加本地目录。'}
          </Typography>
        ) : (
          <CatalogResultsTable
            label="Wrapper 目录列表"
            nameLabel="Wrapper"
            detailsLabel="分类 / 版本"
            rowAttribute="data-phi-wrapper-catalog-choice"
            rows={visibleChoices.map((choice) => {
              const added = choice.selected && choice.enabled
              return {
                rowKey: choice.id,
                id: choice.id,
                icon: (
                  <ResourceIcon
                    icon={choice.cached?.icon ?? choice.registryEntry?.icon}
                    kind="wrapper"
                    sx={{ color: 'primary.main' }}
                  />
                ),
                title: choice.title,
                summary: choice.summary,
                metadata: choice.metadata,
                details: `${choice.category}${choice.version ? ` · v${choice.version}` : ''}`,
                action: (
                  <Button
                    size="small"
                    variant={added ? 'text' : 'outlined'}
                    disabled={added || Boolean(busyId)}
                    onClick={() => void add(choice)}
                    aria-label={`${added ? '已添加' : choice.selected ? '启用' : choice.installed ? '添加' : '安装'} ${choice.title}`}
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
                )
              }
            })}
          />
        )}
      </CatalogBrowseLayout>
    </Dialog>
  )
}
