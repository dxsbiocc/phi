import { Alert, Box, Button, Chip, IconButton, Stack, Tooltip, Typography } from '@mui/material'
import { useMemo, type MouseEvent, type ReactNode } from 'react'
import type { WrapperCompositionCatalogItem } from '../../../../shared/wrapperCompositionManifestTypes'
import type { WrapperRun } from '../../../../shared/wrapperTypes'
import type { Project, ProjectRemoteConnection } from '../../types'
import { PhiIcons } from '../../icons'
import { WrapperDetailBody } from './components/WrapperDetailBody'
import { useWrapperDetailData } from './hooks/useWrapperDetailData'
import { WrapperPackageRail } from './components/WrapperPackageRail'
import { isManagedWrapper, wrapperFamilyName, wrapperPackageKey } from './lib/wrapperFamily'
import { wrapperPackageMembers } from './lib/wrapperPackageDetail'
import {
  canCancelBackgroundRun,
  runProgressLabel,
  runStateColor,
  runStateLabel
} from './lib/wrapperView'
import type { LocalPathKind } from '../../components/MarkdownContent'
import { WrapperRunResultActions } from './components/WrapperRunResultActions'
import { WrapperExecutionTargetControl } from './components/WrapperExecutionTargetControl'
import { WrapperPackageControl } from './components/WrapperPackageControl'
import { useWrapperCatalog } from './hooks/useWrapperCatalog'
import { WrapperSidebar } from './components/WrapperSidebar'
export { WrapperSidebar, type WrapperSidebarProps } from './components/WrapperSidebar'

const ExportIcon = PhiIcons.action.download

const macTitlebarHeight = 44
export interface WrapperDetailProps {
  catalog: WrapperCompositionCatalogItem[]
  runs: WrapperRun[]
  selectedId: string | null
  error: string | null
  onOpenLocalPath?: (path: string, pathKind: LocalPathKind) => void
  onOpenRemoteResult?: (run: WrapperRun, path: string, pathKind: LocalPathKind) => void
  onExportReproducibility?: (runId: string) => void
  onCancelRun?: (runId: string) => void
  packageEnablementBusy?: boolean
  onSetPackageEnabled?: (packageId: string, enabled: boolean) => Promise<boolean | void> | void
  project?: Project
  updatingRemoteProjectId?: string | null
  onUpdateProjectRemoteConnection?: (
    projectId: string,
    connectionId: string,
    patch: ProjectRemoteConnection
  ) => Promise<void>
  onUpdateProjectRemoteDefaults?: (
    projectId: string,
    defaults: { defaultRemoteConnectionId?: string | null; remoteWorkspaceRoot?: string | null }
  ) => Promise<void>
  onOpenRemoteSettings?: () => void
  /** Switch to another wrapper of the same package from the tool list. */
  onSelectWrapper?: (entry: WrapperCompositionCatalogItem) => void
}

export interface WrapperViewContentProps extends WrapperDetailProps {
  isLoading: boolean
  sidebarWidth: number
  onSelect: (id: string) => void
  onRefresh: () => Promise<void> | void
  busyPackageId?: string | null
  onStartSidebarResize?: (event: MouseEvent<HTMLDivElement>) => void
}

function ResizeSeparator({
  onMouseDown
}: {
  onMouseDown?: (event: MouseEvent<HTMLDivElement>) => void
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
        bgcolor: (muiTheme) =>
          muiTheme.palette.mode === 'dark' ? 'rgba(241, 246, 246, 0.18)' : 'rgba(15, 42, 48, 0.18)',
        zIndex: 5,
        WebkitAppRegion: 'no-drag',
        '&::before': {
          content: '""',
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: -4,
          right: -4
        }
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
          height: macTitlebarHeight,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          px: 2,
          borderBottom: 1,
          borderColor: 'divider',
          backgroundColor: (muiTheme) =>
            muiTheme.palette.mode === 'dark' ? muiTheme.palette.background.default : '#FFFFFF',
          WebkitAppRegion: 'drag',
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

export function WrapperDetail({
  catalog,
  runs,
  selectedId,
  error,
  onOpenLocalPath,
  onOpenRemoteResult,
  onExportReproducibility,
  onCancelRun,
  packageEnablementBusy,
  onSetPackageEnabled,
  project,
  updatingRemoteProjectId,
  onUpdateProjectRemoteConnection,
  onUpdateProjectRemoteDefaults,
  onOpenRemoteSettings,
  onSelectWrapper
}: WrapperDetailProps): React.JSX.Element {
  const selected = useMemo(
    () => catalog.find((entry) => entry.id === selectedId),
    [catalog, selectedId]
  )
  const selectedRuns = useMemo(
    () => runs.filter((run) => run.wrapper.canonicalId === selectedId),
    [runs, selectedId]
  )
  const detailData = useWrapperDetailData(selected)
  const packageKey =
    selected && isManagedWrapper(selected) ? wrapperPackageKey(selected) : undefined
  const siblings = useMemo(
    () => (packageKey ? wrapperPackageMembers(catalog, packageKey) : []),
    [catalog, packageKey]
  )

  return (
    <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
      {packageKey && siblings.length > 1 && onSelectWrapper ? (
        <WrapperPackageRail
          familyName={wrapperFamilyName(packageKey)}
          members={siblings}
          selectedId={selectedId}
          onSelect={onSelectWrapper}
        />
      ) : null}
      <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto' }}>
        {error && (
          <Alert severity="error" sx={{ m: 3, mb: 0 }}>
            {error}
          </Alert>
        )}

        {!selected ? (
          <Box sx={{ px: { xs: 3, md: 5 }, pt: 3 }}>
            <Typography variant="body2" color="text.secondary">
              从左侧选择一个 wrapper 查看详情。
            </Typography>
          </Box>
        ) : (
          <Box sx={{ maxWidth: 860, mx: 'auto', px: { xs: 3, md: 5 }, pt: 3, pb: 5 }}>
            <WrapperDetailBody
              manifest={selected}
              icon={selected.icon}
              graph={detailData.graph}
              moduleDetails={detailData.moduleDetails}
              identityExtras={
                <WrapperPackageControl
                  wrapper={selected}
                  busy={packageEnablementBusy}
                  onSetEnabled={onSetPackageEnabled}
                />
              }
              afterIdentity={
                project ? (
                  <Box sx={{ mt: 2 }}>
                    <WrapperExecutionTargetControl
                      project={project}
                      busy={updatingRemoteProjectId === project.id}
                      onUpdateRemoteConnection={onUpdateProjectRemoteConnection}
                      onUpdateRemoteDefaults={onUpdateProjectRemoteDefaults}
                      onOpenRemoteSettings={onOpenRemoteSettings}
                    />
                  </Box>
                ) : null
              }
            >
              <Typography variant="h6" sx={{ fontWeight: 700, mt: 3, mb: 1 }}>
                运行记录
              </Typography>
              {selectedRuns.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  还没有运行记录。
                </Typography>
              ) : (
                <Stack spacing={0.75}>
                  {selectedRuns
                    .slice()
                    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                    .map((run) => (
                      <Stack
                        key={run.runId}
                        direction="row"
                        spacing={1}
                        sx={{ alignItems: 'center' }}
                      >
                        <Chip
                          size="small"
                          label={runStateLabel(run.state)}
                          color={runStateColor(run.state)}
                        />
                        <Typography variant="body2" color="text.secondary">
                          {run.runId}
                        </Typography>
                        {run.remote ? (
                          <Typography variant="caption" color="text.secondary">
                            SSH {run.remote.host}
                          </Typography>
                        ) : null}
                        <Typography variant="caption" color="text.secondary">
                          {new Date(run.createdAt).toLocaleString()}
                        </Typography>
                        {runProgressLabel(run) ? (
                          <Typography variant="caption" color="text.secondary">
                            {runProgressLabel(run)}
                          </Typography>
                        ) : null}
                        <Box sx={{ flex: 1 }} />
                        {canCancelBackgroundRun(run) ? (
                          <Button
                            size="small"
                            color="error"
                            aria-label="取消运行"
                            onClick={() => onCancelRun?.(run.runId)}
                          >
                            取消运行
                          </Button>
                        ) : null}
                        <Tooltip title="导出可复现性元数据">
                          <span>
                            <IconButton
                              aria-label="导出可复现性元数据"
                              size="small"
                              onClick={() => onExportReproducibility?.(run.runId)}
                            >
                              <ExportIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                        <WrapperRunResultActions
                          run={run}
                          onOpenLocalPath={onOpenLocalPath}
                          onOpenRemoteResult={onOpenRemoteResult}
                        />
                      </Stack>
                    ))}
                </Stack>
              )}
            </WrapperDetailBody>
          </Box>
        )}
      </Box>
    </Box>
  )
}

/**
 * Pure presentational wrapper view — takes catalog/run data as props instead
 * of fetching it itself, so it renders synchronously and is directly testable.
 */
export function WrapperViewContent({
  catalog,
  runs,
  selectedId,
  isLoading,
  error,
  sidebarWidth,
  onSelect,
  onRefresh,
  onOpenLocalPath,
  onOpenRemoteResult,
  onExportReproducibility,
  onCancelRun,
  packageEnablementBusy,
  busyPackageId,
  onSetPackageEnabled,
  project,
  updatingRemoteProjectId,
  onUpdateProjectRemoteConnection,
  onUpdateProjectRemoteDefaults,
  onOpenRemoteSettings,
  onStartSidebarResize
}: WrapperViewContentProps): React.JSX.Element {
  const selected = catalog.find((entry) => entry.id === selectedId) ?? null

  return (
    <>
      <WrapperSidebar
        catalog={catalog}
        selectedId={selectedId}
        isLoading={isLoading}
        sidebarWidth={sidebarWidth}
        onSelect={(entry) => onSelect(entry.id)}
        onRefresh={onRefresh}
        busyPackageId={busyPackageId}
        onSetPackageEnabled={onSetPackageEnabled}
      />
      <ResizeSeparator onMouseDown={onStartSidebarResize} />
      <DetailPage title={selected?.name ?? 'Wrappers'}>
        <WrapperDetail
          catalog={catalog}
          runs={runs}
          selectedId={selectedId}
          error={error}
          onOpenLocalPath={onOpenLocalPath}
          onOpenRemoteResult={onOpenRemoteResult}
          onExportReproducibility={onExportReproducibility}
          onCancelRun={onCancelRun}
          packageEnablementBusy={packageEnablementBusy}
          onSetPackageEnabled={onSetPackageEnabled}
          project={project}
          updatingRemoteProjectId={updatingRemoteProjectId}
          onUpdateProjectRemoteConnection={onUpdateProjectRemoteConnection}
          onUpdateProjectRemoteDefaults={onUpdateProjectRemoteDefaults}
          onOpenRemoteSettings={onOpenRemoteSettings}
          onSelectWrapper={(entry) => onSelect(entry.id)}
        />
      </DetailPage>
    </>
  )
}

interface WrapperViewProps {
  sidebarWidth: number
  onOpenLocalPath?: (path: string, pathKind: LocalPathKind) => void
  onOpenRemoteResult?: (run: WrapperRun, path: string, pathKind: LocalPathKind) => void
  onStartSidebarResize?: (event: MouseEvent<HTMLDivElement>) => void
}

export default function WrapperView({
  sidebarWidth,
  onOpenLocalPath,
  onOpenRemoteResult,
  onStartSidebarResize
}: WrapperViewProps): React.JSX.Element {
  const {
    catalog,
    runs,
    selectedWrapperId,
    isLoadingWrappers,
    wrapperError,
    setSelectedWrapperId,
    refreshWrappers,
    exportWrapperReproducibility,
    packageEnablementBusy,
    busyPackageId,
    setPackageEnabled
  } = useWrapperCatalog()

  return (
    <WrapperViewContent
      catalog={catalog}
      runs={runs}
      selectedId={selectedWrapperId}
      isLoading={isLoadingWrappers}
      error={wrapperError}
      sidebarWidth={sidebarWidth}
      onSelect={setSelectedWrapperId}
      onRefresh={refreshWrappers}
      onOpenLocalPath={onOpenLocalPath}
      onOpenRemoteResult={onOpenRemoteResult}
      onExportReproducibility={(runId) => void exportWrapperReproducibility(runId)}
      packageEnablementBusy={packageEnablementBusy}
      busyPackageId={busyPackageId}
      onSetPackageEnabled={setPackageEnabled}
      onStartSidebarResize={onStartSidebarResize}
    />
  )
}
