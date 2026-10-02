import { useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  Divider,
  IconButton,
  Stack,
  Typography
} from '@mui/material'
import type {
  PackageRegistryEntryView,
  PackageRegistryView
} from '../../../../../shared/packageManagerTypes'
import { PhiIcons } from '../../../icons'
import type { SkillSummary } from '../../../types'
import { bundledCatalogSkills, formatPackageSize, registrySkillPackages } from '../lib/skillCatalog'

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
  onRefresh?: () => Promise<void> | void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function CatalogSection({
  title,
  description,
  children
}: {
  title: string
  description: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Box component="section">
      <Typography variant="h6" sx={{ fontWeight: 700 }}>
        {title}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
        {description}
      </Typography>
      {children}
    </Box>
  )
}

function CatalogCard({
  title,
  summary,
  metadata,
  action
}: {
  title: string
  summary: string
  metadata: string
  action: React.ReactNode
}): React.JSX.Element {
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 2 }}>
      <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
        <Box
          sx={{
            width: 42,
            height: 42,
            borderRadius: 1.5,
            bgcolor: 'action.hover',
            color: 'primary.main',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0
          }}
        >
          <PhiIcons.entity.skill size={22} />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontWeight: 700 }}>{title}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
            {summary}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.75, display: 'block' }}>
            {metadata}
          </Typography>
        </Box>
        {action}
      </Stack>
    </Box>
  )
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
  onRefresh
}: SkillCatalogDialogProps): React.JSX.Element {
  const [localRegistry, setLocalRegistry] = useState<PackageRegistryView | null>(null)
  const [localRegistryDir, setLocalRegistryDir] = useState<string | null>(null)
  const [loadingRegistry, setLoadingRegistry] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [installedDuringSession, setInstalledDuringSession] = useState<Set<string>>(new Set())

  const displayedRegistry = registry === undefined ? localRegistry : registry
  const displayedRegistryDir = registryDir === undefined ? localRegistryDir : registryDir
  const bundledSkills = useMemo(() => bundledCatalogSkills(skills), [skills])
  const packages = useMemo(() => registrySkillPackages(displayedRegistry), [displayedRegistry])
  const installedPackageIds = useMemo(() => {
    const ids = new Set(installedDuringSession)
    for (const skill of skills) {
      if (skill.sourceCategory === 'installed-package') ids.add(skill.sourceId ?? skill.name)
    }
    return ids
  }, [installedDuringSession, skills])
  const loading = loadingRegistry || isRegistryLoading
  const error = actionError ?? registryError

  function close(): void {
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

  async function install(entry: PackageRegistryEntryView): Promise<void> {
    if (!onInstallPackage || !displayedRegistryDir) return
    const key = `package:${entry.id}@${entry.version}`
    setBusyKey(key)
    setActionError(null)
    try {
      await onInstallPackage(displayedRegistryDir, entry)
      setInstalledDuringSession((current) => new Set(current).add(entry.id))
      await onRefresh?.()
    } catch (cause) {
      setActionError(`安装技能包失败：${errorMessage(cause)}`)
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={busyKey ? undefined : close}
      maxWidth={false}
      slotProps={{
        paper: {
          sx: {
            width: 'min(920px, calc(100vw - 80px))',
            height: 'min(720px, calc(100vh - 80px))',
            maxHeight: 'calc(100vh - 80px)',
            borderRadius: 2,
            overflow: 'hidden'
          }
        }
      }}
    >
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center', px: 3, py: 2.5 }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5" sx={{ fontWeight: 700 }}>
            从目录添加
          </Typography>
          <Typography variant="body2" color="text.secondary">
            启用 Phi 内置技能，或从您选择的本地软件包目录安装技能。
          </Typography>
        </Box>
        <Button
          variant="outlined"
          startIcon={<PhiIcons.entity.folder size={17} />}
          disabled={loading || busyKey !== null || !onPickRegistryDirectory || !onReadRegistry}
          onClick={() => void chooseRegistry()}
        >
          {displayedRegistryDir ? '更换目录' : '选择目录'}
        </Button>
        <IconButton aria-label="关闭技能目录" disabled={busyKey !== null} onClick={close}>
          <PhiIcons.action.close size={18} />
        </IconButton>
      </Stack>
      <Divider />

      <Box sx={{ flex: 1, overflowY: 'auto', px: 3, py: 3 }}>
        {error ? (
          <Alert severity="error" sx={{ mb: 3 }} onClose={() => setActionError(null)}>
            {error}
          </Alert>
        ) : null}

        <CatalogSection
          title="内置技能"
          description="这些技能已随 Phi 安装；添加只会启用它们，不会改写任何文件。"
        >
          {isSkillsLoading && skills.length === 0 ? (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', py: 2 }}>
              <CircularProgress size={18} />
              <Typography variant="body2" color="text.secondary">
                正在读取内置技能
              </Typography>
            </Stack>
          ) : bundledSkills.length > 0 ? (
            <Stack spacing={1.25}>
              {bundledSkills.map((skill) => {
                const key = `bundled:${skill.name}`
                return (
                  <CatalogCard
                    key={skill.id}
                    title={skill.name}
                    summary={skill.description || '这个技能没有提供说明。'}
                    metadata="内置 · 默认关闭"
                    action={
                      <Button
                        size="small"
                        variant="contained"
                        disabled={busyKey !== null || !onEnableBundled}
                        onClick={() => void enableBundled(skill)}
                      >
                        {busyKey === key ? '正在启用…' : '启用'}
                      </Button>
                    }
                  />
                )
              })}
            </Stack>
          ) : (
            <Typography variant="body2" color="text.secondary">
              没有待启用的内置技能
            </Typography>
          )}
        </CatalogSection>

        <Divider sx={{ my: 4 }} />
        <CatalogSection
          title="本地软件包"
          description="选择包含 index.json 的本地 registry 目录。安装的技能默认启用。"
        >
          {loading ? (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', py: 2 }}>
              <CircularProgress size={18} />
              <Typography variant="body2" color="text.secondary">
                正在读取本地目录
              </Typography>
            </Stack>
          ) : !displayedRegistry ? (
            <Typography variant="body2" color="text.secondary">
              尚未选择本地目录
            </Typography>
          ) : packages.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              目录中没有可安装的技能包
            </Typography>
          ) : (
            <Stack spacing={1.25}>
              {packages.map((entry) => {
                const key = `package:${entry.id}@${entry.version}`
                const installed = installedPackageIds.has(entry.id)
                return (
                  <CatalogCard
                    key={`${entry.id}@${entry.version}`}
                    title={entry.title}
                    summary={entry.summary}
                    metadata={`v${entry.version} · ${formatPackageSize(entry.size)}`}
                    action={
                      <Button
                        size="small"
                        variant={installed ? 'outlined' : 'contained'}
                        disabled={installed || busyKey !== null || !onInstallPackage}
                        onClick={() => void install(entry)}
                      >
                        {installed ? '已安装' : busyKey === key ? '正在安装…' : '安装'}
                      </Button>
                    }
                  />
                )
              })}
            </Stack>
          )}
        </CatalogSection>
      </Box>
    </Dialog>
  )
}
