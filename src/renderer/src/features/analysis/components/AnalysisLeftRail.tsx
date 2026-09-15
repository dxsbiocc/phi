import type { ReactNode } from 'react'
import {
  Box,
  Button,
  Divider,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Tab,
  Tabs,
  Tooltip,
  Typography
} from '@mui/material'
import { PhiIcons, fileIconForPath } from '../../../icons'
import { compactPath, type NotebookListEntry } from '../lib/notebookViewModel'
import type { AnalysisNotebookRegistry } from '../../../types'

export type LeftPanel = 'chat' | 'notebooks'

const AddIcon = PhiIcons.action.add
const ChatIcon = PhiIcons.nav.chat
const NotebookIcon = PhiIcons.file.jupyter
const RefreshIcon = PhiIcons.action.refresh
const isMac = typeof window !== 'undefined' && window.platform === 'darwin'
const macContentTopGap = 8
const leftRailMacChromeHeight = 36
const leftRailTabWidth = 116
const collapsedRailWidth = 44

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
      {notebooks.map((notebook) => {
        const notebookIcon = fileIconForPath(notebook.path)
        const NotebookFileIcon = notebookIcon.Icon
        return (
          <ListItemButton
            key={notebook.id}
            selected={notebook.path === activeNotebookPath}
            onClick={() => onSelectNotebook(notebook)}
            sx={{ alignItems: 'flex-start', mx: 0, mb: 0.5, py: 1 }}
          >
            <NotebookFileIcon
              data-phi-notebook-file-list-icon={notebookIcon.materialIconName}
              fontSize="small"
              sx={{ mt: 0.2, mr: 1, color: notebookIcon.color }}
            />
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
        )
      })}
    </List>
  )
}

export function LeftRail({
  panel,
  collapsed,
  width,
  fullscreen = false,
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
  width: number | string
  fullscreen?: boolean
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
          pt: isMac ? `${leftRailMacChromeHeight + macContentTopGap}px` : 0.75,
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
        pt: isMac ? 0 : 0.75,
        display: 'flex',
        minHeight: 0,
        flexDirection: 'column',
        bgcolor: (theme) =>
          theme.palette.mode === 'dark' ? theme.palette.background.default : '#FFFFFF'
      }}
    >
      {isMac ? (
        <Box
          sx={{
            height: leftRailMacChromeHeight,
            flexShrink: 0,
            px: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            WebkitAppRegion: 'drag'
          }}
        />
      ) : null}
      <Box sx={{ px: 1, pb: 0.5 }}>
        <Tabs
          value={panel}
          onChange={(_, value: LeftPanel) => onPanelChange(value)}
          variant="standard"
          centered
          sx={{
            minHeight: 30,
            '& .MuiTabs-flexContainer': {
              justifyContent: 'center',
              gap: 5
            },
            '& .MuiTabs-indicator': {
              height: 3,
              borderRadius: 999
            },
            '& .MuiTab-root': {
              width: leftRailTabWidth,
              minWidth: leftRailTabWidth,
              minHeight: 30,
              px: 1,
              py: 0.25,
              fontSize: '0.74rem'
            }
          }}
        >
          {tabs.map(({ value, label }) => (
            <Tab
              key={value}
              value={value}
              label={label}
              onClick={() => {
                if (!fullscreen && panel === value) onToggleCollapsed()
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
