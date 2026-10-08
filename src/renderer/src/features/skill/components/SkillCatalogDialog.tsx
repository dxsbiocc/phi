import { useEffect, useMemo, useReducer, useState } from 'react'
import { Alert, Button, CircularProgress, Dialog, Stack, Typography } from '@mui/material'
import type {
  PackageRegistryEntryView,
  PackageRegistryView
} from '../../../../../shared/packageManagerTypes'
import { PhiIcons } from '../../../icons'
import { ResourceIcon } from '../../../components/ResourceIcon'
import type { SkillSummary } from '../../../types'
import { CatalogBrowseLayout } from '../../../components/catalog/CatalogBrowseLayout'
import { CatalogPagination } from '../../../components/catalog/CatalogPagination'
import { getCatalogPage } from '../../../components/catalog/catalogPaging'
import {
  CatalogResultsTable,
  type CatalogResultRow
} from '../../../components/catalog/CatalogResultsTable'
import {
  DEPRECATED_SKILL_LABEL,
  bundledCatalogSkills,
  formatPackageSize,
  registrySkillPackages,
  skillIsEnabled,
  withoutBundledSkillNames
} from '../lib/skillCatalog'
import {
  filterSkillCatalogItems,
  initialSkillCatalogBrowserState,
  knownSkillCatalogPackages,
  skillCatalogBrowserReducer,
  skillCatalogGroups,
  skillCatalogItems
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
  onEnableBundled?: (skill: SkillSummary) => Promise<void> | void
  onPickRegistryDirectory?: () => Promise<string | null>
  onReadRegistry?: (dir: string) => Promise<PackageRegistryView>
  onInstallPackage?: (registryDir: string, entry: PackageRegistryEntryView) => Promise<void> | void
  onApplyUpdate?: (entry: PackageRegistryEntryView) => Promise<void> | void
  onRefresh?: () => Promise<void> | void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function SkillCatalogDialog({
  open,
  skills,
  isSkillsLoading = false,
  registry,
  registryDir,
  isRegistryLoading = false,
  registryError = null,
  onClose,
  onEnableBundled,
  onPickRegistryDirectory,
  onReadRegistry,
  onInstallPackage,
  onApplyUpdate,
  onRefresh
}: SkillCatalogDialogProps): React.JSX.Element {
  const [localRegistry, setLocalRegistry] = useState<PackageRegistryView | null>(null)
  const [localRegistryDir, setLocalRegistryDir] = useState<string | null>(null)
  const [loadingRegistry, setLoadingRegistry] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [installedDuringSession, setInstalledDuringSession] = useState<Set<string>>(new Set())
  const [updateIds, setUpdateIds] = useState<Set<string>>(new Set())
  const [knownPackages, setKnownPackages] = useState<
    Array<PackageRegistryEntryView & { registryDir: string }>
  >([])
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
    void window.api
      .listPackageUpdates()
      .then((updates) => {
        if (active) {
          setUpdateIds(
            new Set(updates.filter((update) => update.type === 'skill').map((update) => update.id))
          )
        }
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    let active = true
    void window.api
      .listPackageRegistries()
      .then((registries) =>
        Promise.all(
          registries
            .filter((item) => item.kind !== 'bundled' && !item.error)
            .map(async (item) => {
              try {
                return await window.api.readPackageRegistry(item.path)
              } catch {
                return null
              }
            })
        )
      )
      .then((registries) => {
        if (!active) return
        setKnownPackages(knownSkillCatalogPackages(registries))
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [open])

  const displayedRegistry = registry === undefined ? localRegistry : registry
  const displayedRegistryDir = registryDir === undefined ? localRegistryDir : registryDir
  const bundledSkills = useMemo(() => bundledCatalogSkills(skills), [skills])
  const packages = useMemo(() => {
    const candidates = displayedRegistry ? registrySkillPackages(displayedRegistry) : knownPackages
    return withoutBundledSkillNames(candidates, skills)
  }, [displayedRegistry, knownPackages, skills])
  const installedPackageIds = useMemo(() => {
    const ids = new Set(installedDuringSession)
    for (const skill of skills) {
      if (skill.sourceCategory === 'installed-package') ids.add(skill.sourceId ?? skill.name)
    }
    return ids
  }, [installedDuringSession, skills])
  const loading = loadingRegistry || isRegistryLoading
  const error = actionError ?? registryError
  const items = useMemo(
    () => skillCatalogItems(bundledSkills, loading ? [] : packages),
    [bundledSkills, loading, packages]
  )
  const groups = useMemo(() => skillCatalogGroups(items), [items])
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
      setLocalRegistryDir(dir)
      setLocalRegistry(nextRegistry)
    } catch (cause) {
      setActionError(`读取本地目录失败：${errorMessage(cause)}`)
    } finally {
      setLoadingRegistry(false)
    }
  }

  async function enableBundled(skill: SkillSummary): Promise<void> {
    if (!onEnableBundled) return
    const key = `bundled:${skill.name}`
    setBusyKey(key)
    setActionError(null)
    try {
      await onEnableBundled(skill)
      await onRefresh?.()
    } catch (cause) {
      setActionError(`启用技能失败：${errorMessage(cause)}`)
    } finally {
      setBusyKey(null)
    }
  }

  async function install(
    entry: PackageRegistryEntryView & { registryDir?: string }
  ): Promise<void> {
    const updating = updateIds.has(entry.id)
    const sourceDir = displayedRegistryDir ?? entry.registryDir
    if (updating ? !onApplyUpdate : !onInstallPackage || !sourceDir) return
    const key = `package:${entry.id}@${entry.version}`
    setBusyKey(key)
    setActionError(null)
    try {
      if (updating) await onApplyUpdate?.(entry)
      else await onInstallPackage?.(sourceDir!, entry)
      setInstalledDuringSession((current) => new Set(current).add(entry.id))
      setUpdateIds((current) => {
        const next = new Set(current)
        next.delete(entry.id)
        return next
      })
      await onRefresh?.()
    } catch (cause) {
      setActionError(`安装技能包失败：${errorMessage(cause)}`)
    } finally {
      setBusyKey(null)
    }
  }

  const rows: CatalogResultRow[] = visibleItems.map((item) => {
    if (item.kind === 'bundled') {
      const { skill } = item
      const key = `bundled:${skill.name}`
      const enabledInProject = skillIsEnabled(skill)
      return {
        rowKey: `bundled:${skill.id}`,
        id: skill.id,
        icon: <ResourceIcon icon={skill.icon} kind="skill" sx={{ color: 'primary.main' }} />,
        title: skill.name,
        summary: skill.deprecated
          ? `${DEPRECATED_SKILL_LABEL}：${skill.deprecated}${skill.description ? ` ${skill.description}` : ''}`
          : skill.description || '这个技能没有提供说明。',
        metadata: '内置',
        details: [skill.environment, skill.version].filter(Boolean).join(' · ') || '未声明',
        action: (
          <Button
            size="small"
            variant="contained"
            title={enabledInProject ? '已在本项目启用；此操作将在全局启用' : '在全局启用此技能'}
            disabled={busyKey !== null || !onEnableBundled}
            onClick={() => void enableBundled(skill)}
          >
            {busyKey === key ? '正在启用…' : '启用'}
          </Button>
        )
      }
    }
    const { entry } = item
    const key = `package:${entry.id}@${entry.version}`
    const installed = installedPackageIds.has(entry.id)
    const updateAvailable = installed && updateIds.has(entry.id)
    return {
      rowKey: key,
      id: entry.id,
      icon: <ResourceIcon icon={entry.icon} kind="skill" sx={{ color: 'primary.main' }} />,
      title: entry.title,
      summary: entry.summary,
      metadata: '软件包',
      details: `v${entry.version} · ${formatPackageSize(entry.size)}`,
      action: (
        <Button
          size="small"
          variant={installed && !updateAvailable ? 'outlined' : 'contained'}
          disabled={
            (installed && !updateAvailable) ||
            busyKey !== null ||
            (updateAvailable ? !onApplyUpdate : !onInstallPackage)
          }
          onClick={() => void install(entry)}
        >
          {busyKey === key
            ? updateAvailable
              ? '正在更新…'
              : '正在安装…'
            : updateAvailable
              ? '更新'
              : installed
                ? '已安装'
                : '安装'}
        </Button>
      )
    }
  })

  return (
    <Dialog
      open={open}
      onClose={busyKey ? undefined : close}
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
        busy={busyKey !== null}
        actions={
          <Button
            size="small"
            variant="outlined"
            startIcon={<PhiIcons.entity.folder size={17} />}
            disabled={loading || busyKey !== null || !onPickRegistryDirectory || !onReadRegistry}
            onClick={() => void chooseRegistry()}
          >
            {displayedRegistryDir ? '更换目录' : '选择目录'}
          </Button>
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
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          启用 Phi 内置技能，或从本地软件包目录安装技能。安装的技能默认启用。
        </Typography>
        {error ? (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError(null)}>
            {error}
          </Alert>
        ) : null}
        {isSkillsLoading && skills.length === 0 && !selectedGroupId.startsWith('category:') ? (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', py: 2 }}>
            <CircularProgress size={18} />
            <Typography variant="body2" color="text.secondary">
              正在读取内置技能
            </Typography>
          </Stack>
        ) : null}
        {loading && selectedGroupId !== 'bundled' ? (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', py: 2 }}>
            <CircularProgress size={18} />
            <Typography variant="body2" color="text.secondary">
              正在读取本地目录
            </Typography>
          </Stack>
        ) : null}
        <CatalogResultsTable
          label="技能目录结果"
          nameLabel="技能"
          detailsLabel="环境 / 版本"
          rows={rows}
          rowAttribute="data-phi-skill-catalog-card"
        />
        {matchingItems.length === 0 && !loading && !(isSkillsLoading && skills.length === 0) ? (
          <Typography variant="body2" color="text.secondary" sx={{ py: 3 }}>
            {browser.query.trim()
              ? '没有匹配的技能，请尝试其他关键词。'
              : selectedGroupId === 'bundled'
                ? '没有待启用的内置技能'
                : displayedRegistry
                  ? '目录中没有可安装的技能包'
                  : '已知软件源中没有可安装的技能包'}
          </Typography>
        ) : null}
      </CatalogBrowseLayout>
    </Dialog>
  )
}
