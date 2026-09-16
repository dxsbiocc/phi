import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  Tooltip,
  Typography
} from '@mui/material'
import type { Theme } from '@mui/material/styles'
import { useMemo, type MouseEvent, type ReactNode } from 'react'
import type { WrapperCatalogEntry } from '../../../../shared/wrapperCatalogTypes'
import type { WrapperRun } from '../../../../shared/wrapperTypes'
import { PhiIcons } from '../../icons'
import { resolveLocalPath } from '../../lib/localPaths'
import { buildWrapperFlowGraph } from './lib/wrapperFlow'
import { runStateColor, runStateLabel, trustTierLabel } from './lib/wrapperView'
import type { LocalPathKind } from '../../components/MarkdownContent'
import { WrapperFlowDiagram } from './components/WrapperFlowDiagram'
import { useWrapperCatalog } from './hooks/useWrapperCatalog'

const AddIcon = PhiIcons.action.add
const RefreshIcon = PhiIcons.action.refresh
const ExportIcon = PhiIcons.action.download
const WrapperEntityIcon = PhiIcons.entity.wrapper

type SidebarWidth = number | string

const isMac = typeof window !== 'undefined' && window.platform === 'darwin'
const macTitlebarHeight = 44
const contentTopGap = 8
const plainSidebarRowSx = {
  alignItems: 'flex-start',
  py: 1.25,
  backgroundColor: 'transparent !important',
  '&:hover': { backgroundColor: 'transparent !important' },
  '&.Mui-selected': {
    backgroundColor: 'transparent !important',
    boxShadow: (theme: Theme) => `inset 3px 0 0 ${theme.palette.primary.main}`
  },
  '&.Mui-selected:hover': { backgroundColor: 'transparent !important' }
} as const

export interface WrapperSidebarProps {
  catalog: WrapperCatalogEntry[]
  selectedId: string | null
  isLoading: boolean
  isAdding: boolean
  sidebarWidth?: SidebarWidth
  onSelect: (entry: WrapperCatalogEntry) => void
  onRefresh: () => void
  onAddCustom: () => void
}

export interface WrapperDetailProps {
  catalog: WrapperCatalogEntry[]
  runs: WrapperRun[]
  selectedId: string | null
  error: string | null
  onOpenLocalPath?: (path: string, pathKind: LocalPathKind) => void
  onExportReproducibility?: (runId: string) => void
}

export interface WrapperViewContentProps extends WrapperDetailProps {
  isLoading: boolean
  isAdding: boolean
  sidebarWidth: number
  onSelect: (id: string) => void
  onRefresh: () => void
  onAddCustom: () => void
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

export function WrapperSidebar({
  catalog,
  selectedId,
  isLoading,
  isAdding,
  sidebarWidth = '100%',
  onSelect,
  onRefresh,
  onAddCustom
}: WrapperSidebarProps): React.JSX.Element {
  return (
    <Box
      className="app-sidebar-surface"
      sx={{
        width: sidebarWidth,
        minWidth: 0,
        flexShrink: 0,
        backgroundColor: (muiTheme) =>
          muiTheme.palette.mode === 'dark' ? muiTheme.palette.background.default : '#FFFFFF',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        pt: isMac ? `${macTitlebarHeight + contentTopGap}px` : 2,
        WebkitAppRegion: 'no-drag'
      }}
    >
      <Box sx={{ px: 2, pb: 1.5, WebkitAppRegion: 'drag' }}>
        <Stack
          direction="row"
          sx={{ mb: 1.5, alignItems: 'center', justifyContent: 'space-between' }}
        >
          <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.5 }}>
            Wrappers
          </Typography>
          <Stack direction="row" spacing={0.5}>
            <Tooltip title="添加自定义 Wrapper">
              <span>
                <IconButton
                  aria-label="添加自定义 Wrapper"
                  size="small"
                  onClick={onAddCustom}
                  disabled={isAdding}
                  sx={{ WebkitAppRegion: 'no-drag' }}
                >
                  <AddIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="刷新">
              <span>
                <IconButton
                  aria-label="刷新"
                  size="small"
                  onClick={onRefresh}
                  disabled={isLoading}
                  sx={{ WebkitAppRegion: 'no-drag' }}
                >
                  <RefreshIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        </Stack>
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
          <Chip size="small" variant="outlined" label={`${catalog.length} 个 wrapper`} />
        </Stack>
      </Box>

      <Divider />

      <List
        disablePadding
        sx={{
          overflowY: 'auto',
          flex: 1,
          py: 1,
          backgroundColor: 'transparent !important',
          WebkitAppRegion: 'no-drag'
        }}
      >
        {isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress size={20} />
          </Box>
        ) : catalog.length === 0 ? (
          <Box sx={{ px: 2, py: 2 }}>
            <Typography variant="body2" color="text.secondary">
              还没有安装任何 wrapper。
            </Typography>
          </Box>
        ) : (
          catalog.map((entry) => (
            <ListItemButton
              key={`${entry.manifest.id}@${entry.manifest.version}`}
              selected={entry.manifest.id === selectedId}
              onClick={() => onSelect(entry)}
              sx={{ ...plainSidebarRowSx, py: 0.75 }}
            >
              <Box
                sx={{
                  width: 26,
                  height: 26,
                  mr: 1,
                  mt: 0.125,
                  borderRadius: 0.75,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: 'primary.main',
                  color: 'primary.contrastText',
                  flexShrink: 0
                }}
              >
                <WrapperEntityIcon sx={{ fontSize: 15 }} />
              </Box>
              <ListItemText
                // The canonical id, not the author-chosen display name, is the
                // trustworthy identifier — a manifest's `name` is free text and
                // could be set to anything, including something misleading
                // about which wrapper this actually is.
                primary={entry.manifest.id}
                secondary={`${entry.manifest.name} · v${entry.manifest.version} · ${trustTierLabel(entry.trustTier)}`}
                slotProps={{
                  primary: {
                    noWrap: true,
                    sx: { fontFamily: 'var(--font-mono)', fontSize: '0.82rem', fontWeight: 600 }
                  },
                  secondary: { noWrap: true, sx: { fontSize: '0.75rem' } }
                }}
              />
            </ListItemButton>
          ))
        )}
      </List>
    </Box>
  )
}

export function WrapperDetail({
  catalog,
  runs,
  selectedId,
  error,
  onOpenLocalPath,
  onExportReproducibility
}: WrapperDetailProps): React.JSX.Element {
  const selected = useMemo(
    () => catalog.find((entry) => entry.manifest.id === selectedId),
    [catalog, selectedId]
  )
  const selectedRuns = useMemo(
    () => runs.filter((run) => run.wrapper.canonicalId === selectedId),
    [runs, selectedId]
  )
  const graph = useMemo(
    () =>
      selected
        ? buildWrapperFlowGraph({ name: selected.manifest.name, steps: selected.manifest.steps })
        : undefined,
    [selected]
  )

  return (
    <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
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
        <Box sx={{ maxWidth: 860, px: { xs: 3, md: 5 }, pt: 3, pb: 5 }}>
          <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
            <Box
              sx={{
                width: 72,
                height: 72,
                borderRadius: 1,
                bgcolor: 'primary.main',
                color: 'primary.contrastText',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0
              }}
            >
              <WrapperEntityIcon />
            </Box>
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography variant="h4" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
                {selected.manifest.name}
              </Typography>
              {/* The canonical id, not the display name above, is what actually
                  identifies this wrapper — keep it visible right next to the name. */}
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ fontFamily: 'var(--font-mono)', display: 'block' }}
              >
                {selected.manifest.id}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                {selected.manifest.summary}
              </Typography>
              <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: 'wrap', rowGap: 1 }}>
                <Chip size="small" label={`v${selected.manifest.version}`} />
                <Chip
                  size="small"
                  label={trustTierLabel(selected.trustTier)}
                  color={selected.trustTier === 'bundled' ? 'primary' : 'default'}
                />
                <Chip size="small" variant="outlined" label={selected.manifest.resourceClass} />
              </Stack>
            </Box>
          </Stack>

          <Divider sx={{ my: 4 }} />

          <Typography variant="h6" sx={{ fontWeight: 700, mb: 1.5 }}>
            结构
          </Typography>
          {graph && <WrapperFlowDiagram graph={graph} height={180} />}

          <Divider sx={{ my: 4 }} />

          <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>
            输入
          </Typography>
          {selected.manifest.inputs.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              无
            </Typography>
          ) : (
            selected.manifest.inputs.map((input) => (
              <Typography key={input.id} variant="body2" color="text.secondary">
                {input.id} ({input.type}
                {input.required ? '，必填' : ''})
              </Typography>
            ))
          )}

          <Typography variant="h6" sx={{ fontWeight: 700, mt: 3, mb: 1 }}>
            输出
          </Typography>
          {selected.manifest.outputs.map((output) => (
            <Typography key={output.id} variant="body2" color="text.secondary">
              {output.label} — {output.path}
              {output.primary ? '（主要）' : ''}
            </Typography>
          ))}

          <Typography variant="h6" sx={{ fontWeight: 700, mt: 3, mb: 1 }}>
            Profile（本地）
          </Typography>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
            {selected.manifest.engine.profiles
              .filter((profile) => profile.executor === 'local')
              .map((profile) => (
                <Chip key={profile.id} size="small" variant="outlined" label={profile.id} />
              ))}
          </Stack>

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
                  <Stack key={run.runId} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <Chip
                      size="small"
                      label={runStateLabel(run.state)}
                      color={runStateColor(run.state)}
                    />
                    <Typography variant="body2" color="text.secondary">
                      {run.runId}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {new Date(run.createdAt).toLocaleString()}
                    </Typography>
                    <Box sx={{ flex: 1 }} />
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
                    <Button
                      size="small"
                      onClick={() => {
                        const absolutePath = resolveLocalPath(
                          run.outDir.startsWith('/') ? run.outDir : `./${run.outDir}`,
                          run.cwd
                        )
                        if (absolutePath) onOpenLocalPath?.(absolutePath, 'directory')
                      }}
                    >
                      打开输出目录
                    </Button>
                  </Stack>
                ))}
            </Stack>
          )}
        </Box>
      )}
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
  isAdding,
  sidebarWidth,
  onSelect,
  onRefresh,
  onAddCustom,
  onOpenLocalPath,
  onExportReproducibility,
  onStartSidebarResize
}: WrapperViewContentProps): React.JSX.Element {
  const selected = catalog.find((entry) => entry.manifest.id === selectedId) ?? null

  return (
    <>
      <WrapperSidebar
        catalog={catalog}
        selectedId={selectedId}
        isLoading={isLoading}
        isAdding={isAdding}
        sidebarWidth={sidebarWidth}
        onSelect={(entry) => onSelect(entry.manifest.id)}
        onRefresh={onRefresh}
        onAddCustom={onAddCustom}
      />
      <ResizeSeparator onMouseDown={onStartSidebarResize} />
      <DetailPage title={selected?.manifest.name ?? 'Wrappers'}>
        <WrapperDetail
          catalog={catalog}
          runs={runs}
          selectedId={selectedId}
          error={error}
          onOpenLocalPath={onOpenLocalPath}
          onExportReproducibility={onExportReproducibility}
        />
      </DetailPage>
    </>
  )
}

interface WrapperViewProps {
  sidebarWidth: number
  onOpenLocalPath?: (path: string, pathKind: LocalPathKind) => void
  onStartSidebarResize?: (event: MouseEvent<HTMLDivElement>) => void
}

export default function WrapperView({
  sidebarWidth,
  onOpenLocalPath,
  onStartSidebarResize
}: WrapperViewProps): React.JSX.Element {
  const {
    catalog,
    runs,
    selectedWrapperId,
    isLoadingWrappers,
    wrapperError,
    isAddingWrapper,
    setSelectedWrapperId,
    refreshWrappers,
    addCustomWrapper,
    exportWrapperReproducibility
  } = useWrapperCatalog()

  return (
    <WrapperViewContent
      catalog={catalog}
      runs={runs}
      selectedId={selectedWrapperId}
      isLoading={isLoadingWrappers}
      error={wrapperError}
      isAdding={isAddingWrapper}
      sidebarWidth={sidebarWidth}
      onSelect={setSelectedWrapperId}
      onRefresh={() => void refreshWrappers()}
      onAddCustom={() => void addCustomWrapper()}
      onOpenLocalPath={onOpenLocalPath}
      onExportReproducibility={(runId) => void exportWrapperReproducibility(runId)}
      onStartSidebarResize={onStartSidebarResize}
    />
  )
}
