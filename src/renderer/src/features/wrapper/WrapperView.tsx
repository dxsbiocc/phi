import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  IconButton,
  Link,
  Stack,
  Tooltip,
  Typography
} from '@mui/material'
import { type Theme } from '@mui/material/styles'
import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import type { WrapperCompositionCatalogItem } from '../../../../shared/wrapperCompositionManifestTypes'
import type { WrapperModuleDetails } from '../../../../shared/wrapperModuleDetailsTypes'
import type { WrapperRun } from '../../../../shared/wrapperTypes'
import type { Project, ProjectRemoteConnection } from '../../types'
import { PhiIcons } from '../../icons'
import { ResourceIcon } from '../../components/ResourceIcon'
import { buildWrapperParamsFlowGraph } from './lib/wrapperFlow'
import { parseWrapperNextflowDag } from './lib/wrapperNextflowDag'
import { highlightLine } from '../../lib/syntaxHighlight'
import { syntaxTokenColor } from '../../lib/syntaxTheme'
import {
  canCancelBackgroundRun,
  parseWrapperCompositionId,
  runProgressLabel,
  runStateColor,
  runStateLabel,
  wrapperProviderColor,
  wrapperTierLabel
} from './lib/wrapperView'
import type { LocalPathKind } from '../../components/MarkdownContent'
import { WrapperFlowDiagram } from './components/WrapperFlowDiagram'
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

/**
 * Renders raw text with this app's own YAML tokenizer (`syntaxHighlight.ts`)
 * — not a parsed/summarized view: `environment.yml` shows exactly what's on
 * disk, whatever fields it actually has, rather than only the
 * `channels`/`dependencies` shape this component happened to expect.
 */
function WrapperYamlBlock({ yaml }: { yaml: string }): React.JSX.Element {
  const lines = useMemo(() => yaml.replace(/\n$/, '').split('\n'), [yaml])
  return (
    <Box
      sx={{
        bgcolor: 'background.default',
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        p: 1.5,
        overflow: 'auto',
        fontFamily: 'var(--font-mono)',
        fontSize: '0.8rem',
        lineHeight: 1.6
      }}
    >
      {lines.map((line, index) => (
        <Box key={index} sx={{ whiteSpace: 'pre' }}>
          {highlightLine(line, 'yaml').map((token, tokenIndex) => (
            <Box
              key={tokenIndex}
              component="span"
              sx={{ color: (theme: Theme) => syntaxTokenColor(theme, token.kind) }}
            >
              {token.value}
            </Box>
          ))}
        </Box>
      ))}
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
  onOpenRemoteSettings
}: WrapperDetailProps): React.JSX.Element {
  const selected = useMemo(
    () => catalog.find((entry) => entry.id === selectedId),
    [catalog, selectedId]
  )
  const selectedRuns = useMemo(
    () => runs.filter((run) => run.wrapper.canonicalId === selectedId),
    [runs, selectedId]
  )
  const tier = selected ? parseWrapperCompositionId(selected.id).tier : ''
  const params = useMemo(() => (selected ? Object.entries(selected.params) : []), [selected])
  const inputParams = useMemo(() => params.filter(([, param]) => param.kind === 'input'), [params])
  const optionParams = useMemo(
    () => params.filter(([, param]) => param.kind === 'option'),
    [params]
  )
  const outputs = useMemo(() => (selected ? Object.entries(selected.outputs) : []), [selected])
  const paramsGraph = useMemo(
    // Built from the wrapper's own declared params/outputs — its real,
    // user-facing contract — not Nextflow's internal process signature.
    // See buildWrapperParamsFlowGraph's own doc comment for why those two
    // can genuinely disagree (a module's process can take extra channels
    // the wrapper hardcodes off).
    () =>
      selected
        ? buildWrapperParamsFlowGraph({
            name: selected.name,
            inputLabels: inputParams.map(([key]) => key),
            outputLabels: outputs.map(([key]) => key)
          })
        : undefined,
    [selected, inputParams, outputs]
  )
  // Only "workflows" (a complete multi-process pipeline) benefits from the
  // real Nextflow DAG: it has no small enumerable params that represent its
  // internal structure the way a module's do, so the params-graph above
  // would just be a handful of top-level pipeline options, not a structure
  // view at all. Keyed by the id the fetch was made for, so a still-in-flight
  // fetch from a previously-selected wrapper never applies once selection
  // moves on (react-hooks/set-state-in-effect wants setState in the async
  // callback, not synchronously at the top of the effect).
  const [dagResult, setDagResult] = useState<{ id: string; source: string | undefined }>()
  useEffect(() => {
    if (!selectedId || tier !== 'workflows') return undefined
    let cancelled = false
    void window.api
      .getWrapperCompositionDag(selectedId)
      .then((dag) => {
        if (!cancelled) setDagResult({ id: selectedId, source: dag })
      })
      .catch(() => {
        if (!cancelled) setDagResult({ id: selectedId, source: undefined })
      })
    return () => {
      cancelled = true
    }
  }, [selectedId, tier])
  const dagSource =
    tier === 'workflows' && dagResult?.id === selectedId ? dagResult.source : undefined
  // Nextflow's raw dag.mmd is mostly channel/value plumbing (`channel.empty`,
  // merge points, …) — parseWrapperNextflowDag collapses all of that down to
  // real processes and the direct dependencies between them. Falls back to
  // the params-graph above if parsing finds no processes (e.g. dag.mmd
  // failed to generate for this wrapper).
  const graph = useMemo(
    () => (dagSource ? parseWrapperNextflowDag(dagSource) : undefined) ?? paramsGraph,
    [dagSource, paramsGraph]
  )
  const [moduleDetailsResult, setModuleDetailsResult] = useState<{
    id: string
    details: WrapperModuleDetails | undefined
  }>()
  useEffect(() => {
    if (!selectedId) return undefined
    let cancelled = false
    void window.api
      .getWrapperCompositionModuleDetails(selectedId)
      .then((details) => {
        if (!cancelled) setModuleDetailsResult({ id: selectedId, details })
      })
      .catch(() => {
        if (!cancelled) setModuleDetailsResult({ id: selectedId, details: undefined })
      })
    return () => {
      cancelled = true
    }
  }, [selectedId])
  const moduleDetails =
    moduleDetailsResult?.id === selectedId ? moduleDetailsResult.details : undefined

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
              <ResourceIcon icon={selected.icon} kind="wrapper" size={72} fallbackSize={24} />
            </Box>
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography variant="h4" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
                {selected.name}
              </Typography>
              {/* The canonical id, not the display name above, is what actually
                  identifies this wrapper — keep it visible right next to the name. */}
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ fontFamily: 'var(--font-mono)', display: 'block' }}
              >
                {selected.id}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                {selected.summary}
              </Typography>
              <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: 'wrap', rowGap: 1 }}>
                <Chip
                  size="small"
                  color={wrapperProviderColor(parseWrapperCompositionId(selected.id).provider)}
                  label={parseWrapperCompositionId(selected.id).provider}
                />
                <Chip
                  size="small"
                  variant="outlined"
                  label={wrapperTierLabel(parseWrapperCompositionId(selected.id).tier)}
                />
              </Stack>
              <Box sx={{ mt: 1.5 }}>
                <WrapperPackageControl
                  wrapper={selected}
                  busy={packageEnablementBusy}
                  onSetEnabled={onSetPackageEnabled}
                />
              </Box>
            </Box>
          </Stack>

          {project && (
            <Box sx={{ mt: 2 }}>
              <WrapperExecutionTargetControl
                project={project}
                busy={updatingRemoteProjectId === project.id}
                onUpdateRemoteConnection={onUpdateProjectRemoteConnection}
                onUpdateRemoteDefaults={onUpdateProjectRemoteDefaults}
                onOpenRemoteSettings={onOpenRemoteSettings}
              />
            </Box>
          )}

          <Divider sx={{ my: 4 }} />

          <Typography variant="h6" sx={{ fontWeight: 700, mb: 1.5 }}>
            结构
          </Typography>
          {graph && (
            // Keyed by wrapper id so switching wrappers remounts the whole
            // ReactFlow instance instead of reusing it with a new `graph`
            // prop — `fitView` only runs once on mount, so reusing the
            // instance left the old pan/zoom transform in place for a
            // completely different graph, which for a same-size-or-smaller
            // one meant the new nodes could land entirely outside the
            // visible viewport (an apparently blank diagram).
            <WrapperFlowDiagram
              key={selected.id}
              graph={graph}
              height={graph.nodes.length > 8 ? 480 : 180}
            />
          )}

          <Divider sx={{ my: 4 }} />

          <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>
            输入
          </Typography>
          {inputParams.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              无
            </Typography>
          ) : (
            inputParams.map(([key, param]) => (
              <Typography key={key} variant="body2" color="text.secondary">
                {key} ({param.type}
                {param.required ? '，必填' : ''})
                {param.description ? ` — ${param.description}` : ''}
              </Typography>
            ))
          )}

          {optionParams.length > 0 && (
            <>
              <Typography variant="h6" sx={{ fontWeight: 700, mt: 3, mb: 1 }}>
                选项
              </Typography>
              {optionParams.map(([key, param]) => (
                <Typography key={key} variant="body2" color="text.secondary">
                  {key} ({param.type}
                  {param.required ? '，必填' : ''})
                  {param.description ? ` — ${param.description}` : ''}
                </Typography>
              ))}
            </>
          )}

          <Typography variant="h6" sx={{ fontWeight: 700, mt: 3, mb: 1 }}>
            输出
          </Typography>
          {outputs.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              无
            </Typography>
          ) : (
            outputs.map(([key, output]) => (
              <Typography key={key} variant="body2" color="text.secondary">
                {key} — {output.path}
                {output.primary ? '（主要）' : ''}
              </Typography>
            ))
          )}

          {moduleDetails?.meta && (
            <>
              <Divider sx={{ my: 4 }} />
              <Typography variant="h6" sx={{ fontWeight: 700, mb: 1.5 }}>
                关于
              </Typography>
              {moduleDetails.meta.description && (
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                  {moduleDetails.meta.description}
                </Typography>
              )}
              {moduleDetails.meta.keywords && moduleDetails.meta.keywords.length > 0 && (
                <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap', rowGap: 1 }}>
                  {moduleDetails.meta.keywords.map((keyword) => (
                    <Chip key={keyword} size="small" variant="outlined" label={keyword} />
                  ))}
                </Stack>
              )}
              {moduleDetails.meta.tools?.map((tool) => (
                <Box key={tool.name} sx={{ mb: 2 }}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                    {tool.name}
                  </Typography>
                  {tool.description && (
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                      {tool.description}
                    </Typography>
                  )}
                  <Stack
                    direction="row"
                    spacing={1.5}
                    sx={{ mt: 0.75, flexWrap: 'wrap', rowGap: 0.5, alignItems: 'center' }}
                  >
                    {tool.licence?.map((licence) => (
                      <Chip key={licence} size="small" label={licence} />
                    ))}
                    {tool.homepage && (
                      <Link
                        href={tool.homepage}
                        target="_blank"
                        rel="noopener noreferrer"
                        variant="body2"
                      >
                        主页
                      </Link>
                    )}
                    {tool.documentation && (
                      <Link
                        href={tool.documentation}
                        target="_blank"
                        rel="noopener noreferrer"
                        variant="body2"
                      >
                        文档
                      </Link>
                    )}
                    {tool.doi && (
                      <Link
                        href={`https://doi.org/${tool.doi}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        variant="body2"
                      >
                        DOI
                      </Link>
                    )}
                  </Stack>
                </Box>
              ))}
              {moduleDetails.meta.authors && moduleDetails.meta.authors.length > 0 && (
                <Typography variant="caption" color="text.secondary">
                  作者：{moduleDetails.meta.authors.join('、')}
                </Typography>
              )}
            </>
          )}

          {moduleDetails?.environment && (
            <>
              <Divider sx={{ my: 4 }} />
              <Typography variant="h6" sx={{ fontWeight: 700, mb: 1.5 }}>
                环境
              </Typography>
              <WrapperYamlBlock yaml={moduleDetails.environment} />
            </>
          )}

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
