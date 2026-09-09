import { useCallback, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import {
  Box,
  Button,
  Chip,
  Divider,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import { alpha, type Theme } from '@mui/material/styles'
import { PhiIcons } from '../icons'
import {
  insertNotebookCell,
  updateNotebookCell,
  type JsonObject,
  type NotebookCell,
  type NotebookCellType,
  type NotebookDocument
} from '../../../shared/notebookDocument'
import { PanelRight } from 'lucide-react'
import type {
  AnalysisKernelDiagnostics,
  AnalysisKernelLanguage,
  AnalysisNotebookFile,
  AnalysisNotebookRegistry,
  AnalysisNotebookSummary,
  AnalysisNotebookSessionStatus,
  JupyterServerStatus
} from '../types'

type LeftPanel = 'chat' | 'notebooks'
type InspectorTab = 'files' | 'variables' | 'artifacts'
type CellState = 'idle' | 'running' | 'error' | 'stale'
type NotebookListEntry = {
  id: string
  path: string
  status: string
  absolutePath?: string
}

export type AnalysisViewProps = {
  notebookRegistry?: AnalysisNotebookRegistry | null
  notebookFile?: AnalysisNotebookFile | null
  initialLeftPanel?: LeftPanel
  initialInspectorTab?: InspectorTab
  initialInspectorCollapsed?: boolean
  isLoadingNotebooks?: boolean
  isOpeningNotebook?: boolean
  notebookError?: string | null
  notebookContentError?: string | null
  kernelDiagnostics?: AnalysisKernelDiagnostics | null
  isLoadingKernels?: boolean
  kernelError?: string | null
  jupyterServerStatus?: JupyterServerStatus | null
  isStartingJupyterServer?: boolean
  jupyterServerError?: string | null
  notebookSessionStatus?: AnalysisNotebookSessionStatus | null
  isStartingNotebookSession?: boolean
  notebookSessionError?: string | null
  onRefreshNotebooks?: () => void
  onRefreshKernels?: () => void
  onRefreshJupyterServer?: () => void
  onStartJupyterServer?: (cwd: string) => void
  onStopJupyterServer?: (cwd: string) => void
  onStartNotebookSession?: (file: AnalysisNotebookFile, document: NotebookDocument) => void
  onStopNotebookSession?: (file: AnalysisNotebookFile) => void
  onRunNotebookCell?: (
    file: AnalysisNotebookFile,
    document: NotebookDocument,
    cellId: string
  ) => void
  executingNotebookCellId?: string | null
  notebookCellExecutionError?: string | null
  onInitializeProjectAnalysis?: (cwd: string) => void
  onOpenNotebook?: (path: string) => void
  onSaveNotebook?: (file: AnalysisNotebookFile, document: NotebookDocument) => void
  onCreateNotebook?: (cwd: string) => void
  onDeleteNotebook?: (file: { path: string; relativePath: string }) => void
  chatPanel?: ReactNode
}

type CanvasCell = {
  id: string
  count: number | null
  type: 'markdown' | 'code' | 'raw'
  language?: string
  state: CellState
  source: string
  output?: string
}

type NotebookArtifact = {
  id: string
  source: string
  name: string
  kind: string
  size: string
}

const AddIcon = PhiIcons.action.add
const ChatIcon = PhiIcons.nav.chat
const CodeIcon = PhiIcons.tool.command
const FileIcon = PhiIcons.tool.read
const NotebookIcon = PhiIcons.nav.analysis
const PlayIcon = PhiIcons.action.quick
const RefreshIcon = PhiIcons.action.refresh
const SaveIcon = PhiIcons.state.done
const StopIcon = PhiIcons.action.stop
const DeleteIcon = PhiIcons.action.delete

const isMac = typeof window !== 'undefined' && window.platform === 'darwin'
const macTitlebarHeight = 44
const contentTopGap = 8
const leftRailWidth = 300
const minLeftRailWidth = 220
const maxLeftRailWidth = 460
const collapsedRailWidth = 44
const inspectorWidth = 340
const minInspectorWidth = 240
const maxInspectorWidth = 520

function stateLabel(state: CellState): string {
  if (state === 'running') return 'Running'
  if (state === 'error') return 'Error'
  if (state === 'stale') return 'Stale'
  return 'Idle'
}

function stateColor(state: CellState): string {
  if (state === 'running') return 'primary.main'
  if (state === 'error') return 'error.main'
  if (state === 'stale') return 'warning.main'
  return 'success.main'
}

function compactPath(path: string): string {
  const parts = path.split('/')
  return parts.length <= 2 ? path : `${parts[0]}/.../${parts[parts.length - 1]}`
}

function stringFromMetadata(metadata: JsonObject, key: string): string | undefined {
  const value = metadata[key]
  return typeof value === 'string' ? value : undefined
}

function objectFromMetadata(metadata: JsonObject, key: string): JsonObject | undefined {
  const value = metadata[key]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined
}

function notebookLanguage(document: NotebookDocument): string {
  const languageInfo = objectFromMetadata(document.metadata, 'language_info')
  const kernelSpec = objectFromMetadata(document.metadata, 'kernelspec')
  return (
    stringFromMetadata(languageInfo ?? {}, 'name') ??
    stringFromMetadata(kernelSpec ?? {}, 'language') ??
    stringFromMetadata(kernelSpec ?? {}, 'display_name') ??
    'Code'
  )
}

function notebookKernelLanguage(document: NotebookDocument): AnalysisKernelLanguage | null {
  const language = notebookLanguage(document).toLocaleLowerCase()
  if (language === 'python' || language.startsWith('python')) return 'python'
  if (language === 'r' || language === 'ir') return 'r'
  return null
}

function kernelAvailabilityLabel(
  document: NotebookDocument | null,
  diagnostics: AnalysisKernelDiagnostics | null | undefined,
  isLoading: boolean,
  error: string | null | undefined
): string {
  if (isLoading) return 'Checking kernels'
  if (error) return 'Kernel check failed'
  if (!diagnostics) return document ? 'Kernel unchecked' : 'Kernel preview'
  if (!diagnostics.jupyterServer.available) return 'Jupyter missing'
  if (!document) return 'Jupyter ready'

  const language = notebookKernelLanguage(document)
  if (language === 'python' && !diagnostics.hasPythonKernel) return 'Python kernel missing'
  if (language === 'r' && !diagnostics.hasRKernel) return 'R kernel missing'

  const matchingKernel =
    diagnostics.kernels.find((kernel) => kernel.language === language) ??
    diagnostics.kernels.find((kernel) => kernel.name === diagnostics.preferredKernelName)
  return matchingKernel ? `${matchingKernel.displayName} · not started` : 'Kernel missing'
}

function kernelAvailabilityColor(
  label: string
): 'default' | 'primary' | 'success' | 'warning' | 'error' {
  if (label.includes('failed')) return 'error'
  if (label.includes('missing')) return 'warning'
  if (label.includes('not started')) return 'primary'
  if (label.includes('ready')) return 'success'
  return 'default'
}

function jupyterServerStateLabel(status: JupyterServerStatus | null | undefined): string {
  if (!status) return 'Jupyter server unchecked'
  if (status.state === 'starting') return 'Jupyter server starting'
  if (status.state === 'ready') return 'Jupyter server ready'
  if (status.state === 'error') return 'Jupyter server error'
  if (status.state === 'exited') return 'Jupyter server exited'
  return 'Jupyter server stopped'
}

function jupyterServerStateColor(
  status: JupyterServerStatus | null | undefined
): 'default' | 'primary' | 'success' | 'warning' | 'error' {
  if (!status) return 'default'
  if (status.state === 'ready') return 'success'
  if (status.state === 'starting') return 'primary'
  if (status.state === 'error') return 'error'
  if (status.state === 'exited') return 'warning'
  return 'default'
}

function notebookSessionStateLabel(
  status: AnalysisNotebookSessionStatus | null | undefined
): string {
  if (!status) return 'Kernel disconnected'
  if (status.state === 'missing') return 'Kernel missing'
  if (status.state === 'idle') return 'Kernel idle'
  if (status.state === 'busy') return 'Kernel busy'
  if (status.state === 'restarting') return 'Kernel restarting'
  if (status.state === 'disconnected') return 'Kernel disconnected'
  if (status.state === 'error') return 'Kernel error'
  return 'Kernel unknown'
}

function notebookSessionStateColor(
  status: AnalysisNotebookSessionStatus | null | undefined
): 'default' | 'primary' | 'success' | 'warning' | 'error' {
  if (!status) return 'default'
  if (status.state === 'idle') return 'success'
  if (status.state === 'busy' || status.state === 'restarting') return 'primary'
  if (status.state === 'missing' || status.state === 'disconnected') return 'warning'
  if (status.state === 'error') return 'error'
  return 'default'
}

function isNotebookSessionRunnable(
  status: AnalysisNotebookSessionStatus | null | undefined
): boolean {
  return Boolean(status?.sessionId && status.state === 'idle')
}

function textFromOutputData(data: JsonObject): string | undefined {
  const plain = data['text/plain']
  if (typeof plain === 'string') return plain
  if (Array.isArray(plain)) {
    return plain.map((item) => (typeof item === 'string' ? item : '')).join('')
  }
  return undefined
}

function notebookOutputDataKind(key: string): string {
  if (key === 'text/html') return 'HTML'
  if (key === 'image/png') return 'PNG'
  if (key === 'image/jpeg') return 'JPEG'
  if (key === 'image/svg+xml') return 'SVG'
  if (key === 'application/vnd.plotly.v1+json') return 'Plotly'
  if (key === 'application/json') return 'JSON'
  if (key.startsWith('text/')) return key.slice('text/'.length).toUpperCase()
  return key
}

function notebookOutputDataBytes(value: unknown): number {
  if (typeof value === 'string') return value.length
  try {
    return JSON.stringify(value).length
  } catch {
    return 0
  }
}

function notebookArtifacts(document: NotebookDocument | null | undefined): NotebookArtifact[] {
  if (!document) return []
  return document.cells.flatMap((cell, cellIndex) => {
    if (cell.cellType !== 'code') return []
    return cell.outputs.flatMap((output, outputIndex) => {
      const entries = Object.entries(output.data).filter(
        ([key]) => key !== 'text/plain' && key !== 'text/markdown'
      )
      return entries.map(([key, value], dataIndex) => {
        const kind = notebookOutputDataKind(key)
        return {
          id: `${cell.id}:${outputIndex}:${key}`,
          source:
            cell.executionCount !== null ? `Cell ${cell.executionCount}` : `Cell ${cellIndex + 1}`,
          name: `${cell.id || `cell-${cellIndex + 1}`}.${kind.toLocaleLowerCase()}`,
          kind,
          size: formatBytes(notebookOutputDataBytes(value) + dataIndex)
        }
      })
    })
  })
}

function outputPreview(cell: NotebookCell): string | undefined {
  const outputs = cell.outputs
    .map((output) => {
      if (output.text) return output.text
      if (output.ename || output.evalue) {
        return [output.ename, output.evalue].filter(Boolean).join(': ')
      }
      return textFromOutputData(output.data)
    })
    .filter((value): value is string => Boolean(value))
  return outputs.length > 0 ? outputs.join('\n') : undefined
}

function documentCells(document: NotebookDocument, executingCellId?: string | null): CanvasCell[] {
  const language = notebookLanguage(document)
  return document.cells.map((cell) => ({
    id: cell.id,
    count: cell.executionCount,
    type: cell.cellType,
    language: cell.cellType === 'code' ? language : undefined,
    state:
      executingCellId === cell.id
        ? 'running'
        : cell.outputs.some((output) => output.outputType === 'error')
          ? 'error'
          : 'idle',
    source: cell.source,
    output: cell.cellType === 'code' ? outputPreview(cell) : undefined
  }))
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function notebookStatus(notebook: AnalysisNotebookSummary): string {
  return `${formatBytes(notebook.bytes)} · ${new Date(notebook.modifiedAt).toLocaleDateString()}`
}

function registryNotebooks(
  registry: AnalysisNotebookRegistry | null | undefined
): NotebookListEntry[] {
  if (!registry) return []
  return registry.notebooks.map((notebook) => ({
    id: notebook.path,
    path: notebook.relativePath,
    absolutePath: notebook.path,
    status: notebookStatus(notebook)
  }))
}

function AnalysisChatPanel({
  activeNotebookPath
}: {
  activeNotebookPath: string
}): React.JSX.Element {
  return (
    <Box sx={{ display: 'flex', minHeight: 0, flex: 1, flexDirection: 'column' }}>
      <Box sx={{ px: 1, pb: 0.75, pt: 1 }}>
        <Typography
          variant="caption"
          color="text.secondary"
          noWrap
          sx={{ display: 'block', fontFamily: 'var(--font-mono)' }}
        >
          {activeNotebookPath}
        </Typography>
      </Box>
      <Divider />
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', p: 1.5 }}>
        <Typography variant="body2" color="text.secondary">
          当前容器未传入真实聊天面板。
        </Typography>
      </Box>
    </Box>
  )
}

function NotebookList({
  notebooks,
  activeNotebookPath,
  registry,
  isLoading,
  error,
  onSelectNotebook,
  onRefreshNotebooks,
  onInitializeProjectAnalysis,
  onCreateNotebook
}: {
  notebooks: NotebookListEntry[]
  activeNotebookPath: string | null
  registry?: AnalysisNotebookRegistry | null
  isLoading?: boolean
  error?: string | null
  onSelectNotebook: (notebook: NotebookListEntry) => void
  onRefreshNotebooks?: () => void
  onInitializeProjectAnalysis?: (cwd: string) => void
  onCreateNotebook?: (cwd: string) => void
}): React.JSX.Element {
  const projectCwd = registry?.projectCwd ?? null

  return (
    <List disablePadding sx={{ px: 0.75, py: 0.75 }}>
      <Box sx={{ px: 0.75, pb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1, minWidth: 0 }} noWrap>
          {registry?.projectName ?? 'Notebook registry'}
        </Typography>
        {onRefreshNotebooks ? (
          <Tooltip title="刷新 notebooks">
            <IconButton size="small" onClick={onRefreshNotebooks}>
              <RefreshIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ) : null}
        {projectCwd && onCreateNotebook ? (
          <Tooltip title="新建 notebook">
            <IconButton size="small" onClick={() => onCreateNotebook(projectCwd)}>
              <AddIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ) : null}
      </Box>
      {isLoading ? (
        <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: 1.5 }}>
          正在扫描 notebooks...
        </Typography>
      ) : null}
      {error ? (
        <Typography variant="body2" color="error.main" sx={{ px: 1, py: 1.5 }}>
          {error}
        </Typography>
      ) : null}
      {!isLoading && !error && registry?.message ? (
        <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: 1.5 }}>
          {registry.message}
        </Typography>
      ) : null}
      {!isLoading && !error && projectCwd && notebooks.length === 0 ? (
        <Box sx={{ px: 1, py: 1.5 }}>
          <Typography variant="body2" color="text.secondary">
            当前项目还没有 notebook。
          </Typography>
          {!registry?.initialized && onInitializeProjectAnalysis ? (
            <Button
              size="small"
              variant="outlined"
              startIcon={<AddIcon fontSize="small" />}
              sx={{ mt: 1 }}
              onClick={() => onInitializeProjectAnalysis(projectCwd)}
            >
              初始化分析目录
            </Button>
          ) : null}
        </Box>
      ) : null}
      {registry?.truncated ? (
        <Typography variant="caption" color="warning.main" sx={{ display: 'block', px: 1, pb: 1 }}>
          扫描结果已截断，请缩小项目目录或移动 notebook 到 notebooks/。
        </Typography>
      ) : null}
      {notebooks.map((notebook) => (
        <ListItemButton
          key={notebook.id}
          selected={notebook.path === activeNotebookPath}
          onClick={() => onSelectNotebook(notebook)}
          sx={{ alignItems: 'flex-start', mx: 0, mb: 0.5, py: 1 }}
        >
          <NotebookIcon fontSize="small" sx={{ mt: 0.2, mr: 1, color: 'primary.main' }} />
          <ListItemText
            primary={compactPath(notebook.path)}
            secondary={notebook.status}
            slotProps={{
              primary: {
                noWrap: true,
                sx: { fontFamily: 'var(--font-mono)', fontSize: '0.82rem', fontWeight: 700 }
              },
              secondary: { sx: { fontSize: '0.76rem' } }
            }}
          />
        </ListItemButton>
      ))}
    </List>
  )
}

function LeftRail({
  panel,
  collapsed,
  width,
  notebooks,
  activeNotebookPath,
  notebookRegistry,
  isLoadingNotebooks,
  notebookError,
  onPanelChange,
  onSelectNotebook,
  onRefreshNotebooks,
  onInitializeProjectAnalysis,
  onCreateNotebook,
  chatPanel,
  onToggleCollapsed
}: {
  panel: LeftPanel
  collapsed: boolean
  width: number
  notebooks: NotebookListEntry[]
  activeNotebookPath: string | null
  notebookRegistry?: AnalysisNotebookRegistry | null
  isLoadingNotebooks?: boolean
  notebookError?: string | null
  onPanelChange: (panel: LeftPanel) => void
  onSelectNotebook: (notebook: NotebookListEntry) => void
  onRefreshNotebooks?: () => void
  onInitializeProjectAnalysis?: (cwd: string) => void
  onCreateNotebook?: (cwd: string) => void
  chatPanel?: ReactNode
  onToggleCollapsed: () => void
}): React.JSX.Element {
  const tabs = [
    { value: 'chat' as const, label: 'Chat', Icon: ChatIcon },
    { value: 'notebooks' as const, label: 'Notebooks', Icon: NotebookIcon }
  ]

  if (collapsed) {
    return (
      <Box
        sx={{
          width: collapsedRailWidth,
          flexShrink: 0,
          borderRight: 1,
          borderColor: 'divider',
          pt: isMac ? 1 : 0.75,
          display: 'flex',
          alignItems: 'center',
          flexDirection: 'column',
          gap: 0.75
        }}
      >
        {tabs.map(({ value, label, Icon }) => (
          <Tooltip key={value} title={label} placement="right">
            <IconButton
              size="small"
              color={panel === value ? 'primary' : 'default'}
              aria-label={label}
              onClick={() => {
                onPanelChange(value)
                onToggleCollapsed()
              }}
            >
              <Icon fontSize="small" />
            </IconButton>
          </Tooltip>
        ))}
      </Box>
    )
  }

  return (
    <Box
      sx={{
        width,
        flexShrink: 0,
        borderRight: 1,
        borderColor: 'divider',
        pt: isMac ? 1 : 0.75,
        display: 'flex',
        minHeight: 0,
        flexDirection: 'column',
        bgcolor: (theme) =>
          theme.palette.mode === 'dark' ? theme.palette.background.default : '#FFFFFF'
      }}
    >
      <Box sx={{ px: 1, pb: 0.5, display: 'flex', alignItems: 'center', gap: 0.75 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
            分析
          </Typography>
        </Box>
      </Box>
      <Box sx={{ px: 1, pb: 0.5 }}>
        <Tabs
          value={panel}
          onChange={(_, value: LeftPanel) => onPanelChange(value)}
          variant="fullWidth"
          sx={{
            minHeight: 30,
            '& .MuiTab-root': { minHeight: 30, py: 0.25, fontSize: '0.74rem' }
          }}
        >
          {tabs.map(({ value, label }) => (
            <Tab
              key={value}
              value={value}
              label={label}
              onClick={() => {
                if (panel === value) onToggleCollapsed()
              }}
            />
          ))}
        </Tabs>
      </Box>
      {panel === 'chat' ? (
        chatPanel ? (
          <Box sx={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>{chatPanel}</Box>
        ) : (
          <AnalysisChatPanel activeNotebookPath={activeNotebookPath ?? 'No notebook selected'} />
        )
      ) : (
        <NotebookList
          notebooks={notebooks}
          activeNotebookPath={activeNotebookPath}
          registry={notebookRegistry}
          isLoading={isLoadingNotebooks}
          error={notebookError}
          onSelectNotebook={onSelectNotebook}
          onRefreshNotebooks={onRefreshNotebooks}
          onInitializeProjectAnalysis={onInitializeProjectAnalysis}
          onCreateNotebook={onCreateNotebook}
        />
      )}
    </Box>
  )
}

function NotebookHeader({
  activeNotebookPath,
  kernelLabel,
  kernelStatusLabel,
  kernelStatusColor,
  isDirty,
  hasDocument,
  isOpening,
  isStartingNotebookSession,
  notebookFile,
  draftDocument,
  notebookSessionStatus,
  onSave,
  onRefreshKernels,
  onStartNotebookSession,
  onStopNotebookSession
}: {
  activeNotebookPath: string
  kernelLabel: string
  kernelStatusLabel: string
  kernelStatusColor: 'default' | 'primary' | 'success' | 'warning' | 'error'
  isDirty: boolean
  hasDocument: boolean
  isOpening: boolean
  isStartingNotebookSession?: boolean
  notebookFile?: AnalysisNotebookFile | null
  draftDocument?: NotebookDocument | null
  notebookSessionStatus?: AnalysisNotebookSessionStatus | null
  onSave?: () => void
  onRefreshKernels?: () => void
  onStartNotebookSession?: (file: AnalysisNotebookFile, document: NotebookDocument) => void
  onStopNotebookSession?: (file: AnalysisNotebookFile) => void
}): React.JSX.Element {
  const hasLiveNotebookSession = Boolean(
    notebookSessionStatus?.sessionId &&
    (notebookSessionStatus.state === 'idle' ||
      notebookSessionStatus.state === 'busy' ||
      notebookSessionStatus.state === 'restarting')
  )
  const canConnectNotebookSession = Boolean(
    notebookFile && draftDocument && onStartNotebookSession && !hasLiveNotebookSession
  )
  const canDisconnectNotebookSession = Boolean(
    notebookFile && onStopNotebookSession && hasLiveNotebookSession
  )
  return (
    <Box
      sx={{
        height: macTitlebarHeight,
        flexShrink: 0,
        borderBottom: 1,
        borderColor: 'divider',
        px: 2,
        display: 'flex',
        alignItems: 'center',
        gap: 1.25,
        WebkitAppRegion: 'drag'
      }}
    >
      <NotebookIcon fontSize="small" sx={{ color: 'primary.main' }} />
      <Typography
        variant="subtitle2"
        noWrap
        sx={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)', fontWeight: 800 }}
      >
        {activeNotebookPath}
      </Typography>
      <Box
        sx={{
          display: { xs: 'none', md: 'flex' },
          alignItems: 'center',
          gap: 0.75,
          minWidth: 0,
          color: 'text.secondary'
        }}
      >
        <Box
          sx={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            bgcolor: kernelStatusColor === 'default' ? 'text.disabled' : `${kernelStatusColor}.main`
          }}
        />
        <Typography variant="caption" noWrap>
          {kernelLabel} · {kernelStatusLabel} · {isDirty ? 'Unsaved' : 'Saved'}
        </Typography>
      </Box>
      <Stack direction="row" spacing={0.5} sx={{ WebkitAppRegion: 'no-drag' }}>
        {hasDocument ? (
          <Tooltip title={isDirty ? '保存 notebook' : '已保存'}>
            <span>
              <IconButton
                size="small"
                aria-label="保存 notebook"
                disabled={!isDirty || isOpening}
                onClick={onSave}
              >
                <SaveIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        ) : null}
        {onRefreshKernels ? (
          <Tooltip title="刷新 kernels">
            <IconButton size="small" aria-label="刷新 kernels" onClick={onRefreshKernels}>
              <RefreshIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ) : null}
        {canConnectNotebookSession ? (
          <Tooltip title="连接 kernel">
            <span>
              <IconButton
                size="small"
                aria-label="连接 kernel"
                disabled={Boolean(isStartingNotebookSession)}
                onClick={() => {
                  if (notebookFile && draftDocument) {
                    onStartNotebookSession?.(notebookFile, draftDocument)
                  }
                }}
              >
                <PlayIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        ) : null}
        {canDisconnectNotebookSession ? (
          <Tooltip title="断开 kernel">
            <span>
              <IconButton
                size="small"
                color="warning"
                aria-label="断开 kernel"
                disabled={Boolean(isStartingNotebookSession)}
                onClick={() => {
                  if (notebookFile) onStopNotebookSession?.(notebookFile)
                }}
              >
                <StopIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        ) : null}
      </Stack>
    </Box>
  )
}

function InspectorToggleButton({
  isCollapsed,
  onToggle
}: {
  isCollapsed: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <Tooltip title={isCollapsed ? '展开右侧栏' : '关闭右侧栏'}>
      <IconButton
        data-phi-inspector-toggle-button={isCollapsed ? 'collapsed' : 'expanded'}
        data-phi-inspector-toggle-position="absolute"
        data-phi-inspector-toggle-anchor="app-top-right"
        size="small"
        color={isCollapsed ? 'default' : 'primary'}
        aria-label={isCollapsed ? '展开右侧栏' : '关闭右侧栏'}
        onClick={onToggle}
        sx={{
          position: 'absolute',
          top: 8,
          right: 8,
          zIndex: 20,
          width: 32,
          height: 32,
          borderRadius: 1.5,
          bgcolor: (theme) =>
            theme.palette.mode === 'dark'
              ? alpha(theme.palette.background.paper, 0.92)
              : alpha(theme.palette.common.white, 0.92),
          border: 1,
          borderColor: 'divider',
          boxShadow: (theme) => theme.shadows[1],
          WebkitAppRegion: 'no-drag',
          '&:hover': {
            bgcolor: 'background.paper'
          }
        }}
      >
        <PanelRight size={18} strokeWidth={1.85} />
      </IconButton>
    </Tooltip>
  )
}

function Cell({
  cell,
  editable = false,
  onSourceChange,
  onInsertAfter,
  onRunCell,
  canRunCells = false
}: {
  cell: CanvasCell
  editable?: boolean
  onSourceChange?: (cellId: string, source: string) => void
  onInsertAfter?: (cellId: string) => void
  onRunCell?: (cellId: string) => void
  canRunCells?: boolean
}): React.JSX.Element {
  const isMarkdown = cell.type === 'markdown'
  const canRun =
    cell.type === 'code' && Boolean(onRunCell) && canRunCells && cell.state !== 'running'
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: '34px minmax(0, 1fr)',
        gap: 0.75,
        py: 1.05,
        '&:hover .cell-floating-actions': {
          opacity: 1,
          transform: 'translateY(0)'
        },
        '&:focus-within .cell-floating-actions': {
          opacity: 1,
          transform: 'translateY(0)'
        },
        '&:hover .cell-shell': {
          borderColor: (theme) => alpha(theme.palette.text.primary, 0.22)
        }
      }}
    >
      <Box
        sx={{ display: 'flex', alignItems: 'center', flexDirection: 'column', gap: 0.55, pt: 0.25 }}
      >
        <Tooltip title="运行 cell">
          <IconButton
            size="small"
            aria-label="运行 cell"
            disabled={!canRun}
            onClick={() => onRunCell?.(cell.id)}
            sx={{
              width: 28,
              height: 28,
              border: 1,
              borderColor: canRun ? 'divider' : 'transparent',
              bgcolor: canRun ? 'background.paper' : 'transparent'
            }}
          >
            <PlayIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Typography
          variant="caption"
          sx={{ fontFamily: 'var(--font-mono)', color: 'text.secondary', minHeight: 16 }}
        >
          {cell.count ?? ''}
        </Typography>
        <Box
          sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: stateColor(cell.state) }}
          title={stateLabel(cell.state)}
        />
      </Box>
      <Box
        className="cell-shell"
        sx={{
          minWidth: 0,
          position: 'relative',
          border: 1,
          borderColor: (theme) =>
            cell.state === 'error'
              ? theme.palette.error.main
              : alpha(theme.palette.text.primary, 0.12),
          borderRadius: 1.25,
          bgcolor: (theme) =>
            alpha(theme.palette.background.paper, theme.palette.mode === 'dark' ? 0.48 : 0.72),
          overflow: 'hidden',
          transition: 'border-color 150ms ease, box-shadow 150ms ease'
        }}
      >
        <Box
          className="cell-floating-actions"
          sx={{
            position: 'absolute',
            top: 6,
            right: 6,
            zIndex: 2,
            display: 'flex',
            alignItems: 'center',
            gap: 0.25,
            px: 0.35,
            py: 0.2,
            border: 1,
            borderColor: 'divider',
            borderRadius: 1,
            bgcolor: (theme) =>
              theme.palette.mode === 'dark'
                ? alpha(theme.palette.background.paper, 0.9)
                : alpha(theme.palette.common.white, 0.92),
            boxShadow: (theme) => theme.shadows[1],
            opacity: cell.state === 'running' || cell.state === 'error' ? 1 : 0,
            transform: 'translateY(-2px)',
            transition: 'opacity 150ms ease, transform 150ms ease'
          }}
        >
          <Tooltip title="插入 cell">
            <IconButton
              size="small"
              aria-label="插入 cell"
              onClick={() => onInsertAfter?.(cell.id)}
              sx={{ width: 24, height: 24 }}
            >
              <AddIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
        {editable ? (
          <TextField
            fullWidth
            multiline
            minRows={isMarkdown ? 2 : 3}
            value={cell.source}
            variant="standard"
            onChange={(event) => onSourceChange?.(cell.id, event.target.value)}
            slotProps={{
              input: {
                disableUnderline: true,
                sx: {
                  p: isMarkdown ? 1.7 : 1.35,
                  pr: 5.5,
                  alignItems: 'flex-start',
                  fontFamily: isMarkdown ? 'inherit' : 'var(--font-mono)',
                  fontSize: isMarkdown ? '0.95rem' : '0.82rem',
                  lineHeight: 1.65
                }
              }
            }}
          />
        ) : (
          <Typography
            component="pre"
            variant="body2"
            sx={{
              m: 0,
              p: isMarkdown ? 1.7 : 1.35,
              pr: 5.5,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              fontFamily: isMarkdown ? 'inherit' : 'var(--font-mono)',
              fontSize: isMarkdown ? '0.95rem' : '0.82rem',
              lineHeight: 1.65
            }}
          >
            {cell.source}
          </Typography>
        )}
        {cell.output ? (
          <>
            <Divider />
            <Box
              sx={{
                px: 1.35,
                py: 1,
                bgcolor: (theme) => alpha(theme.palette.text.primary, 0.03)
              }}
            >
              <Typography variant="caption" color="text.secondary">
                Output
              </Typography>
              <Typography
                component="pre"
                variant="body2"
                sx={{
                  m: 0,
                  mt: 0.5,
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.8rem',
                  color: cell.state === 'error' ? 'error.main' : 'text.primary'
                }}
              >
                {cell.output}
              </Typography>
            </Box>
          </>
        ) : null}
      </Box>
    </Box>
  )
}

function NotebookInsertDock({
  disabled = false,
  onInsert
}: {
  disabled?: boolean
  onInsert: (cellType: Extract<NotebookCellType, 'code' | 'markdown'>) => void
}): React.JSX.Element {
  const actions = [
    { cellType: 'code' as const, label: 'Code', Icon: CodeIcon },
    { cellType: 'markdown' as const, label: 'Markdown', Icon: FileIcon }
  ]

  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', py: 1.25 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.25,
          px: 0.5,
          py: 0.35,
          border: 1,
          borderColor: 'divider',
          borderRadius: 1.5,
          bgcolor: (theme) =>
            theme.palette.mode === 'dark'
              ? alpha(theme.palette.background.paper, 0.72)
              : alpha(theme.palette.common.white, 0.9),
          boxShadow: (theme) => theme.shadows[1],
          opacity: disabled ? 0.55 : 1
        }}
      >
        {actions.map(({ cellType, label, Icon }) => (
          <Tooltip
            key={cellType}
            title={disabled ? '打开 notebook 后添加 cell' : `添加 ${label} cell`}
          >
            <span>
              <Button
                size="small"
                variant="text"
                startIcon={<Icon fontSize="small" />}
                disabled={disabled}
                aria-label={`添加 ${label} cell`}
                onClick={() => onInsert(cellType)}
                sx={{
                  minWidth: 0,
                  px: 1,
                  py: 0.35,
                  borderRadius: 1,
                  color: 'text.secondary',
                  '& .MuiButton-startIcon': { mr: 0.5 }
                }}
              >
                {label}
              </Button>
            </span>
          </Tooltip>
        ))}
      </Box>
    </Box>
  )
}

function NotebookCanvas({
  activeNotebookPath,
  notebookFile,
  initialDocument,
  isOpening,
  error,
  kernelDiagnostics,
  isLoadingKernels,
  kernelError,
  notebookSessionStatus,
  isStartingNotebookSession,
  notebookSessionError,
  executingCellId,
  cellExecutionError,
  onSaveNotebook,
  onRefreshKernels,
  onStartNotebookSession,
  onStopNotebookSession,
  onRunNotebookCell
}: {
  activeNotebookPath: string
  notebookFile?: AnalysisNotebookFile | null
  initialDocument: NotebookDocument | null
  isOpening?: boolean
  error?: string | null
  kernelDiagnostics?: AnalysisKernelDiagnostics | null
  isLoadingKernels?: boolean
  kernelError?: string | null
  notebookSessionStatus?: AnalysisNotebookSessionStatus | null
  isStartingNotebookSession?: boolean
  notebookSessionError?: string | null
  executingCellId?: string | null
  cellExecutionError?: string | null
  onSaveNotebook?: (file: AnalysisNotebookFile, document: NotebookDocument) => void
  onRefreshKernels?: () => void
  onStartNotebookSession?: (file: AnalysisNotebookFile, document: NotebookDocument) => void
  onStopNotebookSession?: (file: AnalysisNotebookFile) => void
  onRunNotebookCell?: (
    file: AnalysisNotebookFile,
    document: NotebookDocument,
    cellId: string
  ) => void
}): React.JSX.Element {
  const [draftDocument, setDraftDocument] = useState<NotebookDocument | null>(initialDocument)
  const cells = draftDocument ? documentCells(draftDocument, executingCellId) : []
  const canRunCells = Boolean(draftDocument && isNotebookSessionRunnable(notebookSessionStatus))
  const kernelLabel = draftDocument
    ? isNotebookSessionRunnable(notebookSessionStatus)
      ? (notebookSessionStatus?.kernelDisplayName ??
        notebookSessionStatus?.kernelName ??
        notebookLanguage(draftDocument))
      : `${notebookLanguage(draftDocument)} notebook`
    : 'No notebook'
  const kernelStatusLabel = notebookSessionStatus
    ? notebookSessionStateLabel(notebookSessionStatus)
    : kernelAvailabilityLabel(
        draftDocument,
        kernelDiagnostics,
        Boolean(isLoadingKernels),
        kernelError
      )
  const kernelStatusColor = notebookSessionStatus
    ? notebookSessionStateColor(notebookSessionStatus)
    : kernelAvailabilityColor(kernelStatusLabel)
  const isDirty = Boolean(
    notebookFile && draftDocument && draftDocument.revision !== notebookFile.savedRevision
  )
  const onUpdateCellSource = (cellId: string, source: string): void => {
    setDraftDocument((document) =>
      document ? updateNotebookCell(document, cellId, { source }) : document
    )
  }
  const onInsertCell = (
    cellId: string,
    cellType: Extract<NotebookCellType, 'code' | 'markdown'> = 'code'
  ): void => {
    setDraftDocument((document) => {
      if (!document) return document
      const index = document.cells.findIndex((cell) => cell.id === cellId)
      return insertNotebookCell(document, index + 1, { cellType, source: '' })
    })
  }
  const onAppendCell = (cellType: Extract<NotebookCellType, 'code' | 'markdown'>): void => {
    setDraftDocument((document) => {
      if (!document) return document
      return insertNotebookCell(document, document.cells.length, { cellType, source: '' })
    })
  }
  const onSave = (): void => {
    if (notebookFile && draftDocument) {
      onSaveNotebook?.(notebookFile, draftDocument)
    }
  }
  const onRunCell = (cellId: string): void => {
    if (notebookFile && draftDocument) {
      onRunNotebookCell?.(notebookFile, draftDocument, cellId)
    }
  }

  return (
    <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <NotebookHeader
        activeNotebookPath={activeNotebookPath}
        kernelLabel={kernelLabel}
        kernelStatusLabel={kernelStatusLabel}
        kernelStatusColor={kernelStatusColor}
        isDirty={isDirty}
        hasDocument={Boolean(notebookFile && draftDocument)}
        isOpening={Boolean(isOpening)}
        isStartingNotebookSession={isStartingNotebookSession}
        notebookFile={notebookFile}
        draftDocument={draftDocument}
        notebookSessionStatus={notebookSessionStatus}
        onSave={onSave}
        onRefreshKernels={onRefreshKernels}
        onStartNotebookSession={onStartNotebookSession}
        onStopNotebookSession={onStopNotebookSession}
      />
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: { xs: 2, md: 4 }, py: 2.5 }}>
        <Box sx={{ maxWidth: 920, mx: 'auto' }}>
          {isOpening ? <Typography color="text.secondary">正在打开 notebook...</Typography> : null}
          {error ? (
            <Typography color="error.main" sx={{ mb: 2 }}>
              {error}
            </Typography>
          ) : null}
          {notebookSessionError ? (
            <Typography color="error.main" sx={{ mb: 2 }}>
              {notebookSessionError}
            </Typography>
          ) : null}
          {cellExecutionError ? (
            <Typography color="error.main" sx={{ mb: 2 }}>
              {cellExecutionError}
            </Typography>
          ) : null}
          {!isOpening &&
            cells.map((cell) => (
              <Cell
                key={cell.id}
                cell={cell}
                editable={Boolean(draftDocument)}
                onSourceChange={onUpdateCellSource}
                onInsertAfter={onInsertCell}
                onRunCell={onRunCell}
                canRunCells={canRunCells}
              />
            ))}
          {!isOpening && cells.length > 0 ? (
            <NotebookInsertDock disabled={!draftDocument} onInsert={onAppendCell} />
          ) : null}
          {!isOpening && cells.length === 0 ? (
            draftDocument ? (
              <NotebookInsertDock onInsert={onAppendCell} />
            ) : (
              <>
                <Box
                  sx={{
                    border: 1,
                    borderColor: 'divider',
                    borderRadius: 2,
                    px: 2,
                    py: 3,
                    color: 'text.secondary'
                  }}
                >
                  <Typography variant="body2">选择或创建 notebook 后开始分析。</Typography>
                </Box>
                <NotebookInsertDock disabled={!draftDocument} onInsert={onAppendCell} />
              </>
            )
          ) : null}
        </Box>
      </Box>
    </Box>
  )
}

function FilesTab({
  notebooks,
  activeNotebookPath,
  registry,
  isLoading,
  error,
  onOpenNotebook,
  onRefreshNotebooks,
  onCreateNotebook,
  onDeleteNotebook,
  onInitializeProjectAnalysis
}: {
  notebooks: NotebookListEntry[]
  activeNotebookPath: string | null
  registry?: AnalysisNotebookRegistry | null
  isLoading?: boolean
  error?: string | null
  onOpenNotebook?: (path: string) => void
  onRefreshNotebooks?: () => void
  onCreateNotebook?: (cwd: string) => void
  onDeleteNotebook?: (file: { path: string; relativePath: string }) => void
  onInitializeProjectAnalysis?: (cwd: string) => void
}): React.JSX.Element {
  const projectCwd = registry?.projectCwd ?? null

  return (
    <List dense disablePadding>
      <Box sx={{ px: 1, pb: 1, display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1, minWidth: 0 }} noWrap>
          {registry?.projectName ?? 'Project notebooks'}
        </Typography>
        {onRefreshNotebooks ? (
          <Tooltip title="刷新 notebooks">
            <IconButton size="small" aria-label="刷新 notebooks" onClick={onRefreshNotebooks}>
              <RefreshIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ) : null}
        {projectCwd && onCreateNotebook ? (
          <Tooltip title="新建 notebook">
            <IconButton
              size="small"
              aria-label="新建 notebook"
              onClick={() => onCreateNotebook(projectCwd)}
            >
              <AddIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ) : null}
      </Box>
      {isLoading ? (
        <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: 1.5 }}>
          正在扫描 notebooks...
        </Typography>
      ) : null}
      {error ? (
        <Typography variant="body2" color="error.main" sx={{ px: 1, py: 1.5 }}>
          {error}
        </Typography>
      ) : null}
      {!isLoading && !error && !registry ? (
        <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: 1.5 }}>
          连接项目后显示真实 notebook 文件。
        </Typography>
      ) : null}
      {!isLoading && !error && registry?.message ? (
        <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: 1.5 }}>
          {registry.message}
        </Typography>
      ) : null}
      {!isLoading && !error && projectCwd && notebooks.length === 0 ? (
        <Box sx={{ px: 1, py: 1.5 }}>
          <Typography variant="body2" color="text.secondary">
            当前项目还没有 notebook。
          </Typography>
          {!registry?.initialized && onInitializeProjectAnalysis ? (
            <Button
              size="small"
              variant="outlined"
              startIcon={<AddIcon fontSize="small" />}
              sx={{ mt: 1 }}
              onClick={() => onInitializeProjectAnalysis(projectCwd)}
            >
              初始化分析目录
            </Button>
          ) : null}
        </Box>
      ) : null}
      {registry?.truncated ? (
        <Typography variant="caption" color="warning.main" sx={{ display: 'block', px: 1, pb: 1 }}>
          扫描结果已截断，请缩小项目目录或移动 notebook 到 notebooks/。
        </Typography>
      ) : null}
      {!isLoading && !error && registry
        ? notebooks.map((notebook) => {
            const canOpen = Boolean(notebook.absolutePath && onOpenNotebook)
            const canDelete = Boolean(notebook.absolutePath && onDeleteNotebook)
            return (
              <Box
                key={notebook.id}
                sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.25, mb: 0.35 }}
              >
                <ListItemButton
                  selected={notebook.path === activeNotebookPath}
                  disabled={!canOpen}
                  aria-label={`打开 ${notebook.path}`}
                  onClick={() => {
                    if (notebook.absolutePath) onOpenNotebook?.(notebook.absolutePath)
                  }}
                  sx={{ minWidth: 0, px: 1, borderRadius: 1, alignItems: 'flex-start' }}
                >
                  <NotebookIcon
                    fontSize="small"
                    sx={{
                      mt: 0.25,
                      mr: 1,
                      color:
                        notebook.path === activeNotebookPath ? 'primary.main' : 'text.secondary'
                    }}
                  />
                  <ListItemText
                    primary={notebook.path}
                    secondary={notebook.status}
                    slotProps={{
                      primary: {
                        noWrap: true,
                        sx: { fontFamily: 'var(--font-mono)', fontSize: '0.8rem', fontWeight: 700 }
                      },
                      secondary: { sx: { fontSize: '0.72rem' } }
                    }}
                  />
                </ListItemButton>
                {canDelete ? (
                  <Tooltip title="删除 notebook">
                    <IconButton
                      size="small"
                      color="error"
                      aria-label={`删除 ${notebook.path}`}
                      onClick={() => {
                        if (!notebook.absolutePath) return
                        if (!window.confirm(`删除 notebook？\n${notebook.path}`)) return
                        onDeleteNotebook?.({
                          path: notebook.absolutePath,
                          relativePath: notebook.path
                        })
                      }}
                      sx={{ mt: 0.1, ml: 0.5, width: 28, height: 28 }}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                ) : null}
              </Box>
            )
          })
        : null}
    </List>
  )
}

function KernelStatusSummary({
  projectCwd,
  diagnostics,
  isLoading,
  error,
  serverStatus,
  isStartingServer,
  serverError,
  notebookSessionStatus,
  onRefresh,
  onRefreshServer,
  onStartServer,
  onStopServer
}: {
  projectCwd?: string | null
  diagnostics?: AnalysisKernelDiagnostics | null
  isLoading?: boolean
  error?: string | null
  serverStatus?: JupyterServerStatus | null
  isStartingServer?: boolean
  serverError?: string | null
  notebookSessionStatus?: AnalysisNotebookSessionStatus | null
  onRefresh?: () => void
  onRefreshServer?: () => void
  onStartServer?: (cwd: string) => void
  onStopServer?: (cwd: string) => void
}): React.JSX.Element {
  const serverLabel = isLoading
    ? 'Checking'
    : diagnostics?.jupyterServer.available
      ? `Jupyter ${diagnostics.jupyterServer.version ?? 'available'}`
      : 'Jupyter missing'
  const canStopServer = serverStatus?.state === 'starting' || serverStatus?.state === 'ready'
  const canControlServer = Boolean(projectCwd && (onStartServer || onStopServer))
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 1.25, minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="caption" sx={{ flex: 1, fontWeight: 800 }}>
          Kernel
        </Typography>
        {onRefresh ? (
          <Tooltip title="刷新 kernels">
            <IconButton size="small" onClick={onRefresh}>
              <RefreshIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ) : null}
      </Box>
      <Stack direction="row" spacing={0.75} sx={{ mt: 1, flexWrap: 'wrap', rowGap: 0.75 }}>
        <Chip size="small" variant="outlined" label={serverLabel} />
        <Chip
          size="small"
          color={jupyterServerStateColor(serverStatus)}
          variant="outlined"
          label={jupyterServerStateLabel(serverStatus)}
        />
        <Chip
          size="small"
          color={notebookSessionStateColor(notebookSessionStatus)}
          variant="outlined"
          label={notebookSessionStateLabel(notebookSessionStatus)}
        />
        <Chip
          size="small"
          color={diagnostics?.hasPythonKernel ? 'success' : 'warning'}
          variant="outlined"
          label={diagnostics?.hasPythonKernel ? 'Python kernel' : 'Python missing'}
        />
        <Chip
          size="small"
          color={diagnostics?.hasRKernel ? 'success' : 'warning'}
          variant="outlined"
          label={diagnostics?.hasRKernel ? 'R kernel' : 'R missing'}
        />
      </Stack>
      {canControlServer ? (
        <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
          <Button
            size="small"
            variant={canStopServer ? 'outlined' : 'contained'}
            startIcon={
              canStopServer ? <StopIcon fontSize="small" /> : <PlayIcon fontSize="small" />
            }
            disabled={Boolean(isStartingServer)}
            onClick={() => {
              if (!projectCwd) return
              if (canStopServer) {
                onStopServer?.(projectCwd)
              } else {
                onStartServer?.(projectCwd)
              }
            }}
          >
            {canStopServer ? '停止 Jupyter' : '启动 Jupyter'}
          </Button>
          {onRefreshServer ? (
            <Button
              size="small"
              variant="text"
              startIcon={<RefreshIcon fontSize="small" />}
              onClick={onRefreshServer}
            >
              状态
            </Button>
          ) : null}
        </Stack>
      ) : null}
      {error ? (
        <Typography variant="caption" color="error.main" sx={{ display: 'block', mt: 1 }}>
          {error}
        </Typography>
      ) : null}
      {serverError ? (
        <Typography variant="caption" color="error.main" sx={{ display: 'block', mt: 1 }}>
          {serverError}
        </Typography>
      ) : null}
      {serverStatus?.message ? (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
          {serverStatus.message}
        </Typography>
      ) : null}
      {notebookSessionStatus?.message ? (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
          {notebookSessionStatus.message}
        </Typography>
      ) : null}
      {diagnostics?.messages.map((message) => (
        <Typography
          key={message}
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mt: 0.75 }}
        >
          {message}
        </Typography>
      ))}
    </Box>
  )
}

function VariablesTab({
  projectCwd,
  kernelDiagnostics,
  isLoadingKernels,
  kernelError,
  jupyterServerStatus,
  isStartingJupyterServer,
  jupyterServerError,
  notebookSessionStatus,
  onRefreshKernels,
  onRefreshJupyterServer,
  onStartJupyterServer,
  onStopJupyterServer
}: {
  projectCwd?: string | null
  kernelDiagnostics?: AnalysisKernelDiagnostics | null
  isLoadingKernels?: boolean
  kernelError?: string | null
  jupyterServerStatus?: JupyterServerStatus | null
  isStartingJupyterServer?: boolean
  jupyterServerError?: string | null
  notebookSessionStatus?: AnalysisNotebookSessionStatus | null
  onRefreshKernels?: () => void
  onRefreshJupyterServer?: () => void
  onStartJupyterServer?: (cwd: string) => void
  onStopJupyterServer?: (cwd: string) => void
}): React.JSX.Element {
  return (
    <Stack spacing={1}>
      <KernelStatusSummary
        projectCwd={projectCwd}
        diagnostics={kernelDiagnostics}
        isLoading={isLoadingKernels}
        error={kernelError}
        serverStatus={jupyterServerStatus}
        isStartingServer={isStartingJupyterServer}
        serverError={jupyterServerError}
        notebookSessionStatus={notebookSessionStatus}
        onRefresh={onRefreshKernels}
        onRefreshServer={onRefreshJupyterServer}
        onStartServer={onStartJupyterServer}
        onStopServer={onStopJupyterServer}
      />
      <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 1.25 }}>
        <Typography variant="body2" sx={{ fontWeight: 700 }}>
          变量检查
        </Typography>
        <Typography variant="caption" color="text.secondary">
          暂时保持收起；接入真实 kernel 变量抓取 API 后再显示变量列表。
        </Typography>
      </Box>
    </Stack>
  )
}

function ArtifactsTab({
  notebookFile
}: {
  notebookFile?: AnalysisNotebookFile | null
}): React.JSX.Element {
  const artifacts = notebookArtifacts(notebookFile?.document)

  return (
    <Stack spacing={1}>
      {notebookFile ? (
        <>
          <Typography variant="caption" color="text.secondary" noWrap>
            {notebookFile.relativePath}
          </Typography>
          {artifacts.length > 0 ? (
            artifacts.map((artifact) => (
              <Box
                key={artifact.id}
                sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 1.25, minWidth: 0 }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0, fontWeight: 800 }}>
                    {artifact.name}
                  </Typography>
                  <Chip size="small" label={artifact.kind} />
                </Box>
                <Typography variant="caption" color="text.secondary">
                  {artifact.source} · {artifact.size}
                </Typography>
              </Box>
            ))
          ) : (
            <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 1.25 }}>
              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                没有输出产物
              </Typography>
              <Typography variant="caption" color="text.secondary">
                运行产生 HTML、图片或 JSON 输出的 cell 后，这里会显示真实产物。
              </Typography>
            </Box>
          )}
        </>
      ) : (
        <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 1.25 }}>
          <Typography variant="body2" sx={{ fontWeight: 700 }}>
            还没有打开 notebook
          </Typography>
          <Typography variant="caption" color="text.secondary">
            打开 notebook 后显示真实输出产物。
          </Typography>
        </Box>
      )}
    </Stack>
  )
}

function InspectorContent({
  tab,
  notebooks,
  activeNotebookPath,
  notebookRegistry,
  notebookFile,
  isLoadingNotebooks,
  notebookError,
  projectCwd,
  kernelDiagnostics,
  isLoadingKernels,
  kernelError,
  jupyterServerStatus,
  isStartingJupyterServer,
  jupyterServerError,
  notebookSessionStatus,
  onOpenNotebook,
  onRefreshNotebooks,
  onCreateNotebook,
  onDeleteNotebook,
  onInitializeProjectAnalysis,
  onRefreshKernels,
  onRefreshJupyterServer,
  onStartJupyterServer,
  onStopJupyterServer
}: {
  tab: InspectorTab
  notebooks: NotebookListEntry[]
  activeNotebookPath: string | null
  notebookRegistry?: AnalysisNotebookRegistry | null
  notebookFile?: AnalysisNotebookFile | null
  isLoadingNotebooks?: boolean
  notebookError?: string | null
  projectCwd?: string | null
  kernelDiagnostics?: AnalysisKernelDiagnostics | null
  isLoadingKernels?: boolean
  kernelError?: string | null
  jupyterServerStatus?: JupyterServerStatus | null
  isStartingJupyterServer?: boolean
  jupyterServerError?: string | null
  notebookSessionStatus?: AnalysisNotebookSessionStatus | null
  onOpenNotebook?: (path: string) => void
  onRefreshNotebooks?: () => void
  onCreateNotebook?: (cwd: string) => void
  onDeleteNotebook?: (file: { path: string; relativePath: string }) => void
  onInitializeProjectAnalysis?: (cwd: string) => void
  onRefreshKernels?: () => void
  onRefreshJupyterServer?: () => void
  onStartJupyterServer?: (cwd: string) => void
  onStopJupyterServer?: (cwd: string) => void
}): React.JSX.Element {
  if (tab === 'variables') {
    return (
      <VariablesTab
        projectCwd={projectCwd}
        kernelDiagnostics={kernelDiagnostics}
        isLoadingKernels={isLoadingKernels}
        kernelError={kernelError}
        jupyterServerStatus={jupyterServerStatus}
        isStartingJupyterServer={isStartingJupyterServer}
        jupyterServerError={jupyterServerError}
        notebookSessionStatus={notebookSessionStatus}
        onRefreshKernels={onRefreshKernels}
        onRefreshJupyterServer={onRefreshJupyterServer}
        onStartJupyterServer={onStartJupyterServer}
        onStopJupyterServer={onStopJupyterServer}
      />
    )
  }
  if (tab === 'artifacts') return <ArtifactsTab notebookFile={notebookFile} />
  return (
    <FilesTab
      notebooks={notebooks}
      activeNotebookPath={activeNotebookPath}
      registry={notebookRegistry}
      isLoading={isLoadingNotebooks}
      error={notebookError}
      onOpenNotebook={onOpenNotebook}
      onRefreshNotebooks={onRefreshNotebooks}
      onCreateNotebook={onCreateNotebook}
      onDeleteNotebook={onDeleteNotebook}
      onInitializeProjectAnalysis={onInitializeProjectAnalysis}
    />
  )
}

function RightInspector({
  tab,
  width,
  notebooks,
  activeNotebookPath,
  notebookRegistry,
  notebookFile,
  isLoadingNotebooks,
  notebookError,
  projectCwd,
  kernelDiagnostics,
  isLoadingKernels,
  kernelError,
  jupyterServerStatus,
  isStartingJupyterServer,
  jupyterServerError,
  notebookSessionStatus,
  onTabChange,
  onOpenNotebook,
  onRefreshNotebooks,
  onCreateNotebook,
  onDeleteNotebook,
  onInitializeProjectAnalysis,
  onRefreshKernels,
  onRefreshJupyterServer,
  onStartJupyterServer,
  onStopJupyterServer
}: {
  tab: InspectorTab
  width: number
  notebooks: NotebookListEntry[]
  activeNotebookPath: string | null
  notebookRegistry?: AnalysisNotebookRegistry | null
  notebookFile?: AnalysisNotebookFile | null
  isLoadingNotebooks?: boolean
  notebookError?: string | null
  projectCwd?: string | null
  kernelDiagnostics?: AnalysisKernelDiagnostics | null
  isLoadingKernels?: boolean
  kernelError?: string | null
  jupyterServerStatus?: JupyterServerStatus | null
  isStartingJupyterServer?: boolean
  jupyterServerError?: string | null
  notebookSessionStatus?: AnalysisNotebookSessionStatus | null
  onTabChange: (tab: InspectorTab) => void
  onOpenNotebook?: (path: string) => void
  onRefreshNotebooks?: () => void
  onCreateNotebook?: (cwd: string) => void
  onDeleteNotebook?: (file: { path: string; relativePath: string }) => void
  onInitializeProjectAnalysis?: (cwd: string) => void
  onRefreshKernels?: () => void
  onRefreshJupyterServer?: () => void
  onStartJupyterServer?: (cwd: string) => void
  onStopJupyterServer?: (cwd: string) => void
}): React.JSX.Element {
  const tabs = useMemo(
    () => [
      { value: 'files' as const, label: 'Files' },
      { value: 'variables' as const, label: 'Variables' },
      { value: 'artifacts' as const, label: 'Artifacts' }
    ],
    []
  )

  return (
    <Box
      sx={{
        width,
        flexShrink: 0,
        borderLeft: 1,
        borderColor: 'divider',
        pt: isMac ? `${macTitlebarHeight + contentTopGap}px` : 0,
        display: 'flex',
        minHeight: 0,
        flexDirection: 'column',
        bgcolor: (theme) =>
          theme.palette.mode === 'dark' ? theme.palette.background.default : '#FFFFFF'
      }}
    >
      <Box
        sx={{
          minHeight: 36,
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          pl: 1,
          pr: 1
        }}
      >
        <Tabs
          value={tab}
          onChange={(_, value: InspectorTab) => onTabChange(value)}
          variant="fullWidth"
          sx={{
            flex: 1,
            minHeight: 36,
            minWidth: 0,
            '& .MuiTab-root': { minHeight: 36, py: 0.5, px: 0.5 }
          }}
        >
          {tabs.map(({ value, label }) => (
            <Tab key={value} value={value} label={label} />
          ))}
        </Tabs>
      </Box>
      <Divider />
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', p: 1.5 }}>
        <InspectorContent
          tab={tab}
          notebooks={notebooks}
          activeNotebookPath={activeNotebookPath}
          notebookRegistry={notebookRegistry}
          notebookFile={notebookFile}
          isLoadingNotebooks={isLoadingNotebooks}
          notebookError={notebookError}
          projectCwd={projectCwd}
          kernelDiagnostics={kernelDiagnostics}
          isLoadingKernels={isLoadingKernels}
          kernelError={kernelError}
          jupyterServerStatus={jupyterServerStatus}
          isStartingJupyterServer={isStartingJupyterServer}
          jupyterServerError={jupyterServerError}
          notebookSessionStatus={notebookSessionStatus}
          onOpenNotebook={onOpenNotebook}
          onRefreshNotebooks={onRefreshNotebooks}
          onCreateNotebook={onCreateNotebook}
          onDeleteNotebook={onDeleteNotebook}
          onInitializeProjectAnalysis={onInitializeProjectAnalysis}
          onRefreshKernels={onRefreshKernels}
          onRefreshJupyterServer={onRefreshJupyterServer}
          onStartJupyterServer={onStartJupyterServer}
          onStopJupyterServer={onStopJupyterServer}
        />
      </Box>
    </Box>
  )
}

function ResizeSeparator({
  label,
  onMouseDown
}: {
  label: string
  onMouseDown: (event: MouseEvent<HTMLDivElement>) => void
}): React.JSX.Element {
  return (
    <Box
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
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

export default function AnalysisView({
  notebookRegistry,
  notebookFile,
  initialLeftPanel = 'chat',
  initialInspectorTab = 'files',
  initialInspectorCollapsed = false,
  isLoadingNotebooks = false,
  isOpeningNotebook = false,
  notebookError = null,
  notebookContentError = null,
  kernelDiagnostics = null,
  isLoadingKernels = false,
  kernelError = null,
  jupyterServerStatus = null,
  isStartingJupyterServer = false,
  jupyterServerError = null,
  notebookSessionStatus = null,
  isStartingNotebookSession = false,
  notebookSessionError = null,
  executingNotebookCellId = null,
  notebookCellExecutionError = null,
  onRefreshNotebooks,
  onRefreshKernels,
  onRefreshJupyterServer,
  onStartJupyterServer,
  onStopJupyterServer,
  onStartNotebookSession,
  onStopNotebookSession,
  onRunNotebookCell,
  onInitializeProjectAnalysis,
  onOpenNotebook,
  onSaveNotebook,
  onCreateNotebook,
  onDeleteNotebook,
  chatPanel
}: AnalysisViewProps = {}): React.JSX.Element {
  const [leftPanel, setLeftPanel] = useState<LeftPanel>(initialLeftPanel)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>(initialInspectorTab)
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [inspectorCollapsed, setInspectorCollapsed] = useState(initialInspectorCollapsed)
  const [leftWidth, setLeftWidth] = useState(leftRailWidth)
  const [rightWidth, setRightWidth] = useState(inspectorWidth)
  const notebooks = useMemo(() => registryNotebooks(notebookRegistry), [notebookRegistry])
  const [selectedNotebookPath, setSelectedNotebookPath] = useState<string | null>(
    notebooks[0]?.path ?? null
  )
  const selectedPathIsAvailable = Boolean(
    selectedNotebookPath && notebooks.some((notebook) => notebook.path === selectedNotebookPath)
  )
  const activeNotebookPath =
    notebookFile?.relativePath ??
    (selectedPathIsAvailable ? selectedNotebookPath : (notebooks[0]?.path ?? null))

  const onSelectNotebook = (notebook: NotebookListEntry): void => {
    setSelectedNotebookPath(notebook.path)
    if (notebook.absolutePath) {
      onOpenNotebook?.(notebook.absolutePath)
    }
  }
  const onStartLeftResize = useCallback(
    (event: MouseEvent<HTMLDivElement>): void => {
      event.preventDefault()

      const startX = event.clientX
      const startWidth = leftWidth
      const onMouseMove = (moveEvent: globalThis.MouseEvent): void => {
        const delta = moveEvent.clientX - startX
        setLeftWidth(Math.min(maxLeftRailWidth, Math.max(minLeftRailWidth, startWidth + delta)))
      }

      const onMouseUp = (): void => {
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    },
    [leftWidth]
  )
  const onStartRightResize = useCallback(
    (event: MouseEvent<HTMLDivElement>): void => {
      event.preventDefault()

      const startX = event.clientX
      const startWidth = rightWidth
      const onMouseMove = (moveEvent: globalThis.MouseEvent): void => {
        const delta = moveEvent.clientX - startX
        setRightWidth(Math.min(maxInspectorWidth, Math.max(minInspectorWidth, startWidth - delta)))
      }

      const onMouseUp = (): void => {
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    },
    [rightWidth]
  )

  return (
    <Box
      component="main"
      sx={{
        flex: 1,
        minWidth: 0,
        height: '100vh',
        display: 'flex',
        position: 'relative',
        overflow: 'hidden',
        bgcolor: (theme: Theme) =>
          theme.palette.mode === 'dark' ? theme.palette.background.default : '#FFFFFF'
      }}
    >
      <LeftRail
        panel={leftPanel}
        collapsed={leftCollapsed}
        width={leftWidth}
        notebooks={notebooks}
        activeNotebookPath={activeNotebookPath}
        notebookRegistry={notebookRegistry}
        isLoadingNotebooks={isLoadingNotebooks}
        notebookError={notebookError}
        onPanelChange={setLeftPanel}
        onSelectNotebook={onSelectNotebook}
        onRefreshNotebooks={onRefreshNotebooks}
        onInitializeProjectAnalysis={onInitializeProjectAnalysis}
        onCreateNotebook={onCreateNotebook}
        chatPanel={chatPanel}
        onToggleCollapsed={() => setLeftCollapsed((value) => !value)}
      />
      {!leftCollapsed ? (
        <ResizeSeparator label="调整分析侧栏宽度" onMouseDown={onStartLeftResize} />
      ) : null}
      <NotebookCanvas
        key={
          notebookFile
            ? `${notebookFile.path}:${notebookFile.savedRevision}:${notebookFile.document.revision}`
            : 'empty'
        }
        activeNotebookPath={activeNotebookPath ?? 'No notebook selected'}
        notebookFile={notebookFile}
        initialDocument={notebookFile?.document ?? null}
        isOpening={isOpeningNotebook}
        error={notebookContentError}
        kernelDiagnostics={kernelDiagnostics}
        isLoadingKernels={isLoadingKernels}
        kernelError={kernelError}
        notebookSessionStatus={notebookSessionStatus}
        isStartingNotebookSession={isStartingNotebookSession}
        notebookSessionError={notebookSessionError}
        executingCellId={executingNotebookCellId}
        cellExecutionError={notebookCellExecutionError}
        onSaveNotebook={onSaveNotebook}
        onRefreshKernels={onRefreshKernels}
        onStartNotebookSession={onStartNotebookSession}
        onStopNotebookSession={onStopNotebookSession}
        onRunNotebookCell={onRunNotebookCell}
      />
      {!inspectorCollapsed ? (
        <ResizeSeparator label="调整检查器宽度" onMouseDown={onStartRightResize} />
      ) : null}
      {!inspectorCollapsed ? (
        <RightInspector
          tab={inspectorTab}
          width={rightWidth}
          notebooks={notebooks}
          activeNotebookPath={activeNotebookPath}
          notebookRegistry={notebookRegistry}
          notebookFile={notebookFile}
          isLoadingNotebooks={isLoadingNotebooks}
          notebookError={notebookError}
          projectCwd={notebookRegistry?.projectCwd ?? null}
          kernelDiagnostics={kernelDiagnostics}
          isLoadingKernels={isLoadingKernels}
          kernelError={kernelError}
          jupyterServerStatus={jupyterServerStatus}
          isStartingJupyterServer={isStartingJupyterServer}
          jupyterServerError={jupyterServerError}
          notebookSessionStatus={notebookSessionStatus}
          onTabChange={setInspectorTab}
          onOpenNotebook={onOpenNotebook}
          onRefreshNotebooks={onRefreshNotebooks}
          onCreateNotebook={onCreateNotebook}
          onDeleteNotebook={onDeleteNotebook}
          onInitializeProjectAnalysis={onInitializeProjectAnalysis}
          onRefreshKernels={onRefreshKernels}
          onRefreshJupyterServer={onRefreshJupyterServer}
          onStartJupyterServer={onStartJupyterServer}
          onStopJupyterServer={onStopJupyterServer}
        />
      ) : null}
      <InspectorToggleButton
        isCollapsed={inspectorCollapsed}
        onToggle={() => setInspectorCollapsed((value) => !value)}
      />
    </Box>
  )
}
