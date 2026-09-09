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

type LeftPanel = 'chat' | 'notebooks'
type InspectorTab = 'files' | 'variables' | 'artifacts'
type CellState = 'idle' | 'running' | 'error' | 'stale'

type MockCell = {
  id: string
  count: number | null
  type: 'markdown' | 'code'
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
const NotebookIcon = PhiIcons.file.markdown
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

const mockNotebooks = [
  { id: 'exploration', path: 'notebooks/exploration.ipynb', status: 'Unsaved' },
  { id: 'qc', path: 'notebooks/qc-summary.ipynb', status: 'Saved' },
  { id: 'figures', path: 'notebooks/figures.ipynb', status: 'Saved' }
]

const mockCells: MockCell[] = [
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

function AnalysisChatPanel(): React.JSX.Element {
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
          exploration.ipynb · Cell 3
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

function NotebookList(): React.JSX.Element {
  return (
    <List disablePadding sx={{ px: 0.75, py: 0.75 }}>
      {mockNotebooks.map((notebook) => (
        <ListItemButton
          key={notebook.id}
          selected={notebook.id === 'exploration'}
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
  onPanelChange,
  onToggleCollapsed
}: {
  panel: LeftPanel
  collapsed: boolean
  onPanelChange: (panel: LeftPanel) => void
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
      {panel === 'chat' ? <AnalysisChatPanel /> : <NotebookList />}
    </Box>
  )
}

function NotebookHeader(): React.JSX.Element {
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
        notebooks/exploration.ipynb
      </Typography>
      <Chip size="small" variant="outlined" label="Python 3.11" />
      <Chip size="small" color="success" variant="outlined" label="Idle" />
      <Chip size="small" color="warning" variant="outlined" label="Unsaved" />
      <Stack direction="row" spacing={0.5} sx={{ WebkitAppRegion: 'no-drag' }}>
        <Tooltip title="运行全部 cell">
          <IconButton size="small" aria-label="运行全部 cell">
            <PlayIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="中断 kernel">
          <IconButton size="small" aria-label="中断 kernel">
            <StopIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="重启 kernel">
          <IconButton size="small" aria-label="重启 kernel">
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

function Cell({ cell }: { cell: MockCell }): React.JSX.Element {
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
            <IconButton size="small" aria-label="插入 cell">
              <AddIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="更多 cell 操作">
            <IconButton size="small" aria-label="更多 cell 操作">
              <MoreIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
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

function NotebookCanvas(): React.JSX.Element {
  return (
    <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <NotebookHeader />
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: { xs: 2, md: 4 }, py: 2.5 }}>
        <Box sx={{ maxWidth: 920, mx: 'auto' }}>
          {mockCells.map((cell) => (
            <Cell key={cell.id} cell={cell} />
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

function VariablesTab(): React.JSX.Element {
  return (
    <Stack spacing={1}>
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

function InspectorContent({ tab }: { tab: InspectorTab }): React.JSX.Element {
  if (tab === 'variables') return <VariablesTab />
  if (tab === 'artifacts') return <ArtifactsTab />
  return <FilesTab />
}

function RightInspector({
  tab,
  collapsed,
  onTabChange,
  onToggleCollapsed
}: {
  tab: InspectorTab
  collapsed: boolean
  onTabChange: (tab: InspectorTab) => void
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
        <InspectorContent tab={tab} />
      </Box>
    </Box>
  )
}

export default function AnalysisView(): React.JSX.Element {
  const [leftPanel, setLeftPanel] = useState<LeftPanel>('chat')
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('variables')
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false)

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
        onPanelChange={setLeftPanel}
        onToggleCollapsed={() => setLeftCollapsed((value) => !value)}
      />
      <NotebookCanvas />
      <RightInspector
        tab={inspectorTab}
        collapsed={inspectorCollapsed}
        onTabChange={setInspectorTab}
        onToggleCollapsed={() => setInspectorCollapsed((value) => !value)}
      />
    </Box>
  )
}
