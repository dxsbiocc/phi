import { useCallback, useEffect, useMemo, useReducer, useState } from 'react'
import { Alert, Button, CircularProgress, Dialog, Stack, Typography } from '@mui/material'
import type {
  PackageRegistryEntryView,
  PackageRegistryView
} from '../../../../../shared/packageManagerTypes'
import { ResourceIcon } from '../../../components/ResourceIcon'
import type { SkillSummary } from '../../../types'
import { CatalogBrowseLayout } from '../../../components/catalog/CatalogBrowseLayout'
import { CatalogAddButton } from '../../../components/catalog/CatalogAddButton'
import { CatalogPagination } from '../../../components/catalog/CatalogPagination'
import { useBusyKeys } from '../../../components/catalog/useBusyKeys'
import { usePackageRemoval } from '../../../components/catalog/usePackageRemoval'
import { getCatalogPage } from '../../../components/catalog/catalogPaging'
import { loadContentCatalog } from '../../../lib/contentCatalog'
import {
  CatalogResultsTable,
  type CatalogResultRow
} from '../../../components/catalog/CatalogResultsTable'
import { formatPackageSize } from '../../../components/catalog/packageSize'
import { SkillPackageDetailPage } from './SkillPackageDetailPage'
import {
  filterSkillCatalogItems,
  initialSkillCatalogBrowserState,
  installedSkillPackageIds,
  knownSkillCatalogPackages,
  skillCatalogBrowserReducer,
  skillCatalogGroups,
  skillCatalogItems,
  type SkillCatalogPackage
} from '../lib/skillCatalogBrowser'

export type SkillCatalogDialogProps = {
  open: boolean
  skills: SkillSummary[]
  isSkillsLoading?: boolean
  registry?: PackageRegistryView | null
  registryDir?: string | null
  isRegistryLoading?: boolean
  registryError?: string | null
  onClose: () => void
  onPickRegistryDirectory?: () => Promise<string | null>
  onReadRegistry?: (dir: string) => Promise<PackageRegistryView>
  onInstallPackage?: (registryDir: string, entry: PackageRegistryEntryView) => Promise<void> | void
  onApplyUpdate?: (entry: PackageRegistryEntryView) => Promise<void> | void
  onRefresh?: () => Promise<void> | void
}

function withoutId(ids: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(ids)
  next.delete(id)
  return next
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function SkillCatalogDialog({
  open,
  skills,
  isSkillsLoading = false,
  registry,
  isRegistryLoading = false,
  registryError = null,
  onClose,
  onPickRegistryDirectory,
  onReadRegistry,
  onInstallPackage,
  onApplyUpdate,
  onRefresh
}: SkillCatalogDialogProps): React.JSX.Element {
  const [localRegistry, setLocalRegistry] = useState<PackageRegistryView | null>(null)
  const [loadingRegistry, setLoadingRegistry] = useState(false)
  const installing = useBusyKeys()
  const [actionError, setActionError] = useState<string | null>(null)
  const [installedDuringSession, setInstalledDuringSession] = useState<Set<string>>(new Set())
  const [removedDuringSession, setRemovedDuringSession] = useState<Set<string>>(new Set())
  const [installedSnapshot, setInstalledSnapshot] = useState<Set<string> | null>(null)
  const [updateIds, setUpdateIds] = useState<Set<string>>(new Set())
  const [knownRegistries, setKnownRegistries] = useState<PackageRegistryView[]>([])
  const [loadingKnownRegistries, setLoadingKnownRegistries] = useState(false)
  const [sourceError, setSourceError] = useState<string | null>(null)
  const [sourceNotice, setSourceNotice] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [browser, dispatchBrowser] = useReducer(
    skillCatalogBrowserReducer,
    initialSkillCatalogBrowserState
  )

  useEffect(() => {
    if (!open) dispatchBrowser({ type: 'close' })
  }, [open])

  useEffect(() => {
    if (!open) return
    let active = true
    let revision = 0
    const reload = (): void => {
      if (!active) return
      const request = ++revision
      const current = (): boolean => active && request === revision
      void Promise.resolve().then(() => {
        if (current()) setLoadingKnownRegistries(true)
      })
      void loadContentCatalog(window.api, { forceRefresh: true })
        .then((catalog) => {
          if (!current()) return
          setKnownRegistries(catalog.registries)
          setSourceError(catalog.errors.join('\n') || null)
          setSourceNotice(catalog.notices.join('\n') || null)
        })
        .catch((cause) => {
          if (current()) setSourceError(errorMessage(cause))
        })
        .finally(() => {
          if (current()) setLoadingKnownRegistries(false)
        })
      void Promise.resolve()
        .then(() => window.api.listPackageUpdates?.())
        .then((updates) => {
          if (current() && updates) {
            setUpdateIds(
              new Set(
                updates.filter((update) => update.type === 'skill').map((update) => update.id)
              )
            )
          }
        })
        .catch(() => undefined)
      void Promise.resolve()
        .then(() => window.api.listInstalledPackages?.())
        .then((installed) => {
          if (!current() || !installed) return
          setInstalledSnapshot(
            new Set(installed.filter((entry) => entry.type === 'skill').map((entry) => entry.id))
          )
          setInstalledDuringSession(new Set())
          setRemovedDuringSession(new Set())
        })
        .catch(() => undefined)
    }
    reload()
    const unsubscribe = window.api.onPackageResourcesChanged?.(reload)
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [open])

  const displayedRegistry = registry === undefined ? localRegistry : registry
  const packages = useMemo(
    () => knownSkillCatalogPackages([...knownRegistries, displayedRegistry ?? null]),
    [displayedRegistry, knownRegistries]
  )
  const installedPackageIds = useMemo(
    () =>
      installedSkillPackageIds(
        installedSnapshot ? [] : skills,
        new Set([...(installedSnapshot ?? []), ...installedDuringSession]),
        removedDuringSession
      ),
    [installedDuringSession, installedSnapshot, removedDuringSession, skills]
  )
  const afterRemoval = useCallback(async (): Promise<void> => {
    await onRefresh?.()
  }, [onRefresh])
  const removal = usePackageRemoval(
    useCallback(async (id: string) => {
      await window.api.uninstallPackage('skill', id)
      setInstalledDuringSession((current) => withoutId(current, id))
      setRemovedDuringSession((current) => new Set(current).add(id))
    }, []),
    afterRemoval
  )
  const loading = loadingRegistry || loadingKnownRegistries || isRegistryLoading
  const error = actionError ?? registryError ?? sourceError ?? removal.error
  const items = useMemo(() => skillCatalogItems(loading ? [] : packages), [loading, packages])
  const groupDefinitions =
    knownRegistries.find((source) => source.kind === 'official')?.skillGroups ??
    displayedRegistry?.skillGroups
  const groups = useMemo(
    () => skillCatalogGroups(items, groupDefinitions),
    [items, groupDefinitions]
  )
  const selectedGroupId = groups.some((group) => group.id === browser.groupId)
    ? browser.groupId
    : 'all'
  const matchingItems = useMemo(
    () => filterSkillCatalogItems(items, selectedGroupId, browser.query),
    [items, selectedGroupId, browser.query]
  )
  const { page, rows: visibleItems } = getCatalogPage(
    matchingItems,
    browser.page,
    browser.rowsPerPage
  )
  useEffect(() => {
    if (!open) return
    dispatchBrowser({
      type: 'reconcile',
      groupIds: groups.map((group) => group.id),
      ready: !loading && !isSkillsLoading && !registryError,
      page
    })
  }, [groups, isSkillsLoading, loading, open, page, registryError])

  function close(): void {
    dispatchBrowser({ type: 'close' })
    setActionError(null)
    setDetailId(null)
    onClose()
  }

  async function chooseRegistry(): Promise<void> {
    if (!onPickRegistryDirectory || !onReadRegistry) return
    setLoadingRegistry(true)
    setActionError(null)
    try {
      const dir = await onPickRegistryDirectory()
      if (!dir) return
      const nextRegistry = await onReadRegistry(dir)
      setLocalRegistry(nextRegistry)
    } catch (cause) {
      setActionError(`读取本地目录失败：${errorMessage(cause)}`)
    } finally {
      setLoadingRegistry(false)
    }
  }

  async function install(
    entry: PackageRegistryEntryView & { registryDir?: string }
  ): Promise<void> {
    const updating = updateIds.has(entry.id)
    const sourceDir = entry.registryDir
    if (updating ? !onApplyUpdate : !onInstallPackage || !sourceDir) return
    if (installing.has(entry.id)) return
    installing.start(entry.id)
    setActionError(null)
    try {
      if (updating) await onApplyUpdate?.(entry)
      else await onInstallPackage?.(sourceDir!, entry)
      setInstalledDuringSession((current) => new Set(current).add(entry.id))
      setRemovedDuringSession((current) => withoutId(current, entry.id))
      setUpdateIds((current) => {
        const next = new Set(current)
        next.delete(entry.id)
        return next
      })
      await onRefresh?.()
    } catch (cause) {
      setActionError(`安装技能包失败：${errorMessage(cause)}`)
    } finally {
      installing.finish(entry.id)
    }
  }

  function renderAction(entry: SkillCatalogPackage): React.JSX.Element {
    const installed = installedPackageIds.has(entry.id)
    const updateAvailable = installed && updateIds.has(entry.id)
    const removing = installed && !updateAvailable
    const working = installing.has(entry.id) || removal.isRemoving(entry.id)
    const label = installing.has(entry.id)
      ? updateAvailable
        ? '正在更新…'
        : '正在安装…'
      : removal.isRemoving(entry.id)
        ? '正在卸载…'
        : updateAvailable
          ? '更新'
          : installed
            ? '卸载'
            : '安装'
    return (
      <Button
        size="small"
        variant={removing ? 'outlined' : 'contained'}
        color={removing ? 'error' : 'primary'}
        disabled={working || (!removing && (updateAvailable ? !onApplyUpdate : !onInstallPackage))}
        onClick={() => void (removing ? removal.remove(entry.id) : install(entry))}
        aria-label={`${updateAvailable ? '更新' : installed ? '卸载' : '安装'} ${entry.title}`}
      >
        {label}
      </Button>
    )
  }

  const rows: CatalogResultRow[] = visibleItems.map(({ entry }) => ({
    rowKey: `package:${entry.id}@${entry.version}`,
    id: entry.id,
    icon: <ResourceIcon icon={entry.icon} kind="skill" sx={{ color: 'primary.main' }} />,
    title: entry.title,
    summary: entry.summary,
    metadata: entry.registryLabel ?? '软件包',
    details: `v${entry.version} · ${formatPackageSize(entry.size)}`,
    action: renderAction(entry)
  }))
  const detailEntry = detailId ? items.find((item) => item.entry.id === detailId)?.entry : undefined

  return (
    <Dialog
      open={open}
      onClose={installing.any ? undefined : close}
      aria-label="技能目录"
      maxWidth={false}
      slotProps={{
        paper: {
          sx: {
            width: 'min(1100px, calc(100vw - 48px))',
            height: 'min(720px, calc(100vh - 64px))',
            maxWidth: 'calc(100vw - 48px)',
            maxHeight: 'calc(100vh - 64px)',
            m: 3,
            borderRadius: 2,
            overflow: 'hidden'
          }
        }
      }}
    >
      {detailEntry ? (
        <SkillPackageDetailPage
          entry={detailEntry}
          installed={installedPackageIds.has(detailEntry.id)}
          action={renderAction(detailEntry)}
          onBack={() => setDetailId(null)}
        />
      ) : (
        <CatalogBrowseLayout
          title="技能目录"
          closeLabel="关闭技能目录"
          groups={groups}
          selectedGroupId={selectedGroupId}
          onGroupChange={(groupId) => dispatchBrowser({ type: 'group', groupId })}
          query={browser.query}
          onQueryChange={(query) => dispatchBrowser({ type: 'query', query })}
          page={page}
          rowsPerPage={browser.rowsPerPage}
          searchLabel="搜索技能名称或说明"
          onClose={close}
          busy={installing.any}
          actions={
            <CatalogAddButton
              label="添加技能目录"
              disabled={loading || !onPickRegistryDirectory || !onReadRegistry}
              onClick={() => void chooseRegistry()}
            />
          }
          footer={
            <CatalogPagination
              count={matchingItems.length}
              page={page}
              rowsPerPage={browser.rowsPerPage}
              onPageChange={(nextPage) => dispatchBrowser({ type: 'page', page: nextPage })}
              onRowsPerPageChange={(rowsPerPage) =>
                dispatchBrowser({ type: 'page-size', rowsPerPage })
              }
            />
          }
        >
          {error ? (
            <Alert
              severity="error"
              sx={{ mb: 2 }}
              onClose={() => {
                setActionError(null)
                removal.clearError()
              }}
            >
              {error}
            </Alert>
          ) : null}
          {isSkillsLoading && skills.length === 0 && !selectedGroupId.startsWith('category:') ? (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', py: 2 }}>
              <CircularProgress size={18} />
              <Typography variant="body2" color="text.secondary">
                正在读取已安装技能
              </Typography>
            </Stack>
          ) : null}
          {loading ? (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', py: 2 }}>
              <CircularProgress size={18} />
              <Typography variant="body2" color="text.secondary">
                正在读取 Phi Packages 和本地目录
              </Typography>
            </Stack>
          ) : null}
          {sourceNotice ? (
            <Alert severity="info" sx={{ mb: 2 }}>
              {sourceNotice}
            </Alert>
          ) : null}
          <CatalogResultsTable
            label="技能目录结果"
            nameLabel="技能"
            detailsLabel="版本 / 大小"
            rows={rows}
            rowAttribute="data-phi-skill-catalog-card"
            onOpen={setDetailId}
          />
          {matchingItems.length === 0 && !loading && !(isSkillsLoading && skills.length === 0) ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 3 }}>
              {browser.query.trim()
                ? '没有匹配的技能，请尝试其他关键词。'
                : displayedRegistry
                  ? '目录中没有可安装的技能包'
                  : '已知软件源中没有可安装的技能包'}
            </Typography>
          ) : null}
        </CatalogBrowseLayout>
      )}
    </Dialog>
  )
}
