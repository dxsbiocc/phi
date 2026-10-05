import { Fragment, useState, type MouseEvent, type ReactNode } from 'react'
import { Box, Typography } from '@mui/material'
import type {
  PackageRegistryEntryView,
  PackageRegistryView
} from '../../../../shared/packageManagerTypes'
import type { SkillSummary } from '../../types'
import { SkillCatalogDialog, type SkillCatalogDialogProps } from './components/SkillCatalogDialog'
import { SkillDetail, type SkillDetailProps } from './components/SkillDetail'
import { SkillSidebar, type SkillSidebarProps } from './components/SkillSidebar'

export { SkillCatalogDialog, SkillDetail, SkillSidebar }
export type { SkillCatalogDialogProps, SkillDetailProps, SkillSidebarProps }

export type SkillViewProps = {
  skills: SkillSummary[]
  isLoading: boolean
  activeSkillId: string | null
  sidebarWidth: number
  onSelectSkill: (id: string) => void
  onStartSidebarResize: (event: MouseEvent<HTMLDivElement>) => void
  busySkillId?: string | null
  projectCwd?: string | null
  onSetGlobalEnabled?: (skill: SkillSummary, enabled: boolean) => Promise<void> | void
  onSetProjectOverride?: (skill: SkillSummary, value: boolean | null) => Promise<void> | void
  onNavigateToPlugin?: (pluginId: string) => void
  onSetSkillDisabled?: (skill: SkillSummary, disabled: boolean) => Promise<void> | void
  onDeleteSkill?: (skill: SkillSummary) => Promise<void> | void
  registry?: PackageRegistryView | null
  registryDir?: string | null
  isRegistryLoading?: boolean
  registryError?: string | null
  onPickRegistryDirectory?: () => Promise<string | null>
  onReadRegistry?: (dir: string) => Promise<PackageRegistryView>
  onInstallPackage?: (registryDir: string, entry: PackageRegistryEntryView) => Promise<void> | void
  onRefresh?: () => Promise<void> | void
}

const isMac = typeof window !== 'undefined' && window.platform === 'darwin'
const MAC_TITLEBAR_HEIGHT = 44

function ResizeSeparator({
  onMouseDown
}: {
  onMouseDown: (event: MouseEvent<HTMLDivElement>) => void
}): React.JSX.Element {
  return (
    <Box
      role="separator"
      aria-orientation="vertical"
      aria-label="调整侧边栏宽度"
      onMouseDown={onMouseDown}
      sx={{
        width: '1px',
        flexShrink: 0,
        position: 'relative',
        cursor: 'col-resize',
        bgcolor: (theme) =>
          theme.palette.mode === 'dark' ? 'rgba(241, 246, 246, 0.18)' : 'rgba(15, 42, 48, 0.18)',
        zIndex: 5,
        WebkitAppRegion: 'no-drag',
        '&::before': { content: '""', position: 'absolute', top: 0, bottom: 0, left: -4, right: -4 }
      }}
    />
  )
}

function DetailPage({
  title,
  children
}: {
  title: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <Box
      component="main"
      sx={{
        flex: 1,
        minWidth: 0,
        height: '100vh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      <Box
        sx={{
          height: MAC_TITLEBAR_HEIGHT,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          px: 2,
          borderBottom: 1,
          borderColor: 'divider',
          backgroundColor: (theme) =>
            theme.palette.mode === 'dark' ? theme.palette.background.default : '#FFFFFF',
          WebkitAppRegion: isMac ? 'drag' : 'no-drag',
          zIndex: 7
        }}
      >
        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
      </Box>
      {children}
    </Box>
  )
}

export default function SkillView({
  skills,
  isLoading,
  activeSkillId,
  sidebarWidth,
  onSelectSkill,
  onStartSidebarResize,
  busySkillId,
  projectCwd,
  onSetGlobalEnabled,
  onSetProjectOverride,
  onNavigateToPlugin,
  onSetSkillDisabled,
  onDeleteSkill,
  registry,
  registryDir,
  isRegistryLoading,
  registryError,
  onPickRegistryDirectory,
  onReadRegistry,
  onInstallPackage,
  onRefresh
}: SkillViewProps): React.JSX.Element {
  const [catalogOpen, setCatalogOpen] = useState(false)
  const selectedSkill = skills.find((skill) => skill.id === activeSkillId) ?? null
  const enableBundled = onSetGlobalEnabled
    ? (skill: SkillSummary) => onSetGlobalEnabled(skill, true)
    : onSetSkillDisabled
      ? (skill: SkillSummary) => onSetSkillDisabled(skill, false)
      : undefined

  return (
    <Fragment>
      <SkillSidebar
        skills={skills}
        isLoading={isLoading}
        activeSkillId={activeSkillId}
        sidebarWidth={sidebarWidth}
        busySkillId={busySkillId}
        onSelectSkill={(skill) => onSelectSkill(skill.id)}
        onSetEnabled={
          onSetGlobalEnabled || onSetSkillDisabled || onSetProjectOverride
            ? (skill, enabled) =>
                skill.projectOverride != null && projectCwd
                  ? onSetProjectOverride?.(skill, enabled)
                  : onSetGlobalEnabled
                    ? onSetGlobalEnabled(skill, enabled)
                    : onSetSkillDisabled?.(skill, !enabled)
            : undefined
        }
        onOpenCatalog={() => setCatalogOpen(true)}
      />
      <ResizeSeparator onMouseDown={onStartSidebarResize} />
      <DetailPage title={selectedSkill?.name ?? '技能'}>
        <SkillDetail
          selectedSkill={selectedSkill}
          busySkillId={busySkillId}
          projectCwd={projectCwd}
          onSetGlobalEnabled={onSetGlobalEnabled}
          onSetProjectOverride={onSetProjectOverride}
          onNavigateToPlugin={onNavigateToPlugin}
          onSetSkillDisabled={onSetSkillDisabled}
          onDeleteSkill={onDeleteSkill}
        />
      </DetailPage>
      <SkillCatalogDialog
        open={catalogOpen}
        skills={skills}
        isSkillsLoading={isLoading}
        registry={registry}
        registryDir={registryDir}
        isRegistryLoading={isRegistryLoading}
        registryError={registryError}
        onClose={() => setCatalogOpen(false)}
        onEnableBundled={enableBundled}
        onPickRegistryDirectory={onPickRegistryDirectory}
        onReadRegistry={onReadRegistry}
        onInstallPackage={onInstallPackage}
        onRefresh={onRefresh}
      />
    </Fragment>
  )
}
