import { useMemo, useState } from 'react'
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
  type NotebookDocument
} from '../../../shared/notebookDocument'
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
  onInitializeProjectAnalysis?: (cwd: string) => void
  onOpenNotebook?: (path: string) => void
  onSaveNotebook?: (file: AnalysisNotebookFile, document: NotebookDocument) => void
  onCreateNotebook?: (cwd: string) => void
}

type CanvasCell = {
  id: string
  count: number | null
  type: 'markdown' | 'code' | 'raw'
  language?: string
  state: CellState
  source: string
  output?: string
  agentTouched?: boolean
}

const AddIcon = PhiIcons.action.add
const AnalysisIcon = PhiIcons.nav.analysis
const ChatIcon = PhiIcons.nav.chat
const CollapseIcon = PhiIcons.action.collapse
const ExpandIcon = PhiIcons.action.expand
const FileIcon = PhiIcons.tool.read
const FolderIcon = PhiIcons.entity.folder
const MoreIcon = PhiIcons.action.more
const NotebookIcon = PhiIcons.nav.analysis
const PlayIcon = PhiIcons.action.quick
const RefreshIcon = PhiIcons.action.refresh
const StopIcon = PhiIcons.action.stop
const VariableIcon = PhiIcons.state.thinking

const isMac = typeof window !== 'undefined' && window.platform === 'darwin'
const macTitlebarHeight = 44
const contentTopGap = 8
const leftRailWidth = 300
const collapsedRailWidth = 44
const inspectorWidth = 340
const collapsedInspectorWidth = 48

const mockNotebooks: NotebookListEntry[] = [
  { id: 'exploration', path: 'notebooks/exploration.ipynb', status: 'Unsaved' },
  { id: 'qc', path: 'notebooks/qc-summary.ipynb', status: 'Saved' },
  { id: 'figures', path: 'notebooks/figures.ipynb', status: 'Saved' }
]

const mockCells: CanvasCell[] = [
  {
    id: 'intro',
    count: null,
    type: 'markdown',
    state: 'idle',
    source:
      '# Exploratory analysis\nLoad the sample table, inspect basic quality metrics, and sketch the first PCA view.'
  },
  {
    id: 'load-data',
    count: 1,
    type: 'code',
    language: 'python',
    state: 'idle',
    source: "import pandas as pd\nsamples = pd.read_csv('data/raw/samples.csv')\nsamples.head()",
    output:
      '5 rows x 8 columns · sample_id, condition, batch, reads, mapped_pct, duplication_pct...',
    agentTouched: true
  },
  {
    id: 'qc-summary',
    count: 2,
    type: 'code',
    language: 'python',
    state: 'stale',
    source: "qc = samples.groupby('condition')[['reads', 'mapped_pct']].mean()\nqc",
    output: 'Output is stale after Cell 1 changed.'
  },
  {
    id: 'plot',
    count: 3,
    type: 'code',
    language: 'python',
    state: 'running',
    source:
      "fig = px.scatter(pca, x='PC1', y='PC2', color='condition')\nfig.write_html('outputs/exploration/pca.html')",
    output: 'Saving interactive artifact...'
  },
  {
    id: 'error',
    count: 4,
    type: 'code',
    language: 'R',
    state: 'error',
    source: 'library(ggplot2)\nggplot(samples, aes(condition, mapped_pct)) + geom_boxplot()',
    output: "Error: object 'mapped_pct' not found in R kernel"
  }
]

const analysisFiles = [
  'notebooks/exploration.ipynb',
  'data/raw/samples.csv',
  'outputs/exploration/pca.html',
  'reports/qc-summary.html',
  'workflows/main.nf'
]

const variables = [
  { name: 'samples', type: 'DataFrame', shape: '128 x 8', detail: '8 columns · 2 missing values' },
  { name: 'qc', type: 'DataFrame', shape: '4 x 2', detail: 'condition-level summary' },
  { name: 'fig', type: 'Plotly Figure', shape: 'artifact', detail: 'outputs/exploration/pca.html' }
]

const artifacts = [
  { source: 'Cell 3', name: 'pca.html', kind: 'HTML', size: '241 KB' },
  { source: 'Cell 2', name: 'qc_table.csv', kind: 'Table', size: '3 KB' },
  { source: 'Cell 4', name: 'r-boxplot-error.txt', kind: 'Log', size: '1 KB' }
]

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

function textFromOutputData(data: JsonObject): string | undefined {
  const plain = data['text/plain']
  if (typeof plain === 'string') return plain
  if (Array.isArray(plain)) {
    return plain.map((item) => (typeof item === 'string' ? item : '')).join('')
  }
  return undefined
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

function documentCells(document: NotebookDocument): CanvasCell[] {
  const language = notebookLanguage(document)
  return document.cells.map((cell) => ({
    id: cell.id,
    count: cell.executionCount,
    type: cell.cellType,
    language: cell.cellType === 'code' ? language : undefined,
    state: cell.outputs.some((output) => output.outputType === 'error') ? 'error' : 'idle',
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
  if (!registry) return mockNotebooks
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
      <Box sx={{ px: 1.5, pb: 1.25 }}>
        <Typography variant="caption" color="text.secondary">
          Context
        </Typography>
        <Typography
          variant="body2"
          sx={{ mt: 0.25, fontFamily: 'var(--font-mono)', fontWeight: 700 }}
        >
          {activeNotebookPath} · Cell 3
        </Typography>
        <Stack direction="row" spacing={0.75} sx={{ mt: 1, flexWrap: 'wrap', rowGap: 0.75 }}>
          <Chip size="small" color="primary" variant="outlined" label="Selected cell" />
          <Chip size="small" variant="outlined" label="Notebook" />
          <Chip size="small" variant="outlined" label="Project" />
        </Stack>
      </Box>
      <Divider />
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', p: 1.5 }}>
        <Stack spacing={1.2}>
          <Box
            sx={{
              alignSelf: 'flex-start',
              borderRadius: 2,
              bgcolor: 'action.hover',
              px: 1.25,
              py: 1
            }}
          >
            <Typography variant="body2">
              我已把 PCA 图保存为交互式 artifact，并标记 Cell 2 输出过期。
            </Typography>
          </Box>
          <Box
            sx={{
              alignSelf: 'stretch',
              border: 1,
              borderColor: 'divider',
              borderRadius: 2,
              px: 1.25,
              py: 1
            }}
          >
            <Typography variant="caption" color="text.secondary">
              Agent transaction
            </Typography>
            <Typography variant="body2" sx={{ mt: 0.25 }}>
              Updated Cell 1, appended Cell 3, saved 1 artifact.
            </Typography>
          </Box>
        </Stack>
      </Box>
      <Divider />
      <Box sx={{ p: 1.5 }}>
        <TextField
          fullWidth
          multiline
          minRows={2}
          maxRows={4}
          placeholder="询问当前 cell、notebook 或项目..."
          size="small"
        />
        <Box sx={{ mt: 1, display: 'flex', justifyContent: 'space-between', gap: 1 }}>
          <Button size="small" variant="outlined" startIcon={<AddIcon fontSize="small" />}>
            引用
          </Button>
          <Button size="small" variant="contained" endIcon={<ChatIcon fontSize="small" />}>
            发送
          </Button>
        </Box>
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
  onToggleCollapsed
}: {
  panel: LeftPanel
  collapsed: boolean
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
  onToggleCollapsed: () => void
}): React.JSX.Element {
  if (collapsed) {
    return (
      <Box
        sx={{
          width: collapsedRailWidth,
          flexShrink: 0,
          borderRight: 1,
          borderColor: 'divider',
          pt: isMac ? `${macTitlebarHeight + contentTopGap}px` : 1,
          display: 'flex',
          alignItems: 'center',
          flexDirection: 'column',
          gap: 0.75
        }}
      >
        <Tooltip title="展开分析侧栏" placement="right">
          <IconButton size="small" onClick={onToggleCollapsed}>
            <ExpandIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Box
          aria-label="Notebook has unsaved changes"
          sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'warning.main' }}
        />
        <Box
          aria-label="Agent activity idle"
          sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'success.main' }}
        />
      </Box>
    )
  }

  return (
    <Box
      sx={{
        width: leftRailWidth,
        flexShrink: 0,
        borderRight: 1,
        borderColor: 'divider',
        pt: isMac ? `${macTitlebarHeight + contentTopGap}px` : 1.5,
        display: 'flex',
        minHeight: 0,
        flexDirection: 'column',
        bgcolor: (theme) =>
          theme.palette.mode === 'dark' ? theme.palette.background.default : '#FFFFFF'
      }}
    >
      <Box sx={{ px: 1.5, pb: 1.25, display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 800 }}>
            分析
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap>
            本地 notebook workbench
          </Typography>
        </Box>
        <Tooltip title="收起分析侧栏">
          <IconButton size="small" onClick={onToggleCollapsed}>
            <CollapseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
      <Box sx={{ px: 1.5, pb: 1 }}>
        <Tabs
          value={panel}
          onChange={(_, value: LeftPanel) => onPanelChange(value)}
          variant="fullWidth"
          sx={{ minHeight: 34, '& .MuiTab-root': { minHeight: 34, py: 0.5 } }}
        >
          <Tab value="chat" label="Chat" />
          <Tab value="notebooks" label="Notebooks" />
        </Tabs>
      </Box>
      {panel === 'chat' ? (
        <AnalysisChatPanel activeNotebookPath={activeNotebookPath ?? 'No notebook selected'} />
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
      <Chip size="small" variant="outlined" label={kernelLabel} />
      <Chip size="small" color={kernelStatusColor} variant="outlined" label={kernelStatusLabel} />
      <Chip
        size="small"
        color={isDirty ? 'warning' : 'success'}
        variant="outlined"
        label={isDirty ? 'Unsaved' : 'Saved'}
      />
      <Stack direction="row" spacing={0.5} sx={{ WebkitAppRegion: 'no-drag' }}>
        {hasDocument ? (
          <Button
            size="small"
            variant="contained"
            disabled={!isDirty || isOpening}
            onClick={onSave}
          >
            保存
          </Button>
        ) : null}
        {onRefreshKernels ? (
          <Tooltip title="刷新 kernels">
            <IconButton size="small" aria-label="刷新 kernels" onClick={onRefreshKernels}>
              <RefreshIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ) : null}
        {canConnectNotebookSession ? (
          <Button
            size="small"
            variant="outlined"
            startIcon={<PlayIcon fontSize="small" />}
            disabled={Boolean(isStartingNotebookSession)}
            onClick={() => {
              if (notebookFile && draftDocument) {
                onStartNotebookSession?.(notebookFile, draftDocument)
              }
            }}
          >
            连接 kernel
          </Button>
        ) : null}
        {canDisconnectNotebookSession ? (
          <Button
            size="small"
            variant="outlined"
            color="warning"
            startIcon={<StopIcon fontSize="small" />}
            disabled={Boolean(isStartingNotebookSession)}
            onClick={() => {
              if (notebookFile) onStopNotebookSession?.(notebookFile)
            }}
          >
            断开
          </Button>
        ) : null}
        <Tooltip title="运行全部 cell">
          <IconButton size="small" aria-label="运行全部 cell" disabled>
            <PlayIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="中断 kernel">
          <IconButton size="small" aria-label="中断 kernel" disabled>
            <StopIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="重启 kernel">
          <IconButton size="small" aria-label="重启 kernel" disabled>
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="更多 notebook 操作">
          <IconButton size="small" aria-label="更多 notebook 操作">
            <MoreIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
    </Box>
  )
}

function Cell({
  cell,
  editable = false,
  onSourceChange,
  onInsertAfter
}: {
  cell: CanvasCell
  editable?: boolean
  onSourceChange?: (cellId: string, source: string) => void
  onInsertAfter?: (cellId: string) => void
}): React.JSX.Element {
  const isMarkdown = cell.type === 'markdown'
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: '44px minmax(0, 1fr)',
        gap: 1.25,
        py: 1.6,
        '&:hover .cell-hover-actions': { opacity: 1 }
      }}
    >
      <Box
        sx={{ display: 'flex', alignItems: 'center', flexDirection: 'column', gap: 0.8, pt: 0.5 }}
      >
        <Tooltip title="运行 cell">
          <IconButton size="small" aria-label="运行 cell" sx={{ width: 30, height: 30 }}>
            <PlayIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Typography
          variant="caption"
          sx={{ fontFamily: 'var(--font-mono)', color: 'text.secondary', minHeight: 18 }}
        >
          {cell.count ?? ''}
        </Typography>
        <Box
          sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: stateColor(cell.state) }}
          title={stateLabel(cell.state)}
        />
        {cell.agentTouched ? (
          <Tooltip title="Agent transaction: updated source and saved output preview">
            <Box
              sx={{
                width: 18,
                height: 18,
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                bgcolor: 'action.selected',
                color: 'primary.main'
              }}
            >
              <VariableIcon sx={{ fontSize: 13 }} />
            </Box>
          </Tooltip>
        ) : null}
      </Box>
      <Box
        sx={{
          minWidth: 0,
          border: 1,
          borderColor: cell.state === 'error' ? 'error.main' : 'divider',
          borderRadius: 2,
          bgcolor: (theme) =>
            alpha(theme.palette.background.paper, theme.palette.mode === 'dark' ? 0.5 : 0.9),
          overflow: 'hidden'
        }}
      >
        <Box
          className="cell-hover-actions"
          sx={{
            minHeight: 34,
            px: 1.25,
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            borderBottom: isMarkdown ? 0 : 1,
            borderColor: 'divider',
            opacity: cell.state === 'running' || cell.state === 'error' ? 1 : 0.2,
            transition: 'opacity 150ms ease'
          }}
        >
          <Chip
            size="small"
            label={isMarkdown ? 'Markdown' : (cell.language ?? 'Code')}
            variant="outlined"
          />
          <Chip
            size="small"
            label={stateLabel(cell.state)}
            sx={{ color: stateColor(cell.state) }}
          />
          <Box sx={{ flex: 1 }} />
          <Tooltip title="插入 cell">
            <IconButton
              size="small"
              aria-label="插入 cell"
              onClick={() => onInsertAfter?.(cell.id)}
            >
              <AddIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="更多 cell 操作">
            <IconButton size="small" aria-label="更多 cell 操作">
              <MoreIcon fontSize="small" />
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
                  p: isMarkdown ? 2 : 1.5,
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
              p: isMarkdown ? 2 : 1.5,
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
                px: 1.5,
                py: 1.25,
                bgcolor: (theme) => alpha(theme.palette.text.primary, 0.035)
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
  onSaveNotebook,
  onRefreshKernels,
  onStartNotebookSession,
  onStopNotebookSession
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
  onSaveNotebook?: (file: AnalysisNotebookFile, document: NotebookDocument) => void
  onRefreshKernels?: () => void
  onStartNotebookSession?: (file: AnalysisNotebookFile, document: NotebookDocument) => void
  onStopNotebookSession?: (file: AnalysisNotebookFile) => void
}): React.JSX.Element {
  const [draftDocument, setDraftDocument] = useState<NotebookDocument | null>(initialDocument)
  const cells = draftDocument ? documentCells(draftDocument) : mockCells
  const kernelLabel = draftDocument ? notebookLanguage(draftDocument) : 'Python 3.11'
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
  const onInsertCell = (cellId: string): void => {
    setDraftDocument((document) => {
      if (!document) return document
      const index = document.cells.findIndex((cell) => cell.id === cellId)
      return insertNotebookCell(document, index + 1, { cellType: 'code', source: '' })
    })
  }
  const onSave = (): void => {
    if (notebookFile && draftDocument) {
      onSaveNotebook?.(notebookFile, draftDocument)
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
          {!isOpening &&
            cells.map((cell) => (
              <Cell
                key={cell.id}
                cell={cell}
                editable={Boolean(draftDocument)}
                onSourceChange={onUpdateCellSource}
                onInsertAfter={onInsertCell}
              />
            ))}
        </Box>
      </Box>
    </Box>
  )
}

function FilesTab(): React.JSX.Element {
  return (
    <List dense disablePadding>
      {analysisFiles.map((path) => {
        const isFolder = !path.includes('.')
        const Icon = isFolder ? FolderIcon : FileIcon
        return (
          <ListItemButton key={path} sx={{ px: 1, borderRadius: 1 }}>
            <Icon
              fontSize="small"
              sx={{ mr: 1, color: isFolder ? 'info.main' : 'text.secondary' }}
            />
            <ListItemText
              primary={path}
              slotProps={{
                primary: {
                  noWrap: true,
                  sx: { fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }
                }
              }}
            />
          </ListItemButton>
        )
      })}
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
          Kernel diagnostics
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
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
        <Typography variant="caption" color="text.secondary">
          Refreshed after Cell 3
        </Typography>
        <Button size="small" startIcon={<RefreshIcon fontSize="small" />}>
          刷新
        </Button>
      </Box>
      {variables.map((variable) => (
        <Box
          key={variable.name}
          sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 1.25, minWidth: 0 }}
        >
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            <Typography
              variant="body2"
              sx={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)', fontWeight: 800 }}
              noWrap
            >
              {variable.name}
            </Typography>
            <Chip size="small" variant="outlined" label={variable.type} />
          </Box>
          <Typography variant="caption" color="text.secondary">
            {variable.shape} · {variable.detail}
          </Typography>
        </Box>
      ))}
      <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, overflow: 'hidden' }}>
        <Box sx={{ px: 1.25, py: 0.9, borderBottom: 1, borderColor: 'divider' }}>
          <Typography variant="caption" sx={{ fontWeight: 800 }}>
            Data Preview · samples
          </Typography>
        </Box>
        {[
          'sample_id | condition | reads | mapped_pct',
          'S1        | treated   | 24011 | 92.4',
          'S2        | control   | 19842 | 89.7'
        ].map((row) => (
          <Typography
            key={row}
            component="pre"
            variant="caption"
            sx={{ m: 0, px: 1.25, py: 0.45, fontFamily: 'var(--font-mono)' }}
          >
            {row}
          </Typography>
        ))}
      </Box>
    </Stack>
  )
}

function ArtifactsTab(): React.JSX.Element {
  return (
    <Stack spacing={1}>
      <Typography variant="caption" color="text.secondary">
        notebooks/exploration.ipynb
      </Typography>
      {artifacts.map((artifact) => (
        <Box
          key={artifact.name}
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
      ))}
    </Stack>
  )
}

function InspectorContent({
  tab,
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
  tab: InspectorTab
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
  if (tab === 'artifacts') return <ArtifactsTab />
  return <FilesTab />
}

function RightInspector({
  tab,
  collapsed,
  projectCwd,
  kernelDiagnostics,
  isLoadingKernels,
  kernelError,
  jupyterServerStatus,
  isStartingJupyterServer,
  jupyterServerError,
  notebookSessionStatus,
  onTabChange,
  onRefreshKernels,
  onRefreshJupyterServer,
  onStartJupyterServer,
  onStopJupyterServer,
  onToggleCollapsed
}: {
  tab: InspectorTab
  collapsed: boolean
  projectCwd?: string | null
  kernelDiagnostics?: AnalysisKernelDiagnostics | null
  isLoadingKernels?: boolean
  kernelError?: string | null
  jupyterServerStatus?: JupyterServerStatus | null
  isStartingJupyterServer?: boolean
  jupyterServerError?: string | null
  notebookSessionStatus?: AnalysisNotebookSessionStatus | null
  onTabChange: (tab: InspectorTab) => void
  onRefreshKernels?: () => void
  onRefreshJupyterServer?: () => void
  onStartJupyterServer?: (cwd: string) => void
  onStopJupyterServer?: (cwd: string) => void
  onToggleCollapsed: () => void
}): React.JSX.Element {
  const tabs = useMemo(
    () => [
      { value: 'files' as const, label: 'Files' },
      { value: 'variables' as const, label: 'Variables' },
      { value: 'artifacts' as const, label: 'Artifacts' }
    ],
    []
  )

  if (collapsed) {
    return (
      <Box
        sx={{
          width: collapsedInspectorWidth,
          borderLeft: 1,
          borderColor: 'divider',
          pt: isMac ? `${macTitlebarHeight + contentTopGap}px` : 1,
          display: 'flex',
          alignItems: 'center',
          flexDirection: 'column',
          gap: 0.75
        }}
      >
        <Tooltip title="展开分析检查器" placement="left">
          <IconButton size="small" onClick={onToggleCollapsed}>
            <ExpandIcon fontSize="small" sx={{ transform: 'rotate(180deg)' }} />
          </IconButton>
        </Tooltip>
        {tabs.map((item) => (
          <Tooltip key={item.value} title={item.label} placement="left">
            <IconButton
              size="small"
              color={tab === item.value ? 'primary' : 'default'}
              onClick={() => {
                onTabChange(item.value)
                onToggleCollapsed()
              }}
            >
              <AnalysisIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ))}
      </Box>
    )
  }

  return (
    <Box
      sx={{
        width: inspectorWidth,
        flexShrink: 0,
        borderLeft: 1,
        borderColor: 'divider',
        pt: isMac ? `${macTitlebarHeight + contentTopGap}px` : 1.5,
        display: 'flex',
        minHeight: 0,
        flexDirection: 'column',
        bgcolor: (theme) =>
          theme.palette.mode === 'dark' ? theme.palette.background.default : '#FFFFFF'
      }}
    >
      <Box sx={{ px: 1.5, pb: 1.25, display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 800 }}>
            Inspector
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap>
            文件、变量和产物
          </Typography>
        </Box>
        <Tooltip title="收起检查器">
          <IconButton size="small" onClick={onToggleCollapsed}>
            <CollapseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
      <Tabs
        value={tab}
        onChange={(_, value: InspectorTab) => onTabChange(value)}
        variant="fullWidth"
        sx={{ minHeight: 36, px: 1, '& .MuiTab-root': { minHeight: 36, py: 0.5, px: 0.5 } }}
      >
        <Tab value="files" label="Files" />
        <Tab value="variables" label="Variables" />
        <Tab value="artifacts" label="Artifacts" />
      </Tabs>
      <Divider />
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', p: 1.5 }}>
        <InspectorContent
          tab={tab}
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
      </Box>
    </Box>
  )
}

export default function AnalysisView({
  notebookRegistry,
  notebookFile,
  initialLeftPanel = 'chat',
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
  onRefreshNotebooks,
  onRefreshKernels,
  onRefreshJupyterServer,
  onStartJupyterServer,
  onStopJupyterServer,
  onStartNotebookSession,
  onStopNotebookSession,
  onInitializeProjectAnalysis,
  onOpenNotebook,
  onSaveNotebook,
  onCreateNotebook
}: AnalysisViewProps = {}): React.JSX.Element {
  const [leftPanel, setLeftPanel] = useState<LeftPanel>(initialLeftPanel)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('variables')
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false)
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

  return (
    <Box
      component="main"
      sx={{
        flex: 1,
        minWidth: 0,
        height: '100vh',
        display: 'flex',
        overflow: 'hidden',
        bgcolor: (theme: Theme) =>
          theme.palette.mode === 'dark' ? theme.palette.background.default : '#FFFFFF'
      }}
    >
      <LeftRail
        panel={leftPanel}
        collapsed={leftCollapsed}
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
        onToggleCollapsed={() => setLeftCollapsed((value) => !value)}
      />
      <NotebookCanvas
        key={notebookFile ? `${notebookFile.path}:${notebookFile.savedRevision}` : 'mock'}
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
        onSaveNotebook={onSaveNotebook}
        onRefreshKernels={onRefreshKernels}
        onStartNotebookSession={onStartNotebookSession}
        onStopNotebookSession={onStopNotebookSession}
      />
      <RightInspector
        tab={inspectorTab}
        collapsed={inspectorCollapsed}
        projectCwd={notebookRegistry?.projectCwd ?? null}
        kernelDiagnostics={kernelDiagnostics}
        isLoadingKernels={isLoadingKernels}
        kernelError={kernelError}
        jupyterServerStatus={jupyterServerStatus}
        isStartingJupyterServer={isStartingJupyterServer}
        jupyterServerError={jupyterServerError}
        notebookSessionStatus={notebookSessionStatus}
        onTabChange={setInspectorTab}
        onRefreshKernels={onRefreshKernels}
        onRefreshJupyterServer={onRefreshJupyterServer}
        onStartJupyterServer={onStartJupyterServer}
        onStopJupyterServer={onStopJupyterServer}
        onToggleCollapsed={() => setInspectorCollapsed((value) => !value)}
      />
    </Box>
  )
}
